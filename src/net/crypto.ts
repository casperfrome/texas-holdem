// 端到端加密：中转服务器只能看到乱码。
//
// - 账号记录、带密码的房间：密码由人设置，可能很短，用 PBKDF2 慢哈希派生密钥。
// - 房主密钥、没密码的房间：本身就是 128 位随机数，用 HKDF 派生即可。
// - 房主和每个参与者之间：双方各有一对 ECDH 密钥，协商出只有两人知道的一对一密钥，
//   玩家的底牌只用它加密，观众即使知道房间密码也解不开。

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 128 位随机数，URL 安全的 base64 */
export function randomId(bytes = 16): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string, hexChars = 64): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, hexChars);
}

const aesKey = (raw: Uint8Array<ArrayBuffer>, extractable = false) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', extractable, ['encrypt', 'decrypt']);

/** 由高强度随机数派生 AES 密钥 */
export async function secretKey(secret: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('texas-holdem/v2'), info: enc.encode(info) }, base, 256);
  return aesKey(new Uint8Array(bits), true);
}

export const PBKDF2_ITERATIONS = 150_000;

/** 由人设置的密码派生 AES 密钥（可导出，方便记住登录状态） */
export async function passwordKey(password: string, salt: string, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, base, 256);
  return aesKey(new Uint8Array(bits), true);
}

export const exportKey = async (key: CryptoKey) => toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
export const importKey = (b64: string) => aesKey(fromBase64(b64), true);

export interface EcdhPair {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function generateEcdh(): Promise<EcdhPair> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

/** 只保留公钥需要的字段，便于比较和放进消息 */
export const publicPart = (jwk: JsonWebKey): JsonWebKey => ({ kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! });

/** 参与者编号：由公钥算出，别人无法冒用（没有对应的私钥就算不出一对一密钥） */
export const clientIdOf = (pub: JsonWebKey) => sha256Hex(`${pub.crv}.${pub.x}.${pub.y}`, 24);

/** 用自己的私钥和对方的公钥协商出一对一密钥；双方算出来的一样 */
export async function pairKey(myPrivate: JsonWebKey, theirPublic: JsonWebKey): Promise<CryptoKey> {
  const priv = await crypto.subtle.importKey('jwk', myPrivate, ECDH, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('jwk', publicPart(theirPublic), ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  return secretKey(toBase64(shared), 'pair/v2');
}

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
