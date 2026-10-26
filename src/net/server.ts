import type { Action } from '../engine';
import type { ClientSnapshot, GameClient } from '../game/client';
import type { Command, ServerEvent } from '../shared/server-protocol';

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401) dispatchEvent(new Event('session-expired'));
    throw new Error(data.error ?? '请求失败，请稍后重试');
  }
  return data;
}

export class ServerConnection {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private hiddenAt = 0;
  constructor(
    private readonly event: (event: ServerEvent) => void,
    private readonly status: (value: 'connecting' | 'online' | 'offline') => void,
    private readonly opened: () => void = () => {},
  ) {
    addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.visibility);
    this.open();
  }
  private visibility = () => {
    if (document.hidden) this.hiddenAt = Date.now();
    else if (this.hiddenAt && Date.now() - this.hiddenAt > 1000) this.wake();
  };
  private wake = () => {
    if (this.stopped) return;
    clearTimeout(this.retry);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
    this.open();
  };
  private open() {
    if (this.stopped) return;
    this.status('connecting');
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket) { this.status('online'); this.opened(); } };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        const event = JSON.parse(String(data)) as ServerEvent;
        if (event.t === 'superseded' || event.t === 'closed') this.close();
        this.event(event);
      } catch { this.event({ t: 'error', error: '服务器消息无法解析，请刷新页面' }); }
    };
    socket.onerror = () => {};
    socket.onclose = ({ code }) => {
      if (this.socket !== socket || this.stopped) return;
      this.status('offline');
      if (code === 4001) { this.close(); dispatchEvent(new Event('session-expired')); return; }
      this.retry = setTimeout(() => this.open(), 1500);
    };
  }
  send(data: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data)); }
  close() {
    this.stopped = true; clearTimeout(this.retry);
    removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.visibility);
    this.socket?.close();
  }
}

export class ServerGameClient implements GameClient {
  readonly role = 'guest' as const;
  private listeners = new Set<() => void>();
  private snapshot: ClientSnapshot = {
    view: null, room: null, turn: null, epoch: null, error: null,
    connection: { self: 'connecting', peer: 'unknown', superseded: false },
    pending: false, nudged: null, nudgeUsed: null, denied: null,
  };
  private version = 0;
  private pending: Command | null = null;
  private connection: ServerConnection;
  private resend: ReturnType<typeof setInterval>;
  constructor(readonly roomId: string) {
    this.connection = new ServerConnection((event) => this.receive(event),
      (self) => this.update({ connection: { ...this.snapshot.connection, self } }),
      () => {
        this.connection.send({ t: 'subscribe', v: 3, roomId });
        if (this.pending) this.connection.send(this.pending);
      });
    this.resend = setInterval(() => { if (this.pending) this.connection.send(this.pending); }, 2000);
  }
  private receive(event: ServerEvent) {
    if (event.t === 'state') {
      this.version = event.version;
      const peerSeat = event.view.you === 0 ? 1 : 0;
      this.update({
        view: event.view, epoch: event.epoch,
        ...(event.epoch !== this.snapshot.epoch || event.view.matchNumber !== this.snapshot.view?.matchNumber ? { nudgeUsed: null } : {}),
        room: {
          name: event.room.name, seats: event.room.seats, watchers: event.watcherNames,
          maxWatchers: event.room.maxWatchers, you: event.seat === null ? 'watcher' : 'player', owner: event.owner,
        },
        turn: event.remainingMs === null || event.view.hand?.toAct === null || !event.view.hand
          ? null : { seat: event.view.hand.toAct, deadline: Date.now() + event.remainingMs },
        connection: { self: 'online', peer: event.room.seats[peerSeat] === null ? 'unknown' : event.room.online[peerSeat] ? 'online' : 'offline', superseded: false },
      });
    } else if (event.t === 'ack' && event.id === this.pending?.id) {
      const nudged = this.pending.op === 'nudge' && !event.error;
      const hand = this.snapshot.view?.hand;
      this.pending = null;
      this.update({ pending: false, error: event.error ?? null, ...(nudged && hand ? { nudgeUsed: `${hand.number}:${hand.log.length}` } : {}) });
    } else if (event.t === 'error') {
      this.pending = null;
      this.update({ error: event.error, pending: false, ...(!this.snapshot.view ? { denied: event.error } : {}) });
    } else if (event.t === 'closed') this.update({ denied: event.error });
    else if (event.t === 'superseded') { this.pending = null; this.update({ pending: false, connection: { ...this.snapshot.connection, superseded: true } }); }
    else if (event.t === 'nudge') this.update({ nudged: { from: event.from, at: Date.now() } });
  }
  private update(patch: Partial<ClientSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; for (const l of this.listeners) l(); }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private command(op: Command['op'], action?: Action) {
    if (this.pending || !this.snapshot.epoch || this.snapshot.connection.self !== 'online') return;
    const base = { t: 'command' as const, v: 3 as const, id: crypto.randomUUID(), roomId: this.roomId, epoch: this.snapshot.epoch, version: this.version };
    this.pending = op === 'action' && action ? { ...base, op, action } : { ...base, op: op as Exclude<Command['op'], 'action'> };
    this.update({ pending: true, error: null });
    this.connection.send(this.pending);
  }
  act(action: Action) { this.command('action', action); }
  next() { this.command('next'); }
  sit() { this.command('sit'); }
  stand() { this.command('stand'); }
  reset() { this.command('reset'); }
  nudge() { this.command('nudge'); }
  dismissError() { this.update({ error: null }); }
  leave() { this.dispose(); }
  dispose() { clearInterval(this.resend); this.connection.close(); this.listeners.clear(); }
}
