import { describe, expect, it } from 'vitest';
import { seededRandomInt } from '../engine/test-utils';
import { GuestClient, HostController, type KeyValueStore } from '../game/client';
import { generateEcdh, importKey } from './crypto';
import {
  createHostedRoom, hostKeyOf, listingFor, type LobbyRoom, publishListing, removeListing, roomKeyOf, unlockRoom, watchLobby,
} from './lobby';
import { GuestLink, HostLink } from './room-conn';
import { MemoryBus, MemoryServer } from './test-bus';

const ITER = 1000;

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

describe('房间列表', () => {
  it('建的房间出现在列表里，房主在线的排前面；解散后消失', async () => {
    const server = new MemoryServer();
    const bus = new MemoryBus(server);
    const a = await createHostedRoom({ name: '甲的房间', password: '', maxWatchers: 2 }, ITER);
    const b = await createHostedRoom({ name: '乙的房间', password: '123', maxWatchers: 0 }, ITER);
    await publishListing(bus, listingFor(a, '甲', ['甲', null], 0));
    await publishListing(bus, listingFor(b, '乙', ['乙', '丙'], 0));
    await bus.publish(`thp/v2/r/${b.roomId}/host-online`, '1', { retain: true });

    let rooms: LobbyRoom[] = [];
    const viewer = new MemoryBus(server);
    watchLobby(viewer, (r) => { rooms = r; });
    await viewer.settle();
    expect(rooms.map((r) => [r.name, r.online, r.locked])).toEqual([['乙的房间', true, true], ['甲的房间', false, false]]);
    // 列表里不含房间密钥和房主密钥
    expect(JSON.stringify(rooms)).not.toContain(a.hostSecret);
    expect(JSON.stringify(rooms)).not.toContain(a.roomKey);

    await removeListing(bus, a.roomId);
    await viewer.settle();
    expect(rooms.map((r) => r.name)).toEqual(['乙的房间']);
  });

  it('密码对才能进，没密码的房间直接进', async () => {
    const locked = await createHostedRoom({ name: 'x', password: '123', maxWatchers: 2 }, ITER);
    const open = await createHostedRoom({ name: 'y', password: '', maxWatchers: 2 }, ITER);
    expect(await unlockRoom(listingFor(locked, 'h', ['h', null], 0), '12', ITER)).toBeNull();
    expect(await unlockRoom(listingFor(locked, 'h', ['h', null], 0), '123', ITER)).not.toBeNull();
    expect(await unlockRoom(listingFor(open, 'h', ['h', null], 0), '', ITER)).not.toBeNull();
  });
});

describe('经过中转的房间', () => {
  async function room(password = 'pw') {
    const server = new MemoryServer();
    const hosted = await createHostedRoom({ name: '房间', password, maxWatchers: 2 }, ITER);
    const hostLink = new HostLink({
      roomId: hosted.roomId, roomKey: await roomKeyOf(hosted), hostKey: await hostKeyOf(hosted), ecdh: hosted.ecdh,
      bus: new MemoryBus(server),
    });
    const host = new HostController(hostLink, { name: '房主', store: memoryStore(), random: seededRandomInt(3), maxWatchers: 2 });
    const listing = listingFor(hosted, '房主', ['房主', null], 0);
    const join = async (name: string, want: 'play' | 'watch', pw = password) => {
      const bus = new MemoryBus(server);
      const key = (await unlockRoom(listing, pw, ITER)) ?? await importKey(btoa('x'.repeat(32)));
      const link = new GuestLink({ roomId: hosted.roomId, roomKey: key, hostPublic: listing.hostPublic, ecdh: await generateEcdh(), bus });
      return { client: new GuestClient(link, { name, token: `t-${name}`, want }), bus };
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await new MemoryBus(server).settle(); };
    return { server, host, join, settle };
  }

  it('对手进房打牌；观众收到的密文里没有任何人的底牌', async () => {
    const { server, host, join, settle } = await room();
    const p = await join('小王', 'play');
    await settle();
    expect(host.getSnapshot().room!.seats).toEqual(['房主', '小王']);
    expect(p.client.getSnapshot().view!.hand!.players[1].hole).toHaveLength(2);

    const w = await join('老李', 'watch');
    await settle();
    const wv = w.client.getSnapshot().view!;
    expect(w.client.getSnapshot().room!.you).toBe('watcher');
    expect(wv.hand!.players[0].hole).toBeNull();
    expect(wv.hand!.players[1].hole).toBeNull();

    // 观众拿着房间密码，也解不开发给对手的画面
    const toPlayer = [...server.retained.entries()].filter(([t]) => t.includes('/to/'));
    expect(toPlayer.length).toBe(2);
  });

  it('密码不对的人发来的消息房主直接忽略', async () => {
    const { host, join, settle } = await room();
    const bad = await join('坏人', 'play', 'wrong');
    await settle();
    expect(host.getSnapshot().room!.seats[1]).toBeNull();
    expect(bad.client.getSnapshot().view).toBeNull();
  });
});
