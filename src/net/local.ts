// 同一台设备上两个标签页之间的传输（BroadcastChannel），用于单机测试。
import { type Envelope, type GuestMessage, type HostMessage, PROTOCOL_VERSION, type Role, type Transport } from './protocol';

export function createLocalTransport(role: 'host', room?: string): Transport<GuestMessage, HostMessage>;
export function createLocalTransport(role: 'guest', room?: string): Transport<HostMessage, GuestMessage>;
export function createLocalTransport(role: Role, room = 'default'): Transport<GuestMessage | HostMessage, GuestMessage | HostMessage> {
  const channel = new BroadcastChannel(`thp-local-${room}`);
  const handlers = new Set<(msg: GuestMessage | HostMessage) => void>();

  channel.onmessage = (e: MessageEvent<Envelope>) => {
    const env = e.data;
    if (!env || env.v !== PROTOCOL_VERSION || env.from === role) return;
    for (const h of handlers) h(env.msg);
  };

  return {
    send(msg) {
      const env: Envelope = { v: PROTOCOL_VERSION, from: role, msg };
      channel.postMessage(env);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      channel.close();
    },
  };
}
