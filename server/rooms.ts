import { randomUUID } from 'node:crypto';
import {
  applyAction, createMatch, cryptoRandomInt, DEFAULT_CONFIG, legalActions, startHand, startNextMatch, viewFor,
  type Action, type Config, type MatchState, type Seat,
} from '../src/engine';
import type { Command, RoomState, ServerEvent, ServerRoom, User } from '../src/shared/server-protocol';
import { ApiError, object, text } from './auth';
import { Store } from './database';

export const TURN_MS = 15_000;
export const GRACE_MS = 60_000;
export interface Peer { send(event: ServerEvent): void; close(): void }
interface Member { userId: string; name: string; seat: Seat | null; offlineAt: number | null; nudged: string | null }
export interface StoredRoom {
  id: string; name: string; ownerId: string; ownerName: string; password: string | null; maxWatchers: number;
  epoch: string; version: number; state: MatchState; members: Member[]; deadline: number | null; turn: string | null;
}

export class Rooms {
  readonly rooms = new Map<string, StoredRoom>();
  private readonly peers = new Map<string, Peer>();
  onChange: () => void = () => {};
  constructor(readonly store: Store, private readonly now = Date.now, private readonly config: Config = DEFAULT_CONFIG) {
    for (const row of store.db.prepare('SELECT data FROM rooms').all() as { data: string }[]) {
      const room = JSON.parse(row.data) as StoredRoom;
      room.members = room.members.map((m) => ({ ...m, offlineAt: now() }));
      room.deadline = room.turn ? now() + TURN_MS : null;
      room.version++;
      this.rooms.set(room.id, room);
      store.saveRoom(room);
    }
    store.db.prepare('DELETE FROM commands WHERE created < ?').run(now() - 7 * 86400_000);
  }
  get(id: string) {
    const room = this.rooms.get(id);
    if (!room) throw new ApiError('房间不存在或已解散', 404);
    return room;
  }
  private key(roomId: string, userId: string) { return `${roomId}:${userId}`; }
  private member(room: StoredRoom, userId: string) {
    const member = room.members.find((m) => m.userId === userId);
    if (!member) throw new ApiError('请先加入房间', 403);
    return member;
  }
  private turnKey(room: StoredRoom) {
    const h = room.state.hand;
    return h && !h.result && h.toAct !== null ? `${room.epoch}:${h.number}:${h.log.length}` : null;
  }
  private fresh(room: StoredRoom) {
    room.state = createMatch(this.config, cryptoRandomInt(2) as Seat);
    room.epoch = randomUUID();
    if ([0, 1].every((s) => room.members.some((m) => m.seat === s))) room.state = startHand(room.state);
  }
  private save(room: StoredRoom) {
    room.version++;
    const turn = this.turnKey(room);
    if (turn !== room.turn) {
      room.turn = turn;
      room.deadline = turn ? this.now() + TURN_MS : null;
    }
    const winner = room.state.matchWinner;
    if (winner !== null) {
      const won = room.members.find((m) => m.seat === winner);
      const lost = room.members.find((m) => m.seat === (winner === 0 ? 1 : 0));
      if (won && lost) this.store.result(`${room.id}:${room.epoch}:${room.state.matchNumber}`, won.userId, lost.userId);
    }
    this.store.saveRoom(room);
  }
  private change(room: StoredRoom, fn: () => void) {
    const before = structuredClone(room);
    try { this.store.db.transaction(() => { fn(); this.save(room); })(); }
    catch (error) { Object.assign(room, before); throw error; }
    this.publish(room);
  }
  list(): ServerRoom[] { return [...this.rooms.values()].reverse().map((r) => this.summary(r)); }
  summary(room: StoredRoom): ServerRoom {
    const seated = (seat: Seat) => room.members.find((m) => m.seat === seat);
    return {
      roomId: room.id, name: room.name, ownerId: room.ownerId, ownerName: room.ownerName,
      locked: !!room.password, seats: [seated(0)?.name ?? null, seated(1)?.name ?? null],
      online: [seated(0)?.offlineAt === null, seated(1)?.offlineAt === null],
      watchers: room.members.filter((m) => m.seat === null).length, maxWatchers: room.maxWatchers,
    };
  }
  create(user: User, name: string, password: string | null, maxWatchers: number) {
    const room: StoredRoom = {
      id: randomUUID(), name, ownerId: user.id, ownerName: user.username, password, maxWatchers,
      epoch: randomUUID(), version: 0, state: createMatch(this.config), deadline: null, turn: null,
      members: [{ userId: user.id, name: user.username, seat: 0, offlineAt: this.now(), nudged: null }],
    };
    this.store.saveRoom(room);
    this.rooms.set(room.id, room);
    this.onChange();
    return this.summary(room);
  }
  join(room: StoredRoom, user: User, want: 'play' | 'watch') {
    if (room.members.some((m) => m.userId === user.id)) return;
    const seat = ([0, 1] as const).find((s) => !room.members.some((m) => m.seat === s));
    const chosen = want === 'play' && seat !== undefined ? seat : null;
    if (chosen === null && room.members.filter((m) => m.seat === null).length >= room.maxWatchers) {
      throw new ApiError(room.maxWatchers === 0 ? '座位已满，这个房间不开放观战' : '观战席已满');
    }
    this.change(room, () => {
      room.members.push({ userId: user.id, name: user.username, seat: chosen, offlineAt: this.now(), nudged: null });
      if (chosen !== null) this.fresh(room);
    });
  }
  state(room: StoredRoom, userId: string): RoomState {
    const member = this.member(room, userId);
    return {
      t: 'state', v: 3, room: this.summary(room), seat: member.seat, owner: room.ownerId === userId,
      watcherNames: room.members.filter((m) => m.seat === null).map((m) => m.name),
      epoch: room.epoch, version: room.version, view: viewFor(room.state, member.seat ?? 0, member.seat === null),
      remainingMs: room.deadline === null ? null : Math.max(0, room.deadline - this.now()),
      stats: this.store.user(userId).stats,
    };
  }
  attach(room: StoredRoom, userId: string, peer: Peer) {
    const member = this.member(room, userId);
    const key = this.key(room.id, userId);
    const previous = this.peers.get(key);
    this.peers.set(key, peer);
    if (previous && previous !== peer) { previous.send({ t: 'superseded' }); previous.close(); }
    this.change(room, () => { member.offlineAt = null; });
  }
  active(roomId: string, userId: string, peer: Peer) { return this.peers.get(this.key(roomId, userId)) === peer; }
  detach(roomId: string, userId: string, peer: Peer) {
    if (!this.active(roomId, userId, peer)) return;
    this.peers.delete(this.key(roomId, userId));
    const room = this.rooms.get(roomId);
    const member = room?.members.find((m) => m.userId === userId);
    if (!room || !member) return;
    this.change(room, () => {
      member.offlineAt = this.now();
    });
  }
  leave(room: StoredRoom, userId: string) {
    const member = this.member(room, userId);
    this.change(room, () => {
      room.members = room.members.filter((m) => m !== member);
      if (member.seat !== null) this.fresh(room);
    });
    const key = this.key(room.id, userId);
    const peer = this.peers.get(key);
    this.peers.delete(key);
    peer?.send({ t: 'closed', error: '已离开房间' });
    peer?.close();
  }
  remove(room: StoredRoom, userId: string) {
    if (room.ownerId !== userId) throw new ApiError('只有房主可以解散房间', 403);
    this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM rooms WHERE id=?').run(room.id);
      this.store.db.prepare('DELETE FROM commands WHERE room_id=?').run(room.id);
    })();
    this.rooms.delete(room.id);
    for (const member of room.members) {
      const key = this.key(room.id, member.userId);
      const peer = this.peers.get(key);
      this.peers.delete(key);
      peer?.send({ t: 'closed', error: '房主已解散房间' }); peer?.close();
    }
    this.onChange();
  }
  command(userId: string, raw: unknown): { id: string; error?: string } {
    const msg = object(raw);
    const id = text(msg.id, 80);
    const room = this.get(text(msg.roomId, 80));
    const member = this.member(room, userId);
    const cached = this.store.db.prepare('SELECT error FROM commands WHERE room_id=? AND user_id=? AND id=?')
      .get(room.id, userId, id) as { error: string | null } | undefined;
    if (cached) return cached.error ? { id, error: cached.error } : { id };
    const before = structuredClone(room);
    let error: string | undefined;
    let nudge: Peer | undefined;
    this.store.db.transaction(() => {
      try {
        if (msg.v !== 3 || msg.epoch !== room.epoch || msg.version !== room.version) throw new ApiError('画面已更新，请按最新牌面操作');
        switch (msg.op as Command['op']) {
          case 'action': {
            if (member.seat === null) throw new ApiError('观众不能操作');
            const a = object(msg.action);
            if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(String(a.type))) throw new ApiError('未知操作');
            if (a.type === 'bet' || a.type === 'raise') {
              if (!Number.isSafeInteger(a.to) || (a.to as number) < 0) throw new ApiError('下注金额不正确');
            }
            room.state = applyAction(room.state, member.seat, a as unknown as Action);
            break;
          }
          case 'next':
            if (member.seat === null) throw new ApiError('观众不能操作');
            if (!room.members.some((m) => m.seat === (member.seat === 0 ? 1 : 0))) throw new ApiError('等待另一位玩家坐下');
            if (room.state.hand && !room.state.hand.result) throw new ApiError('这手牌还没结束');
            room.state = startHand(room.state.matchWinner === null ? room.state : startNextMatch(room.state));
            break;
          case 'sit': {
            if (member.seat !== null) break;
            const free = ([0, 1] as const).find((s) => !room.members.some((m) => m.seat === s));
            if (free === undefined) throw new ApiError('座位已经有人了');
            member.seat = free; this.fresh(room); break;
          }
          case 'stand':
            if (member.seat === null) break;
            if (room.members.filter((m) => m.seat === null).length >= room.maxWatchers) throw new ApiError('没有空余观战席，可以直接离开房间');
            member.seat = null; this.fresh(room); break;
          case 'reset':
            if (room.ownerId !== userId) throw new ApiError('只有房主可以重新开始');
            this.fresh(room); break;
          case 'nudge': {
            if (member.seat === null || !room.turn || room.state.hand?.toAct === member.seat) throw new ApiError('现在不能催促');
            if (member.nudged === room.turn) throw new ApiError('这一轮已经催过了');
            member.nudged = room.turn;
            const target = room.members.find((m) => m.seat === room.state.hand?.toAct);
            if (target) nudge = this.peers.get(this.key(room.id, target.userId));
            break;
          }
          default: throw new ApiError('未知操作');
        }
        this.save(room);
      } catch (e) {
        Object.assign(room, before);
        if (!(e instanceof ApiError) && !(e instanceof Error && e.name === 'IllegalActionError')) throw e;
        error = (e as Error).message;
      }
      this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run(room.id, userId, id, error ?? null, this.now());
    })();
    this.publish(room);
    if (!error) (nudge as Peer | undefined)?.send({ t: 'nudge', from: member.name });
    return error ? { id, error } : { id };
  }
  tick() {
    for (const room of this.rooms.values()) {
      const expired = room.members.filter((m) => m.offlineAt !== null && this.now() - m.offlineAt >= GRACE_MS);
      if (expired.length) {
        this.change(room, () => {
          room.members = room.members.filter((m) => !expired.includes(m));
          if (expired.some((m) => m.seat !== null)) this.fresh(room);
        });
      }
      if (room.deadline !== null && this.now() >= room.deadline + 1000) {
        const seat = room.state.hand?.toAct;
        const legal = seat === null || seat === undefined ? null : legalActions(room.state, seat);
        if (legal && seat !== null && seat !== undefined) this.change(room, () => {
          room.state = applyAction(room.state, seat, { type: legal.canCheck ? 'check' : 'fold' });
          const entry = room.state.hand?.log.filter((e) => e.kind === 'action').at(-1);
          if (entry?.kind === 'action') entry.timeout = true;
        });
      }
    }
  }
  private publish(room: StoredRoom) {
    for (const member of room.members) this.peers.get(this.key(room.id, member.userId))?.send(this.state(room, member.userId));
    this.onChange();
  }
}
