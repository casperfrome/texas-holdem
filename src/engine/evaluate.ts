import { type Card, rankOf, suitOf } from './cards';

export enum Category {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export const CATEGORY_NAME: Record<Category, string> = {
  [Category.HighCard]: '高牌',
  [Category.OnePair]: '一对',
  [Category.TwoPair]: '两对',
  [Category.ThreeOfAKind]: '三条',
  [Category.Straight]: '顺子',
  [Category.Flush]: '同花',
  [Category.FullHouse]: '葫芦',
  [Category.FourOfAKind]: '四条',
  [Category.StraightFlush]: '同花顺',
};

export interface HandValue {
  category: Category;
  /** 同牌型时依次比较的点数，越靠前越重要 */
  tiebreak: number[];
  /** 组成这手牌的 5 张牌 */
  cards: Card[];
  /** 中文名称，例如 "葫芦"、"皇家同花顺" */
  name: string;
}

/** a 比 b 大返回正数，小返回负数，一样大返回 0 */
export function compareHands(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const d = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 5 张牌的牌型 */
export function evaluate5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`需要 5 张牌，收到 ${cards.length} 张`);
  const ranks = cards.map(rankOf).sort((x, y) => y - x);
  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  // 顺子的最大点数；A-2-3-4-5 算 5 最大
  let straightHigh = 0;
  const distinct = [...new Set(ranks)];
  if (distinct.length === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    else if (ranks.join() === '14,5,4,3,2') straightHigh = 5;
  }

  // 按"张数多的在前，同张数点数大的在前"分组，例如葫芦 → [[Q,3],[5,2]]
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts].sort((x, y) => y[1] - x[1] || y[0] - x[0]);
  const byGroup = groups.map(([r]) => r);
  const shape = groups.map(([, n]) => n).join('');

  let category: Category;
  let tiebreak: number[];
  if (straightHigh && isFlush) { category = Category.StraightFlush; tiebreak = [straightHigh]; }
  else if (shape === '41') { category = Category.FourOfAKind; tiebreak = byGroup; }
  else if (shape === '32') { category = Category.FullHouse; tiebreak = byGroup; }
  else if (isFlush) { category = Category.Flush; tiebreak = ranks; }
  else if (straightHigh) { category = Category.Straight; tiebreak = [straightHigh]; }
  else if (shape === '311') { category = Category.ThreeOfAKind; tiebreak = byGroup; }
  else if (shape === '221') { category = Category.TwoPair; tiebreak = byGroup; }
  else if (shape === '2111') { category = Category.OnePair; tiebreak = byGroup; }
  else { category = Category.HighCard; tiebreak = ranks; }

  const name = category === Category.StraightFlush && straightHigh === 14 ? '皇家同花顺' : CATEGORY_NAME[category];
  return { category, tiebreak, cards: orderForDisplay(cards, byGroup, straightHigh), name };
}

/** 显示顺序：对子/三条在前，顺子从大到小（A-2-3-4-5 时 A 放最后） */
function orderForDisplay(cards: Card[], byGroup: number[], straightHigh: number): Card[] {
  const weight = (c: Card) => {
    const r = rankOf(c);
    if (straightHigh === 5 && r === 14) return -1;
    return 100 - byGroup.indexOf(r) * 20 + r / 100;
  };
  return cards.slice().sort((a, b) => weight(b) - weight(a));
}

/** 从 5–7 张牌中选出最好的 5 张 */
export function bestHand(cards: Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error(`需要 5–7 张牌，收到 ${cards.length} 张`);
  if (new Set(cards).size !== cards.length) throw new Error(`有重复的牌：${cards.join(' ')}`);
  let best: HandValue | null = null;
  for (const combo of combinations(cards, 5)) {
    const v = evaluate5(combo);
    if (!best || compareHands(v, best) > 0) best = v;
  }
  return best!;
}

function* combinations<T>(items: T[], k: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === k) { yield picked.slice(); return; }
  for (let i = start; i <= items.length - (k - picked.length); i++) {
    picked.push(items[i]!);
    yield* combinations(items, k, i + 1, picked);
    picked.pop();
  }
}
