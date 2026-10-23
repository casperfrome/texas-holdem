// 端到端加密：中转服务器只能看到乱码。
// 口令和房主密钥都是 128 位随机数，用 HKDF 派生即可，不需要 PBKDF2 那样的慢哈希。
import type { RoomCredentials } from './room';

export interface RoomKeys {
  /** 双方共用：加密所有往来消息 */
  roomKey: CryptoKey;
  /** 只有房主有：加密完整牌局存档（包括没发的牌） */
  hostKey: CryptoKey | null;
  /** 频道地址，由口令派生，不暴露口令本身 */
  topicId: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function hkdf(secret: string, info: string, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const out = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('texas-holdem-heads-up'), info: enc.encode(info) }, base, bits);
  return new Uint8Array(out);
}

const aesKey = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function deriveKeys(c: RoomCredentials): Promise<RoomKeys> {
  const roomKey = await aesKey(await hkdf(c.room, 'room-key/v1', 256));
  const topicBytes = await hkdf(c.room, 'topic/v1', 128);
  const topicId = Array.from(topicBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hostKey = c.hostSecret ? await aesKey(await hkdf(`${c.room}~${c.hostSecret}`, 'host-key/v1', 256)) : null;
  return { roomKey, hostKey, topicId };
}

function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 加密成 base64 文本：12 字节随机 IV + AES-GCM 密文 */
export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

/** 解密失败（密钥不对或被篡改）时抛出异常 */
export async function unseal(key: CryptoKey, text: string): Promise<unknown> {
  const u8 = fromBase64(text);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12));
  return JSON.parse(dec.decode(pt));
}
