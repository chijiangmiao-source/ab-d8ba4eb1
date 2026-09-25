import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseStore, RELEASE_STATUS, ConflictError } from '../src/store.js';
import { DeviceSimulator } from '../src/simulator.js';
import { ReleaseService } from '../src/release-service.js';
import { parameterDigest } from '../src/digest.js';

let dir;
let storeFile;
let deviceFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'optical-'));
  storeFile = join(dir, 'releases.json');
  deviceFile = join(dir, 'devices.json');
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeService() {
  const store = new ReleaseStore(storeFile);
  const simulator = new DeviceSimulator(deviceFile);
  return { store, simulator, service: new ReleaseService(store, simulator) };
}

const TARGETS = ['col-1', 'col-2', 'col-3'];

test('全部目标回执摘要匹配时才原子推进代次', async () => {
  const { store, service } = makeService();
  await store.load();
  const { release } = await service.submit({
    stableId: 'wave-A',
    payloadText: 'laser=4.2K gain=7',
    targets: TARGETS,
  });

  const done = await service.dispatch(release.id);
  assert.equal(done.status, RELEASE_STATUS.PUBLISHED);
  assert.equal(done.generation, 1);
  for (const d of TARGETS) assert.equal(done.deviceGenerations[d], 1);
});

test('缺少任一回执保持 STAGING，补齐后下一轮发布代次连续', async () => {
  const { store, simulator, service } = makeService();
  await store.load();
  await simulator.load();

  const digest = parameterDigest('wave-B', 'p1');
  const relId = 'rel-late-1';
  await store.create({
    id: relId,
    stableId: 'wave-B',
    digest,
    payloadText: 'p1',
    targets: TARGETS,
  });
  const release = store.get(relId);
  // 只暂存前两台，第三台“迟到”
  for (const d of TARGETS.slice(0, 2)) {
    const { receipt } = await simulator.stage({
      releaseId: relId,
      deviceId: d,
      digest,
      stableId: 'wave-B',
      payloadText: 'p1',
    });
    await store.recordReceipt(relId, d, { ...receipt, source: 'device' });
  }
  let r = await store.evaluate(relId);
  assert.equal(r.status, RELEASE_STATUS.STAGING);
  assert.equal(r.generation, null);

  // 迟到设备补齐
  await service.dispatch(relId);
  r = store.get(relId);
  assert.equal(r.status, RELEASE_STATUS.PUBLISHED);
  assert.equal(r.generation, 1);
});

test('任一设备摘要不符 => BLOCKED，永不推进，其余设备代次不变', async () => {
  const { store, service } = makeService();
  await store.load();
  const digest = parameterDigest('wave-C', 'p-correct');
  const relId = 'rel-mismatch-1';
  await store.create({
    id: relId,
    stableId: 'wave-C',
    digest,
    payloadText: 'p-correct',
    targets: TARGETS,
  });

  for (const d of TARGETS.slice(0, 2)) {
    await store.recordReceipt(relId, d, {
      receiptId: `ok-${d}`,
      digest,
      stagedAt: new Date().toISOString(),
      source: 'device',
    });
  }
  await store.recordReceipt(relId, TARGETS[2], {
    receiptId: 'bad',
    digest: parameterDigest('wave-C', 'p-TAMPERED'),
    stagedAt: new Date().toISOString(),
    source: 'device',
  });

  const blocked = await store.evaluate(relId);
  assert.equal(blocked.status, RELEASE_STATUS.BLOCKED);
  assert.equal(blocked.generation, null);
  assert.deepEqual(store.state.generations, {});

  // 即使后来又出现“正确”回执，也不得翻案推进（首条回执权威）
  await store.recordReceipt(relId, TARGETS[2], {
    receiptId: 'good',
    digest,
    stagedAt: new Date().toISOString(),
    source: 'device',
  });
  const still = await store.evaluate(relId);
  assert.equal(still.status, RELEASE_STATUS.BLOCKED);
});

test('同一 stableId 异载荷冲突，同载荷重传返回原发布单', async () => {
  const { service } = makeService();
  await service.store.load();
  await service.simulator.load();

  const first = await service.submit({
    stableId: 'wave-D',
    payloadText: 'v1',
    targets: TARGETS,
  });
  await service.dispatch(first.release.id);

  await assert.rejects(
    service.submit({ stableId: 'wave-D', payloadText: 'v2-different', targets: TARGETS }),
    (err) => err instanceof ConflictError && err.code === 'STABLE_ID_CONFLICT',
  );

  const retried = await service.submit({
    stableId: 'wave-D',
    payloadText: 'v1',
    targets: TARGETS,
  });
  assert.equal(retried.idempotent, true);
  assert.equal(retried.release.id, first.release.id);
  assert.equal(retried.release.status, RELEASE_STATUS.PUBLISHED);
});

test('设备暂存按 发布编号+摘要 幂等，重复暂存返回同一回执', async () => {
  const { simulator } = makeService();
  await simulator.load();
  const args = {
    releaseId: 'rel-x',
    deviceId: 'col-1',
    digest: 'dig-1',
    stableId: 's',
    payloadText: 'p',
  };
  const a = await simulator.stage(args);
  const b = await simulator.stage(args);
  assert.equal(b.idempotent, true);
  assert.equal(b.receipt.receiptId, a.receipt.receiptId);
});

test('崩溃恢复：设备已暂存但回执未落库，重启核对补记后原子生效', async () => {
  // —— 崩溃前：发布意图已落盘、一台设备暂存已落盘、其余设备尚未派发 ——
  let store = new ReleaseStore(storeFile);
  let simulator = new DeviceSimulator(deviceFile);
  await store.load();
  await simulator.load();

  const digest = parameterDigest('wave-crash', 'p-crash');
  const relId = 'rel-crash-1';
  await store.create({
    id: relId,
    stableId: 'wave-crash',
    digest,
    payloadText: 'p-crash',
    targets: TARGETS,
  });
  const { receipt: r0 } = await simulator.stage({
    releaseId: relId,
    deviceId: TARGETS[0],
    digest,
    stableId: 'wave-crash',
    payloadText: 'p-crash',
  });
  // 进程此刻退出：回执没有落库
  assert.ok(r0.receiptId);

  // —— 重启：重新加载两份持久化文件 ——
  store = new ReleaseStore(storeFile);
  simulator = new DeviceSimulator(deviceFile);
  await store.load();
  await simulator.load();

  const reloaded = store.get(relId);
  assert.equal(reloaded.status, RELEASE_STATUS.STAGING);
  assert.deepEqual(Object.keys(reloaded.receipts), []);

  const restarted = new ReleaseService(store, simulator);
  const recovered = await restarted.reconcile();
  assert.ok(recovered.some((x) => x.deviceId === TARGETS[0] && x.recovered));

  const after = store.get(relId);
  assert.equal(after.status, RELEASE_STATUS.PUBLISHED);
  assert.equal(after.receipts[TARGETS[0]].source, 'recovered');
  assert.equal(after.receipts[TARGETS[0]].receiptId, r0.receiptId);
  for (const d of TARGETS) assert.equal(after.deviceGenerations[d], 1);
});

test('重启核对发现设备侧摘要不符 => 补记不符并 BLOCKED，不得推进', async () => {
  const store = new ReleaseStore(storeFile);
  const simulator = new DeviceSimulator(deviceFile);
  await store.load();
  await simulator.load();

  const digest = parameterDigest('wave-bad-device', 'p');
  const relId = 'rel-bad-1';
  await store.create({
    id: relId,
    stableId: 'wave-bad-device',
    digest,
    payloadText: 'p',
    targets: ['col-1', 'col-2'],
  });
  // 设备 col-1 暂存了错误摘要（模拟设备内容被污染/串单）
  await simulator.stage({
    releaseId: relId,
    deviceId: 'col-1',
    digest: parameterDigest('wave-bad-device', 'p-OTHER'),
    stableId: 'wave-bad-device',
    payloadText: 'p',
  });

  // 重启
  const store2 = new ReleaseStore(storeFile);
  const sim2 = new DeviceSimulator(deviceFile);
  await store2.load();
  await sim2.load();
  await new ReleaseService(store2, sim2).reconcile();

  const after = store2.get(relId);
  assert.equal(after.status, RELEASE_STATUS.BLOCKED);
  assert.equal(after.receipts['col-1'].match, false);
  assert.equal(after.generation, null);
});

test('连续两代发布在每台设备上的代次严格递增', async () => {
  const { service, store } = makeService();
  await store.load();
  await service.simulator.load();

  const a = await service.submit({ stableId: 'g1', payloadText: 'a', targets: ['d1'] });
  await service.dispatch(a.release.id);
  const b = await service.submit({ stableId: 'g2', payloadText: 'b', targets: ['d1'] });
  await service.dispatch(b.release.id);

  assert.equal(store.state.generations.d1, 2);
  assert.equal(store.get(b.release.id).deviceGenerations.d1, 2);
});
