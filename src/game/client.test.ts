import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo, GuestMessage, GuestTransport, HostMessage, HostTransport, Want } from '../net/protocol';
import { type Action, createMatch, legalActions } from '../engine';
import { seededRandomInt } from '../engine/test-utils';
import {
  canNudge, GuestClient, HostController, type HostOptions, isSavedGame, type KeyValueStore, pickLatest, RESEND_MS,
  type SavedGame, TIMEOUT_GRACE_MS, TURN_MS,
} from './client';

/** 内存里的房间：一个房主、任意多个参与者，消息同步送达 */
function hub() {
  const toHost = new Set<(from: string, m: GuestMessage) => void>();
  const presence = new Set<(from: string, online: boolean) => void>();
  const toGuest = new Map<string, Set<(m: HostMessage) => void>>();
  const sent: { to: string; msg: HostMessage }[] = [];
  const host: HostTransport = {
    send: (to, m) => { sent.push({ to, msg: structuredClone(m) }); toGuest.get(to)?.forEach((h) => h(structuredClone(m))); },
    onMessage: (h) => { toHost.add(h); return () => toHost.delete(h); },
    onPresence: (h) => { presence.add(h); return () => presence.delete(h); },
    close: () => toHost.clear(),
  };
  const guest = (id: string): GuestTransport => {
    const handlers = new Set<(m: HostMessage) => void>();
    toGuest.set(id, handlers);
    return {
      send: (m) => toHost.forEach((h) => h(id, structuredClone(m))),
      onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
      close: () => handlers.clear(),
    };
  };
  return { host, guest, sent, setPresence: (id: string, online: boolean) => presence.forEach((h) => h(id, online)) };
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

const identity = (name: string, want: Want = 'play') => ({ name, token: `token-${name}`, want });

function setup(options: HostOptions = {}) {
  const net = hub();
  const store = options.store ?? memoryStore();
  const host = new HostController(net.host, { name: '房主', store, random: seededRandomInt(42), maxWatchers: 2, ...options });
  const guest = new GuestClient(net.guest('g1'), identity('小王'));
  return { net, host, guest, store };
}

afterEach(() => vi.useRealTimers());

describe('房主和对手', () => {
  it('只有房主时不发牌，有人坐下才开局', () => {
    const net = hub();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(1) });
    expect(host.getSnapshot().view!.hand).toBeNull();
    expect(host.getSnapshot().room!.seats).toEqual(['房主', null]);
    const guest = new GuestClient(net.guest('g1'), identity('小王'));
    expect(host.matchState.hand).not.toBeNull();
    expect(host.getSnapshot().room!.seats).toEqual(['房主', '小王']);
    expect(guest.getSnapshot().room!.you).toBe('player');
  });

  it('对手连上后收到自己的画面，看不到房主的底牌', () => {
    const { host, guest } = setup();
    const gv = guest.getSnapshot().view!;
    expect(gv.you).toBe(1);
    expect(gv.hand!.players[1].hole).toHaveLength(2);
    expect(gv.hand!.players[0].hole).toBeNull();
    expect(host.getSnapshot().view!.hand!.players[0].hole).toHaveLength(2);
    guest.dispose();
    host.dispose();
  });

  it('轮到谁谁才能操作，双方画面同步更新', () => {
    const { host, guest } = setup();
    const toAct = host.matchState.hand!.toAct!;
    const [actor, waiter] = toAct === 0 ? [host, guest] : [guest, host];

    waiter.act({ type: 'call' });
    expect(waiter.getSnapshot().error).toContain('还没轮到你');

    actor.act({ type: 'call' });
    expect(actor.getSnapshot().error).toBeNull();
    expect(host.matchState.hand!.toAct).toBe(1 - toAct);
    expect(guest.getSnapshot().view!.hand!.toAct).toBe(1 - toAct);
  });

  it('非法金额被拒绝并提示原因', () => {
    const { host, guest } = setup();
    const actor = host.matchState.hand!.toAct === 0 ? host : guest;
    actor.act({ type: 'raise', to: 11 });
    expect(actor.getSnapshot().error).toContain('加注金额必须在');
    actor.dismissError();
    expect(actor.getSnapshot().error).toBeNull();
  });

  it('重复的消息只执行一次', () => {
    const net = hub();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(1) });
    const gt = net.guest('g1');
    const rejects: HostMessage[] = [];
    gt.onMessage((m) => { if (m.t === 'reject') rejects.push(m); });
    gt.send({ t: 'hello', ...identity('小王') });
    // 牌局进行中要求下一手会被拒绝；同一序号再发、更小的序号都应被直接忽略
    gt.send({ t: 'next', seq: 100 });
    gt.send({ t: 'next', seq: 100 });
    gt.send({ t: 'next', seq: 99 });
    expect(rejects).toHaveLength(1);
    // 弃牌后，同一序号的"下一手"只开一手
    const seat = host.matchState.hand!.toAct!;
    if (seat === 0) host.act({ type: 'fold' });
    else gt.send({ t: 'action', seq: 101, action: { type: 'fold' } });
    gt.send({ t: 'next', seq: 102 });
    gt.send({ t: 'next', seq: 102 });
    expect(host.matchState.hand!.number).toBe(2);
    expect(rejects).toHaveLength(1);
  });

  it('这手牌结束后任一方都能开始下一手，没结束时不行', () => {
    const { host, guest } = setup();
    guest.next();
    expect(guest.getSnapshot().error).toContain('还没结束');
    const actor = host.matchState.hand!.toAct === 0 ? host : guest;
    actor.act({ type: 'fold' });
    expect(guest.getSnapshot().view!.hand!.result).not.toBeNull();
    guest.next();
    expect(host.matchState.hand!.number).toBe(2);
    expect(guest.getSnapshot().view!.hand!.result).toBeNull();
  });

  it('房主刷新页面后从存档继续，对手换了设备也能认回座位', () => {
    const store = memoryStore();
    const first = setup({ store });
    const actor = first.host.matchState.hand!.toAct === 0 ? first.host : first.guest;
    actor.act({ type: 'raise', to: 30 });
    const saved = first.host.matchState;
    first.host.dispose();

    const net = hub();
    const reloaded = new HostController(net.host, { store, random: seededRandomInt(7), maxWatchers: 2 });
    expect(reloaded.matchState).toEqual(saved);
    expect(reloaded.getSnapshot().room!.seats[1]).toBe('小王');
    // 另一台设备（新编号），同一账号的凭证
    const back = new GuestClient(net.guest('g-new-device'), identity('小王', 'watch'));
    expect(back.getSnapshot().room!.you).toBe('player');
    expect(back.getSnapshot().view!.hand!.players[1].hole).toEqual(saved.hand!.players[1].hole);
    // 同名但凭证不同：只能观战
    const fake = new GuestClient(net.guest('g-fake'), { name: '小王', token: 'other', want: 'play' });
    expect(fake.getSnapshot().room!.you).toBe('watcher');
  });

  it('房主不认识的人发来操作时，请他重新打招呼', () => {
    const net = hub();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(1) });
    const gt = net.guest('g1');
    const got: HostMessage[] = [];
    gt.onMessage((m) => got.push(m));
    gt.send({ t: 'next', seq: 5 });
    expect(got).toEqual([{ t: 'rehello' }]);
    host.dispose();
  });
});

describe('观战', () => {
  it('观众收到的任何画面里都没有底牌，摊牌时才看得到', () => {
    const { net, host, guest } = setup();
    const watcher = new GuestClient(net.guest('w1'), identity('老李', 'watch'));
    expect(watcher.getSnapshot().room!.you).toBe('watcher');
    expect(host.getSnapshot().room!.watchers).toEqual(['老李']);
    // 一直跟注 / 过牌打到摊牌
    for (let i = 0; i < 20 && !host.matchState.hand!.result; i++) {
      const seat = host.matchState.hand!.toAct!;
      const legal = legalActions(host.matchState, seat)!;
      const action: Action = legal.canCheck ? { type: 'check' } : { type: 'call' };
      if (seat === 0) host.act(action); else guest.act(action);
    }
    const toWatcher = net.sent.filter((s) => s.to === 'w1' && s.msg.t === 'state').map((s) => s.msg);
    expect(toWatcher.length).toBeGreaterThan(3);
    for (const msg of toWatcher) {
      if (msg.t !== 'state') continue;
      const hand = msg.view.hand!;
      if (hand.result?.reason === 'showdown') continue;
      expect(hand.players[0].hole).toBeNull();
      expect(hand.players[1].hole).toBeNull();
      expect(msg.view.legal).toBeNull();
    }
    expect(watcher.getSnapshot().view!.hand!.result!.reason).toBe('showdown');
    expect(watcher.getSnapshot().view!.hand!.players[0].hole).toHaveLength(2);
  });

  it('观众不能操作也不能催', () => {
    const { net } = setup();
    const watcher = new GuestClient(net.guest('w1'), identity('老李', 'watch'));
    watcher.act({ type: 'fold' });
    expect(watcher.getSnapshot().error).toBe('观众不能操作');
    expect(canNudge(watcher.getSnapshot())).toBe(false);
  });

  it('座位满了想坐下只能观战；观战席满了进不来', () => {
    const { net, host } = setup({ maxWatchers: 1 });
    const a = new GuestClient(net.guest('a'), identity('甲'));
    expect(a.getSnapshot().room!.you).toBe('watcher');
    const b = new GuestClient(net.guest('b'), identity('乙', 'watch'));
    expect(b.getSnapshot().denied).toBe('观战席已满');
    expect(host.getSnapshot().room!.watchers).toEqual(['甲']);
  });

  it('不开放观战时，座位有人就进不来', () => {
    const { net } = setup({ maxWatchers: 0 });
    const a = new GuestClient(net.guest('a'), identity('甲'));
    expect(a.getSnapshot().denied).toContain('不开放观战');
  });

  it('对手站起后座位空出来，观众可以坐下开新的一局', () => {
    const { net, host, guest } = setup();
    const watcher = new GuestClient(net.guest('w1'), identity('老李', 'watch'));
    watcher.sit();
    expect(watcher.getSnapshot().error).toBe('座位已经有人了');

    guest.stand();
    expect(host.getSnapshot().room!.seats[1]).toBeNull();
    expect(host.matchState.hand).toBeNull(); // 桌上回到等待对手坐下
    expect(host.getSnapshot().turn).toBeNull();
    expect(guest.getSnapshot().room!.you).toBe('watcher');

    watcher.sit();
    expect(host.getSnapshot().room!.seats[1]).toBe('老李');
    expect(watcher.getSnapshot().room!.you).toBe('player');
    expect(host.matchState.hand!.number).toBe(1);
    expect(host.matchState.stacks).toEqual([1000, 1000]);
  });

  it('观众掉线让出观战席；对手离开让出座位', () => {
    const { net, host, guest } = setup();
    new GuestClient(net.guest('w1'), identity('老李', 'watch'));
    net.setPresence('w1', false);
    expect(host.getSnapshot().room!.watchers).toEqual([]);
    // 对手只是掉线：座位保留，显示不在线
    net.setPresence('g1', false);
    expect(host.getSnapshot().room!.seats[1]).toBe('小王');
    expect(host.getSnapshot().connection.peer).toBe('offline');
    guest.leave();
    expect(host.getSnapshot().room!.seats[1]).toBeNull();
  });
});

describe('倒计时', () => {
  it('超时能过牌就过牌，否则弃牌，并在记录里标注', () => {
    vi.useFakeTimers();
    const { host, guest } = setup();
    const turn = host.getSnapshot().turn!;
    expect(turn.seat).toBe(host.matchState.hand!.toAct);
    expect(turn.deadline - Date.now()).toBe(TURN_MS);
    const remaining = guest.getSnapshot().turn!.deadline - Date.now();
    expect(remaining).toBeGreaterThan(TURN_MS - 100);

    // 翻牌前小盲面对大盲，不能过牌 → 弃牌
    vi.advanceTimersByTime(TURN_MS);
    expect(host.matchState.hand!.result).toBeNull(); // 还有网络余量
    vi.advanceTimersByTime(TIMEOUT_GRACE_MS);
    const hand = host.matchState.hand!;
    expect(hand.result?.reason).toBe('fold');
    expect(hand.log.filter((e) => e.kind === 'action').at(-1)).toMatchObject({ action: 'fold', timeout: true });
    expect(host.getSnapshot().turn).toBeNull();
  });

  it('能过牌时超时自动过牌；每次轮到新的人重新计时', () => {
    vi.useFakeTimers();
    const { host, guest } = setup();
    const sb = host.matchState.hand!.toAct!;
    vi.advanceTimersByTime(10_000);
    (sb === 0 ? host : guest).act({ type: 'call' });
    // 大盲可以过牌：重新给满 15 秒
    expect(host.getSnapshot().turn!.deadline - Date.now()).toBe(TURN_MS);
    vi.advanceTimersByTime(TURN_MS + TIMEOUT_GRACE_MS);
    const hand = host.matchState.hand!;
    expect(hand.street).toBe('flop');
    expect(hand.log.filter((e) => e.kind === 'action').at(-1)).toMatchObject({ action: 'check', timeout: true });
  });

  it('没有对手时不计时', () => {
    vi.useFakeTimers();
    const net = hub();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(1) });
    expect(host.getSnapshot().turn).toBeNull();
    host.dispose();
  });
});

describe('催一催', () => {
  it('对手思考时可以催，每轮只能催一次', () => {
    const { host, guest } = setup();
    const toAct = host.matchState.hand!.toAct!;
    const [waiter, actor] = toAct === 0 ? [guest, host] : [host, guest];
    expect(canNudge(actor.getSnapshot())).toBe(false); // 轮到自己时不能催
    expect(canNudge(waiter.getSnapshot())).toBe(true);
    waiter.nudge();
    expect(actor.getSnapshot().nudged?.from).toBe(toAct === 0 ? '小王' : '房主');
    expect(canNudge(waiter.getSnapshot())).toBe(false);
    const first = actor.getSnapshot().nudged;
    waiter.nudge();
    expect(actor.getSnapshot().nudged).toBe(first);

    // 轮次变了可以再催
    actor.act({ type: 'call' });
    expect(canNudge(actor.getSnapshot())).toBe(true);
  });
});

/** 可以手动控制投递的传输：消息先排队，deliver() 才送达；可以模拟丢包 */
function lossyPair() {
  const toHost: GuestMessage[] = [];
  const toGuest: HostMessage[] = [];
  const hostHandlers = new Set<(from: string, m: GuestMessage) => void>();
  const guestHandlers = new Set<(m: HostMessage) => void>();
  let connHandler: ((c: ConnectionInfo) => void) | null = null;
  const host: HostTransport = {
    send: (_to, m) => void toGuest.push(structuredClone(m)),
    onMessage: (h) => { hostHandlers.add(h); return () => hostHandlers.delete(h); },
    close: () => {},
  };
  const guest: GuestTransport = {
    send: (m) => void toHost.push(structuredClone(m)),
    onMessage: (h) => { guestHandlers.add(h); return () => guestHandlers.delete(h); },
    onConnection: (h) => { connHandler = h; h({ self: 'connecting', peer: 'unknown', superseded: false }); return () => { connHandler = null; }; },
    close: () => {},
  };
  return {
    host, guest, toHost, toGuest,
    deliver() {
      while (toHost.length || toGuest.length) {
        for (const m of toHost.splice(0)) hostHandlers.forEach((h) => h('g1', m));
        for (const m of toGuest.splice(0)) guestHandlers.forEach((h) => h(m));
      }
    },
    drop() { toHost.length = 0; toGuest.length = 0; },
    setConnection(c: ConnectionInfo) { connHandler?.(c); },
  };
}

/** 轮到玩家时一个合法的被动操作 */
function guestMove(host: HostController): Action {
  return legalActions(host.matchState, 1)!.canCheck ? { type: 'check' } : { type: 'call' };
}

function lossySetup(seed = 5) {
  const net = lossyPair();
  const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(seed) });
  const guest = new GuestClient(net.guest, identity('小王'));
  net.deliver();
  return { net, host, guest };
}

describe('断线与重发', () => {
  it('操作丢失时定时重发，直到房主确认', () => {
    vi.useFakeTimers();
    const { net, host, guest } = lossySetup();
    if (host.matchState.hand!.toAct === 0) { host.act({ type: 'call' }); net.deliver(); }

    const move = guestMove(host);
    guest.act(move);
    expect(guest.getSnapshot().pending).toBe(true);
    // 操作再点一次不会重复发送
    guest.act(move);
    expect(net.toHost.filter((m) => m.t === 'action')).toHaveLength(1);
    net.drop(); // 丢了

    vi.advanceTimersByTime(RESEND_MS);
    expect(net.toHost.filter((m) => m.t === 'action')).toHaveLength(1);
    net.deliver();
    expect(guest.getSnapshot().pending).toBe(false);
    expect(host.matchState.hand!.log.filter((e) => e.kind === 'action').at(-1)).toMatchObject({ seat: 1, action: move.type });
    guest.dispose();
    host.dispose();
  });

  it('房主已处理但确认丢失：重发的操作不会执行两次', () => {
    vi.useFakeTimers();
    const { net, host, guest } = lossySetup();
    if (host.matchState.hand!.toAct === 0) { host.act({ type: 'call' }); net.deliver(); }

    guest.act(guestMove(host));
    // 送到房主，但房主的回复丢了
    const action = net.toHost.splice(0);
    action.forEach((m) => (host as unknown as { handle(from: string, m: GuestMessage): void }).handle('g1', m));
    net.drop();
    const logLength = host.matchState.hand!.log.length;
    expect(guest.getSnapshot().pending).toBe(true);

    vi.advanceTimersByTime(RESEND_MS);
    net.deliver();
    expect(host.matchState.hand!.log.length).toBe(logLength);
    expect(guest.getSnapshot().pending).toBe(false);
    guest.dispose();
    host.dispose();
  });

  it('被拒绝的操作停止重发并显示原因', () => {
    vi.useFakeTimers();
    const { net, host, guest } = lossySetup();
    const guestToAct = host.matchState.hand!.toAct === 1;
    guest.act(guestToAct ? { type: 'raise', to: 3 } : { type: 'call' });
    net.deliver();
    expect(guest.getSnapshot().pending).toBe(false);
    expect(guest.getSnapshot().error).toBeTruthy();
    vi.advanceTimersByTime(RESEND_MS * 3);
    expect(net.toHost.filter((m) => m.t === 'action')).toHaveLength(0);
    guest.dispose();
    host.dispose();
  });

  it('重新连上服务器时立刻打招呼拿最新画面', () => {
    const net = lossyPair();
    const guest = new GuestClient(net.guest, identity('小王'));
    net.toHost.length = 0;
    net.setConnection({ self: 'online', peer: 'unknown', superseded: false });
    expect(net.toHost).toEqual([{ t: 'hello', ...identity('小王') }]);
    guest.dispose();
  });

  it('旧画面不覆盖新画面；房主重新开始后接受新对局', () => {
    const { net, host, guest } = lossySetup();
    const actor = host.matchState.hand!.toAct;
    if (actor === 0) host.act({ type: 'call' }); else { guest.act({ type: 'call' }); }
    net.deliver();
    const s = guest.getSnapshot();
    const epoch = s.epoch!;
    net.toGuest.push({ t: 'state', epoch, version: 0, ackSeq: 0, room: s.room!, turn: null, view: { ...s.view!, handCount: 999 } });
    net.deliver();
    expect(guest.getSnapshot().view!.handCount).not.toBe(999);

    host.reset();
    net.deliver();
    expect(guest.getSnapshot().view!.matchWins).toEqual([0, 0]);
    expect(guest.getSnapshot().view!.hand!.log.filter((e) => e.kind === 'action')).toHaveLength(0);
    guest.dispose();
    host.dispose();
  });

  it('玩家换了时钟偏慢的设备，序号仍大于房主处理过的', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01'));
    const { net, host, guest: fast } = lossySetup();
    if (host.matchState.hand!.toAct === 1) fast.act({ type: 'call' }); else host.act({ type: 'call' });
    net.deliver();
    fast.dispose();

    vi.setSystemTime(new Date('2020-01-01')); // 新设备时钟慢了 10 年
    const slow = new GuestClient(net.guest, identity('小王'));
    net.deliver();
    const before = host.matchState.hand!.log.length;
    if (host.matchState.hand!.toAct === 1) {
      slow.act({ type: 'check' });
      net.deliver();
      expect(host.matchState.hand!.log.length).toBeGreaterThan(before);
    }
    slow.dispose();
    host.dispose();
  });
});

describe('房主存档', () => {
  const base = (over: Partial<SavedGame>): SavedGame => ({
    state: createMatch(), epoch: 'a', version: 1, opponent: null, savedAt: 1, ...over,
  });

  it('同一对局取版本号大的，不同对局取保存时间新的', () => {
    expect(pickLatest(base({ version: 3 }), base({ version: 5 }))!.version).toBe(5);
    expect(pickLatest(base({ version: 9, savedAt: 1 }), base({ epoch: 'b', version: 1, savedAt: 2 }))!.epoch).toBe('b');
    expect(pickLatest(null, base({}))!.epoch).toBe('a');
    expect(pickLatest(null, null)).toBeNull();
    expect(isSavedGame(base({}))).toBe(true);
    expect(isSavedGame({ ...base({}), opponent: undefined })).toBe(false);
  });

  it('换设备：用服务器上较新的存档继续', () => {
    const store = memoryStore();
    const first = setup({ store, saveKey: 'room-a' });
    const actor = first.host.matchState.hand!.toAct === 0 ? first.host : first.guest;
    actor.act({ type: 'raise', to: 30 });
    const remote = JSON.parse(store.data.get('room-a')!) as SavedGame;

    const net = hub();
    const otherDevice = new HostController(net.host, { store: memoryStore(), remoteSave: remote, random: seededRandomInt(9) });
    expect(otherDevice.matchState).toEqual(first.host.matchState);
    expect(otherDevice.getSnapshot().room!.seats[1]).toBe('小王');
  });

  it('每次变化都会保存到服务器', () => {
    const saves: SavedGame[] = [];
    const { host } = setup({ saveRemote: (s) => saves.push(s) });
    const n = saves.length;
    host.act({ type: 'fold' });
    host.act({ type: 'fold' }); // 第二次非法，不应保存
    expect(saves.length).toBeLessThanOrEqual(n + 1);
    expect(isSavedGame(saves.at(-1))).toBe(true);
  });

  it('房主在另一台设备打开后，这里不再处理任何操作', () => {
    let emit: ((c: ConnectionInfo) => void) | null = null;
    const net = hub();
    const t: HostTransport = {
      ...net.host,
      onConnection: (h) => { emit = h; h({ self: 'online', peer: 'unknown', superseded: false }); return () => {}; },
    };
    const host = new HostController(t, { store: memoryStore(), random: seededRandomInt(2) });
    new GuestClient(net.guest('g1'), identity('小王'));
    emit!({ self: 'online', peer: 'unknown', superseded: true });
    const before = host.matchState;
    host.act({ type: 'fold' });
    expect(host.matchState).toBe(before);
    expect(host.getSnapshot().error).toContain('另一台设备');
  });

  it('座位或观众变化时通知房间列表', () => {
    const summaries: unknown[] = [];
    const { net } = setup({ onRoomChange: (s) => summaries.push(s) });
    new GuestClient(net.guest('w1'), identity('老李', 'watch'));
    expect(summaries.at(-1)).toEqual({ seats: ['房主', '小王'], watchers: 1 });
  });
});
