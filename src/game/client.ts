// 界面只和 GameClient 打交道：房主端直接驱动规则引擎，玩家端把操作发给房主。
import {
  type Action, applyAction, type Config, createMatch, cryptoRandomInt, DEFAULT_CONFIG, IllegalActionError,
  type MatchState, type PlayerView, type RandomInt, type Seat, startHand, startNextMatch, viewFor,
} from '../engine';
import type { GuestMessage, GuestTransport, HostMessage, HostTransport, Role } from '../net/protocol';

export const HOST_SEAT: Seat = 0;
export const GUEST_SEAT: Seat = 1;

export interface ClientSnapshot {
  view: PlayerView | null;
  /** 最近一次操作被拒绝的原因 */
  error: string | null;
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

const SAVE_KEY = 'thp.host.match.v1';

interface SavedGame {
  state: MatchState;
  version: number;
  lastGuestSeq: number;
}

/** 下一手；本局已分出胜负时先重开一局 */
export function advance(state: MatchState, random: RandomInt): MatchState {
  if (state.hand && !state.hand.result) throw new IllegalActionError('这手牌还没结束');
  return startHand(state.matchWinner !== null ? startNextMatch(state) : state, random);
}

abstract class BaseClient {
  protected snapshot: ClientSnapshot = { view: null, error: null };
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
}

/** 房主：持有完整状态，处理双方的操作，把各自能看的画面发出去 */
export class HostController extends BaseClient implements GameClient {
  readonly role = 'host' as const;
  private state: MatchState;
  private version: number;
  private lastGuestSeq: number;
  private readonly store: KeyValueStore;
  private readonly random: RandomInt;
  private readonly unsubscribe: () => void;

  constructor(private readonly transport: HostTransport, options: HostOptions = {}) {
    super();
    this.store = options.store ?? browserStore;
    this.random = options.random ?? cryptoRandomInt;
    const saved = loadGame(this.store);
    if (saved) {
      ({ state: this.state, version: this.version, lastGuestSeq: this.lastGuestSeq } = saved);
    } else {
      this.state = createMatch(options.config ?? DEFAULT_CONFIG, this.random(2) as Seat);
      this.version = 0;
      this.lastGuestSeq = 0;
    }
    if (!this.state.hand) this.state = startHand(this.state, this.random);
    this.unsubscribe = transport.onMessage((msg) => this.handleGuest(msg));
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
    this.state = startHand(createMatch(this.state.config, this.random(2) as Seat), this.random);
    this.version++;
    this.publish();
    this.update({ error: null });
  }

  dispose(): void {
    this.unsubscribe();
    this.transport.close();
  }

  private handleGuest(msg: GuestMessage) {
    if (msg.t === 'hello') {
      this.sendGuestState();
      return;
    }
    // 重复或过期的消息（例如断线重发）直接忽略
    if (msg.seq <= this.lastGuestSeq) return;
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
    const msg: HostMessage = { t: 'state', version: this.version, view: viewFor(this.state, GUEST_SEAT) };
    this.transport.send(msg);
  }

  private save() {
    const saved: SavedGame = { state: this.state, version: this.version, lastGuestSeq: this.lastGuestSeq };
    this.store.set(SAVE_KEY, JSON.stringify(saved));
  }
}

function loadGame(store: KeyValueStore): SavedGame | null {
  const raw = store.get(SAVE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as SavedGame;
    if (!saved?.state?.config || !Array.isArray(saved.state.stacks) || typeof saved.version !== 'number') return null;
    return saved;
  } catch {
    return null;
  }
}

/** 玩家：只显示房主发来的画面，操作发给房主 */
export class GuestClient extends BaseClient implements GameClient {
  readonly role = 'guest' as const;
  private seq = 0;
  private readonly unsubscribe: () => void;
  private readonly helloTimer: ReturnType<typeof setInterval>;

  constructor(private readonly transport: GuestTransport) {
    super();
    this.unsubscribe = transport.onMessage((msg) => this.handleHost(msg));
    transport.send({ t: 'hello' });
    // 房主还没打开时，定时再打招呼，直到收到画面
    this.helloTimer = setInterval(() => {
      if (!this.snapshot.view) transport.send({ t: 'hello' });
    }, 1500);
  }

  act(action: Action): void {
    this.transport.send({ t: 'action', seq: this.nextSeq(), action });
  }

  next(): void {
    this.transport.send({ t: 'next', seq: this.nextSeq() });
  }

  dispose(): void {
    clearInterval(this.helloTimer);
    this.unsubscribe();
    this.transport.close();
  }

  /** 用时间戳做序号：页面刷新后序号仍然递增，房主不会误判为重复消息 */
  private nextSeq(): number {
    this.seq = Math.max(Date.now(), this.seq + 1);
    return this.seq;
  }

  private handleHost(msg: HostMessage) {
    if (msg.t === 'state') this.update({ view: msg.view });
    else this.update({ error: msg.message });
  }
}
