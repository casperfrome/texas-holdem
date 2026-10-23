import { describe, expect, it } from 'vitest';
import { newDeck } from './cards';
import { bestHand, Category, compareHands, evaluate5 } from './evaluate';

const h = (s: string) => s.split(' ');
const best = (s: string) => bestHand(h(s));
/** a 和 b 都是 7 张牌（或 5 张），返回 a 相对 b 的胜负符号 */
const cmp = (a: string, b: string) => Math.sign(compareHands(best(a), best(b)));

describe('牌型识别', () => {
  it.each([
    ['As Ks Qs Js Ts', Category.StraightFlush, '皇家同花顺'],
    ['9h 8h 7h 6h 5h', Category.StraightFlush, '同花顺'],
    ['5d 4d 3d 2d Ad', Category.StraightFlush, '同花顺'],
    ['Kc Kd Kh Ks 7c', Category.FourOfAKind, '四条'],
    ['Qc Qd Qh 5s 5c', Category.FullHouse, '葫芦'],
    ['Ad Jd 8d 6d 2d', Category.Flush, '同花'],
    ['Ts 9d 8c 7h 6s', Category.Straight, '顺子'],
    ['5s 4d 3c 2h As', Category.Straight, '顺子'],
    ['As Kd Qc Jh Ts', Category.Straight, '顺子'],
    ['8s 8d 8c Kh 3s', Category.ThreeOfAKind, '三条'],
    ['Js Jd 4c 4h As', Category.TwoPair, '两对'],
    ['Ts Td Kc 6h 3s', Category.OnePair, '一对'],
    ['As Qd 9c 6h 3s', Category.HighCard, '高牌'],
  ])('%s → %s', (cards, category, name) => {
    const v = evaluate5(h(cards));
    expect(v.category).toBe(category);
    expect(v.name).toBe(name);
  });

  it('Q-K-A-2-3 不是顺子', () => {
    expect(evaluate5(h('Qs Kd Ac 2h 3s')).category).toBe(Category.HighCard);
  });

  it('5 张牌全部 259 万种组合的牌型数量与理论值一致', () => {
    const deck = newDeck();
    const counts = new Array<number>(9).fill(0);
    const hand = ['', '', '', '', ''];
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++)
      for (let d = c + 1; d < 52; d++) for (let e = d + 1; e < 52; e++) {
        hand[0] = deck[a]!; hand[1] = deck[b]!; hand[2] = deck[c]!; hand[3] = deck[d]!; hand[4] = deck[e]!;
        counts[evaluate5(hand).category]!++;
      }
    expect(counts).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  }, 60000);
});

describe('从 7 张牌选最好的 5 张', () => {
  it('同时有同花和顺子时选同花', () => {
    const v = best('Ah 9h 8d 7h 6h 5c 2h');
    expect(v.category).toBe(Category.Flush);
    expect(v.tiebreak).toEqual([14, 9, 7, 6, 2]);
  });

  it('有顺子也有同花，但不是同花顺', () => {
    expect(best('9h 8h 7h 6h 5s 2h Kd').category).toBe(Category.Flush);
  });

  it('7 张里藏着同花顺', () => {
    const v = best('9h 8h 7h 6h 5h 4h 3h');
    expect(v.category).toBe(Category.StraightFlush);
    expect(v.tiebreak).toEqual([9]);
  });

  it('三个对子时取最大的两对，踢脚取剩下最大的', () => {
    const v = best('Ks Kd 9c 9h 4s 4d 3c');
    expect(v.category).toBe(Category.TwoPair);
    expect(v.tiebreak).toEqual([13, 9, 4]);
  });

  it('两个三条组成葫芦，取较大的三条', () => {
    const v = best('7s 7d 7c 5h 5s 5d Ac');
    expect(v.category).toBe(Category.FullHouse);
    expect(v.tiebreak).toEqual([7, 5]);
  });

  it('四条的踢脚取剩下最大的', () => {
    expect(best('9s 9d 9c 9h Ks Kd 2c').tiebreak).toEqual([9, 13]);
  });

  it('6 张连续牌取最大的顺子', () => {
    expect(best('4s 5d 6c 7h 8s 9d 2c').tiebreak).toEqual([9]);
  });

  it('A-2-3-4-5 和 6 同时存在时取 6 最大的顺子', () => {
    expect(best('As 2d 3c 4h 5s 6d Kc').tiebreak).toEqual([6]);
  });

  it('返回的 5 张牌按显示顺序排列', () => {
    expect(best('Qs Qd Qc 5h 5s 2d 3c').cards).toEqual(h('Qs Qd Qc 5h 5s'));
    expect(best('As 9d 3c Kh 5s Kd 2c').cards.map((c) => c[0])).toEqual(['K', 'K', 'A', '9', '5']);
    // 有一对 K 但能组成 A-2-3-4-5 顺子时，顺子更大
    expect(best('As 2d 3c 4h 5s Kd Kc').category).toBe(Category.Straight);
    expect(evaluate5(h('As 2d 3c 4h 5s')).cards.map((c) => c[0])).toEqual(['5', '4', '3', '2', 'A']);
  });

  it('拒绝重复的牌和错误的张数', () => {
    expect(() => best('As As Kd Qc Jh')).toThrow();
    expect(() => best('As Kd Qc Jh')).toThrow();
  });
});

describe('同牌型比大小', () => {
  const board = 'Ks 9d 7c 4h 2s';
  it('一对 K，比踢脚 Q > J', () => {
    expect(cmp(`Kh Qc ${board}`, `Kd Js ${board}`)).toBe(1);
  });

  it('打公共牌：底牌都用不上时平分', () => {
    const b = 'As Ad Kc Kh Qs';
    expect(cmp(`Jc 3d ${b}`, `Td 9h ${b}`)).toBe(0);
  });

  it('同花逐张比较，比到第 5 张', () => {
    expect(cmp('Ah Jh 8h 6h 3h', 'Ad Jd 8d 6d 2d')).toBe(1);
  });

  it('A-2-3-4-5 是最小的顺子', () => {
    expect(cmp('6s 5d 4c 3h 2s', '5s 4d 3c 2h As')).toBe(1);
  });

  it('葫芦先比三条再比对子', () => {
    expect(cmp('3s 3d 3c 2h 2s', '2c 2d 2h As Ad')).toBe(1);
    expect(cmp('Ts Td Tc 9h 9s', 'Th Tc Td 8h 8s')).toBe(1);
  });

  it('两对先比大对，再比小对，再比踢脚', () => {
    expect(cmp('As Ad 3c 3h 2s', 'Ks Kd Qc Qh As')).toBe(1);
    expect(cmp('As Ad 5c 5h 2s', 'Ac Ah 4c 4h Ks')).toBe(1);
    expect(cmp('As Ad 5c 5h Ks', 'Ac Ah 5d 5s Qs')).toBe(1);
  });

  it('花色不分大小', () => {
    expect(cmp('As Ks Qs Js 9s', 'Ah Kh Qh Jh 9h')).toBe(0);
  });

  it('第 6、7 张牌不参与比较', () => {
    // 两人最好的 5 张都是 A A K Q J，第 6 张的 9 和 2 不算
    expect(cmp('As Ad Kc Qh Js 9d 2c', 'Ah Ac Kd Qs Jc 2d 3h')).toBe(0);
  });
});
