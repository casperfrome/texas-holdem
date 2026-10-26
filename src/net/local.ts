// 同一台设备上几个标签页之间的传输（BroadcastChannel），用于单机测试。
import { type GuestMessage, type GuestTransport, type HostMessage, type HostTransport, PROTOCOL_VERSION } from './protocol';

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  /** 'host' 或参与者编号 */
  from: string;
  /** 房主发给谁 */
  to?: string;
  msg?: GuestMessage | HostMessage;
  /** 参与者关掉了标签页 */
  gone?: boolean;
}

export function createLocalHostTransport(room = 'default'): HostTransport {
  const channel = new BroadcastChannel(`thp-local-v2-${room}`);
  const handlers = new Set<(from: string, msg: GuestMessage) => void>();
  const presence = new Set<(from: string, online: boolean) => void>();
  channel.onmessage = (e: MessageEvent<Envelope>) => {
    const env = e.data;
    if (!env || env.v !== PROTOCOL_VERSION || env.from === 'host') return;
    if (env.gone) for (const h of presence) h(env.from, false);
    else for (const h of handlers) h(env.from, env.msg as GuestMessage);
  };
  return {
    send(to, msg) { channel.postMessage({ v: PROTOCOL_VERSION, from: 'host', to, msg } satisfies Envelope); },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onPresence(handler) {
      presence.add(handler);
      return () => presence.delete(handler);
    },
    close() {
      handlers.clear();
      channel.close();
    },
  };
}

export function createLocalGuestTransport(room = 'default'): GuestTransport {
  const id = Math.random().toString(36).slice(2, 10);
  const channel = new BroadcastChannel(`thp-local-v2-${room}`);
  const handlers = new Set<(msg: HostMessage) => void>();
  channel.onmessage = (e: MessageEvent<Envelope>) => {
    const env = e.data;
    if (!env || env.v !== PROTOCOL_VERSION || env.from !== 'host' || env.to !== id) return;
    for (const h of handlers) h(env.msg as HostMessage);
  };
  // 相当于 MQTT 的掉线遗嘱：关掉标签页时告诉房主
  const gone = () => channel.postMessage({ v: PROTOCOL_VERSION, from: id, gone: true } satisfies Envelope);
  addEventListener('pagehide', gone);
  return {
    send(msg) { channel.postMessage({ v: PROTOCOL_VERSION, from: id, msg } satisfies Envelope); },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      removeEventListener('pagehide', gone);
      gone();
      handlers.clear();
      channel.close();
    },
  };
}
