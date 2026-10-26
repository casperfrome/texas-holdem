// 账号：没有自己的服务器，账号记录作为保留消息存在公共中转服务器上，
// 用密码派生的密钥整体加密，服务器和别人只能看到乱码。本机同时留一份，服务器丢了可以补回去。
//
// 以后上了自己的服务器，换掉这个文件的实现即可，界面只用到 AccountService 的几个方法。
import type { KeyValueStore } from '../game/client';
import { type PubSub, ROOT } from './broker';
import { type EcdhPair, exportKey, importKey, passwordKey, randomId, seal, sha256Hex, unseal } from './crypto';

/** 自己创建的房间：重新登录（包括换设备）后凭这些继续当房主 */
export interface HostedRoom {
  roomId: string;
  name: string;
  /** 加密房主存档用 */
  hostSecret: string;
  /** 房间密钥（由房间密码派生），base64 */
  roomKey: string;
  locked: boolean;
  salt: string;
  /** 用房间密钥加密的 "ok"，进房的人用来当场验证密码 */
  check: string;
  maxWatchers: number;
  ecdh: EcdhPair;
  createdAt: number;
}

export interface AccountData {
  username: string;
  /** 座位凭证的来源：每个房间用它派生出不同的凭证 */
  seatToken: string;
  rooms: HostedRoom[];
  stats: { won: number; lost: number };
  /** 已记过战绩的对局，避免重复计算（只留最近的） */
  recorded: string[];
  updatedAt: number;
}

export interface Session {
  id: string;
  salt: string;
  key: CryptoKey;
  data: AccountData;
}

interface StoredRecord {
  v: 2;
  salt: string;
  data: string;
}

export class AccountError extends Error {
  override name = 'AccountError';
}

const SESSION_KEY = 'thp.v2.session';
const cacheKey = (id: string) => `thp.v2.account.${id}`;

export const accountTopic = (id: string) => `${ROOT}/users/${id}`;

export function normalizeUsername(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) throw new AccountError('请输入用户名');
  if ([...name].length > 16) throw new AccountError('用户名最多 16 个字');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new AccountError('用户名里有不能用的字符');
  return name;
}

/** 用户名不区分大小写 */
export const accountId = (username: string) => sha256Hex(`thp-user:${username.toLowerCase()}`, 32);

/** 每个房间的座位凭证不同，房主拿到也没法冒充你去别的房间 */
export const seatTokenFor = (data: AccountData, roomId: string) => sha256Hex(`${data.seatToken}:${roomId}`, 32);

function parseRecord(text: string | null): StoredRecord | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text) as StoredRecord;
    return r && r.v === 2 && typeof r.salt === 'string' && typeof r.data === 'string' ? r : null;
  } catch {
    return null;
  }
}

async function openRecord(record: StoredRecord, key: CryptoKey): Promise<AccountData | null> {
  try { return await unseal(key, record.data) as AccountData; } catch { return null; }
}

export class AccountService {
  constructor(private readonly bus: PubSub, private readonly store: KeyValueStore, private readonly iterations?: number) {}

  async register(rawName: string, password: string): Promise<Session> {
    const username = normalizeUsername(rawName);
    if (!password) throw new AccountError('请输入密码');
    const id = await accountId(username);
    const existing = parseRecord(await this.bus.fetchRetained(accountTopic(id))) ?? parseRecord(this.store.get(cacheKey(id)));
    if (existing) throw new AccountError('这个用户名已经被注册了');
    const salt = randomId();
    const key = await passwordKey(password, salt, this.iterations);
    const data: AccountData = {
      username, seatToken: randomId(), rooms: [], stats: { won: 0, lost: 0 }, recorded: [], updatedAt: Date.now(),
    };
    return this.save({ id, salt, key, data }, data);
  }

  async login(rawName: string, password: string): Promise<Session> {
    const username = normalizeUsername(rawName);
    if (!password) throw new AccountError('请输入密码');
    const id = await accountId(username);
    const remote = parseRecord(await this.bus.fetchRetained(accountTopic(id)));
    const local = parseRecord(this.store.get(cacheKey(id)));
    if (!remote && !local) throw new AccountError('没有这个用户名，请先注册');

    let best: Session | null = null;
    for (const record of [remote, local]) {
      if (!record) continue;
      const key = await passwordKey(password, record.salt, this.iterations);
      const data = await openRecord(record, key);
      if (data && (!best || data.updatedAt > best.data.updatedAt)) best = { id, salt: record.salt, key, data };
    }
    if (!best) throw new AccountError('用户名或密码不对');
    // 服务器上没有或比本机旧：用本机这份补回去
    const remoteData = remote && best.salt === remote.salt ? await openRecord(remote, best.key) : null;
    if (!remoteData || remoteData.updatedAt < best.data.updatedAt) await this.save(best, best.data);
    else this.cache(best.id, remote!);
    await this.remember(best);
    return best;
  }

  /** 本机记住的登录状态；没有时返回 null */
  async restore(): Promise<Session | null> {
    const raw = this.store.get(SESSION_KEY);
    if (!raw) return null;
    try {
      const { id, key: keyText } = JSON.parse(raw) as { id: string; key: string };
      const record = parseRecord(this.store.get(cacheKey(id)));
      if (!record) return null;
      const key = await importKey(keyText);
      const data = await openRecord(record, key);
      return data ? { id, salt: record.salt, key, data } : null;
    } catch {
      return null;
    }
  }

  /** 从服务器拿最新的账号记录（例如在另一台设备上建了房间）；服务器上的不比本机新就原样返回 */
  async refresh(session: Session): Promise<Session> {
    const remote = parseRecord(await this.bus.fetchRetained(accountTopic(session.id)));
    if (!remote || remote.salt !== session.salt) return session;
    const data = await openRecord(remote, session.key);
    if (!data || data.updatedAt <= session.data.updatedAt) return session;
    this.cache(session.id, remote);
    return { ...session, data };
  }

  /** 修改账号内容并保存到服务器和本机 */
  async update(session: Session, change: (d: AccountData) => AccountData): Promise<Session> {
    return this.save(session, change(structuredClone(session.data)));
  }

  logout() {
    this.store.set(SESSION_KEY, '');
  }

  private async save(session: Session, data: AccountData): Promise<Session> {
    const next: Session = { ...session, data: { ...data, updatedAt: Math.max(Date.now(), session.data.updatedAt + 1) } };
    const record: StoredRecord = { v: 2, salt: next.salt, data: await seal(next.key, next.data) };
    const text = JSON.stringify(record);
    this.store.set(cacheKey(next.id), text);
    await this.bus.publish(accountTopic(next.id), text, { retain: true });
    await this.remember(next);
    return next;
  }

  private cache(id: string, record: StoredRecord) {
    this.store.set(cacheKey(id), JSON.stringify(record));
  }

  private async remember(s: Session) {
    this.store.set(SESSION_KEY, JSON.stringify({ id: s.id, key: await exportKey(s.key) }));
  }
}

/** 一局分出胜负后记战绩；同一局只记一次 */
export function recordMatch(data: AccountData, matchKey: string, won: boolean): AccountData | null {
  if (data.recorded.includes(matchKey)) return null;
  return {
    ...data,
    stats: { won: data.stats.won + (won ? 1 : 0), lost: data.stats.lost + (won ? 0 : 1) },
    recorded: [...data.recorded, matchKey].slice(-50),
  };
}
