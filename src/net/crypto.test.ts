import { describe, expect, it } from 'vitest';
import { deriveKeys, seal, unseal } from './crypto';
import { createRoom, guestLink, hostLink, parseRoomHash, parseRoomLink } from './room';

describe('房间链接', () => {
  it('房主链接和朋友链接都能解析回来', () => {
    const c = createRoom();
    const base = 'https://example.com/texas-holdem/';
    const host = parseRoomHash(new URL(hostLink(base, c)).hash);
    const guest = parseRoomHash(new URL(guestLink(base, c)).hash);
    expect(host).toEqual(c);
    expect(guest).toEqual({ room: c.room, hostSecret: null, broker: 'emqx' });
    expect(guestLink(base, c)).not.toContain(c.hostSecret);
  });

  it('非默认中转服务器写进链接', () => {
    const c = createRoom('hivemq');
    expect(guestLink('https://x/', c)).toMatch(/&b=hivemq$/);
    expect(parseRoomHash(new URL(guestLink('https://x/', c)).hash)?.broker).toBe('hivemq');
  });

  it('不认识的链接返回 null', () => {
    expect(parseRoomHash('')).toBeNull();
    expect(parseRoomHash('#host')).toBeNull();
    expect(parseRoomHash('#local=host')).toBeNull();
    expect(parseRoomHash('#join=short')).toBeNull();
    expect(parseRoomHash('#host=abcdefghijklmnopqrstuv')).toBeNull(); // 缺房主密钥
    expect(parseRoomHash('#join=abcdefghijklmnop<script>')).toBeNull();
  });

  it('粘贴整条链接、只粘贴 # 后面、前后有空格都能识别', () => {
    const c = createRoom();
    const url = hostLink('https://casperfrome.github.io/texas-holdem/', c);
    expect(parseRoomLink(url)).toEqual(c);
    expect(parseRoomLink(`  ${url}\n`)).toEqual(c);
    expect(parseRoomLink(url.slice(url.indexOf('#')))).toEqual(c);
    expect(parseRoomLink(`join=${c.room}`)).toEqual({ ...c, hostSecret: null });
    expect(parseRoomLink('你好')).toBeNull();
    expect(parseRoomLink('https://casperfrome.github.io/texas-holdem/')).toBeNull();
  });

  it('每次创建的房间都不一样', () => {
    const a = createRoom();
    const b = createRoom();
    expect(a.room).not.toBe(b.room);
    expect(a.hostSecret).not.toBe(b.hostSecret);
  });
});

describe('加密', () => {
  it('同一房间派生出相同的频道和密钥，朋友没有房主密钥', async () => {
    const c = createRoom();
    const host = await deriveKeys(c);
    const guest = await deriveKeys({ ...c, hostSecret: null });
    expect(host.topicId).toBe(guest.topicId);
    expect(host.topicId).toMatch(/^[0-9a-f]{32}$/);
    expect(host.hostKey).not.toBeNull();
    expect(guest.hostKey).toBeNull();
    // 房主加密的消息朋友能解开
    const text = await seal(host.roomKey, { hello: '你好', n: [1, 2] });
    expect(await unseal(guest.roomKey, text)).toEqual({ hello: '你好', n: [1, 2] });
  });

  it('频道地址不包含口令', async () => {
    const c = createRoom();
    const { topicId } = await deriveKeys(c);
    expect(topicId).not.toContain(c.room);
  });

  it('不同房间的钥匙解不开，被篡改的消息解不开', async () => {
    const a = await deriveKeys(createRoom());
    const b = await deriveKeys(createRoom());
    expect(a.topicId).not.toBe(b.topicId);
    const text = await seal(a.roomKey, { x: 1 });
    await expect(unseal(b.roomKey, text)).rejects.toThrow();
    const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(unseal(a.roomKey, tampered)).rejects.toThrow();
  });

  it('房主存档只有房主密钥能解开', async () => {
    const c = createRoom();
    const host = await deriveKeys(c);
    const guest = await deriveKeys({ ...c, hostSecret: null });
    const saved = await seal(host.hostKey!, { deck: ['As', 'Kd'] });
    await expect(unseal(guest.roomKey, saved)).rejects.toThrow();
    expect(await unseal(host.hostKey!, saved)).toEqual({ deck: ['As', 'Kd'] });
  });

  it('同样内容每次加密结果不同（随机 IV）', async () => {
    const { roomKey } = await deriveKeys(createRoom());
    expect(await seal(roomKey, 1)).not.toBe(await seal(roomKey, 1));
  });

  it('大消息也能加解密', async () => {
    const { roomKey } = await deriveKeys(createRoom());
    const big = { s: 'x'.repeat(200_000) };
    expect(await unseal(roomKey, await seal(roomKey, big))).toEqual(big);
  });
});
