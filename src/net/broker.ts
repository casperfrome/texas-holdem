// 和公共 MQTT 中转服务器的一条连接：断线自动重连、回到前台时检查连接是否还活着、
// 重新连上后补发保留消息、按频道（支持 + 通配符）分发收到的消息。
// 账号、房间列表、房间各自在这上面加自己的频道和加密。
import mqtt, { type MqttClient } from 'mqtt';

export type LinkStatus = 'connecting' | 'online' | 'offline';

/** 所有频道都在这个前缀下；改了消息格式就换版本号，新旧版本互不干扰 */
export const ROOT = 'thp/v2';

export const BROKERS = {
  emqx: { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  hivemq: { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
  mosquitto: { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
} as const;

export type BrokerId = keyof typeof BROKERS;
export const DEFAULT_BROKER: BrokerId = 'emqx';

export const isBrokerId = (x: unknown): x is BrokerId => typeof x === 'string' && x in BROKERS;

const BROKER_KEY = 'thp.v2.broker';

/**
 * 本机选用的中转服务器。账号和房间都存在中转服务器上，所以大家要用同一个；
 * 默认的连不上时可以换，邀请链接会带上房主用的那个。
 */
export function loadBrokerChoice(store: { get(k: string): string | null }): BrokerId {
  const id = store.get(BROKER_KEY);
  return isBrokerId(id) ? id : DEFAULT_BROKER;
}

export function saveBrokerChoice(store: { set(k: string, v: string): void }, id: BrokerId) {
  store.set(BROKER_KEY, id);
}

export interface Will {
  topic: string;
  payload: string;
  retain: boolean;
}

export interface BrokerOptions {
  url?: string;
  /** 掉线时服务器代发的消息（在线记录用） */
  will?: Will | Promise<Will>;
}

export type MessageHandler = (topic: string, text: string) => void;

export interface Subscription {
  /** 服务器确认订阅后完成 */
  ready: Promise<void>;
  off(): void;
}

/** 账号、房间列表、房间用到的发布/订阅能力；测试里用内存实现代替真的中转服务器 */
export interface PubSub {
  subscribe(filter: string, handler: MessageHandler): Subscription;
  publish(topic: string, payload: string | Promise<string>, opts?: { retain?: boolean; remember?: boolean }): Promise<void>;
  fetchRetained(topic: string, waitMs?: number): Promise<string | null>;
  forget(topic: string): void;
  onStatus(handler: (s: LinkStatus) => void): () => void;
  close(final?: Will | Promise<Will>): void;
}

const ECHO_TIMEOUT_MS = 1500;
const CONNECT_TIMEOUT_MS = 10_000;

/** MQTT 频道匹配：+ 匹配一级，# 匹配剩下所有 */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

interface Filter {
  handlers: Set<MessageHandler>;
  waiting: (() => void)[];
}

export class Broker implements PubSub {
  readonly inst = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  private readonly url: string;
  private readonly will: Will | Promise<Will> | undefined;
  private client: MqttClient | null = null;
  /** 第一个连接对象建好后完成；在这之前要发的消息先等着，不要丢 */
  private readonly created: Promise<void>;
  private markCreated!: () => void;
  private closed = false;
  private status: LinkStatus = 'connecting';
  private readonly statusHandlers = new Set<(s: LinkStatus) => void>();
  private readonly filters = new Map<string, Filter>();
  /** 每次（重新）连上时都要重发的保留消息：频道 → 内容 */
  private readonly remembered = new Map<string, string>();
  /** 保证发送按调用顺序进行（内容可能要先异步加密） */
  private chain: Promise<unknown> = Promise.resolve();
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(opts: BrokerOptions = {}) {
    this.url = opts.url ?? BROKERS[DEFAULT_BROKER].url;
    this.will = opts.will;
    this.created = new Promise((r) => { this.markCreated = r; });
    void this.open();
    this.watchPage();
  }

  get linkStatus(): LinkStatus { return this.status; }

  onStatus(handler: (s: LinkStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  subscribe(filter: string, handler: MessageHandler): Subscription {
    let f = this.filters.get(filter);
    if (!f) {
      f = { handlers: new Set(), waiting: [] };
      this.filters.set(filter, f);
    }
    f.handlers.add(handler);
    const entry = f;
    const ready = new Promise<void>((resolve) => entry.waiting.push(resolve));
    // 每次都发订阅请求：服务器会把保留消息再推一次，新加的处理函数也能收到
    if (this.client?.connected) this.sendSubscribe([filter]);
    return {
      ready,
      off: () => {
        entry.handlers.delete(handler);
        if (entry.handlers.size === 0 && this.filters.get(filter) === entry) {
          this.filters.delete(filter);
          if (this.client?.connected) this.client.unsubscribe(filter);
        }
      },
    };
  }

  /**
   * 发布。payload 可以是还在加密中的 Promise，发送顺序仍按调用顺序。
   * remember：断线重连后自动重发（保留消息用）；内容为空字符串表示清除保留消息。
   */
  publish(topic: string, payload: string | Promise<string>, opts: { retain?: boolean; remember?: boolean } = {}): Promise<void> {
    const done = this.chain.then(async () => {
      const text = await payload;
      await this.created;
      if (opts.remember) {
        if (text) this.remembered.set(topic, text);
        else this.remembered.delete(topic);
      }
      // 断线时 qos 1 消息会排队，连上后发出
      this.client?.publish(topic, text, { qos: 1, retain: opts.retain ?? false });
    });
    this.chain = done.catch(() => {});
    return done;
  }

  forget(topic: string) {
    this.remembered.delete(topic);
  }

  /**
   * 读一次某个频道的保留消息；没有时返回 null。
   * 一定要等到真正连上服务器、订阅确认后再判断，否则会把"还没收到"当成"没有"。
   */
  async fetchRetained(topic: string, waitMs = 2500): Promise<string | null> {
    let got: string | undefined;
    const sub = this.subscribe(topic, (_, text) => { if (got === undefined) got = text; });
    try {
      const timedOut = await Promise.race([
        sub.ready.then(() => false),
        delay(CONNECT_TIMEOUT_MS).then(() => true),
      ]);
      if (timedOut) throw new Error('连不上中转服务器。请检查网络，或在下面换一个中转服务器试试');
      // 保留消息在订阅确认后由服务器推送，收到就立刻返回
      const deadline = Date.now() + waitMs;
      while (got === undefined && Date.now() < deadline) await delay(50);
      return got || null;
    } finally {
      sub.off();
    }
  }

  /** 关闭连接；final 是关闭前最后发的一条消息（例如"我下线了"） */
  close(final?: Will | Promise<Will>) {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanup) fn();
    if (this.echoTimer) clearTimeout(this.echoTimer);
    const client = this.client;
    if (!client) return;
    void this.chain.then(async () => {
      const last = await final;
      if (last && client.connected) {
        client.publish(last.topic, last.payload, { qos: 1, retain: last.retain }, () => client.end());
      } else {
        client.end(true);
      }
    }).catch(() => client.end(true));
  }

  // ---------- 内部 ----------

  private setStatus(s: LinkStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private sendSubscribe(filters: string[]) {
    const client = this.client;
    if (!client || filters.length === 0) return;
    client.subscribe(filters, { qos: 1 }, (err) => {
      if (err) return;
      for (const name of filters) {
        const f = this.filters.get(name);
        if (f) for (const resolve of f.waiting.splice(0)) resolve();
      }
    });
  }

  private echoTopic() { return `${ROOT}/echo/${this.inst}`; }

  private async open() {
    if (this.closed) return;
    const will = await this.will;
    if (this.closed) return;
    const client = mqtt.connect(this.url, {
      clientId: `thp_${this.inst}_${Math.random().toString(36).slice(2, 8)}`,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 1000,
      connectTimeout: 8000,
      ...(will ? { will: { topic: will.topic, payload: will.payload, qos: 1 as const, retain: will.retain } } : {}),
    });
    this.client = client;
    this.markCreated();

    client.on('connect', () => {
      if (client !== this.client) return;
      this.setStatus('online');
      this.sendSubscribe([...this.filters.keys(), this.echoTopic()]);
      // 重新发出保留消息（可能在断线期间没发出去，或者被遗嘱覆盖了）
      for (const [topic, payload] of this.remembered) client.publish(topic, payload, { qos: 1, retain: true });
    });
    client.on('reconnect', () => { if (client === this.client) this.setStatus('connecting'); });
    client.on('offline', () => { if (client === this.client) this.setStatus('offline'); });
    client.on('close', () => { if (client === this.client && this.status === 'online') this.setStatus('offline'); });
    client.on('message', (topic, payload) => {
      if (client !== this.client) return;
      if (topic === this.echoTopic()) {
        if (this.echoTimer) { clearTimeout(this.echoTimer); this.echoTimer = null; }
        return;
      }
      const text = payload.toString();
      for (const [filter, f] of this.filters) {
        if (!topicMatches(filter, topic)) continue;
        for (const h of f.handlers) h(topic, text);
      }
    });
  }

  /** 回到前台或网络恢复时，确认连接还活着；不活着就立刻换一个新连接，不等浏览器自己发现 */
  private checkAlive() {
    if (this.closed) return;
    const client = this.client;
    if (!client || !client.connected) {
      this.replaceClient();
      return;
    }
    if (this.echoTimer) return;
    this.echoTimer = setTimeout(() => { this.echoTimer = null; this.replaceClient(); }, ECHO_TIMEOUT_MS);
    client.publish(this.echoTopic(), '1', { qos: 0 });
  }

  private replaceClient() {
    if (this.closed) return;
    const old = this.client;
    this.client = null;
    old?.removeAllListeners();
    old?.end(true);
    this.setStatus('connecting');
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

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
