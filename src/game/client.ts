// 界面只和 GameClient 打交道：房主端直接驱动规则引擎，玩家端把操作发给房主。
import {
  type Action, applyAction, type Config, createMatch, cryptoRandomInt, DEFAULT_CONFIG, IllegalActionError,
  type MatchState, type PlayerView, type RandomInt, type Seat, startHand, startNextMatch, viewFor,
} from '../engine';
import {
  type ConnectionInfo, type GuestMessage, type GuestTransport, type HostMessage, type HostTransport,
  LOCAL_CONNECTION, type Role,
} from '../net/protocol';

export const HOST_SEAT: Seat = 0;
export const GUEST_SEAT: Seat = 1;

/** 玩家的操作没得到房主确认时，每隔这么久重发一次 */
export const RESEND_MS = 2000;

export interface ClientSnapshot {
  view: PlayerView | null;
  /** 最近一次操作被拒绝的原因 */
  error: string | null;
  connection: ConnectionInfo;
  /** 玩家：操作已发出，还没得到房主确认 */
  pending: boolean;
}

export interface GameClient {
  readonly role: Role;
  getSnapshot(): ClientSnapshot;
  subscribe(listener: () => void): () => void;
  act(action: Action): void;
  /** 下一手 / 再来一局 */
  next(): void;
  dismissError(): void;
  dispose(): void;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStore: KeyValueStore = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 隐私模式等情况下存不了，只是不能断点续玩 */ } },
};

const SAVE_KEY = 'thp.host.match.v2';

export interface SavedGame {
  state: MatchState;
  /** 对局编号：重新开始时换一个 */
  epoch: string;
  version: number;
  lastGuestSeq: number;
  savedAt: number;
}

/** 两份存档取较新的：同一对局比版本号，不同对局比保存时间 */
export function pickLatest(a: SavedGame | null, b: SavedGame | null): SavedGame | null {
  if (!a || !b) return a ?? b;
  if (a.epoch === b.epoch) return a.version >= b.version ? a : b;
  return a.savedAt >= b.savedAt ? a : b;
}

export function isSavedGame(x: unknown): x is SavedGame {
  const s = x as SavedGame;
  return !!s && typeof s === 'object' && typeof s.epoch === 'string' && typeof s.version === 'number'
    && typeof s.lastGuestSeq === 'number' && typeof s.savedAt === 'number'
    && !!s.state?.config && Array.isArray(s.state.stacks);
}

function loadLocal(store: KeyValueStore): SavedGame | null {
  const raw = store.get(SAVE_KEY);
  if (!raw) return null;
  try {
    const saved: unknown = JSON.parse(raw);
    return isSavedGame(saved) ? saved : null;
  } catch {
    return null;
  }
}

const newEpoch = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

/** 下一手；本局已分出胜负时先重开一局 */
export function advance(state: MatchState, random: RandomInt): MatchState {
  if (state.hand && !state.hand.result) throw new IllegalActionError('这手牌还没结束');
  return startHand(state.matchWinner !== null ? startNextMatch(state) : state, random);
}

abstract class BaseClient {
  protected snapshot: ClientSnapshot = { view: null, error: null, connection: LOCAL_CONNECTION, pending: false };
  private listeners = new Set<() => void>();

  getSnapshot = (): ClientSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dismissError(): void {
    if (this.snapshot.error) this.update({ error: null });
  }

  protected update(patch: Partial<ClientSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}

export interface HostOptions {
  store?: KeyValueStore;
  random?: RandomInt;
  config?: Config;
  /** 服务器上的存档（换设备时用）；和本机存档取较新的 */
  remoteSave?: SavedGame | null;
  /** 每次变化后把存档发到服务器 */
  saveRemote?: (saved: SavedGame) => void;
}

/** 房主：持有完整状态，处理双方的操作，把各自能看的画面发出去 */
export class HostController extends BaseClient implements GameClient {
  readonly role = 'host' as const;
  private state: MatchState;
  private epoch: string;
  private version: number;
  private lastGuestSeq: number;
  private readonly store: KeyValueStore;
  private readonly random: RandomInt;
  private readonly saveRemote: ((saved: SavedGame) => void) | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly transport: HostTransport, options: HostOptions = {}) {
    super();
    this.store = options.store ?? browserStore;
    this.random = options.random ?? cryptoRandomInt;
    this.saveRemote = options.saveRemote;
    const saved = pickLatest(loadLocal(this.store), options.remoteSave ?? null);
    if (saved) {
      ({ state: this.state, epoch: this.epoch, version: this.version, lastGuestSeq: this.lastGuestSeq } = saved);
    } else {
      this.state = createMatch(options.config ?? DEFAULT_CONFIG, this.random(2) as Seat);
      this.epoch = newEpoch();
      this.version = 0;
      this.lastGuestSeq = 0;
    }
    if (!this.state.hand) this.state = startHand(this.state, this.random);
    this.unsubscribe.push(transport.onMessage((msg) => this.handleGuest(msg)));
    if (transport.onConnection) {
      this.unsubscribe.push(transport.onConnection((connection) => this.update({ connection })));
    }
    this.publish();
  }

  /** 测试和调试用：当前完整状态 */
  get matchState(): MatchState { return this.state; }

  act(action: Action): void {
    const error = this.change((s) => applyAction(s, HOST_SEAT, action));
    this.update({ error });
  }

  next(): void {
    const error = this.change((s) => advance(s, this.random));
    this.update({ error });
  }

  /** 清空当前对局，双方筹码和比分从头开始 */
  reset(): void {
    if (this.snapshot.connection.superseded) return;
    this.state = startHand(createMatch(this.state.config, this.random(2) as Seat), this.random);
    this.epoch = newEpoch();
    this.version = 0;
    this.publish();
    this.update({ error: null });
  }

  dispose(): void {
    for (const u of this.unsubscribe) u();
    this.transport.close();
  }

  private handleGuest(msg: GuestMessage) {
    if (this.snapshot.connection.superseded) return;
    if (msg.t === 'hello') {
      this.sendGuestState();
      return;
    }
    // 重复或过期的消息（例如断线重发）：再发一次画面，让玩家知道已经处理过
    if (msg.seq <= this.lastGuestSeq) {
      this.sendGuestState();
      return;
    }
    this.lastGuestSeq = msg.seq;
    const error = msg.t === 'action'
      ? this.change((s) => applyAction(s, GUEST_SEAT, msg.action))
      : this.change((s) => advance(s, this.random));
    if (error) {
      this.save();
      this.transport.send({ t: 'reject', seq: msg.seq, message: error });
      this.sendGuestState();
    }
  }

  /** 应用一次变化；非法操作返回错误信息，状态不变 */
  private change(fn: (s: MatchState) => MatchState): string | null {
    if (this.snapshot.connection.superseded) return '房主已在另一台设备上打开';
    try {
      this.state = fn(this.state);
    } catch (e) {
      if (e instanceof IllegalActionError) return e.message;
      throw e;
    }
    this.version++;
    this.publish();
    return null;
  }

  private publish() {
    this.save();
    this.update({ view: viewFor(this.state, HOST_SEAT) });
    this.sendGuestState();
  }

  private sendGuestState() {
    const msg: HostMessage = {
      t: 'state', epoch: this.epoch, version: this.version, ackSeq: this.lastGuestSeq, view: viewFor(this.state, GUEST_SEAT),
    };
    this.transport.send(msg);
  }

  private save() {
    const saved: SavedGame = {
      state: this.state, epoch: this.epoch, version: this.version, lastGuestSeq: this.lastGuestSeq, savedAt: Date.now(),
    };
    this.store.set(SAVE_KEY, JSON.stringify(saved));
    this.saveRemote?.(saved);
  }
}

type PendingMessage = Extract<GuestMessage, { seq: number }>;

/** 玩家：只显示房主发来的画面，操作发给房主，没得到确认就一直重发 */
export class GuestClient extends BaseClient implements GameClient {
  readonly role = 'guest' as const;
  private seq = 0;
  private epoch: string | null = null;
  private version = -1;
  private pendingMsg: PendingMessage | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly transport: GuestTransport) {
    super();
    this.unsubscribe.push(transport.onMessage((msg) => this.handleHost(msg)));
    if (transport.onConnection) {
      this.unsubscribe.push(transport.onConnection((connection) => {
        const cameOnline = connection.self === 'online' && this.snapshot.connection.self !== 'online';
        const hostBack = connection.peer === 'online' && this.snapshot.connection.peer !== 'online';
        this.update({ connection });
        // 刚连上服务器或房主刚上线：打个招呼拿最新画面，并重发没确认的操作
        if (cameOnline || hostBack) this.flush();
      }));
    }
    transport.send({ t: 'hello' });
    this.timer = setInterval(() => {
      if (!this.snapshot.view || this.pendingMsg) this.flush();
    }, RESEND_MS);
  }

  act(action: Action): void {
    if (this.pendingMsg) return; // 上一个操作还没确认
    this.sendPending({ t: 'action', seq: this.nextSeq(), action });
  }

  next(): void {
    if (this.pendingMsg) return;
    this.sendPending({ t: 'next', seq: this.nextSeq() });
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const u of this.unsubscribe) u();
    this.transport.close();
  }

  private sendPending(msg: PendingMessage) {
    this.pendingMsg = msg;
    this.update({ pending: true, error: null });
    this.transport.send(msg);
  }

  private flush() {
    if (this.pendingMsg) this.transport.send(this.pendingMsg);
    else this.transport.send({ t: 'hello' });
  }

  /** 用时间戳做序号：页面刷新后序号仍然递增，房主不会误判为重复消息 */
  private nextSeq(): number {
    this.seq = Math.max(Date.now(), this.seq + 1);
    return this.seq;
  }

  private handleHost(msg: HostMessage) {
    if (msg.t === 'reject') {
      if (this.pendingMsg?.seq === msg.seq) {
        this.pendingMsg = null;
        this.update({ pending: false, error: msg.message });
      }
      return;
    }
    // 旧画面（例如服务器上保留的旧消息晚到）不覆盖新画面；房主重新开始时对局编号会变
    if (msg.epoch === this.epoch && msg.version < this.version) return;
    this.epoch = msg.epoch;
    this.version = msg.version;
    // 换了设备、时钟偏慢时，序号也要比房主处理过的大，否则会被当成重复消息
    this.seq = Math.max(this.seq, msg.ackSeq);
    const acked = this.pendingMsg !== null && msg.ackSeq >= this.pendingMsg.seq;
    if (acked) this.pendingMsg = null;
    this.update({ view: msg.view, pending: this.pendingMsg !== null });
  }
}
