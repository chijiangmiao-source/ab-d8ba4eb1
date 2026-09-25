import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STATUS_LABEL = {
  STAGING: '暂存中',
  PUBLISHED: '已发布',
  BLOCKED: '摘要不符 · 已阻塞',
};

const RECEIPT_LABEL = {
  PENDING: '等待回执',
  MATCHED: '摘要匹配',
  MISMATCH: '摘要不符',
  ERROR: '暂存失败',
};

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), {
      status: res.status,
      body,
    });
  }
  return body;
}

function shortDigest(d) {
  return d ? `${d.slice(0, 10)}…` : '—';
}

function StatusBadge({ status }) {
  const cls = `badge badge-${status.toLowerCase()}`;
  return <span className={cls}>{STATUS_LABEL[status] ?? status}</span>;
}

function ReceiptBadge({ state }) {
  const cls = `badge badge-receipt-${state.toLowerCase()}`;
  return <span className={cls}>{RECEIPT_LABEL[state] ?? state}</span>;
}

function SubmitForm({ onCreated }) {
  const [stableId, setStableId] = useState('');
  const [targets, setTargets] = useState('collector-a, collector-b, collector-c');
  const [payloadText, setPayloadText] = useState('laser_wavelength_nm=780\ncooling_temp_k=4.2\ngain=7.0\n');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const list = targets
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!stableId.trim() || !payloadText.trim() || list.length === 0) {
      setError('稳定发布标识、目标采集器与参数文本均不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const data = await api('/api/releases', {
        method: 'POST',
        body: JSON.stringify({ stableId: stableId.trim(), payloadText, targets: list }),
      });
      setNotice(
        data.idempotent
          ? `重传已识别为同一发布：${data.release.id}`
          : `发布编号：${data.release.id}`,
      );
      onCreated(data.release.id);
    } catch (err) {
      if (err.status === 409) {
        setError(
          `冲突：同一稳定标识已有不同载荷的发布（${err.body.existingReleaseId}，摘要 ${shortDigest(
            err.body.existingDigest,
          )}）`,
        );
      } else {
        setError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h2>提交参数发布</h2>
      <label>
        稳定发布标识
        <input
          value={stableId}
          onChange={(e) => setStableId(e.target.value)}
          placeholder="例如 bench-2026-09-25-01"
        />
      </label>
      <label>
        目标采集器（逗号或空格分隔）
        <input value={targets} onChange={(e) => setTargets(e.target.value)} />
      </label>
      <label>
        参数文本
        <textarea rows={6} value={payloadText} onChange={(e) => setPayloadText(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="submit" disabled={submitting}>
          {submitting ? '提交中…' : '提交发布意图'}
        </button>
        {notice && <span className="notice">{notice}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <p className="hint">
        提交只返回发布编号；页面重试安全，同标识同参数重传返回同一发布单，同标识不同参数返回冲突。
      </p>
    </form>
  );
}

function DeviceRow({ device }) {
  return (
    <tr>
      <td className="mono">{device.deviceId}</td>
      <td>
        <ReceiptBadge state={device.receiptState} />
      </td>
      <td className="mono">{device.receiptId ? device.receiptId : '—'}</td>
      <td className="mono" title={device.digest ?? ''}>
        {shortDigest(device.digest)}
      </td>
      <td>{device.source === 'recovered' ? '重启补记' : device.source === 'device' ? '设备直报' : '—'}</td>
      <td>{device.generation ?? '—'}</td>
      <td>{device.stagedAt ? new Date(device.stagedAt).toLocaleTimeString() : '—'}</td>
      <td className="error-text">{device.lastError ?? ''}</td>
    </tr>
  );
}

function ReleaseCard({ release, selected, onSelect }) {
  const allMatch = release.summary.matched === release.summary.total;
  return (
    <div
      className={`card release ${selected ? 'selected' : ''} ${
        release.status === 'PUBLISHED' ? 'is-published' : ''
      }`}
      onClick={() => onSelect(release.id)}
    >
      <div className="release-head">
        <StatusBadge status={release.status} />
        <span className="mono release-id">{release.id}</span>
      </div>
      <div className="release-meta">
        <span>标识 <b>{release.stableId}</b></span>
        <span>
          回执 {release.summary.matched}/{release.summary.total}
          {release.summary.mismatched > 0 && (
            <span className="error-text"> · {release.summary.mismatched} 不符</span>
          )}
        </span>
        <span>生效代次 {release.generation ?? '—'}</span>
      </div>
      <div className="mono digest" title={release.digest}>
        摘要 {shortDigest(release.digest)}
      </div>
      {selected && allMatch && release.status === 'STAGING' && (
        <div className="hint">全部回执已匹配，等待状态机原子推进…</div>
      )}
    </div>
  );
}

export default function App() {
  const [releases, setReleases] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/releases');
      setReleases(data.releases);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasStaging = useMemo(
    () => releases.some((r) => r.status === 'STAGING'),
    [releases],
  );

  useEffect(() => {
    if (!autoRefresh) return;
    // 有暂存中的发布时 1.5s 轮询，否则 5s
    timerRef.current = setInterval(refresh, hasStaging ? 1500 : 5000);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, hasStaging, refresh]);

  const selected = releases.find((r) => r.id === selectedId) ?? null;

  async function reconcile(id) {
    await api(`/api/releases/${id}/reconcile`, { method: 'POST' });
    refresh();
  }

  return (
    <div className="page">
      <header>
        <h1>低温光学台 · 参数发布台</h1>
        <div className="toolbar">
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新
          </label>
          <button onClick={refresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          {refreshError && <span className="error">刷新失败：{refreshError}</span>}
        </div>
      </header>

      <div className="layout">
        <div className="column">
          <SubmitForm onCreated={(id) => setSelectedId(id)} />
        </div>

        <div className="column grow">
          <h2>发布单（只读服务端已确认信息）</h2>
          {releases.length === 0 && <div className="card empty">尚无发布记录</div>}
          {releases.map((r) => (
            <ReleaseCard
              key={r.id}
              release={r}
              selected={r.id === selectedId}
              onSelect={setSelectedId}
            />
          ))}

          {selected && (
            <div className="card detail">
              <div className="detail-head">
                <h2 className="mono">{selected.id}</h2>
                <StatusBadge status={selected.status} />
                <button onClick={() => reconcile(selected.id)}>核对补记 / 重新派发</button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>采集器</th>
                    <th>暂存回执</th>
                    <th>回执编号</th>
                    <th>摘要</th>
                    <th>来源</th>
                    <th>最终生效代次</th>
                    <th>暂存时间</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.devices.map((d) => (
                    <DeviceRow key={d.deviceId} device={d} />
                  ))}
                </tbody>
              </table>
              <div className="detail-foot">
                <span>
                  汇总阶段：<b>{STATUS_LABEL[selected.status]}</b>
                </span>
                <span>
                  匹配 {selected.summary.matched} / 不符 {selected.summary.mismatched} / 失败{' '}
                  {selected.summary.errors ?? 0} / 等待 {selected.summary.pending}
                </span>
                {selected.promotedAt && (
                  <span>生效时间 {new Date(selected.promotedAt).toLocaleString()}</span>
                )}
                {selected.blockedAt && (
                  <span className="error-text">
                    阻塞时间 {new Date(selected.blockedAt).toLocaleString()}，未推进代次
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
