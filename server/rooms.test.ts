import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './database';
import { GRACE_MS, Rooms, TURN_MS, type Peer } from './rooms';
import type { Action } from '../src/engine';
import type { ServerEvent, User } from '../src/shared/server-protocol';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(startingStack = 1000) {
  const store = new Store(':memory:'); stores.push(store);
  let clock = 100_000;
  const rooms = new Rooms(store, () => clock, { startingStack, smallBlind: 5, bigBlind: 10 });
  const users: User[] = ['owner', 'player', 'watcher', 'extra'].map((name) => {
    store.db.prepare('INSERT INTO users(id,name,normalized,password) VALUES(?,?,?,?)').run(name, name, name, 'hash');
    return store.user(name);
  });
  const owner = users[0]!; const player = users[1]!; const watcher = users[2]!;
  const listing = rooms.create(owner, 'Test', null, 2);
  const room = rooms.get(listing.roomId);
  const messages = new Map<string, ServerEvent[]>();
  const connect = (user: User) => {
    const events: ServerEvent[] = []; messages.set(user.id, events);
    const peer: Peer = { send: (event) => events.push(event), close() {} };
    rooms.attach(room, user.id, peer); return peer;
  };
  const ownerPeer = connect(owner);
  rooms.join(room, player, 'play'); const playerPeer = connect(player);
  rooms.join(room, watcher, 'watch'); connect(watcher);
  let seq = 0;
  const command = (user: User, op: 'action' | 'next' | 'sit' | 'stand' | 'nudge' | 'reset', action?: Action, id?: string) => {
    const message = { t: 'command', v: 3, id: id ?? `request-${++seq}`, roomId: room.id, epoch: room.epoch, version: room.version, op, ...(action ? { action } : {}) };
    return { message, reply: rooms.command(user.id, message) };
  };
  return { store, rooms, room, users, owner, player, watcher, connect, ownerPeer, playerPeer, messages, command,
    advance(ms: number) { clock += ms; rooms.tick(); } };
}
describe('authoritative rooms', () => {
  it('does not leak deck or opponent cards to players or spectators', () => {
    const s = setup();
    const owner = s.rooms.state(s.room, s.owner.id);
    expect(owner.view.hand!.players[0].hole).toHaveLength(2);
    expect(owner.view.hand!.players[1].hole).toBeNull();
    const player = s.rooms.state(s.room, s.player.id);
    expect(player.view.hand!.players[0].hole).toBeNull();
    expect(player.view.hand!.players[1].hole).toHaveLength(2);
    const watcher = s.rooms.state(s.room, s.watcher.id);
    expect(watcher.view.hand!.players.every((p) => p.hole === null)).toBe(true);
    expect(watcher.view.legal).toBeNull();
    expect(JSON.stringify(owner)).not.toContain('"deck"');
    expect(JSON.stringify(watcher)).not.toContain('"password"');
  });
  it('deduplicates commands and rejects stale, spectator and malformed actions', () => {
    const s = setup(); const actor = s.room.state.hand!.toAct === 0 ? s.owner : s.player;
    const sent = s.command(actor, 'action', { type: 'call' });
    expect(sent.reply.error).toBeUndefined();
    const version = s.room.version;
    expect(s.rooms.command(actor.id, sent.message).error).toBeUndefined();
    expect(s.room.version).toBe(version);
    expect(s.rooms.command(actor.id, { ...sent.message, id: 'different' }).error).toContain('更新');
    expect(s.command(s.watcher, 'action', { type: 'allin' }).reply.error).toContain('观众');
    expect(s.command(s.owner, 'action', { type: 'raise', to: NaN }).reply.error).toContain('金额');
  });
  it('lets the owner stand and another player take seat zero without inheriting owner rights', () => {
    const s = setup();
    expect(s.command(s.owner, 'stand').reply.error).toBeUndefined();
    expect(s.rooms.state(s.room, s.owner.id).owner).toBe(true);
    expect(s.rooms.state(s.room, s.owner.id).seat).toBeNull();
    expect(s.command(s.watcher, 'sit').reply.error).toBeUndefined();
    expect(s.rooms.state(s.room, s.watcher.id).seat).toBe(0);
    expect(s.command(s.watcher, 'reset').reply.error).toContain('房主');
    expect(s.command(s.owner, 'sit').reply.error).toContain('座位');
    expect(() => s.rooms.remove(s.room, s.watcher.id)).toThrow('房主');
  });
  it('retains disconnected seats for sixty seconds, continues timers, and restores the same hand', () => {
    const s = setup(); const initial = structuredClone(s.room.state.hand);
    s.rooms.detach(s.room.id, s.player.id, s.playerPeer);
    s.advance(TURN_MS + 1001);
    expect(s.room.state.hand!.log.some((e) => e.kind === 'action' && e.timeout)).toBe(true);
    expect(s.room.members.find((m) => m.userId === s.player.id)?.seat).toBe(1);
    s.connect(s.player);
    expect(s.room.state.hand!.players.map((p) => p.hole)).toEqual(initial!.players.map((p) => p.hole));
    s.advance(GRACE_MS);
    expect(s.room.members.find((m) => m.userId === s.player.id)?.seat).toBe(1);
  });
  it('evicts expired seats without recording an unfinished match', () => {
    const s = setup(); s.rooms.detach(s.room.id, s.player.id, s.playerPeer);
    s.advance(GRACE_MS);
    expect(s.rooms.summary(s.room).seats[1]).toBeNull();
    expect(s.room.state.hand).toBeNull();
    expect(s.store.user(s.owner.id).stats).toEqual({ won: 0, lost: 0 });
  });
  it('takes over the connection and ignores the superseded socket closing', () => {
    const s = setup(); const previous = s.messages.get(s.player.id)!;
    const current = s.connect(s.player);
    expect(previous.some((e) => e.t === 'superseded')).toBe(true);
    s.rooms.detach(s.room.id, s.player.id, s.playerPeer);
    expect(s.rooms.active(s.room.id, s.player.id, current)).toBe(true);
    expect(s.rooms.summary(s.room).online[1]).toBe(true);
  });
  it('persists full games, resets recovery timers and records an actual match exactly once', () => {
    const s = setup(20);
    let count = 0;
    while (s.room.state.matchWinner === null && count++ < 200) {
      const seat = s.room.state.hand?.toAct;
      if (seat === null || seat === undefined) { expect(s.command(s.owner, 'next').reply.error).toBeUndefined(); continue; }
      const actor = seat === 0 ? s.owner : s.player;
      expect(s.command(actor, 'action', { type: 'allin' }).reply.error).toBeUndefined();
    }
    expect(s.room.state.matchWinner).not.toBeNull();
    const total = () => s.store.user(s.owner.id).stats.won + s.store.user(s.player.id).stats.won;
    expect(total()).toBe(1);
    s.connect(s.owner); expect(total()).toBe(1);
    const restored = new Rooms(s.store);
    expect(restored.get(s.room.id).state).toEqual(s.room.state);
    expect(restored.get(s.room.id).members.every((m) => m.offlineAt !== null)).toBe(true);
    expect(restored.get(s.room.id).members).toHaveLength(3);
    expect(total()).toBe(1);
  });
  it('enforces spectator capacity for standing and serializes competing seat requests', () => {
    const s = setup(); s.rooms.join(s.room, s.users[3]!, 'watch');
    expect(s.command(s.owner, 'stand').reply.error).toContain('观战席');
    s.rooms.leave(s.room, s.player.id);
    expect(s.command(s.watcher, 'sit').reply.error).toBeUndefined();
    expect(s.command(s.users[3]!, 'sit').reply.error).toContain('座位');
    expect(s.rooms.summary(s.room).seats).toEqual(['owner', 'watcher']);
  });
});
