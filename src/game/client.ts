// 界面只和 GameClient 打交道：房主端直接驱动规则引擎，对手和观众把操作发给房主。
//
// 房主坐 0 号位；1 号位留给第一个选择坐下的人，其余进房的人坐观战席。
// 房主也是唯一的计时器：轮到谁就给谁 15 秒，超时能过牌就过牌，否则弃牌。
import {
  type Action, applyAction, type Config, createMatch, cryptoRandomInt, DEFAULT_CONFIG, IllegalActionError,
  legalActions, type MatchState, type PlayerView, type RandomInt, type Seat, startHand, startNextMatch, viewFor,
} from '../engine';
import {
  type ConnectionInfo, type GuestMessage, type GuestTransport, type HostMessage, type HostTransport, LOCAL_CONNECTION,
  type Role, type RoomInfo, type SeatedMessage, type Want,
} from '../net/protocol';

export const HOST_SEAT: Seat = 0;
export const GUEST_SEAT: Seat = 1;

/** 参与者的操作没得到房主确认时，每隔这么久重发一次 */
export const RESEND_MS = 2000;
/** 每次行动的限时 */
export const TURN_MS = 15_000;
/** 给网络延迟留的余量：界面上显示 15 秒，房主多等 1 秒才代为操作 */
export const TIMEOUT_GRACE_MS = 1000;

export interface Turn {
  seat: Seat;
  /** 本机时钟下的截止时刻 */
  deadline: number;
}

export interface ClientSnapshot {
  view: PlayerView | null;
  room: RoomInfo | null;
  turn: Turn | null;
  /** 对局编号，和 view.matchNumber 一起唯一确定一局 */
  epoch: string | null;
  /** 最近一次操作被拒绝的原因 */
  error: string | null;
  connection: ConnectionInfo;
  /** 参与者：操作已发出，还没得到房主确认 */
  pending: boolean;
  /** 最近一次被催 */
  nudged: { from: string; at: number } | null;
  /** 这一轮已经催过对手了（值为轮次编号） */
  nudgeUsed: string | null;
  /** 被房主拒之门外的原因（例如观战席已满） */
  denied: string | null;
}

export interface GameClient {
  readonly role: Role;
  getSnapshot(): ClientSnapshot;
  subscribe(listener: () => void): () => void;
  act(action: Action): void;
  /** 下一手 / 再来一局 */
  next(): void;
  sit(): void;
  stand(): void;
  /** 催对手 */
  nudge(): void;
  dismissError(): void;
  /** 主动离开房间（让出座位 / 观战席），然后释放连接 */
  leave(): void;
  dispose(): void;
}

/** 轮次编号：同一手牌里每多一条记录就是新的一轮行动 */
export function turnKey(view: PlayerView | null): string | null {
  const hand = view?.hand;
  if (!hand || hand.result || hand.toAct === null) return null;
  return `${hand.number}:${hand.log.length}`;
}

/** 现在能不能催对手：自己坐着、轮到对手、这一轮还没催过 */
export function canNudge(s: ClientSnapshot): boolean {
  if (!s.view || !s.room || s.room.you === 'watcher' || s.room.seats.some((name) => name === null)) return false;
  const key = turnKey(s.view);
  return key !== null && s.view.hand!.toAct !== s.view.you && s.nudgeUsed !== key;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const browserStore: KeyValueStore = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 隐私模式等情况下存不了，只是不能断点续玩 */ } },
};

export interface Opponent {
  name: string;
  /** 座位凭证：同一账号换设备回来时据此认回座位 */
  token: string;
  lastSeq: number;
}

export interface SavedGame {
  state: MatchState;
  /** 对局编号：重新开始或换了对手时换一个 */
  epoch: string;
  version: number;
  /** 1 号位上的人；null 表示空位 */
  opponent: Opponent | null;
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
    && typeof s.savedAt === 'number' && 'opponent' in s
    && (s.opponent === null || (typeof s.opponent?.token === 'string' && typeof s.opponent.name === 'string'))
    && !!s.state?.config && Array.isArray(s.state.stacks);
}

function loadLocal(store: KeyValueStore, key: string): SavedGame | null {
  const raw = store.get(key);
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

const EMPTY: ClientSnapshot = {
  view: null, room: null, turn: null, epoch: null, error: null, connection: LOCAL_CONNECTION, pending: false,
  nudged: null, nudgeUsed: null, denied: null,
};

abstract class BaseClient {
  protected snapshot: ClientSnapshot = EMPTY;
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

/** 房间列表上要显示的变化 */
export interface RoomSummary {
  seats: [string, string | null];
  watchers: number;
}

export interface HostOptions {
  /** 房主自己的名字 */
  name?: string;
  roomName?: string;
  /** 观战席数量，0 = 不开放观战 */
  maxWatchers?: number;
  store?: KeyValueStore;
  /** 本机存档的键，每个房间一个 */
  saveKey?: string;
  random?: RandomInt;
  config?: Config;
  /** 服务器上的存档（换设备时用）；和本机存档取较新的 */
  remoteSave?: SavedGame | null;
  /** 每次变化后把存档发到服务器 */
  saveRemote?: (saved: SavedGame) => void;
  /** 座位或观众变化时调用，用来更新房间列表 */
  onRoomChange?: (summary: RoomSummary) => void;
}

interface Member {
  /** 参与者编号；房主刷新后、对手还没重新打招呼前为 null */
  id: string | null;
  name: string;
  token: string;
  lastSeq: number;
  online: boolean;
}

/** 房主：持有完整状态，处理所有人的操作，把各自能看的画面发出去 */
export class HostController extends BaseClient implements GameClient {
  readonly role = 'host' as const;
  private state: MatchState;
  private epoch: string;
  private version: number;
  private opponent: Member | null;
  private readonly watchers = new Map<string, Member>();
  private readonly name: string;
  private readonly roomName: string;
  private readonly maxWatchers: number;
  private readonly store: KeyValueStore;
  private readonly saveKey: string;
  private readonly random: RandomInt;
  private readonly saveRemote: ((saved: SavedGame) => void) | undefined;
  private readonly onRoomChange: ((summary: RoomSummary) => void) | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  private lastSummary = '';

  private currentTurn: string | null = null;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 对手这一轮已经催过房主了 */
  private opponentNudged: string | null = null;

  constructor(private readonly transport: HostTransport, options: HostOptions = {}) {
    super();
    this.name = options.name ?? '房主';
    this.roomName = options.roomName ?? '';
    this.maxWatchers = options.maxWatchers ?? 0;
    this.store = options.store ?? browserStore;
    this.saveKey = options.saveKey ?? 'thp.host.v3';
    this.random = options.random ?? cryptoRandomInt;
    this.saveRemote = options.saveRemote;
    this.onRoomChange = options.onRoomChange;
    const saved = pickLatest(loadLocal(this.store, this.saveKey), options.remoteSave ?? null);
    if (saved) {
      ({ state: this.state, epoch: this.epoch, version: this.version } = saved);
      this.opponent = saved.opponent ? { ...saved.opponent, id: null, online: false } : null;
    } else {
      this.state = createMatch(options.config ?? DEFAULT_CONFIG, this.random(2) as Seat);
      this.epoch = newEpoch();
      this.version = 0;
      this.opponent = null;
    }
    if (this.opponent && !this.state.hand) this.state = startHand(this.state, this.random);
    if (!this.opponent && this.state.hand) this.newMatch();
    this.unsubscribe.push(transport.onMessage((from, msg) => this.handle(from, msg)));
    if (transport.onPresence) this.unsubscribe.push(transport.onPresence((from, online) => this.presence(from, online)));
    if (transport.onConnection) {
      this.unsubscribe.push(transport.onConnection((c) => {
        this.update({ connection: { ...c, peer: this.peerStatus() } });
        if (c.superseded) this.clearTimer();
      }));
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
    const error = this.opponent ? this.change((s) => advance(s, this.random)) : '等对手坐下后才能开始';
    this.update({ error });
  }

  /** 房主一直坐在 0 号位 */
  sit(): void {}
  stand(): void {}

  nudge(): void {
    if (!canNudge(this.snapshot) || !this.opponent?.id) return;
    this.transport.send(this.opponent.id, { t: 'nudge', from: this.name });
    this.update({ nudgeUsed: turnKey(this.snapshot.view) });
  }

  /** 清空当前对局，双方筹码和比分从头开始 */
  reset(): void {
    if (this.snapshot.connection.superseded) return;
    this.newMatch();
    this.publish();
    this.update({ error: null });
  }

  leave(): void { this.dispose(); }

  dispose(): void {
    this.clearTimer();
    for (const u of this.unsubscribe) u();
    this.transport.close();
  }

  private newMatch() {
    const fresh = createMatch(this.state.config, this.random(2) as Seat);
    this.state = this.opponent ? startHand(fresh, this.random) : fresh;
    this.epoch = newEpoch();
    this.version = 0;
  }

  private peerStatus(): ConnectionInfo['peer'] {
    if (!this.opponent) return 'unknown';
    return this.opponent.online ? 'online' : 'offline';
  }

  private memberOf(id: string): Member | null {
    if (this.opponent?.id === id) return this.opponent;
    return this.watchers.get(id) ?? null;
  }

  private handle(from: string, msg: GuestMessage) {
    if (this.snapshot.connection.superseded) return;
    switch (msg.t) {
      case 'hello': return this.hello(from, msg.name, msg.token, msg.want);
      case 'nudge': return this.receiveNudge(from);
      case 'bye': return this.bye(from);
      default: return this.seated(from, msg);
    }
  }

  private hello(from: string, name: string, token: string, want: Want) {
    const member: Member = { id: from, name, token, lastSeq: 0, online: true };
    if (this.opponent && this.opponent.token === token) {
      // 认回座位（可能换了设备）
      this.opponent.id = from;
      this.opponent.name = name;
      this.opponent.online = true;
      this.watchers.delete(from);
    } else if (want === 'play' && !this.opponent) {
      this.watchers.delete(from);
      this.seatOpponent(member);
    } else if (!this.watchers.has(from)) {
      if (this.watchers.size >= this.maxWatchers) {
        const message = want === 'play' && this.opponent
          ? (this.maxWatchers === 0 ? '座位已经有人了，这个房间不开放观战' : '座位和观战席都满了')
          : (this.maxWatchers === 0 ? '这个房间不开放观战' : '观战席已满');
        this.transport.send(from, { t: 'denied', message });
        return;
      }
      this.watchers.set(from, member);
    }
    this.update({ connection: { ...this.snapshot.connection, peer: this.peerStatus() } });
    this.publish();
  }

  private seatOpponent(member: Member) {
    this.opponent = member;
    this.newMatch();
  }

  /** 带序号的消息：同一序号只处理一次 */
  private seated(from: string, msg: SeatedMessage) {
    const member = this.memberOf(from);
    if (!member) {
      // 房主刚换了设备或刷新过，还不知道这个人是谁
      this.transport.send(from, { t: 'rehello' });
      return;
    }
    if (msg.seq <= member.lastSeq) {
      this.sendState(member);
      return;
    }
    member.lastSeq = msg.seq;
    const isOpponent = member === this.opponent;
    let error: string | null;
    switch (msg.t) {
      case 'action':
        error = isOpponent ? this.change((s) => applyAction(s, GUEST_SEAT, msg.action)) : '观众不能操作';
        break;
      case 'next':
        error = isOpponent ? this.change((s) => advance(s, this.random)) : '观众不能操作';
        break;
      case 'sit':
        if (isOpponent) error = null;
        else if (this.opponent) error = '座位已经有人了';
        else {
          this.watchers.delete(from);
          this.seatOpponent(member);
          this.publish();
          error = null;
        }
        break;
      case 'stand':
        if (isOpponent) {
          this.standUp();
          this.watchers.set(from, member);
          this.publish();
        }
        error = null;
        break;
    }
    if (error) {
      this.save();
      this.transport.send(from, { t: 'reject', seq: msg.seq, message: error });
      this.sendState(member);
    } else if (msg.t === 'sit' || msg.t === 'stand') {
      this.sendState(member);
    }
  }

  /** 对手离座：座位空出来，桌上回到"等待对手坐下"；下一个坐下的人从新的一局开始 */
  private standUp() {
    this.opponent = null;
    this.newMatch();
  }

  private bye(from: string) {
    if (this.opponent?.id === from) this.standUp();
    this.watchers.delete(from);
    this.transport.forget?.(from);
    this.update({ connection: { ...this.snapshot.connection, peer: this.peerStatus() } });
    this.publish();
  }

  private presence(from: string, online: boolean) {
    if (this.opponent?.id === from) {
      this.opponent.online = online;
      this.update({ connection: { ...this.snapshot.connection, peer: this.peerStatus() } });
    } else if (!online && this.watchers.delete(from)) {
      // 观众掉线就让出观战席，回来时重新打招呼即可
      this.transport.forget?.(from);
      this.publish();
    }
  }

  private receiveNudge(from: string) {
    const key = turnKey(this.snapshot.view);
    if (!this.opponent || this.opponent.id !== from || key === null) return;
    if (this.state.hand?.toAct !== HOST_SEAT || this.opponentNudged === key) return;
    this.opponentNudged = key;
    this.update({ nudged: { from: this.opponent.name, at: Date.now() } });
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
    this.armTimer();
    this.save();
    this.update({
      view: viewFor(this.state, HOST_SEAT),
      room: this.roomInfo('host'),
      turn: this.currentTurn ? { seat: this.state.hand!.toAct!, deadline: this.deadline } : null,
      epoch: this.epoch,
    });
    if (this.opponent) this.sendState(this.opponent);
    for (const w of this.watchers.values()) this.sendState(w);
    this.reportRoom();
  }

  private roomInfo(you: RoomInfo['you']): RoomInfo {
    return {
      name: this.roomName,
      seats: [this.name, this.opponent?.name ?? null],
      watchers: [...this.watchers.values()].map((w) => w.name),
      maxWatchers: this.maxWatchers,
      you,
    };
  }

  private reportRoom() {
    if (!this.onRoomChange) return;
    const summary: RoomSummary = { seats: [this.name, this.opponent?.name ?? null], watchers: this.watchers.size };
    const key = JSON.stringify(summary);
    if (key === this.lastSummary) return;
    this.lastSummary = key;
    this.onRoomChange(summary);
  }

  private sendState(member: Member) {
    if (!member.id) return;
    const isOpponent = member === this.opponent;
    const msg: HostMessage = {
      t: 'state',
      epoch: this.epoch,
      version: this.version,
      ackSeq: member.lastSeq,
      room: this.roomInfo(isOpponent ? 'player' : 'watcher'),
      // 观众从 1 号位的角度看，自己"坐"在下方的空位，但看不到任何底牌
      view: isOpponent ? viewFor(this.state, GUEST_SEAT) : viewFor(this.state, GUEST_SEAT, true),
      turn: this.currentTurn
        ? { seat: this.state.hand!.toAct!, remainingMs: Math.max(0, this.deadline - Date.now()) }
        : null,
    };
    this.transport.send(member.id, msg);
  }

  /** 轮次变了就重新计时 */
  private armTimer() {
    const hand = this.state.hand;
    const key = this.opponent && hand && !hand.result && hand.toAct !== null
      ? `${this.epoch}:${hand.number}:${hand.log.length}`
      : null;
    if (key === this.currentTurn) return;
    this.clearTimer();
    this.currentTurn = key;
    if (!key || this.snapshot.connection.superseded) return;
    this.deadline = Date.now() + TURN_MS;
    this.timer = setTimeout(() => this.timeout(), TURN_MS + TIMEOUT_GRACE_MS);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 超时：能过牌就过牌，否则弃牌 */
  private timeout() {
    this.timer = null;
    const seat = this.state.hand?.toAct;
    if (seat === null || seat === undefined) return;
    const legal = legalActions(this.state, seat);
    if (!legal) return;
    this.change((s) => {
      const next = applyAction(s, seat, { type: legal.canCheck ? 'check' : 'fold' });
      const entry = next.hand!.log.filter((e) => e.kind === 'action' && e.seat === seat).at(-1);
      if (entry?.kind === 'action') entry.timeout = true;
      return next;
    });
  }

  private save() {
    const opponent = this.opponent ? { name: this.opponent.name, token: this.opponent.token, lastSeq: this.opponent.lastSeq } : null;
    const saved: SavedGame = { state: this.state, epoch: this.epoch, version: this.version, opponent, savedAt: Date.now() };
    this.store.set(this.saveKey, JSON.stringify(saved));
    this.saveRemote?.(saved);
  }
}

export interface GuestIdentity {
  name: string;
  token: string;
  want: Want;
}

/** 对手 / 观众：只显示房主发来的画面，操作发给房主，没得到确认就一直重发 */
export class GuestClient extends BaseClient implements GameClient {
  readonly role = 'guest' as const;
  private seq = 0;
  private version = -1;
  private pendingMsg: SeatedMessage | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly identity: GuestIdentity;

  constructor(private readonly transport: GuestTransport, identity: GuestIdentity) {
    super();
    this.identity = { ...identity };
    this.unsubscribe.push(transport.onMessage((msg) => this.handleHost(msg)));
    if (transport.onConnection) {
      this.unsubscribe.push(transport.onConnection((connection) => {
        const cameOnline = connection.self === 'online' && this.snapshot.connection.self !== 'online';
        const hostBack = connection.peer === 'online' && this.snapshot.connection.peer !== 'online';
        this.update({ connection });
        // 刚连上服务器或房主刚上线：打个招呼拿最新画面，并重发没确认的操作
        if (cameOnline || hostBack) this.flush(true);
      }));
    }
    this.hello();
    this.timer = setInterval(() => {
      if (!this.snapshot.denied && (!this.snapshot.view || this.pendingMsg)) this.flush(!this.snapshot.view);
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

  sit(): void {
    if (this.pendingMsg) return;
    this.identity.want = 'play';
    this.sendPending({ t: 'sit', seq: this.nextSeq() });
  }

  stand(): void {
    if (this.pendingMsg) return;
    this.identity.want = 'watch';
    this.sendPending({ t: 'stand', seq: this.nextSeq() });
  }

  nudge(): void {
    if (!canNudge(this.snapshot)) return;
    this.transport.send({ t: 'nudge' });
    this.update({ nudgeUsed: turnKey(this.snapshot.view) });
  }

  leave(): void {
    this.transport.send({ t: 'bye' });
    this.dispose();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const u of this.unsubscribe) u();
    this.transport.close();
  }

  private hello() {
    this.transport.send({ t: 'hello', ...this.identity });
  }

  private sendPending(msg: SeatedMessage) {
    this.pendingMsg = msg;
    this.update({ pending: true, error: null });
    this.transport.send(msg);
  }

  private flush(withHello: boolean) {
    if (withHello || !this.pendingMsg) this.hello();
    if (this.pendingMsg) this.transport.send(this.pendingMsg);
  }

  /** 用时间戳做序号：页面刷新后序号仍然递增，房主不会误判为重复消息 */
  private nextSeq(): number {
    this.seq = Math.max(Date.now(), this.seq + 1);
    return this.seq;
  }

  private handleHost(msg: HostMessage) {
    switch (msg.t) {
      case 'reject':
        if (this.pendingMsg?.seq === msg.seq) {
          this.pendingMsg = null;
          this.update({ pending: false, error: msg.message });
        }
        return;
      case 'nudge':
        this.update({ nudged: { from: msg.from, at: Date.now() } });
        return;
      case 'denied':
        this.pendingMsg = null;
        this.update({ denied: msg.message, pending: false });
        return;
      case 'rehello':
        this.flush(true);
        return;
      case 'state':
        break;
    }
    // 旧画面（例如服务器上保留的旧消息晚到）不覆盖新画面；对局编号变了就接受
    if (msg.epoch === this.snapshot.epoch && msg.version < this.version) return;
    this.version = msg.version;
    // 换了设备、时钟偏慢时，序号也要比房主处理过的大，否则会被当成重复消息
    this.seq = Math.max(this.seq, msg.ackSeq);
    const acked = this.pendingMsg !== null && msg.ackSeq >= this.pendingMsg.seq;
    if (acked) this.pendingMsg = null;
    this.update({
      view: msg.view,
      room: msg.room,
      epoch: msg.epoch,
      turn: msg.turn ? { seat: msg.turn.seat, deadline: Date.now() + msg.turn.remainingMs } : null,
      pending: this.pendingMsg !== null,
      denied: null,
    });
  }
}
