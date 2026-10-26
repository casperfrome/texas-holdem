// Three independent authenticated sessions against the real HTTP/WebSocket server.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const origin = process.env.PUBLIC_ORIGIN ?? base;
const prefix = `qa${Date.now().toString(36)}`;
const password = randomBytes(16).toString('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (test()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
async function request(path, cookie = '', method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return { result, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
}
const accounts = [];
const peers = [];
let roomId;
let owner;
async function connect(account) {
  const peer = { account, state: null, acks: new Map(), events: [], ws: null };
  peers.push(peer);
  peer.ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { origin, headers: { Cookie: account.cookie } });
  peer.ws.on('error', () => {});
  peer.ws.on('message', (bytes) => {
    const event = JSON.parse(bytes.toString()); peer.events.push(event);
    if (event.t === 'state') peer.state = event;
    if (event.t === 'ack') peer.acks.set(event.id, event);
  });
  await until(() => peer.ws.readyState === WebSocket.OPEN, 'websocket open');
  peer.ws.send(JSON.stringify({ t: 'subscribe', v: 3, roomId }));
  await until(() => peer.state !== null, 'room subscribe');
  return peer;
}
let sequence = 0;
async function command(peer, op, action, raw) {
  const msg = raw ?? {
    t: 'command', v: 3, id: `smoke-${++sequence}`, roomId,
    epoch: peer.state.epoch, version: peer.state.version, op, ...(action ? { action } : {}),
  };
  peer.acks.delete(msg.id);
  peer.ws.send(JSON.stringify(msg));
  await until(() => peer.acks.has(msg.id), 'command acknowledgment');
  return { ack: peer.acks.get(msg.id), msg };
}
try {
  for (const suffix of ['a', 'b', 'c']) {
    const response = await request('/auth/register', '', 'POST', { username: prefix + suffix, password });
    accounts.push({ ...response.result.user, cookie: response.cookie });
  }
  const created = await request('/rooms', accounts[0].cookie, 'POST', { name: '部署验收', password, maxWatchers: 2 });
  roomId = created.result.room.roomId;
  owner = await connect(accounts[0]);
  await request(`/rooms/${roomId}/join`, accounts[1].cookie, 'POST', { password: 'wrong', want: 'play' }, 403);
  await request(`/rooms/${roomId}/join`, accounts[1].cookie, 'POST', { password, want: 'play' });
  let player = await connect(accounts[1]);
  await request(`/rooms/${roomId}/join`, accounts[2].cookie, 'POST', { password, want: 'watch' });
  let watcher = await connect(accounts[2]);
  await until(() => owner.state.view.hand && player.state.view.hand, 'game started');
  assert.equal(owner.state.view.hand.players[1].hole, null);
  assert.equal(player.state.view.hand.players[0].hole, null);
  assert(watcher.state.view.hand.players.every((p) => p.hole === null));
  assert(!JSON.stringify(watcher.state).includes('"deck"'));
  assert((await command(watcher, 'action', { type: 'allin' })).ack.error.includes('观众'));
  const previous = player;
  player = await connect(accounts[1]);
  await until(() => previous.events.some((e) => e.t === 'superseded'), 'device takeover');
  assert.equal((await command(owner, 'stand')).ack.error, undefined);
  assert.equal(owner.state.seat, null); assert.equal(owner.state.owner, true);
  assert.equal((await command(watcher, 'sit')).ack.error, undefined);
  await until(() => watcher.state.seat === 0 && player.state.room.seats[0] === accounts[2].username, 'seat zero reassigned');
  console.log('PASS: authentication, room password, card isolation, takeover, owner standing, seat zero');
  let last;
  for (let i = 0; i < 200 && watcher.state.view.matchWinner === null; i++) {
    if (watcher.state.view.hand.result) last = await command(watcher, 'next');
    else {
      const actor = watcher.state.view.hand.toAct === 0 ? watcher : player;
      last = await command(actor, 'action', { type: 'allin' });
    }
    assert.equal(last.ack.error, undefined);
  }
  assert.notEqual(watcher.state.view.matchWinner, null);
  assert.equal(player.state.stats.won + watcher.state.stats.won, 1);
  assert.equal(player.state.stats.lost + watcher.state.stats.lost, 1);
  const duplicateActor = peers.findLast((p) => p.acks.has(last.msg.id));
  const version = duplicateActor.state.version;
  assert.equal((await command(duplicateActor, '', undefined, last.msg)).ack.error, undefined);
  assert.equal(duplicateActor.state.version, version);
  console.log('PASS: complete match, exactly-once statistics and duplicate request');
  assert.equal((await command(watcher, 'next')).ack.error, undefined);
  const before = structuredClone(watcher.state);
  const timedOut = before.view.hand.toAct === 0 ? watcher : player;
  timedOut.ws.close();
  await pause(17_000);
  const restored = await connect(timedOut.account);
  assert(restored.state.view.hand.log.some((e) => e.timeout));
  assert.deepEqual(restored.state.view.hand.players.map((p) => p.hole === null ? null : p.hole), timedOut.state.view.hand.players.map((p) => p.hole === null ? null : p.hole));
  if (timedOut === watcher) watcher = restored; else player = restored;
  console.log('PASS: real server timeout and reconnection');
  if (process.env.SMOKE_RESTART_SERVICE === '1') {
    const snapshot = structuredClone(player.state);
    execFileSync('systemctl', ['restart', 'texas-holdem'], { stdio: 'pipe' });
    for (let i = 0; i < 40; i++) {
      try { await request('/health'); break; } catch { await pause(250); }
    }
    owner = await connect(accounts[0]); player = await connect(accounts[1]); watcher = await connect(accounts[2]);
    assert.equal(player.state.epoch, snapshot.epoch);
    assert.deepEqual(player.state.view.stacks, snapshot.view.stacks);
    assert.deepEqual(player.state.view.hand.players.map((p) => p.hole), snapshot.view.hand.players.map((p) => p.hole));
    console.log('PASS: systemd restart, persistent users, sessions, seats, stacks and cards');
  }
  console.log('SMOKE PASSED');
} finally {
  for (const peer of peers) peer.ws?.close();
  if (roomId && accounts[0]) await request(`/rooms/${roomId}`, accounts[0].cookie, 'DELETE');
  if (process.env.SMOKE_CLEAN_DB && accounts.length) {
    await pause(100);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(process.env.SMOKE_CLEAN_DB);
    db.transaction(() => {
      for (const account of accounts) {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(account.id);
        db.prepare('DELETE FROM results WHERE winner=? OR loser=?').run(account.id, account.id);
        db.prepare('DELETE FROM users WHERE id=? AND normalized=?').run(account.id, account.username.toLowerCase());
      }
    })();
    db.close();
  }
}
