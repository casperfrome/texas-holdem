import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';
import { buildApp } from './app';
import type { ServerEvent } from '../src/shared/server-protocol';
import { api } from '../src/net/server';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const instance of apps.splice(0)) await instance.app.close(); });
async function setup() {
  const instance = await buildApp({ database: ':memory:', origin: 'http://localhost:5173', rateLimit: false });
  apps.push(instance); return instance;
}
it('supports the browser API client for body-less leave, delete and logout requests over real HTTP', async () => {
  const { app } = await setup();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const actualFetch = globalThis.fetch;
  const registration = await actualFetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'browser', password: 'x' }),
  });
  const cookie = registration.headers.get('set-cookie')!.split(';')[0]!;
  vi.stubGlobal('fetch', (path: string, init: RequestInit = {}) => actualFetch(`${base}${path}`, {
    ...init, headers: { ...init.headers, Cookie: cookie, Origin: 'http://localhost:5173' },
  }));
  const created = await api<{ room: { roomId: string } }>('/rooms', 'POST', { name: 'browser room', password: '', maxWatchers: 2 });
  const path = `/rooms/${created.room.roomId}`;
  await expect(api(`${path}/leave`, 'POST')).resolves.toEqual({ ok: true });
  await expect(api(path, 'DELETE')).resolves.toEqual({ ok: true });
  await expect(api('/auth/logout', 'POST')).resolves.toEqual({ ok: true });
  expect((await actualFetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status).toBe(401);
});
it('authenticates with hashed passwords, normalized unique usernames and protected cookies', async () => {
  const { app, store } = await setup();
  expect((await app.inject('/api/me')).statusCode).toBe(401);
  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: ' Alice ', password: 'secret' } });
  expect(register.statusCode).toBe(200);
  const cookie = register.headers['set-cookie'] as string;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax');
  expect((store.db.prepare('SELECT password FROM users').get() as { password: string }).password).not.toContain('secret');
  expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ALICE', password: 'x' } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'wrong' } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.username).toBe('Alice');
  expect((await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
});
it('validates room passwords and permissions and rejects forged websocket membership', async () => {
  const { app } = await setup();
  const account = async (name: string) => (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, password: 'x' } })).headers['set-cookie'] as string;
  const owner = await account('owner'); const guest = await account('guest');
  const create = await app.inject({ method: 'POST', url: '/api/rooms', headers: { cookie: owner }, payload: { name: 'room', password: 'locked', maxWatchers: 2 } });
  const id = create.json().room.roomId as string;
  const join = (password: string) => app.inject({ method: 'POST', url: `/api/rooms/${id}/join`, headers: { cookie: guest }, payload: { password, want: 'play' } });
  expect((await join('wrong')).statusCode).toBe(403);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: 'http://localhost:5173', headers: { cookie: guest } });
  const received: ServerEvent[] = []; ws.on('message', (bytes) => received.push(JSON.parse(bytes.toString()) as ServerEvent));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'subscribe', v: 3, roomId: id }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(received.some((e) => e.t === 'error' && e.error.includes('加入'))).toBe(true);
  expect(received.some((e) => e.t === 'state')).toBe(false);
  expect((await join('locked')).statusCode).toBe(200);
  ws.send(JSON.stringify({ t: 'subscribe', v: 3, roomId: id }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(received.some((e) => e.t === 'state' && e.seat === 1)).toBe(true);
  expect((await app.inject({ method: 'DELETE', url: `/api/rooms/${id}`, headers: { cookie: guest } })).statusCode).toBe(403);
  ws.close(); await once(ws, 'close');
});
