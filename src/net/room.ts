// 房间凭据：房间口令（双方都有）+ 房主密钥（只有房主有）。
// 链接格式：房主 #host=<口令>~<房主密钥>，朋友 #join=<口令>；可选 &b=<中转服务器>。
// 都放在 # 后面，不会发给托管网站。
import type { KeyValueStore } from '../game/client';

export interface RoomCredentials {
  room: string;
  /** 只有房主有；为 null 表示玩家 */
  hostSecret: string | null;
  broker: BrokerId;
}

export type BrokerId = 'emqx' | 'hivemq' | 'mosquitto';

export const BROKERS: Record<BrokerId, { name: string; url: string }> = {
  emqx: { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  hivemq: { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
  mosquitto: { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
};

export const DEFAULT_BROKER: BrokerId = 'emqx';

const STORE_KEY = 'thp.room.v1';
const SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const isHost = (c: RoomCredentials) => c.hostSecret !== null;

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128 位
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createRoom(broker: BrokerId = DEFAULT_BROKER): RoomCredentials {
  return { room: randomSecret(), hostSecret: randomSecret(), broker };
}

/** 解析链接 # 后面的部分；不是房间链接返回 null */
export function parseRoomHash(hash: string): RoomCredentials | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const b = params.get('b');
  const broker: BrokerId = b && b in BROKERS ? (b as BrokerId) : DEFAULT_BROKER;
  const host = params.get('host');
  if (host) {
    const [room, secret] = host.split('~');
    if (room && secret && SECRET_RE.test(room) && SECRET_RE.test(secret)) return { room, hostSecret: secret, broker };
    return null;
  }
  const join = params.get('join');
  if (join && SECRET_RE.test(join)) return { room: join, hostSecret: null, broker };
  return null;
}

function link(base: string, fragment: string, broker: BrokerId): string {
  return `${base}#${fragment}${broker === DEFAULT_BROKER ? '' : `&b=${broker}`}`;
}

/** 发给朋友的链接 */
export const guestLink = (base: string, c: RoomCredentials) => link(base, `join=${c.room}`, c.broker);

/** 房主自己换设备用的链接，不能发给别人 */
export function hostLink(base: string, c: RoomCredentials): string {
  if (!c.hostSecret) throw new Error('只有房主有房主链接');
  return link(base, `host=${c.room}~${c.hostSecret}`, c.broker);
}

export function loadRoom(store: KeyValueStore): RoomCredentials | null {
  const raw = store.get(STORE_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as RoomCredentials;
    if (!SECRET_RE.test(c.room) || (c.hostSecret !== null && !SECRET_RE.test(c.hostSecret)) || !(c.broker in BROKERS)) return null;
    return c;
  } catch {
    return null;
  }
}

export const saveRoom = (store: KeyValueStore, c: RoomCredentials) => store.set(STORE_KEY, JSON.stringify(c));
export const clearRoom = (store: KeyValueStore) => store.set(STORE_KEY, '');
