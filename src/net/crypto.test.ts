import { describe, expect, it } from 'vitest';
import { clientIdOf, generateEcdh, pairKey, passwordKey, randomId, seal, secretKey, unseal } from './crypto';
import { parseInviteHash, inviteLink } from './room';

describe('邀请链接', () => {
  it('能解析回房间号，不认识的返回 null', () => {
    const id = randomId();
    expect(parseInviteHash(new URL(inviteLink('https://x/texas-holdem/', id, 'emqx')).hash)).toEqual({ roomId: id, broker: 'emqx' });
    expect(inviteLink('https://x/', id, 'emqx')).not.toContain('&b=');
    expect(parseInviteHash(new URL(inviteLink('https://x/', id, 'hivemq')).hash)).toEqual({ roomId: id, broker: 'hivemq' });
    expect(parseInviteHash(`#room=${id}&b=nope`)!.broker).toBe('emqx');
    expect(parseInviteHash('')).toBeNull();
    expect(parseInviteHash('#local=host')).toBeNull();
    expect(parseInviteHash('#room=short')).toBeNull();
    expect(parseInviteHash('#room=abcdefghijklmnop<script>')).toBeNull();
  });
});

describe('加密', () => {
  it('同一密码和盐派生出同一个密钥，密码不对解不开', async () => {
    const salt = randomId();
    const a = await passwordKey('1', salt, 1000);
    const b = await passwordKey('1', salt, 1000);
    const wrong = await passwordKey('2', salt, 1000);
    const text = await seal(a, { hello: '你好', n: [1, 2] });
    expect(await unseal(b, text)).toEqual({ hello: '你好', n: [1, 2] });
    await expect(unseal(wrong, text)).rejects.toThrow();
  });

  it('同一密码换了盐就是不同的密钥', async () => {
    const a = await passwordKey('1', randomId(), 1000);
    const b = await passwordKey('1', randomId(), 1000);
    await expect(unseal(b, await seal(a, 1))).rejects.toThrow();
  });

  it('房主和参与者各自算出同一个一对一密钥，第三个人算不出', async () => {
    const host = await generateEcdh();
    const guest = await generateEcdh();
    const other = await generateEcdh();
    const k1 = await pairKey(host.privateJwk, guest.publicJwk);
    const k2 = await pairKey(guest.privateJwk, host.publicJwk);
    const k3 = await pairKey(other.privateJwk, host.publicJwk);
    const text = await seal(k1, { hole: ['As', 'Kd'] });
    expect(await unseal(k2, text)).toEqual({ hole: ['As', 'Kd'] });
    await expect(unseal(k3, text)).rejects.toThrow();
  });

  it('参与者编号由公钥决定', async () => {
    const a = await generateEcdh();
    const b = await generateEcdh();
    expect(await clientIdOf(a.publicJwk)).toBe(await clientIdOf({ ...a.publicJwk }));
    expect(await clientIdOf(a.publicJwk)).not.toBe(await clientIdOf(b.publicJwk));
    expect(await clientIdOf(a.publicJwk)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('被篡改的消息解不开；同样内容每次加密结果不同', async () => {
    const key = await secretKey(randomId(), 'test');
    const text = await seal(key, { x: 1 });
    const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    await expect(unseal(key, btoa(String.fromCharCode(...bytes)))).rejects.toThrow();
    expect(await seal(key, 1)).not.toBe(await seal(key, 1));
  });

  it('大消息也能加解密', async () => {
    const key = await secretKey(randomId(), 'test');
    const big = { s: 'x'.repeat(200_000) };
    expect(await unseal(key, await seal(key, big))).toEqual(big);
  });
});
