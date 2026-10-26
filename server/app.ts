import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ApiError, hashPassword, newToken, object, text, tokenHash, verifyPassword } from './auth';
import { Store } from './database';
import { Rooms, type Peer } from './rooms';
import type { ServerEvent } from '../src/shared/server-protocol';

export interface AppOptions {
  database?: string; origin?: string; secureCookie?: boolean; logger?: boolean; rateLimit?: boolean;
}
export async function buildApp(options: AppOptions = {}) {
  const origin = options.origin ?? 'http://localhost:5173';
  const secure = options.secureCookie ?? origin.startsWith('https:');
  const allowedOrigins = new Set([origin]);
  if (!secure && /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) {
    allowedOrigins.add('http://localhost:5173'); allowedOrigins.add('http://127.0.0.1:5173');
  }
  const store = new Store(options.database ?? 'data/game.sqlite');
  const rooms = new Rooms(store);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384, trustProxy: '127.0.0.1' });
  await app.register(cookie);
  if (options.rateLimit !== false) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      throw new ApiError('请求来源不正确', 403);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error({ err: e }, 'request failed');
    reply.code(status).send({ error: status >= 500 ? '服务器暂时无法处理请求' : e.message });
  });
  const session = (raw?: string) => {
    if (!raw) throw new ApiError('请先登录', 401);
    const row = store.db.prepare('SELECT user_id,expires FROM sessions WHERE token=?').get(tokenHash(raw)) as
      { user_id: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now()) throw new ApiError('登录已过期，请重新登录', 401);
    return store.user(row.user_id);
  };
  const user = (request: FastifyRequest) => session(request.cookies.session);
  const authenticate = (reply: FastifyReply, id: string) => {
    const token = newToken();
    const maxAge = 30 * 86400;
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), id, Date.now() + maxAge * 1000);
    reply.setCookie('session', token, { path: '/', httpOnly: true, secure, sameSite: 'lax', maxAge });
    return store.user(id);
  };
  const authLimit = { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } };
  app.get('/api/health', async () => { store.db.prepare('SELECT 1').get(); return { ok: true, version: 3 }; });
  app.post('/api/auth/register', authLimit, async (request, reply) => {
    const body = object(request.body);
    const name = text(text(body.username, 64).trim().replace(/\s+/g, ' '), 16);
    const password = text(body.password, 1024);
    const normalized = name.toLowerCase();
    if (store.db.prepare('SELECT id FROM users WHERE normalized=?').get(normalized)) throw new ApiError('这个用户名已经被注册了', 409);
    const hash = await hashPassword(password);
    const id = randomUUID();
    try { store.db.prepare('INSERT INTO users(id,name,normalized,password) VALUES(?,?,?,?)').run(id, name, normalized, hash); }
    catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError('这个用户名已经被注册了', 409);
      throw error;
    }
    return { user: authenticate(reply, id) };
  });
  app.post('/api/auth/login', authLimit, async (request, reply) => {
    const body = object(request.body);
    const name = text(body.username, 64).trim().replace(/\s+/g, ' ').toLowerCase();
    const password = text(body.password, 1024);
    const row = store.db.prepare('SELECT id,password FROM users WHERE normalized=?').get(name) as
      { id: string; password: string } | undefined;
    const hash = row?.password ?? `00000000000000000000000000000000:${'00'.repeat(64)}`;
    const valid = await verifyPassword(password, hash);
    if (!row || !valid) throw new ApiError('用户名或密码不对', 401);
    return { user: authenticate(reply, row.id) };
  });
  app.get('/api/me', async (request) => ({ user: user(request) }));
  const connections = new Set<{ ws: WebSocket; token: string; userId: string }>();
  app.post('/api/auth/logout', async (request, reply) => {
    const raw = request.cookies.session;
    if (raw) {
      const hash = tokenHash(raw);
      store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash);
      for (const connection of connections) if (connection.token === hash) connection.ws.close(4001, 'logged out');
    }
    reply.clearCookie('session', { path: '/', httpOnly: true, secure, sameSite: 'lax' });
    return { ok: true };
  });
  app.get('/api/rooms', async (request) => { user(request); return { rooms: rooms.list() }; });
  app.post('/api/rooms', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request) => {
    const actor = user(request);
    const body = object(request.body);
    const name = text(body.name, 24).trim() || '德州扑克';
    const password = text(body.password ?? '', 1024, true);
    if (![0, 2, 5, 10].includes(body.maxWatchers as number)) throw new ApiError('观战席数量不正确');
    const hash = password ? await hashPassword(password) : null;
    return { room: rooms.create(actor, name, hash, body.maxWatchers as number) };
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/join', async (request) => {
    const actor = user(request);
    const body = object(request.body);
    const room = rooms.get(request.params.id);
    if (body.want !== 'play' && body.want !== 'watch') throw new ApiError('请选择打牌或观战');
    if (room.password && room.ownerId !== actor.id && !room.members.some((m) => m.userId === actor.id)) {
      if (!await verifyPassword(text(body.password ?? '', 1024, true), room.password)) throw new ApiError('房间密码不对', 403);
      if (rooms.get(room.id) !== room) throw new ApiError('房间已解散', 404);
    }
    rooms.join(room, actor, body.want);
    return { room: rooms.summary(room) };
  });
  app.post<{ Params: { id: string } }>('/api/rooms/:id/leave', async (request) => {
    rooms.leave(rooms.get(request.params.id), user(request).id); return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/rooms/:id', async (request) => {
    rooms.remove(rooms.get(request.params.id), user(request).id); return { ok: true };
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  app.server.on('upgrade', (request, socket, head) => {
    try {
      if (request.url !== '/ws' || !allowedOrigins.has(request.headers.origin ?? '')) throw new ApiError('来源不正确', 403);
      const raw = app.parseCookie(request.headers.cookie ?? '').session;
      const actor = session(raw);
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, actor.id, raw));
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  const lobby = () => {
    const listings = rooms.list();
    for (const connection of connections) {
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify({
        t: 'lobby', rooms: listings, user: store.user(connection.userId),
      } satisfies ServerEvent));
    }
  };
  rooms.onChange = lobby;
  wss.on('connection', (ws: WebSocket, userId: string, raw: string) => {
    const connection = { ws, userId, token: tokenHash(raw) };
    connections.add(connection);
    let roomId: string | null = null;
    let alive = true;
    let messages = 0;
    let windowStart = Date.now();
    const peer: Peer = {
      send(event) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1024 * 1024) { ws.close(4008, 'slow connection'); return; }
        ws.send(JSON.stringify(event));
      },
      close() { ws.close(4000); },
    };
    ws.on('error', () => {});
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      try { session(raw); } catch { ws.close(4001); return; }
      if (!alive) { ws.terminate(); return; }
      alive = false; ws.ping();
    }, 15_000);
    ws.on('message', (bytes, binary) => {
      try {
        session(raw);
        if (Date.now() - windowStart >= 60_000) { messages = 0; windowStart = Date.now(); }
        if (++messages > 120) { ws.close(4008, 'too many messages'); return; }
        if (binary) throw new ApiError('只接受 JSON 文本');
        const msg = object(JSON.parse(bytes.toString()));
        if (msg.v !== 3) throw new ApiError('客户端版本已过期，请刷新页面');
        if (msg.t === 'subscribe') {
          const nextId = text(msg.roomId, 80);
          const room = rooms.get(nextId);
          // Validate membership before releasing the previous subscription.
          rooms.state(room, userId);
          if (roomId && roomId !== nextId) rooms.detach(roomId, userId, peer);
          roomId = nextId;
          rooms.attach(room, userId, peer);
        } else if (msg.t === 'command') {
          if (!roomId || msg.roomId !== roomId || !rooms.active(roomId, userId, peer)) throw new ApiError('连接已失效，请重新进入房间');
          peer.send({ t: 'ack', ...rooms.command(userId, msg) });
        } else throw new ApiError('未知消息');
      } catch (error) {
        const known = error instanceof ApiError || error instanceof SyntaxError;
        if (!known) app.log.error({ err: error }, 'websocket command failed');
        peer.send({ t: 'error', error: known ? (error as Error).message : '服务器暂时无法处理请求' });
      }
    });
    ws.on('close', () => {
      clearInterval(heartbeat); connections.delete(connection);
      if (roomId) rooms.detach(roomId, userId, peer);
    });
    lobby();
  });
  const timer = setInterval(() => {
    try { rooms.tick(); } catch (error) { app.log.error({ err: error }, 'room timer failed'); }
  }, 250);
  const cleanup = setInterval(() => store.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()), 3600_000);
  app.addHook('preClose', async () => {
    clearInterval(timer); clearInterval(cleanup);
    for (const connection of connections) connection.ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  app.addHook('onClose', async () => { store.close(); });
  return { app, store, rooms };
}
