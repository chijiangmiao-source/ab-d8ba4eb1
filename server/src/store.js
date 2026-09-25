import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './atomic-write.js';

export const RELEASE_STATUS = Object.freeze({
  STAGING: 'STAGING', // 暂存中：等待全部采集器回执
  PUBLISHED: 'PUBLISHED', // 已发布：代次已原子推进
  BLOCKED: 'BLOCKED', // 已阻塞：存在摘要不符的回执，永不推进
});

export class ConflictError extends Error {
  constructor(existingRelease) {
    super(`stableId 已用于另一份不同载荷的发布: ${existingRelease.id}`);
    this.code = 'STABLE_ID_CONFLICT';
    this.existingRelease = existingRelease;
    this.status = 409;
  }
}

function defaultState() {
  return {
    releases: {},
    stableIndex: {}, // stableId -> releaseId
    generations: {}, // deviceId -> 当前生效代次
    effective: {}, // deviceId -> 当前生效版本
  };
}

/**
 * 发布状态机持久化层。
 * 所有变更经 mutate() 串行化并以一次 rename 原子落盘，
 * “推进代次”这一动作在单次原子写入内完成。
 */
export class ReleaseStore {
  constructor(file, now = () => new Date().toISOString()) {
    this.file = file;
    this.now = now;
    this.state = defaultState();
    this._chain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.state = { ...defaultState(), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = defaultState();
    }
    return this.state;
  }

  /** 串行化所有变更，避免并发派发写出互相覆盖。 */
  mutate(fn) {
    const run = this._chain.then(async () => {
      const result = await fn(this.state);
      await atomicWriteJson(this.file, this.state);
      return result;
    });
    // 链尾不能因为一次业务失败而永久中断
    this._chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * 登记发布意图。
   * 同 stableId + 同摘要 => 幂等返回原发布单；
   * 同 stableId + 异摘要 => 冲突。
   */
  create({ id, stableId, digest, payloadText, targets }) {
    return this.mutate((state) => {
      const existingId = state.stableIndex[stableId];
      if (existingId) {
        const existing = state.releases[existingId];
        if (existing.digest === digest) {
          return { release: existing, idempotent: true };
        }
        throw new ConflictError(existing);
      }
      const release = {
        id,
        stableId,
        digest,
        payloadText,
        targets: [...targets],
        status: RELEASE_STATUS.STAGING,
        receipts: {},
        deviceGenerations: {},
        generation: null,
        createdAt: this.now(),
        promotedAt: null,
        blockedAt: null,
      };
      state.releases[id] = release;
      state.stableIndex[stableId] = id;
      return { release, idempotent: false };
    });
  }

  get(releaseId) {
    return this.state.releases[releaseId] ?? null;
  }

  list() {
    return Object.values(this.state.releases).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  /**
   * 记录一台设备的暂存回执（设备实时返回或重启后从模拟器核对补记，走同一入口）。
   * 首条与发布摘要匹配/不符的回执即权威，重复上报保持原结果。
   */
  recordReceipt(releaseId, deviceId, receipt) {
    return this.mutate((state) => {
      const release = state.releases[releaseId];
      if (!release) throw Object.assign(new Error('release not found'), { status: 404 });
      if (!release.receipts[deviceId]) {
        release.receipts[deviceId] = {
          deviceId,
          receiptId: receipt.receiptId,
          digest: receipt.digest,
          match: receipt.digest === release.digest,
          source: receipt.source, // 'device' | 'recovered'
          stagedAt: receipt.stagedAt,
          recordedAt: this.now(),
          lastError: receipt.lastError ?? null,
        };
      }
      return release.receipts[deviceId];
    });
  }

  /** 记录一次暂存尝试失败（设备不可达等），不产生回执。 */
  recordAttemptError(releaseId, deviceId, message) {
    return this.mutate((state) => {
      const release = state.releases[releaseId];
      if (!release || release.status !== RELEASE_STATUS.STAGING) return;
      const prev = release.receipts[deviceId];
      if (prev) return;
      release.receipts[deviceId] = {
        deviceId,
        receiptId: null,
        digest: null,
        match: false,
        source: 'device',
        stagedAt: null,
        recordedAt: this.now(),
        lastError: message,
      };
    });
  }

  clearAttemptError(releaseId, deviceId) {
    return this.mutate((state) => {
      const release = state.releases[releaseId];
      const r = release?.receipts[deviceId];
      if (r && !r.receiptId) delete release.receipts[deviceId];
    });
  }

  /**
   * 依据当前回执评估能否推进：
   * - 任一回执摘要不符 => BLOCKED（终态，永不推进）
   * - 全部目标均有匹配回执 => 在本次原子写入内推进每台设备代次
   * - 否则维持 STAGING（设备迟到/不可达）
   */
  evaluate(releaseId) {
    return this.mutate((state) => {
      const release = state.releases[releaseId];
      if (!release) return null;
      if (release.status !== RELEASE_STATUS.STAGING) return release;

      const mismatch = release.targets.find((d) => {
        const r = release.receipts[d];
        return r && r.receiptId && !r.match;
      });
      if (mismatch) {
        release.status = RELEASE_STATUS.BLOCKED;
        release.blockedAt = this.now();
        return release;
      }

      const allMatched = release.targets.every((d) => {
        const r = release.receipts[d];
        return r && r.receiptId && r.match;
      });
      if (!allMatched) return release;

      // —— 原子推进：代次、生效版本与发布单状态在同一次落盘内变更 ——
      for (const deviceId of release.targets) {
        const next = (state.generations[deviceId] ?? 0) + 1;
        state.generations[deviceId] = next;
        state.effective[deviceId] = {
          releaseId: release.id,
          stableId: release.stableId,
          digest: release.digest,
          generation: next,
          promotedAt: this.now(),
        };
        release.deviceGenerations[deviceId] = next;
      }
      release.generation = Math.max(...Object.values(release.deviceGenerations));
      release.status = RELEASE_STATUS.PUBLISHED;
      release.promotedAt = this.now();
      return release;
    });
  }

  stagingReleases() {
    return Object.values(this.state.releases).filter(
      (r) => r.status === RELEASE_STATUS.STAGING,
    );
  }

  devicesOverview() {
    return Object.fromEntries(
      Object.entries(this.state.generations).map(([deviceId, generation]) => [
        deviceId,
        { generation, effective: this.state.effective[deviceId] ?? null },
      ]),
    );
  }

  async reset() {
    this.state = defaultState();
    await atomicWriteJson(this.file, this.state);
  }
}
