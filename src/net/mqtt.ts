// 通过公共 MQTT 服务器中转的房间连接。所有内容都在本机加密后再发出去。
//
// 频道（都在 thp/<topicId>/ 下）：
//   state           房主 → 玩家：最新画面（保留消息，玩家一连上就能拿到）
//   h2g             房主 → 玩家：拒绝等一次性消息
//   g2h             玩家 → 房主：操作
//   presence/<角色>  在线记录（保留消息 + 遗嘱：掉线时服务器自动标记离线）
//   save            房主存档，用房主密钥加密，玩家解不开（保留消息）
//   claim           房主占用记录：房主在另一台设备打开时，旧设备停止生效（保留消息）
//   echo/<实例>      自己发给自己，检查连接是否还活着
import mqtt, { type MqttClient } from 'mqtt';
import { seal, unseal, type RoomKeys } from './crypto';
import {
  type ConnectionInfo, type GuestMessage, type GuestTransport, type HostMessage, type HostTransport, PROTOCOL_VERSION,
  type Role, type Transport,
} from './protocol';

type Body = GuestMessage | HostMessage;

interface Packet {
  v: typeof PROTOCOL_VERSION;
  from: Role;
  inst: string;
  at: number;
  kind: 'msg' | 'presence' | 'claim' | 'echo';
  body?: Body;
  online?: boolean;
}

export interface RoomConnectionOptions {
  role: Role;
  keys: RoomKeys;
  brokerUrl: string;
}

const ECHO_TIMEOUT_MS = 1500;

export class RoomConnection implements Transport<Body, Body> {
  readonly role: Role;
  readonly inst = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  private readonly keys: RoomKeys;
  private readonly brokerUrl: string;
  private readonly base: string;
  private readonly peerRole: Role;

  private client: MqttClient | null = null;
  private closed = false;
  private info: ConnectionInfo = { self: 'connecting', peer: 'unknown', superseded: false };
  private readonly msgHandlers = new Set<(m: Body) => void>();
  private readonly connHandlers = new Set<(i: ConnectionInfo) => void>();

  /** 保证加密和发送按顺序进行 */
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<unknown> = Promise.resolve();
  /** 需要在每次（重新）连上时重发的保留消息：频道 → 密文 */
  private readonly retained = new Map<string, string>();

  /** 启动时收到的保留消息 */
  private retainedSave: unknown = undefined;
  private seenClaimAt = 0;
  private myClaimAt = 0;
  private readonly subscribed: Promise<void>;
  private markSubscribed!: () => void;

  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(opts: RoomConnectionOptions) {
    this.role = opts.role;
    this.peerRole = opts.role === 'host' ? 'guest' : 'host';
    this.keys = opts.keys;
    this.brokerUrl = opts.brokerUrl;
    this.base = `thp/${opts.keys.topicId}`;
    this.subscribed = new Promise((r) => { this.markSubscribed = r; });
    void this.open();
    this.watchPage();
  }

  // ---------- Transport ----------

  send(body: Body): void {
    if (this.info.superseded) return;
    if (this.role === 'host') {
      const msg = body as HostMessage;
      if (msg.t === 'state') this.publishPacket(this.topic('state'), { kind: 'msg', body: msg }, true);
      else this.publishPacket(this.topic('h2g'), { kind: 'msg', body: msg }, false);
    } else {
      this.publishPacket(this.topic('g2h'), { kind: 'msg', body }, false);
    }
  }

  onMessage(handler: (m: Body) => void): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  onConnection(handler: (i: ConnectionInfo) => void): () => void {
    this.connHandlers.add(handler);
    handler(this.info);
    return () => this.connHandlers.delete(handler);
  }

  get connection(): ConnectionInfo { return this.info; }

  /** 按角色收窄消息类型：房主只会收到玩家的消息，反之亦然（频道按角色区分） */
  asHost(): HostTransport {
    if (this.role !== 'host') throw new Error('不是房主连接');
    return this as unknown as HostTransport;
  }

  asGuest(): GuestTransport {
    if (this.role !== 'guest') throw new Error('不是玩家连接');
    return this as unknown as GuestTransport;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanup) fn();
    if (this.echoTimer) clearTimeout(this.echoTimer);
    const client = this.client;
    if (!client) return;
    // 主动离开：先写离线记录再断开
    void this.sealPacket({ kind: 'presence', online: false }).then((payload) => {
      if (client.connected) client.publish(this.topic(`presence/${this.role}`), payload, { qos: 1, retain: true }, () => client.end());
      else client.end(true);
    });
  }

  // ---------- 房主专用 ----------

  /**
   * 等待服务器上的房主存档；服务器上没有存档时返回 null。
   * 一定要等到真正连上服务器再判断，否则会用旧存档或新对局覆盖服务器上的进度。
   */
  async loadSave(waitAfterSubscribeMs = 2000): Promise<unknown> {
    await this.subscribed;
    // 保留消息在订阅确认后由服务器推送，收到就立刻返回
    const deadline = Date.now() + waitAfterSubscribeMs;
    while (this.retainedSave === undefined && Date.now() < deadline) await delay(50);
    await this.recvChain;
    return this.retainedSave ?? null;
  }

  /** 用房主密钥加密后保存到服务器 */
  saveRemote(value: unknown): void {
    const key = this.keys.hostKey;
    if (!key || this.info.superseded) return;
    const topic = this.topic('save');
    this.sendChain = this.sendChain.then(async () => {
      const payload = await seal(key, value);
      this.retained.set(topic, payload);
      this.client?.publish(topic, payload, { qos: 1, retain: true });
    }).catch(() => {});
  }

  /** 声明"现在由这台设备当房主"；之后如果另一台设备也声明了，这里就停止生效 */
  claimHost(): void {
    this.myClaimAt = Math.max(Date.now(), this.seenClaimAt + 1);
    this.publishPacket(this.topic('claim'), { kind: 'claim', at: this.myClaimAt }, true);
  }

  // ---------- 内部 ----------

  private topic(name: string) { return `${this.base}/${name}`; }

  private emit(patch: Partial<ConnectionInfo>) {
    const next = { ...this.info, ...patch };
    if (next.self === this.info.self && next.peer === this.info.peer && next.superseded === this.info.superseded) return;
    this.info = next;
    for (const h of this.connHandlers) h(next);
  }

  private sealPacket(p: Omit<Packet, 'v' | 'from' | 'inst' | 'at'> & { at?: number }): Promise<string> {
    const packet: Packet = { v: PROTOCOL_VERSION, from: this.role, inst: this.inst, at: Date.now(), ...p };
    return seal(this.keys.roomKey, packet);
  }

  private publishPacket(topic: string, p: Omit<Packet, 'v' | 'from' | 'inst' | 'at'> & { at?: number }, retain: boolean) {
    this.sendChain = this.sendChain.then(async () => {
      const payload = await this.sealPacket(p);
      if (retain) this.retained.set(topic, payload);
      // 断线时 qos 1 消息会排队，连上后发出
      this.client?.publish(topic, payload, { qos: 1, retain });
    }).catch(() => {});
  }

  private async open() {
    if (this.closed) return;
    const will = await this.sealPacket({ kind: 'presence', online: false });
    if (this.closed) return;
    const client = mqtt.connect(this.brokerUrl, {
      clientId: `thp_${this.inst}_${Math.random().toString(36).slice(2, 8)}`,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 1000,
      connectTimeout: 8000,
      will: { topic: this.topic(`presence/${this.role}`), payload: will, qos: 1, retain: true },
    });
    this.client = client;

    client.on('connect', () => {
      if (client !== this.client) return;
      this.emit({ self: 'online' });
      const topics = this.role === 'host'
        ? ['g2h', 'save', 'claim', 'presence/guest']
        : ['state', 'h2g', 'presence/host'];
      client.subscribe([...topics.map((t) => this.topic(t)), this.topic(`echo/${this.inst}`)], { qos: 1 }, () => this.markSubscribed());
      this.publishPacket(this.topic(`presence/${this.role}`), { kind: 'presence', online: true }, true);
      // 重新发出保留消息（可能在断线期间没发出去）
      for (const [topic, payload] of this.retained) {
        if (!topic.endsWith(`presence/${this.role}`)) client.publish(topic, payload, { qos: 1, retain: true });
      }
    });
    client.on('reconnect', () => { if (client === this.client) this.emit({ self: 'connecting' }); });
    client.on('offline', () => { if (client === this.client) this.emit({ self: 'offline' }); });
    client.on('close', () => { if (client === this.client && this.info.self === 'online') this.emit({ self: 'offline' }); });
    client.on('message', (topic, payload) => {
      if (client !== this.client) return;
      const text = payload.toString();
      this.recvChain = this.recvChain.then(() => this.receive(topic, text)).catch(() => {});
    });
  }

  private async receive(topic: string, text: string) {
    if (!text) return; // 空内容 = 保留消息被清除
    if (topic === this.topic('save')) {
      if (!this.keys.hostKey) return;
      try { this.retainedSave = await unseal(this.keys.hostKey, text); } catch { /* 不是这个房主的存档 */ }
      return;
    }
    let p: Packet;
    try {
      p = await unseal(this.keys.roomKey, text) as Packet;
    } catch {
      return; // 解不开：不是这个房间的消息
    }
    if (p?.v !== PROTOCOL_VERSION) return;

    if (p.kind === 'echo') {
      if (p.inst === this.inst && this.echoTimer) { clearTimeout(this.echoTimer); this.echoTimer = null; }
      return;
    }
    if (p.kind === 'claim') {
      this.seenClaimAt = Math.max(this.seenClaimAt, p.at);
      if (p.inst !== this.inst && this.myClaimAt > 0 && p.at > this.myClaimAt) {
        this.emit({ superseded: true });
        this.client?.end(true);
      }
      return;
    }
    if (p.inst === this.inst || p.from === this.role) return;
    if (p.kind === 'presence') {
      this.emit({ peer: p.online ? 'online' : 'offline' });
      return;
    }
    if (p.kind === 'msg' && p.body) {
      if (this.info.peer !== 'online' && p.from === this.peerRole) this.emit({ peer: 'online' });
      for (const h of this.msgHandlers) h(p.body);
    }
  }

  /** 回到前台或网络恢复时，确认连接还活着；不活着就立刻换一个新连接，不等浏览器自己发现 */
  private checkAlive() {
    if (this.closed || this.info.superseded) return;
    const client = this.client;
    if (!client || !client.connected) {
      this.replaceClient();
      return;
    }
    if (this.echoTimer) return;
    this.echoTimer = setTimeout(() => { this.echoTimer = null; this.replaceClient(); }, ECHO_TIMEOUT_MS);
    this.publishPacket(this.topic(`echo/${this.inst}`), { kind: 'echo' }, false);
  }

  private replaceClient() {
    if (this.closed || this.info.superseded) return;
    const old = this.client;
    this.client = null;
    old?.removeAllListeners();
    old?.end(true);
    this.emit({ self: 'connecting' });
    void this.open();
  }

  private watchPage() {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.hidden) { this.hiddenAt = Date.now(); return; }
      if (this.hiddenAt !== null && Date.now() - this.hiddenAt > 1000) this.checkAlive();
      this.hiddenAt = null;
    };
    const onOnline = () => this.checkAlive();
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) this.checkAlive(); };
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('online', onOnline);
    addEventListener('pageshow', onPageShow);
    this.cleanup.push(
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => removeEventListener('online', onOnline),
      () => removeEventListener('pageshow', onPageShow),
    );
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
