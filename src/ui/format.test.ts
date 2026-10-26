import { describe, expect, it } from 'vitest';
import { applyAction, bestHand, createMatch, legalActions, startHand, viewFor } from '../engine';
import { deckFor } from '../engine/test-utils';
import { describeEntry, describeHand, describeResult, namer, potSizedTo } from './format';

const name = (cards: string) => describeHand(bestHand(cards.split(' ')));

describe('牌型名称', () => {
  it.each([
    ['As Qd 9c 6h 3s', '高牌 A'],
    ['6h 6s Kc Jd 9s', '一对 6'],
    ['Ks Kd 8c 8h 2s', '两对 K 和 8'],
    ['7s 7d 7c Ah 2s', '三条 7'],
    ['7s 8d 9c Th Js', '顺子（7 到 J）'],
    ['As 2d 3c 4h 5s', '顺子（A 到 5）'],
    ['Ad Jd 8d 6d 2d', '同花（A 高）'],
    ['Qc Qd Qh 5s 5c', '葫芦（Q 带 5）'],
    ['9s 9d 9c 9h Ks', '四条 9'],
    ['5h 6h 7h 8h 9h', '同花顺（5 到 9）'],
    ['As Ks Qs Js Ts', '皇家同花顺'],
  ])('%s → %s', (cards, expected) => {
    expect(name(cards)).toBe(expected);
  });
});

describe('按底池比例下注', () => {
  const s = startHand(createMatch(), deckFor(0, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s'));

  it('小盲翻牌前满池加注是加到 30', () => {
    const view = viewFor(s, 0);
    expect(potSizedTo(view, view.legal!, 1)).toBe(30);
    expect(potSizedTo(view, view.legal!, 0.5)).toBe(20);
  });

  it('不超过上限、不低于下限', () => {
    const view = viewFor(s, 0);
    expect(potSizedTo(view, view.legal!, 1000)).toBe(1000);
    expect(potSizedTo(view, view.legal!, 0)).toBe(20);
  });

  it('翻牌后半池下注', () => {
    const flop = applyAction(applyAction(s, 0, { type: 'call' }), 1, { type: 'check' });
    const view = viewFor(flop, 1);
    expect(legalActions(flop, 1)!.canBet).toBe(true);
    expect(potSizedTo(view, view.legal!, 0.5)).toBe(10);
    expect(potSizedTo(view, view.legal!, 1)).toBe(20);
  });
});

describe('记录文字', () => {
  it('从各自视角描述', () => {
    const s = applyAction(startHand(createMatch(), deckFor(0, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s')), 0, { type: 'raise', to: 30 });
    const log = s.hand!.log;
    expect(log.map((e) => describeEntry(e, namer(0)))).toEqual(['你 放小盲 5', '对手 放大盲 10', '你 加注到 30']);
    expect(describeEntry(log[2]!, namer(1))).toBe('对手 加注到 30');
    expect(describeEntry(log[2]!, namer(1, ['小王', '老李']))).toBe('小王 加注到 30');
  });

  it('观众看两边都用名字', () => {
    const s = applyAction(startHand(createMatch(), deckFor(0, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s')), 0, { type: 'fold' });
    const who = namer(1, ['小王', '老李'], true);
    expect(describeEntry(s.hand!.log.find((e) => e.kind === 'action')!, who)).toBe('小王 弃牌');
    expect(describeResult(s.hand!.result!, who)).toEqual({ title: '老李赢了 10', detail: '小王弃牌了' });
    expect(describeResult(s.hand!.result!, namer(0, ['小王', '老李']))).toEqual({ title: '老李赢了 10', detail: '你弃牌了' });
  });

  it('超时自动的操作有标注', () => {
    expect(describeEntry({ kind: 'action', seat: 0, street: 'flop', action: 'check', amount: 0, to: 0, allIn: false, timeout: true }, namer(0)))
      .toBe('你 过牌（超时自动）');
  });
});
