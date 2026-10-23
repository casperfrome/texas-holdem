import { describe, expect, it } from 'vitest';
import { cryptoRandomInt, formatCard, isValidCard, newDeck, rankOf, shuffle, suitOf } from './cards';

describe('牌', () => {
  it('一副牌有 52 张且没有重复', () => {
    const deck = newDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.every(isValidCard)).toBe(true);
  });

  it('点数和花色', () => {
    expect(rankOf('2c')).toBe(2);
    expect(rankOf('Td')).toBe(10);
    expect(rankOf('As')).toBe(14);
    expect(suitOf('Kh')).toBe('h');
    expect(() => rankOf('1s')).toThrow();
    expect(() => suitOf('Ax')).toThrow();
    expect(isValidCard('Ax')).toBe(false);
    expect(isValidCard('A')).toBe(false);
  });

  it('显示格式', () => {
    expect(formatCard('Td')).toBe('10♦');
    expect(formatCard('As')).toBe('A♠');
  });
});

describe('洗牌', () => {
  it('洗牌后仍是同样的 52 张，原数组不变', () => {
    const deck = newDeck();
    const shuffled = shuffle(deck);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled)).toEqual(new Set(deck));
    expect(deck).toEqual(newDeck());
  });

  it('加密随机整数落在范围内', () => {
    for (let i = 0; i < 1000; i++) {
      const n = cryptoRandomInt(7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
    expect(() => cryptoRandomInt(0)).toThrow();
  });

  it('每张牌出现在每个位置的概率大致均匀', () => {
    // 3 张牌洗 60000 次，6 种排列各约 10000 次
    const counts = new Map<string, number>();
    for (let i = 0; i < 60000; i++) {
      const key = shuffle(['a', 'b', 'c']).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(9300);
      expect(c).toBeLessThan(10700);
    }
  });
});
