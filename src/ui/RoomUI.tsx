import { useEffect, useState } from 'react';
import type { ConnectionInfo, Role } from '../net/protocol';
import { detectPlatform, useInstallPrompt } from './pwa';

const INSTALL_STEPS: Record<ReturnType<typeof detectPlatform>, string[]> = {
  ios: ['点 Safari 底部（或地址栏旁）的"分享"按钮', '选"添加到主屏幕"', '点右上角"添加"'],
  android: ['点浏览器右上角的菜单（三个点）', '选"安装应用"或"添加到主屏幕"'],
  'mac-safari': ['点菜单栏"文件"', '选"添加到程序坞"'],
  desktop: ['点地址栏右侧的"安装"图标（Chrome / Edge）', '或者打开浏览器菜单，选"安装德州扑克"'],
};

/** 安装到主屏幕 / 桌面的说明 */
export function InstallPanel({ onClose }: { onClose: () => void }) {
  const install = useInstallPrompt();
  const platform = detectPlatform();
  const steps = INSTALL_STEPS[platform];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="安装到主屏幕" onClick={(e) => e.stopPropagation()}>
        <h2>安装到主屏幕</h2>
        <p className="muted">装好后像普通 App 一样从图标打开，全屏显示。</p>
        {install ? (
          <button type="button" className="btn btn-raise" onClick={() => { void install(); }}>一键安装</button>
        ) : (
          <ol className="steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>
        )}
        {platform === 'ios' && (
          <p><strong>注意：</strong>从主屏幕打开的游戏和 Safari 是分开存储的，第一次从图标打开时需要再登录一次。</p>
        )}
        <div className="sheet-buttons">
          <button type="button" className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 连接状态小圆点：绿 = 已连接，黄 = 连接中，红 = 断开 */
export function StatusDot({ connection }: { connection: ConnectionInfo }) {
  const label = { online: '已连接', connecting: '连接中…', offline: '已断开' }[connection.self];
  return (
    <span className={`status-dot status-${connection.self}`} title={label} role="status" aria-label={label} />
  );
}

/** 被催时：提示音 + 震动 */
export function alertNudge() {
  navigator.vibrate?.([120, 80, 120]);
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => void ctx.close();
  } catch { /* 浏览器不让播放声音时只震动 */ }
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
