import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './atomic-write.js';

/**
 * 采集器设备模拟器。
 * 与发布状态机分开持久化：设备暂存成功不代表服务端回执已落库，
 * 进程在两者之间退出时，状态机重启后靠 verifyReceipt 回来核对补记。
 *
 * 幂等键：发布编号 + 设备编号 + 参数摘要。
 */
export class DeviceSimulator {
  constructor(file, now = () => new Date().toISOString()) {
    this.file = file;
    this.now = now;
    // key: `${releaseId}:${deviceId}` -> staging record
    this.staged = {};
    this._chain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      this.staged = JSON.parse(raw).staged ?? {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.staged = {};
    }
  }

  #mutate(fn) {
    const run = this._chain.then(async () => {
      const result = await fn(this.staged);
      await atomicWriteJson(this.file, { staged: this.staged });
      return result;
    });
    this._chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 设备侧暂存：同一发布同一设备重复暂存同一摘要 => 返回原回执。 */
  stage({ releaseId, deviceId, digest, stableId, payloadText }) {
    return this.#mutate((staged) => {
      const key = `${releaseId}:${deviceId}`;
      const existing = staged[key];
      if (existing) {
        if (existing.digest !== digest) {
          throw Object.assign(
            new Error(`设备 ${deviceId} 已暂存该发布的另一份摘要`),
            {
              status: 409,
              code: 'DEVICE_DIGEST_CONFLICT',
              existingDigest: existing.digest,
              existingReceiptId: existing.receiptId,
            },
          );
        }
        return { receipt: existing, idempotent: true };
      }
      const receipt = {
        receiptId: `rcpt_${releaseId}_${deviceId}_${Math.random().toString(36).slice(2, 10)}`,
        releaseId,
        deviceId,
        stableId,
        digest,
        size: Buffer.byteLength(payloadText, 'utf8'),
        stagedAt: this.now(),
      };
      staged[key] = receipt;
      return { receipt, idempotent: false };
    });
  }

  /** 供服务端重启后核对：设备上是否暂存了该发布，摘要是什么。 */
  verifyReceipt(releaseId, deviceId) {
    return this.staged[`${releaseId}:${deviceId}`] ?? null;
  }

  async reset() {
    this.staged = {};
    await atomicWriteJson(this.file, { staged: {} });
  }
}
