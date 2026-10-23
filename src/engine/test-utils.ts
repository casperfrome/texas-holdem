// 测试用工具：可复现的随机数、按指定牌面排好的牌堆
import { type Card, newDeck, type RandomInt } from './cards';
import type { Seat } from './game';

/** 带种子的伪随机数（mulberry32），只用于测试 */
export function seededRandomInt(seed: number): RandomInt {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

/**
 * 按发牌顺序排好一副牌：先大盲、后庄家轮流发底牌，然后烧牌 + 翻牌、烧牌 + 转牌、烧牌 + 河牌。
 * seat0 / seat1 是两个座位的底牌，例如 "As Kd"；board 是 5 张公共牌。
 */
export function deckFor(button: Seat, seat0: string, seat1: string, board: string): Card[] {
  const hole: [Card[], Card[]] = [seat0.split(' '), seat1.split(' ')];
  const boardCards = board.split(' ');
  const bb: Seat = button === 0 ? 1 : 0;
  const placed: (Card | null)[] = [
    hole[bb][0]!, hole[button][0]!, hole[bb][1]!, hole[button][1]!,
    null, boardCards[0]!, boardCards[1]!, boardCards[2]!,
    null, boardCards[3]!,
    null, boardCards[4]!,
  ];
  const used = new Set(placed.filter((c): c is Card => c !== null));
  if (used.size !== 9) throw new Error('deckFor：指定的牌有重复');
  const rest = newDeck().filter((c) => !used.has(c));
  const deck = placed.map((c) => c ?? rest.shift()!);
  return [...deck, ...rest];
}
