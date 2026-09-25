/**
 * verify 服务入口：
 *  1) 代码测试（node --test）
 *  2) 构建检查（vite build）
 *  3) API 冒烟（对运行中的 app 服务）：发布、回执、代次、重复发布、冲突
 *  4) 崩溃恢复冒烟：自启一个 CRASH_POINT 实例，制造“设备已暂存、回执未落库”，
 *     重启后核对补记并原子生效
 * 全部通过 exit 0，任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const ROOT = new URL('..', import.meta.url).pathname;

function log(step, msg) {
  console.log(`\n[verify:${step}] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function waitHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* 服务尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`health check 超时: ${baseUrl}/api/health`);
}

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// ---------- 1) 代码测试 ----------
log('tests', '运行后端代码测试');
await run(process.execPath, ['--test', 'server/test/']);

// ---------- 2) 构建检查 ----------
log('build', '运行前端构建检查');
await run('npm', ['run', 'build', '--workspace', 'web']);

// ---------- 3) API 冒烟 ----------
log('smoke', `对 ${BASE_URL} 做 API 冒烟`);
await waitHealth(BASE_URL);

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const stableId = `verify-${suffix}`;
const targets = ['verify-a', 'verify-b', 'verify-c'];
const payloadText = `laser=780\ntemp_k=4.2\nrun=${suffix}\n`;

const postRelease = async (body) =>
  fetch(`${BASE_URL}/api/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let res = await postRelease({ stableId, payloadText, targets });
assert(res.status === 201, `首次提交返回 201（实际 ${res.status}）`);
let { release } = await res.json();
const releaseId = release.id;
assert(Boolean(releaseId), `取得发布编号 ${releaseId}`);

// 轮询直到终态
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  ({ release } = await getJson(`/api/releases/${releaseId}`));
  if (release.status !== 'STAGING') break;
  await new Promise((r) => setTimeout(r, 300));
}
assert(release.status === 'PUBLISHED', `全部回执匹配后原子推进为 PUBLISHED（实际 ${release.status}）`);
assert(
  release.devices.every((d) => d.receiptState === 'MATCHED' && d.generation >= 1),
  '每台设备暂存回执摘要匹配且记录了最终生效代次',
);
assert(release.summary.matched === 3, '汇总：3/3 回执匹配');

// 重复发布：同标识同载荷返回原结果
res = await postRelease({ stableId, payloadText, targets });
assert(res.status === 200, `已完成发布的重传返回 200（实际 ${res.status}）`);
const again = await res.json();
assert(again.idempotent === true && again.release.id === releaseId, '重传幂等返回原发布单');
assert(again.release.status === 'PUBLISHED', '重传返回的原结果仍为 PUBLISHED');

// 同标识异载荷冲突
res = await postRelease({ stableId, payloadText: `${payloadText}\nTAMPERED=1\n`, targets });
assert(res.status === 409, `同一标识异载荷返回 409 冲突（实际 ${res.status}）`);
const conflict = await res.json();
assert(conflict.code === 'STABLE_ID_CONFLICT', '冲突码 STABLE_ID_CONFLICT');

// 列表接口只返回服务端已确认字段
const list = await getJson('/api/releases');
assert(
  list.releases.some((r) => r.id === releaseId && r.generation === release.generation),
  '发布单列表可查且带生效代次',
);

// 页面静态资源由同一服务托管
const page = await fetch(`${BASE_URL}/`);
assert(page.ok && (await page.text()).includes('参数发布'), '发布页由后端托管可访问');

// ---------- 4) 崩溃恢复冒烟 ----------
log('crash', '自启故障注入实例：设备暂存成功、回执落库前退出');
const dataDir = await mkdtemp(join(tmpdir(), 'optical-verify-'));
const crashPort = 8099;
const crashUrl = `http://127.0.0.1:${crashPort}`;

const startServer = (extraEnv) =>
  spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(crashPort),
      DATA_DIR: dataDir,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const crashed = startServer({ CRASH_POINT: 'after-device-stage' });
crashed.stdout.on('data', () => {});
crashed.stderr.on('data', (d) => process.stderr.write(`[crash-instance] ${d}`));

await waitHealth(crashUrl);
const crashStable = `crash-${suffix}`;
const crashPost = fetch(`${crashUrl}/api/releases`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    stableId: crashStable,
    payloadText: `crash payload ${suffix}`,
    targets: ['crash-a', 'crash-b', 'crash-c'],
  }),
});
// 进程在首台设备暂存后立即退出，POST 必然中断
await crashPost.catch(() => {});

const exitCode = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('timeout'), 10000);
  crashed.on('exit', (code) => {
    clearTimeout(t);
    resolve(code);
  });
});
assert(exitCode === 99, `故障实例按预期以 99 退出（实际 ${exitCode}）`);

log('crash', '不带故障点重启，等待启动核对补记');
const restarted = startServer({ CRASH_POINT: '' });
restarted.stdout.on('data', () => {});
restarted.stderr.on('data', (d) => process.stderr.write(`[restart-instance] ${d}`));
await waitHealth(crashUrl);

const crashList = await (await fetch(`${crashUrl}/api/releases`)).json();
const crashRelease = crashList.releases.find((r) => r.stableId === crashStable);
assert(Boolean(crashRelease), '重启后仍能查到崩溃前已落库的发布意图');

const deadline2 = Date.now() + 15000;
let recovered;
while (Date.now() < deadline2) {
  recovered = await (await fetch(`${crashUrl}/api/releases/${crashRelease.id}`)).json().then(
    (x) => x.release,
  );
  if (recovered.status !== 'STAGING') break;
  await new Promise((r) => setTimeout(r, 300));
}
assert(recovered.status === 'PUBLISHED', `重启补记后发布成功（实际 ${recovered.status}）`);
assert(
  recovered.devices.some((d) => d.deviceId === 'crash-a' && d.source === 'recovered'),
  '崩溃窗口内的首台设备回执由重启核对补记（source=recovered）',
);
assert(
  recovered.devices.every((d) => d.receiptState === 'MATCHED' && d.generation === 1),
  '三台设备摘要全部匹配且代次一致推进为 1',
);

restarted.kill('SIGTERM');
await rm(dataDir, { recursive: true, force: true });

log('done', '代码测试、构建检查、API 冒烟、崩溃恢复全部通过');
process.exit(0);
