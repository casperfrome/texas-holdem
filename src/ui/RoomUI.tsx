import { useEffect, useState } from 'react';
import type { ConnectionInfo, Role } from '../net/protocol';

/** 连接状态小圆点：绿 = 已连接，黄 = 连接中，红 = 断开 */
export function StatusDot({ connection }: { connection: ConnectionInfo }) {
  const label = { online: '已连接', connecting: '连接中…', offline: '已断开' }[connection.self];
  return (
    <span className={`status-dot status-${connection.self}`} title={label} role="status" aria-label={label} />
  );
}

/** 顶部提示：自己断线、对方不在线、朋友还没加入 */
export function StatusBanner({ role, connection, hasView, onInvite }: {
  role: Role;
  connection: ConnectionInfo;
  hasView: boolean;
  onInvite: () => void;
}) {
  if (connection.self !== 'online') {
    return <div className="banner banner-warn">{connection.self === 'connecting' ? '正在连接…' : '网络断开，正在重连…'}</div>;
  }
  if (role === 'host') {
    if (connection.peer === 'unknown') {
      return (
        <div className="banner">
          朋友还没加入
          <button type="button" className="link" onClick={onInvite}>发邀请链接</button>
        </div>
      );
    }
    if (connection.peer === 'offline') return <div className="banner banner-warn">朋友暂时不在线，牌局暂停</div>;
    return null;
  }
  if (connection.peer === 'offline' && hasView) return <div className="banner banner-warn">房主不在线，牌局暂停</div>;
  return null;
}

/** 显示一个链接，可以复制或调用系统分享 */
export function LinkPanel({ title, note, url, warn, onClose }: {
  title: string;
  note: string;
  url: string;
  warn?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const canShare = typeof navigator.share === 'function';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className={warn ? 'sheet-warn' : 'muted'}>{note}</p>
        <div className="link-box">{url}</div>
        {copied === 'fail' && <p className="muted small">自动复制失败，请长按上面的链接手动复制。</p>}
        <div className="sheet-buttons">
          <button type="button" className="btn btn-raise" onClick={copy}>{copied === 'ok' ? '已复制' : '复制链接'}</button>
          {canShare && !warn && (
            <button type="button" className="btn" onClick={() => { navigator.share({ title: '德州扑克邀请', url }).catch(() => {}); }}>分享…</button>
          )}
          <button type="button" className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 联机时保持屏幕常亮：手机锁屏后浏览器会暂停页面，连接也会断 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let active = true;
    const acquire = async () => {
      if (document.hidden || !active) return;
      try { lock = await navigator.wakeLock.request('screen'); } catch { /* 低电量模式等情况下会被拒绝 */ }
    };
    const onVisibility = () => { if (!document.hidden) void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release().catch(() => {});
    };
  }, [enabled]);
}
