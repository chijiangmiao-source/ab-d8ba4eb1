import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { RELEASE_STATUS, ConflictError } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function validateTargets(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('targets 必须是非空设备编号数组');
  }
  const targets = value.map((t) => {
    if (typeof t !== 'string') throw badRequest('targets 只能包含字符串');
    const id = t.trim();
    if (!id) throw badRequest('targets 不能包含空设备编号');
    return id;
  });
  if (new Set(targets).size !== targets.length) {
    throw badRequest('targets 不能包含重复设备');
  }
  return targets;
}

function validateSubmit(body) {
  if (!body || typeof body !== 'object') throw badRequest('请求体必须是 JSON');
  const stableId = typeof body.stableId === 'string' ? body.stableId.trim() : '';
  const payloadText = typeof body.payloadText === 'string' ? body.payloadText : '';
  if (!stableId) throw badRequest('stableId 不能为空');
  if (!payloadText.trim()) throw badRequest('payloadText 不能为空');
  if (Buffer.byteLength(payloadText, 'utf8') > 64 * 1024) {
    throw badRequest('payloadText 不能超过 64KiB');
  }
  return { stableId, payloadText, targets: validateTargets(body.targets) };
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });
}

/** 把内部发布单投影为页面只读视图：页面只展示服务端已确认的信息。 */
export function releaseView(r) {
  const devices = r.targets.map((deviceId) => {
    const rcpt = r.receipts[deviceId];
    if (!rcpt) return { deviceId, receiptState: 'PENDING' };
    if (!rcpt.receiptId) {
      return {
        deviceId,
        receiptState: 'ERROR',
        lastError: rcpt.lastError,
        recordedAt: rcpt.recordedAt,
      };
    }
    return {
      deviceId,
      receiptState: rcpt.match ? 'MATCHED' : 'MISMATCH',
      receiptId: rcpt.receiptId,
      digest: rcpt.digest,
      source: rcpt.source,
      stagedAt: rcpt.stagedAt,
      recordedAt: rcpt.recordedAt,
      generation: r.deviceGenerations[deviceId] ?? null,
    };
  });
  const matched = devices.filter((d) => d.receiptState === 'MATCHED').length;
  const mismatched = devices.filter((d) => d.receiptState === 'MISMATCH').length;
  const errors = devices.filter((d) => d.receiptState === 'ERROR').length;
  const pending = r.targets.length - matched - mismatched - errors;
  return {
    id: r.id,
    stableId: r.stableId,
    digest: r.digest,
    targets: r.targets,
    status: r.status,
    phase: r.status,
    createdAt: r.createdAt,
    promotedAt: r.promotedAt,
    blockedAt: r.blockedAt,
    generation: r.generation,
    summary: { total: r.targets.length, matched, mismatched, errors, pending },
    devices,
  };
}

export function createApp({ store, service }) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // 提交发布意图，返回发布编号；重传同载荷幂等返回原发布单
  app.post('/api/releases', async (req, res, next) => {
    try {
      const input = validateSubmit(req.body);
      const { release, idempotent } = await service.submit(input);
      res.status(idempotent ? 200 : 201).json({
        idempotent,
        release: releaseView(release),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/releases', (_req, res) => {
    res.json({ releases: store.list().map(releaseView) });
  });

  app.get('/api/releases/:id', (req, res, next) => {
    const release = store.get(req.params.id);
    if (!release) return next(Object.assign(new Error('发布单不存在'), { status: 404 }));
    res.json({ release: releaseView(release) });
  });

  // 工程师可在设备迟到/恢复后主动触发一次核对补记与推进
  app.post('/api/releases/:id/reconcile', async (req, res, next) => {
    try {
      const release = await service.dispatch(req.params.id);
      if (!release) {
        return next(Object.assign(new Error('发布单不存在'), { status: 404 }));
      }
      res.json({ release: releaseView(release) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/devices', (_req, res) => {
    res.json({ devices: store.devicesOverview() });
  });

  // 托管构建后的 React 页面
  const webDist = resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  app.use((err, _req, res, _next) => {
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        existingReleaseId: err.existingRelease.id,
        existingDigest: err.existingRelease.digest,
      });
    }
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message, code: err.code ?? 'INTERNAL' });
  });

  return app;
}

export { RELEASE_STATUS };
