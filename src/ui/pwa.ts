// "添加到主屏幕 / 安装到桌面"相关：识别平台、接住浏览器的安装提示。
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type Platform = 'ios' | 'android' | 'mac-safari' | 'desktop';

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// 这个事件可能在界面渲染之前就触发，所以在模块加载时就开始监听
if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function detectPlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua)) return 'mac-safari';
  return 'desktop';
}

/** 已经是从主屏幕 / 桌面图标打开的 */
export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** 浏览器支持一键安装时（Chrome、Edge、安卓）返回安装函数，否则返回 null */
export function useInstallPrompt(): (() => Promise<void>) | null {
  const event = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => deferred,
  );
  if (!event) return null;
  return async () => {
    await event.prompt();
    await event.userChoice.catch(() => null);
    deferred = null;
    notify();
  };
}
