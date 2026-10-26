// 房间里的通信，跑在一条 MQTT 连接上。频道（都在 thp/v2/r/<房间号>/ 下）：
//   c2h               参与者 → 房主：外层用房间密钥加密（不知道密码就进不来），
//                     里层用一对一密钥加密（别的参与者冒充不了你）
//   to/<编号>/state   房主 → 某个参与者：最新画面（保留消息，一连上就能拿到），只用一对一密钥加密
//   to/<编号>/evt     房主 → 某个参与者：拒绝、被催等一次性消息
//   presence/<编号>   参与者在线记录（保留消息 + 遗嘱：掉线时服务器自动标记离线）
//   host-online       房主在线记录，明文 "1" / "0"，房间列表也要看
//   save              房主存档，用房主密钥加密，别人解不开
//   claim             房主占用记录：房主在另一台设备打开时，旧设备停止生效
import { Broker, type LinkStatus, type PubSub, ROOT } from './broker';
import { clientIdOf, type EcdhPair, pairKey, publicPart, seal, unseal } from './crypto';
import {
  type ConnectionInfo, type GuestMessage, type GuestTransport, type HostMessage, type HostTransport, PROTOCOL_VERSION,
} from './protocol';

export const roomBase = (roomId: string) => `${ROOT}/r/${roomId}`;
export const hostOnlineTopic = (roomId: string) => `${roomBase(roomId)}/host-online`;

interface ToHost {
  v: typeof PROTOCOL_VERSION;
  from: string;
  pub: JsonWebKey;
  /** 用一对一密钥加密的 GuestMessage */
  body: string;
}

interface ToGuest {
  v: typeof PROTOCOL_VERSION;
  body: HostMessage;
}

const linkToSelf = (s: LinkStatus): ConnectionInfo['self'] => s;

/**
 * 本页面里每个房间正在用的连接数。快速离开又进入同一个房间时，旧连接晚到的"下线"
 * 会盖掉新连接的"上线"，所以只有最后一个连接关闭时才发"下线"。
 */
const openLinks = new Map<string, number>();
const retain = (key: string) => openLinks.set(key, (openLinks.get(key) ?? 0) + 1);
function release(key: string): boolean {
  const n = (openLinks.get(key) ?? 1) - 1;
  if (n > 0) openLinks.set(key, n);
  else openLinks.delete(key);
  return n <= 0;
}

export interface HostLinkOptions {
  roomId: string;
  roomKey: CryptoKey;
  hostKey: CryptoKey;
  ecdh: EcdhPair;
  /** 测试时传入内存实现；默认连公共中转服务器 */
  bus?: PubSub;
  brokerUrl?: string;
}

/** 房主一端 */
export class HostLink implements HostTransport {
  private readonly bus: PubSub;
  private readonly base: string;
  private readonly roomId: string;
  private readonly roomKey: CryptoKey;
  private readonly hostKey: CryptoKey;
  private readonly ecdh: EcdhPair;
  private readonly inst = Math.random().toString(36).slice(2, 10);
  private readonly pairKeys = new Map<string, Promise<CryptoKey>>();
  private readonly msgHandlers = new Set<(from: string, m: GuestMessage) => void>();
  private readonly presenceHandlers = new Set<(from: string, online: boolean) => void>();
  private readonly connHandlers = new Set<(i: ConnectionInfo) => void>();
  private info: ConnectionInfo = { self: 'connecting', peer: 'unknown', superseded: false };
  private recvChain: Promise<unknown> = Promise.resolve();
  private readonly offs: (() => void)[] = [];
  private seenClaimAt = 0;
  private myClaimAt = 0;
  private readonly ready: Promise<unknown>;

  constructor(opts: HostLinkOptions) {
    this.roomId = opts.roomId;
    this.roomKey = opts.roomKey;
    this.hostKey = opts.hostKey;
    this.ecdh = opts.ecdh;
    this.base = roomBase(opts.roomId);
    retain(`host:${opts.roomId}`);
    this.bus = opts.bus ?? new Broker({
      ...(opts.brokerUrl ? { url: opts.brokerUrl } : {}),
      will: { topic: hostOnlineTopic(opts.roomId), payload: '0', retain: true },
    });
    const subs = [
      this.bus.subscribe(`${this.base}/c2h`, (_, text) => this.queue(() => this.receive(text))),
      this.bus.subscribe(`${this.base}/presence/+`, (topic, text) => this.queue(() => this.receivePresence(topic, text))),
      this.bus.subscribe(`${this.base}/claim`, (_, text) => this.queue(() => this.receiveClaim(text))),
    ];
    this.offs.push(...subs.map((s) => () => s.off()));
    this.ready = Promise.all(subs.map((s) => s.ready));
    this.offs.push(this.bus.onStatus((s) => this.emit({ self: linkToSelf(s) })));
    void this.bus.publish(hostOnlineTopic(opts.roomId), '1', { retain: true, remember: true });
  }

  send(to: string, msg: HostMessage): void {
    if (this.info.superseded) return;
    const key = this.pairKeys.get(to);
    if (!key) return; // 还没收到过这个人的消息，不知道怎么加密
    const packet: ToGuest = { v: PROTOCOL_VERSION, body: msg };
    const payload = key.then((k) => seal(k, packet));
    if (msg.t === 'state') void this.bus.publish(`${this.base}/to/${to}/state`, payload, { retain: true, remember: true });
    else void this.bus.publish(`${this.base}/to/${to}/evt`, payload);
  }

  forget(to: string): void {
    void this.bus.publish(`${this.base}/to/${to}/state`, '', { retain: true, remember: true });
  }

  onMessage(handler: (from: string, m: GuestMessage) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  onPresence(handler: (from: string, online: boolean) => void): () => void {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onConnection(handler: (i: ConnectionInfo) => void): () => void {
    this.connHandlers.add(handler);
    handler(this.info);
    return () => this.connHandlers.delete(handler);
  }

  close(): void {
    for (const off of this.offs) off();
    const last = release(`host:${this.roomId}`) && !this.info.superseded;
    this.bus.close(last ? { topic: hostOnlineTopic(this.roomId), payload: '0', retain: true } : undefined);
  }

  /** 读服务器上的房主存档；没有时返回 null。会等到真正连上服务器再判断 */
  async loadSave(): Promise<unknown> {
    const text = await this.bus.fetchRetained(`${this.base}/save`);
    await this.ready;
    await this.recvChain;
    if (!text) return null;
    try { return await unseal(this.hostKey, text); } catch { return null; }
  }

  saveRemote(value: unknown): void {
    if (this.info.superseded) return;
    void this.bus.publish(`${this.base}/save`, seal(this.hostKey, value), { retain: true, remember: true });
  }

  /** 声明"现在由这台设备当房主"；之后如果另一台设备也声明了，这里就停止生效 */
  claimHost(): void {
    this.myClaimAt = Math.max(Date.now(), this.seenClaimAt + 1);
    void this.bus.publish(`${this.base}/claim`, seal(this.hostKey, { inst: this.inst, at: this.myClaimAt }), { retain: true, remember: true });
  }

  // ---------- 内部 ----------

  private queue(fn: () => Promise<void>) {
    this.recvChain = this.recvChain.then(fn).catch(() => {});
  }

  private emit(patch: Partial<ConnectionInfo>) {
    const next = { ...this.info, ...patch };
    if (next.self === this.info.self && next.peer === this.info.peer && next.superseded === this.info.superseded) return;
    this.info = next;
    for (const h of this.connHandlers) h(next);
  }

  private async receive(text: string) {
    if (!text || this.info.superseded) return;
    let p: ToHost;
    try { p = await unseal(this.roomKey, text) as ToHost; } catch { return; } // 密码不对
    if (p?.v !== PROTOCOL_VERSION || typeof p.from !== 'string' || !p.pub) return;
    if (await clientIdOf(p.pub) !== p.from) return;
    let key = this.pairKeys.get(p.from);
    if (!key) {
      key = pairKey(this.ecdh.privateJwk, p.pub);
      this.pairKeys.set(p.from, key);
    }
    let msg: GuestMessage;
    try { msg = await unseal(await key, p.body) as GuestMessage; } catch { return; }
    for (const h of this.msgHandlers) h(p.from, msg);
  }

  private async receivePresence(topic: string, text: string) {
    const from = topic.slice(topic.lastIndexOf('/') + 1);
    if (!text) return;
    let p: { online?: boolean };
    try { p = await unseal(this.roomKey, text) as { online?: boolean }; } catch { return; }
    for (const h of this.presenceHandlers) h(from, p.online === true);
  }

  private async receiveClaim(text: string) {
    if (!text) return;
    let p: { inst: string; at: number };
    try { p = await unseal(this.hostKey, text) as { inst: string; at: number }; } catch { return; }
    this.seenClaimAt = Math.max(this.seenClaimAt, p.at);
    if (p.inst !== this.inst && this.myClaimAt > 0 && p.at > this.myClaimAt) {
      this.emit({ superseded: true });
      this.bus.close();
    }
  }
}

export interface GuestLinkOptions {
  roomId: string;
  roomKey: CryptoKey;
  hostPublic: JsonWebKey;
  ecdh: EcdhPair;
  bus?: PubSub;
  brokerUrl?: string;
}

/** 参与者一端 */
export class GuestLink implements GuestTransport {
  private readonly bus: PubSub;
  private readonly base: string;
  private readonly roomKey: CryptoKey;
  private readonly ecdh: EcdhPair;
  private readonly id: Promise<string>;
  private readonly key: Promise<CryptoKey>;
  private readonly offline: Promise<string>;
  private readonly msgHandlers = new Set<(m: HostMessage) => void>();
  private readonly connHandlers = new Set<(i: ConnectionInfo) => void>();
  private info: ConnectionInfo = { self: 'connecting', peer: 'unknown', superseded: false };
  private recvChain: Promise<unknown> = Promise.resolve();
  private readonly offs: (() => void)[] = [];
  private readonly roomId: string;

  constructor(opts: GuestLinkOptions) {
    this.roomId = opts.roomId;
    retain(`guest:${opts.roomId}`);
    this.base = roomBase(opts.roomId);
    this.roomKey = opts.roomKey;
    this.ecdh = opts.ecdh;
    this.id = clientIdOf(opts.ecdh.publicJwk);
    this.key = pairKey(opts.ecdh.privateJwk, opts.hostPublic);
    this.offline = seal(opts.roomKey, { online: false });
    const presence = this.id.then((id) => `${this.base}/presence/${id}`);
    this.bus = opts.bus ?? new Broker({
      ...(opts.brokerUrl ? { url: opts.brokerUrl } : {}),
      will: Promise.all([presence, this.offline]).then(([topic, payload]) => ({ topic, payload, retain: true })),
    });
    this.offs.push(this.bus.onStatus((s) => this.emit({ self: linkToSelf(s) })));
    const host = this.bus.subscribe(hostOnlineTopic(opts.roomId), (_, text) => {
      if (text === '1') this.emit({ peer: 'online' });
      else if (text === '0') this.emit({ peer: 'offline' });
    });
    this.offs.push(() => host.off());
    void this.id.then((id) => {
      const sub = this.bus.subscribe(`${this.base}/to/${id}/+`, (_, text) => this.queue(() => this.receive(text)));
      this.offs.push(() => sub.off());
      void this.bus.publish(`${this.base}/presence/${id}`, seal(this.roomKey, { online: true }), { retain: true, remember: true });
    });
  }

  send(msg: GuestMessage): void {
    const payload = (async () => {
      const packet: ToHost = {
        v: PROTOCOL_VERSION, from: await this.id, pub: publicPart(this.ecdh.publicJwk), body: await seal(await this.key, msg),
      };
      return seal(this.roomKey, packet);
    })();
    void this.bus.publish(`${this.base}/c2h`, payload);
  }

  onMessage(handler: (m: HostMessage) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  onConnection(handler: (i: ConnectionInfo) => void): () => void {
    this.connHandlers.add(handler);
    handler(this.info);
    return () => this.connHandlers.delete(handler);
  }

  close(): void {
    for (const off of this.offs) off();
    if (!release(`guest:${this.roomId}`)) {
      this.bus.close();
      return;
    }
    this.bus.close(Promise.all([this.id, this.offline]).then(([id, payload]) => ({
      topic: `${this.base}/presence/${id}`, payload, retain: true,
    })));
  }

  private queue(fn: () => Promise<void>) {
    this.recvChain = this.recvChain.then(fn).catch(() => {});
  }

  private emit(patch: Partial<ConnectionInfo>) {
    const next = { ...this.info, ...patch };
    if (next.self === this.info.self && next.peer === this.info.peer) return;
    this.info = next;
    for (const h of this.connHandlers) h(next);
  }

  private async receive(text: string) {
    if (!text) return; // 空内容 = 保留消息被清除
    let p: ToGuest;
    try { p = await unseal(await this.key, text) as ToGuest; } catch { return; }
    if (p?.v !== PROTOCOL_VERSION || !p.body) return;
    for (const h of this.msgHandlers) h(p.body);
  }
}
