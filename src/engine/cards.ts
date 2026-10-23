// 牌用两个字符表示：点数 + 花色，例如 "As" = 黑桃 A，"Td" = 方块 10
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // ♠ ♥ ♦ ♣

export type Card = string;

/** 返回一副按固定顺序排列的 52 张牌 */
export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** 点数数值：2 → 2 … A → 14 */
export function rankOf(card: Card): number {
  const i = RANKS.indexOf(card[0] ?? '');
  if (i < 0) throw new Error(`无效的牌：${card}`);
  return i + 2;
}

export function suitOf(card: Card): string {
  const s = card[1] ?? '';
  if (!SUITS.includes(s) || s === '') throw new Error(`无效的牌：${card}`);
  return s;
}

export function isValidCard(card: unknown): card is Card {
  return typeof card === 'string' && card.length === 2
    && RANKS.includes(card[0]!) && SUITS.includes(card[1]!);
}

/** 返回 [0, max) 之间的随机整数 */
export type RandomInt = (max: number) => number;

/** 用浏览器/Node 的加密随机数生成均匀分布的整数（拒绝采样，避免取模偏差） */
export const cryptoRandomInt: RandomInt = (max) => {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new Error(`无效的范围：${max}`);
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
};

/** Fisher–Yates 洗牌，返回新数组 */
export function shuffle<T>(items: readonly T[], randomInt: RandomInt = cryptoRandomInt): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 显示用："Td" → "10♦" */
export function formatCard(card: Card): string {
  const r = card[0] === 'T' ? '10' : card[0];
  return `${r}${SUIT_SYMBOL[card[1] ?? ''] ?? '?'}`;
}
