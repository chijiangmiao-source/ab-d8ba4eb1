import { randomUUID } from 'node:crypto';
import { parameterDigest } from './digest.js';
import { RELEASE_STATUS } from './store.js';
import { maybeCrash } from './crash-hook.js';

/**
 * 发布编排：
 *  1) 登记发布意图（拿到发布编号）
 *  2) 逐台设备幂等暂存并落库回执
 *  3) 全部目标回执摘要匹配 => 状态机原子推进代次
 * 设备迟到/不可达时保持 STAGING，由后台核对与后续重试补齐。
 */
export class ReleaseService {
  constructor(store, simulator) {
    this.store = store;
    this.simulator = simulator;
  }

  /** 提交发布意图；同 stableId 重传同载荷返回原发布单。 */
  async submit({ stableId, payloadText, targets }) {
    const digest = parameterDigest(stableId, payloadText);
    const id = `rel_${randomUUID()}`;
    const { release, idempotent } = await this.store.create({
      id,
      stableId,
      digest,
      payloadText,
      targets,
    });
    if (idempotent) {
      // 已完成发布的重传返回原结果；进行中的重传继续/恢复派发
      if (release.status === RELEASE_STATUS.STAGING) {
        this.#dispatch(release).catch(() => {});
      }
      return { release, idempotent: true };
    }
    this.#dispatch(release).catch(() => {});
    return { release, idempotent: false };
  }

  /** 向所有尚无匹配回执的目标派发暂存；可安全重复执行。 */
  async dispatch(releaseId) {
    const release = this.store.get(releaseId);
    if (!release) return null;
    return this.#dispatch(release);
  }

  async #dispatch(release) {
    for (const deviceId of release.targets) {
      const current = this.store.get(release.id);
      if (!current || current.status !== RELEASE_STATUS.STAGING) return current;
      const r = current.receipts[deviceId];
      if (r && r.receiptId) continue; // 已有权威回执（含补记）

      try {
        const { receipt } = await this.simulator.stage({
          releaseId: release.id,
          deviceId,
          digest: release.digest,
          stableId: release.stableId,
          payloadText: release.payloadText,
        });

        // —— 崩溃窗口：设备暂存已持久化，服务端回执尚未落库 ——
        await maybeCrash('after-device-stage');

        await this.store.clearAttemptError(release.id, deviceId);
        await this.store.recordReceipt(release.id, deviceId, {
          ...receipt,
          source: 'device',
        });
      } catch (err) {
        if (err.code === 'DEVICE_DIGEST_CONFLICT') {
          // 设备侧事实摘要与发布摘要不符：补记不符回执，状态机随后 BLOCKED
          await this.store.clearAttemptError(release.id, deviceId);
          await this.store.recordReceipt(release.id, deviceId, {
            receiptId: err.existingReceiptId,
            digest: err.existingDigest,
            stagedAt: null,
            source: 'device',
          });
          await this.store.evaluate(release.id);
          continue;
        }
        await this.store.recordAttemptError(release.id, deviceId, err.message);
      }
    }
    return this.store.evaluate(release.id);
  }

  /**
   * 重启恢复：对所有 STAGING 发布单向模拟器逐台核对。
   * 设备上确有暂存 => 按设备侧事实补记回执（source=recovered）；
   * 设备侧摘要与发布摘要不符 => 补记不符回执，状态机转入 BLOCKED，不得推进；
   * 设备上查不到 => 保持未发布（设备迟到/当时不可达），稍后重新派发。
   */
  async reconcile() {
    const results = [];
    for (const release of this.store.stagingReleases()) {
      for (const deviceId of release.targets) {
        const r = release.receipts[deviceId];
        if (r && r.receiptId) continue;
        const deviceRecord = this.simulator.verifyReceipt(release.id, deviceId);
        if (deviceRecord) {
          await this.store.clearAttemptError(release.id, deviceId);
          await this.store.recordReceipt(release.id, deviceId, {
            ...deviceRecord,
            source: 'recovered',
          });
          results.push({ releaseId: release.id, deviceId, recovered: true });
        } else {
          results.push({ releaseId: release.id, deviceId, recovered: false });
        }
      }
      const updated = await this.store.evaluate(release.id);
      // 核对后仍未齐且设备其实可暂存（迟到场景）：再派发一次
      if (updated && updated.status === RELEASE_STATUS.STAGING) {
        await this.#dispatch(updated);
      }
    }
    return results;
  }
}
