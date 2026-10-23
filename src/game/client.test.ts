import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionInfo, GuestMessage, HostMessage, Transport } from '../net/protocol';
import { type Action, createMatch, legalActions } from '../engine';
import { seededRandomInt } from '../engine/test-utils';
import {
  GuestClient, HostController, isSavedGame, type KeyValueStore, pickLatest, RESEND_MS, type SavedGame,
} from './client';

/** 内存里的一对传输通道，消息同步送达 */
function transportPair() {
  const toHost = new Set<(m: GuestMessage) => void>();
  const toGuest = new Set<(m: HostMessage) => void>();
  const host: Transport<GuestMessage, HostMessage> = {
    send: (m) => toGuest.forEach((h) => h(structuredClone(m))),
    onMessage: (h) => { toHost.add(h); return () => toHost.delete(h); },
    close: () => toHost.clear(),
  };
  const guest: Transport<HostMessage, GuestMessage> = {
    send: (m) => toHost.forEach((h) => h(structuredClone(m))),
    onMessage: (h) => { toGuest.add(h); return () => toGuest.delete(h); },
    close: () => toGuest.clear(),
  };
  return { host, guest };
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

function setup(store = memoryStore()) {
  const { host: ht, guest: gt } = transportPair();
  const host = new HostController(ht, { store, random: seededRandomInt(42) });
  const guest = new GuestClient(gt);
  return { host, guest, store };
}

afterEach(() => vi.useRealTimers());

describe('房主和玩家', () => {
  it('玩家连上后收到自己的画面，看不到房主的底牌', () => {
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
    const { host: ht, guest: gt } = transportPair();
    const host = new HostController(ht, { store: memoryStore(), random: seededRandomInt(1) });
    const rejects: HostMessage[] = [];
    gt.onMessage((m) => { if (m.t === 'reject') rejects.push(m); });
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

  it('房主刷新页面后从存档继续', () => {
    const store = memoryStore();
    const first = setup(store);
    const actor = first.host.matchState.hand!.toAct === 0 ? first.host : first.guest;
    actor.act({ type: 'raise', to: 30 });
    const saved = first.host.matchState;
    first.host.dispose();

    const { host: ht } = transportPair();
    const reloaded = new HostController(ht, { store, random: seededRandomInt(7) });
    expect(reloaded.matchState).toEqual(saved);
  });

  it('房主还没打开时，玩家会定时重新打招呼', () => {
    vi.useFakeTimers();
    const { host: ht, guest: gt } = transportPair();
    const guest = new GuestClient(gt);
    expect(guest.getSnapshot().view).toBeNull();
    const host = new HostController(ht, { store: memoryStore(), random: seededRandomInt(3) });
    // 房主启动时会主动发一次画面
    expect(guest.getSnapshot().view).not.toBeNull();
    const hellos: GuestMessage[] = [];
    ht.onMessage((m) => hellos.push(m));
    vi.advanceTimersByTime(5000);
    expect(hellos).toHaveLength(0); // 已有画面，不再重复打招呼
    guest.dispose();
    host.dispose();
  });
});

/** 可以手动控制投递的传输：消息先排队，deliver() 才送达；可以模拟丢包 */
function lossyPair() {
  const toHost: GuestMessage[] = [];
  const toGuest: HostMessage[] = [];
  const hostHandlers = new Set<(m: GuestMessage) => void>();
  const guestHandlers = new Set<(m: HostMessage) => void>();
  let connHandler: ((c: ConnectionInfo) => void) | null = null;
  const host: Transport<GuestMessage, HostMessage> = {
    send: (m) => void toGuest.push(structuredClone(m)),
    onMessage: (h) => { hostHandlers.add(h); return () => hostHandlers.delete(h); },
    close: () => {},
  };
  const guest: Transport<HostMessage, GuestMessage> = {
    send: (m) => void toHost.push(structuredClone(m)),
    onMessage: (h) => { guestHandlers.add(h); return () => guestHandlers.delete(h); },
    onConnection: (h) => { connHandler = h; h({ self: 'connecting', peer: 'unknown', superseded: false }); return () => { connHandler = null; }; },
    close: () => {},
  };
  return {
    host, guest, toHost, toGuest,
    deliver() {
      while (toHost.length || toGuest.length) {
        for (const m of toHost.splice(0)) hostHandlers.forEach((h) => h(m));
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

describe('断线与重发', () => {
  it('操作丢失时定时重发，直到房主确认', () => {
    vi.useFakeTimers();
    const net = lossyPair();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(5) });
    const guest = new GuestClient(net.guest);
    net.deliver();
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
  });

  it('房主已处理但确认丢失：重发的操作不会执行两次', () => {
    vi.useFakeTimers();
    const net = lossyPair();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(5) });
    const guest = new GuestClient(net.guest);
    net.deliver();
    if (host.matchState.hand!.toAct === 0) { host.act({ type: 'call' }); net.deliver(); }

    guest.act(guestMove(host));
    // 送到房主，但房主的回复丢了
    const action = net.toHost.splice(0);
    action.forEach((m) => (host as unknown as { handleGuest(m: GuestMessage): void }).handleGuest(m));
    net.drop();
    const logLength = host.matchState.hand!.log.length;
    expect(guest.getSnapshot().pending).toBe(true);

    vi.advanceTimersByTime(RESEND_MS);
    net.deliver();
    expect(host.matchState.hand!.log.length).toBe(logLength);
    expect(guest.getSnapshot().pending).toBe(false);
    guest.dispose();
  });

  it('被拒绝的操作停止重发并显示原因', () => {
    vi.useFakeTimers();
    const net = lossyPair();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(5) });
    const guest = new GuestClient(net.guest);
    net.deliver();
    const guestToAct = host.matchState.hand!.toAct === 1;
    guest.act(guestToAct ? { type: 'raise', to: 3 } : { type: 'call' });
    net.deliver();
    expect(guest.getSnapshot().pending).toBe(false);
    expect(guest.getSnapshot().error).toBeTruthy();
    vi.advanceTimersByTime(RESEND_MS * 3);
    expect(net.toHost.filter((m) => m.t === 'action')).toHaveLength(0);
    guest.dispose();
  });

  it('重新连上服务器时立刻打招呼拿最新画面', () => {
    const net = lossyPair();
    const guest = new GuestClient(net.guest);
    net.toHost.length = 0;
    net.setConnection({ self: 'online', peer: 'unknown', superseded: false });
    expect(net.toHost).toEqual([{ t: 'hello' }]);
    guest.dispose();
  });

  it('旧画面不覆盖新画面；房主重新开始后接受新对局', () => {
    const net = lossyPair();
    const host = new HostController(net.host, { store: memoryStore(), random: seededRandomInt(5) });
    const guest = new GuestClient(net.guest);
    net.deliver();
    const first = net.toGuest; // 记录之后的消息
    const actor = host.matchState.hand!.toAct;
    if (actor === 0) host.act({ type: 'call' }); else { guest.act({ type: 'call' }); net.deliver(); }
    const v = guest.getSnapshot().view!;
    // 把一条旧画面重新投递
    const stale: HostMessage = { t: 'state', epoch: 'x', version: -1, ackSeq: 0, view: v };
    void first;
    const epoch = (host as unknown as { epoch: string }).epoch;
    net.toGuest.push({ ...stale, epoch, version: 0, view: { ...v, handCount: 999 } });
    net.deliver();
    expect(guest.getSnapshot().view!.handCount).not.toBe(999);

    host.reset();
    net.deliver();
    expect(guest.getSnapshot().view!.matchWins).toEqual([0, 0]);
    expect(guest.getSnapshot().view!.hand!.log.filter((e) => e.kind === 'action')).toHaveLength(0);
    guest.dispose();
  });

  it('玩家换了时钟偏慢的设备，序号仍大于房主处理过的', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01'));
    const net = lossyPair();
    const store = memoryStore();
    const host = new HostController(net.host, { store, random: seededRandomInt(5) });
    const fast = new GuestClient(net.guest);
    net.deliver();
    if (host.matchState.hand!.toAct === 1) { fast.act({ type: 'call' }); net.deliver(); } else { host.act({ type: 'call' }); net.deliver(); }
    fast.dispose();

    vi.setSystemTime(new Date('2020-01-01')); // 新设备时钟慢了 10 年
    const slow = new GuestClient(net.guest);
    net.deliver();
    const before = host.matchState.hand!.log.length;
    if (host.matchState.hand!.toAct === 1) {
      slow.act({ type: 'check' });
      net.deliver();
      expect(host.matchState.hand!.log.length).toBeGreaterThan(before);
    }
    slow.dispose();
  });
});

describe('房主存档', () => {
  const base = (over: Partial<SavedGame>): SavedGame => ({
    state: createMatch(), epoch: 'a', version: 1, lastGuestSeq: 0, savedAt: 1, ...over,
  });

  it('同一对局取版本号大的，不同对局取保存时间新的', () => {
    expect(pickLatest(base({ version: 3 }), base({ version: 5 }))!.version).toBe(5);
    expect(pickLatest(base({ version: 9, savedAt: 1 }), base({ epoch: 'b', version: 1, savedAt: 2 }))!.epoch).toBe('b');
    expect(pickLatest(null, base({}))!.epoch).toBe('a');
    expect(pickLatest(null, null)).toBeNull();
  });

  it('换设备：用服务器上较新的存档继续', () => {
    const store = memoryStore();
    const first = setup(store);
    const actor = first.host.matchState.hand!.toAct === 0 ? first.host : first.guest;
    actor.act({ type: 'raise', to: 30 });
    const remote = JSON.parse(store.data.get('thp.host.match.v2')!) as SavedGame;

    const { host: ht } = transportPair();
    const otherDevice = new HostController(ht, { store: memoryStore(), remoteSave: remote, random: seededRandomInt(9) });
    expect(otherDevice.matchState).toEqual(first.host.matchState);
  });

  it('每次变化都会保存到服务器', () => {
    const saves: SavedGame[] = [];
    const { host: ht } = transportPair();
    const host = new HostController(ht, { store: memoryStore(), random: seededRandomInt(2), saveRemote: (s) => saves.push(s) });
    const n = saves.length;
    host.act({ type: 'fold' });
    host.act({ type: 'fold' }); // 第二次非法，不应保存
    expect(saves.length).toBeLessThanOrEqual(n + 1);
    expect(isSavedGame(saves.at(-1))).toBe(true);
  });

  it('房主在另一台设备打开后，这里不再处理任何操作', () => {
    let emit: ((c: ConnectionInfo) => void) | null = null;
    const { host: ht } = transportPair();
    const t: Transport<GuestMessage, HostMessage> = {
      ...ht,
      onConnection: (h) => { emit = h; h({ self: 'online', peer: 'unknown', superseded: false }); return () => {}; },
    };
    const host = new HostController(t, { store: memoryStore(), random: seededRandomInt(2) });
    emit!({ self: 'online', peer: 'unknown', superseded: true });
    const before = host.matchState;
    host.act({ type: 'fold' });
    expect(host.matchState).toBe(before);
    expect(host.getSnapshot().error).toContain('另一台设备');
  });
});
