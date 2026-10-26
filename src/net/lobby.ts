// 房间列表：每个房间一条明文保留消息，所有人都能看到房间名、房主、座位和观众人数，
// 但进房需要密码（有密码时），牌局内容另外加密。
import type { HostedRoom } from './accounts';
import { type PubSub, ROOT } from './broker';
import { exportKey, generateEcdh, importKey, passwordKey, publicPart, randomId, seal, secretKey, unseal } from './crypto';
import { hostOnlineTopic, roomBase } from './room-conn';

export interface RoomListing {
  v: 2;
  roomId: string;
  name: string;
  host: string;
  locked: boolean;
  salt: string;
  check: string;
  hostPublic: JsonWebKey;
  seats: [string, string | null];
  watchers: number;
  maxWatchers: number;
  blinds: [number, number];
  updatedAt: number;
}

export interface LobbyRoom extends RoomListing {
  /** 房主现在是否在线 */
  online: boolean;
}

export const listingTopic = (roomId: string) => `${ROOT}/lobby/${roomId}`;

/** 列表里不显示太久没人管的房间 */
export const STALE_MS = 30 * 24 * 3600 * 1000;

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function parseListing(text: string): RoomListing | null {
  try {
    const l = JSON.parse(text) as RoomListing;
    if (l?.v !== 2 || typeof l.roomId !== 'string' || !ROOM_ID_RE.test(l.roomId) || typeof l.name !== 'string') return null;
    if (!Array.isArray(l.seats) || typeof l.maxWatchers !== 'number' || !l.hostPublic) return null;
    return l;
  } catch {
    return null;
  }
}

/** 进房要用的房间密钥：有密码时由密码派生，没有时由房间号派生 */
export async function roomKeyFor(roomId: string, locked: boolean, salt: string, password: string, iterations?: number) {
  return locked ? passwordKey(password, salt, iterations) : secretKey(roomId, 'room/v2');
}

/** 验证输入的密码；不对时返回 null */
export async function unlockRoom(listing: RoomListing, password: string, iterations?: number): Promise<CryptoKey | null> {
  const key = await roomKeyFor(listing.roomId, listing.locked, listing.salt, password, iterations);
  try {
    return (await unseal(key, listing.check)) === 'ok' ? key : null;
  } catch {
    return null;
  }
}

export interface NewRoom {
  name: string;
  password: string;
  maxWatchers: number;
}

/** 生成新房间的全部凭据（存进房主账号） */
export async function createHostedRoom(opts: NewRoom, iterations?: number): Promise<HostedRoom> {
  const roomId = randomId();
  const salt = randomId();
  const locked = opts.password.length > 0;
  const key = await roomKeyFor(roomId, locked, salt, opts.password, iterations);
  return {
    roomId,
    name: opts.name.trim().slice(0, 24) || '德州扑克',
    hostSecret: randomId(),
    roomKey: await exportKey(key),
    locked,
    salt,
    check: await seal(key, 'ok'),
    maxWatchers: opts.maxWatchers,
    ecdh: await generateEcdh(),
    createdAt: Date.now(),
  };
}

export const hostKeyOf = (room: HostedRoom) => secretKey(room.hostSecret, 'host/v2');
export const roomKeyOf = (room: HostedRoom) => importKey(room.roomKey);

export function listingFor(room: HostedRoom, host: string, seats: [string, string | null], watchers: number): RoomListing {
  return {
    v: 2,
    roomId: room.roomId,
    name: room.name,
    host,
    locked: room.locked,
    salt: room.salt,
    check: room.check,
    hostPublic: publicPart(room.ecdh.publicJwk),
    seats,
    watchers,
    maxWatchers: room.maxWatchers,
    blinds: [5, 10],
    updatedAt: Date.now(),
  };
}

export function publishListing(bus: PubSub, listing: RoomListing) {
  return bus.publish(listingTopic(listing.roomId), JSON.stringify(listing), { retain: true, remember: true });
}

/** 解散房间：从列表里删掉，并清掉服务器上的存档 */
export async function removeListing(bus: PubSub, roomId: string) {
  await bus.publish(listingTopic(roomId), '', { retain: true, remember: true });
  for (const topic of [hostOnlineTopic(roomId), `${roomBase(roomId)}/save`, `${roomBase(roomId)}/claim`]) {
    await bus.publish(topic, '', { retain: true });
  }
}

/** 订阅房间列表；在线的房间排前面，然后按最近更新排序 */
export function watchLobby(bus: PubSub, onChange: (rooms: LobbyRoom[]) => void, now = () => Date.now()): () => void {
  const listings = new Map<string, RoomListing>();
  const online = new Map<string, boolean>();
  let emitted = false;
  const emit = () => {
    emitted = true;
    const rooms = [...listings.values()]
      .filter((l) => now() - l.updatedAt < STALE_MS)
      .map((l) => ({ ...l, online: online.get(l.roomId) ?? false }))
      .sort((a, b) => Number(b.online) - Number(a.online) || b.updatedAt - a.updatedAt);
    onChange(rooms);
  };
  const a = bus.subscribe(`${ROOT}/lobby/+`, (topic, text) => {
    const roomId = topic.slice(topic.lastIndexOf('/') + 1);
    const listing = text ? parseListing(text) : null;
    if (listing && listing.roomId === roomId) listings.set(roomId, listing);
    else listings.delete(roomId);
    emit();
  });
  const b = bus.subscribe(`${ROOT}/r/+/host-online`, (topic, text) => {
    const roomId = topic.split('/').at(-2)!;
    online.set(roomId, text === '1');
    if (listings.has(roomId)) emit();
  });
  // 订阅确认后保留消息很快就到；等一会儿还没有任何房间，才算"列表是空的"
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.all([a.ready, b.ready]).then(() => {
    timer = setTimeout(() => { if (!emitted) emit(); }, 1500);
  });
  return () => { a.off(); b.off(); clearTimeout(timer); };
}
