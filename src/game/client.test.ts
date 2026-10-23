import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestMessage, HostMessage, Transport } from '../net/protocol';
import { seededRandomInt } from '../engine/test-utils';
import { GuestClient, HostController, type KeyValueStore } from './client';

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
