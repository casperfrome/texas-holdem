import { describe, expect, it } from 'vitest';
import {
  type Action, applyAction, createMatch, IllegalActionError, legalActions,
  type MatchState, type Seat, startHand, startNextMatch,
} from './game';
import { deckFor } from './test-utils';
import { viewFor } from './view';

// 默认：seat0 拿 AA，seat1 拿 KK，公共牌对谁都没帮助
const AA_VS_KK = deckFor(0, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s');

/** 依次执行一串行动，每项是 [座位, 行动] */
function play(state: MatchState, ...steps: [Seat, Action][]): MatchState {
  return steps.reduce((s, [seat, action]) => applyAction(s, seat, action), state);
}
const check: Action = { type: 'check' };
const call: Action = { type: 'call' };
const fold: Action = { type: 'fold' };
const raise = (to: number): Action => ({ type: 'raise', to });
const bet = (to: number): Action => ({ type: 'bet', to });
const allin: Action = { type: 'allin' };

/** 双方一路过牌/跟注到河牌结束 */
function checkDown(state: MatchState): MatchState {
  let s = state;
  while (s.hand && !s.hand.result) {
    const seat = s.hand.toAct!;
    s = applyAction(s, seat, legalActions(s, seat)!.canCheck ? check : call);
  }
  return s;
}

function withStacks(stacks: [number, number], button: Seat = 0): MatchState {
  const m = createMatch(undefined, button);
  m.stacks = stacks;
  return m;
}

describe('盲注与行动顺序', () => {
  it('庄家放小盲、对方放大盲，翻牌前庄家先行动，翻牌后大盲先行动', () => {
    let s = startHand(createMatch(), AA_VS_KK);
    const h = s.hand!;
    expect(h.button).toBe(0);
    expect(h.players[0]).toMatchObject({ stack: 995, bet: 5, hole: ['As', 'Ad'] });
    expect(h.players[1]).toMatchObject({ stack: 990, bet: 10, hole: ['Kc', 'Kd'] });
    expect(h.toAct).toBe(0);
    expect(legalActions(s, 0)).toMatchObject({ canCheck: false, canCall: true, callAmount: 5, canRaise: true, minTo: 20, maxTo: 1000 });
    expect(legalActions(s, 1)).toBeNull();

    s = applyAction(s, 0, call);
    // 小盲只补齐时，大盲还有一次"选择权"
    expect(s.hand!.toAct).toBe(1);
    expect(legalActions(s, 1)).toMatchObject({ canCheck: true, canCall: false, canRaise: true, minTo: 20 });

    s = applyAction(s, 1, check);
    expect(s.hand!.street).toBe('flop');
    expect(s.hand!.board).toEqual(['2c', '7d', '9h']);
    expect(s.hand!.toAct).toBe(1);

    s = play(s, [1, check], [0, check]);
    expect(s.hand!.street).toBe('turn');
    expect(s.hand!.board).toHaveLength(4);
    expect(s.hand!.toAct).toBe(1);
  });

  it('每手牌交换庄家，盲注跟着交换', () => {
    let s = checkDown(startHand(createMatch(), AA_VS_KK));
    s = startHand(s, deckFor(1, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s'));
    const h = s.hand!;
    expect(h.number).toBe(2);
    expect(h.button).toBe(1);
    expect(h.players[1].bet).toBe(5);
    expect(h.players[0].bet).toBe(10);
    expect(h.toAct).toBe(1);
  });

  it('大盲在小盲溜入后加注，小盲可以再加注', () => {
    const s = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, raise(30)]);
    expect(s.hand!.toAct).toBe(0);
    expect(legalActions(s, 0)).toMatchObject({ canRaise: true, minTo: 50, callAmount: 20 });
  });
});

describe('下注与加注金额', () => {
  it('最小加注增量不能小于上一次的增量', () => {
    let s = startHand(createMatch(), AA_VS_KK);
    expect(() => applyAction(s, 0, raise(15))).toThrow(IllegalActionError);
    s = applyAction(s, 0, raise(30)); // 增量 20
    expect(legalActions(s, 1)).toMatchObject({ minTo: 50 });
    expect(() => applyAction(s, 1, raise(45))).toThrow('50');
    s = applyAction(s, 1, raise(50));
    expect(legalActions(s, 0)).toMatchObject({ minTo: 70, callAmount: 20 });
    s = applyAction(s, 0, raise(200)); // 增量 150
    expect(legalActions(s, 1)).toMatchObject({ minTo: 350 });
  });

  it('翻牌后最小下注是一个大盲', () => {
    let s = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, check]);
    expect(legalActions(s, 1)).toMatchObject({ canBet: true, canRaise: false, minTo: 10 });
    expect(() => applyAction(s, 1, bet(5))).toThrow(IllegalActionError);
    expect(() => applyAction(s, 1, raise(20))).toThrow('请选择下注');
    s = applyAction(s, 1, bet(10));
    expect(legalActions(s, 0)).toMatchObject({ canCheck: false, canRaise: true, minTo: 20 });
    expect(() => applyAction(s, 0, check)).toThrow('不能过牌');
    expect(() => applyAction(s, 0, bet(20))).toThrow('请选择加注');
  });

  it('拒绝非整数金额和没有需要跟的注时跟注', () => {
    const s = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, check]);
    expect(() => applyAction(s, 1, bet(10.5))).toThrow(IllegalActionError);
    expect(() => applyAction(s, 1, call)).toThrow('请选择过牌');
  });

  it('下注上限是有效筹码（双方较少的那份）', () => {
    const s = startHand(withStacks([1000, 100]), AA_VS_KK);
    expect(legalActions(s, 0)).toMatchObject({ maxTo: 100 });
    expect(() => applyAction(s, 0, raise(101))).toThrow(IllegalActionError);
  });
});

describe('弃牌', () => {
  it('弃牌后对方赢下底池，没人跟的下注退回', () => {
    const s = play(startHand(createMatch(), AA_VS_KK), [0, raise(30)], [1, fold]);
    const r = s.hand!.result!;
    expect(r).toMatchObject({ reason: 'fold', winners: [0], pot: 20, won: [20, 0], hands: null });
    expect(s.stacks).toEqual([1010, 990]);
    expect(s.hand!.log).toContainEqual({ kind: 'return', seat: 0, amount: 20 });
    expect(s.hand!.board).toEqual([]);
    expect(s.nextButton).toBe(1);
  });

  it('可以在能过牌时弃牌', () => {
    const s = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, fold]);
    expect(s.hand!.result!.winners).toEqual([0]);
    expect(s.stacks).toEqual([1010, 990]);
  });
});

describe('非法时机', () => {
  it('没轮到自己、这手牌已结束、上一手没结束都不能操作', () => {
    const s = startHand(createMatch(), AA_VS_KK);
    expect(() => applyAction(s, 1, call)).toThrow('还没轮到你');
    expect(() => startHand(s, AA_VS_KK)).toThrow('还没结束');
    const done = applyAction(s, 0, fold);
    expect(() => applyAction(done, 1, check)).toThrow('没有进行中');
    expect(() => applyAction(createMatch(), 0, check)).toThrow('没有进行中');
    expect(() => startNextMatch(done)).toThrow('还没结束');
  });

  it('不修改传入的状态', () => {
    const s = startHand(createMatch(), AA_VS_KK);
    const before = JSON.stringify(s);
    applyAction(s, 0, raise(30));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('拒绝无效的配置和牌堆', () => {
    expect(() => createMatch({ startingStack: 1000, smallBlind: 20, bigBlind: 10 })).toThrow();
    expect(() => createMatch({ startingStack: 0, smallBlind: 5, bigBlind: 10 })).toThrow();
    expect(() => startHand(createMatch(), AA_VS_KK.slice(1))).toThrow('52');
  });
});

describe('摊牌', () => {
  it('过牌到底，牌大的赢，非庄家先亮牌', () => {
    const s = checkDown(play(startHand(createMatch(), AA_VS_KK), [0, call]));
    const r = s.hand!.result!;
    expect(r.reason).toBe('showdown');
    expect(r.winners).toEqual([0]);
    expect(r.pot).toBe(20);
    expect(r.hands![0].name).toBe('一对');
    expect(r.showOrder).toEqual([1, 0]);
    expect(s.stacks).toEqual([1010, 990]);
  });

  it('河牌圈最后下注的人先亮牌', () => {
    const toRiver = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, check], [1, check], [0, check], [1, check], [0, check]);
    expect(toRiver.hand!.street).toBe('river');
    expect(play(toRiver, [1, bet(20)], [0, call]).hand!.result!.showOrder).toEqual([1, 0]);
    expect(play(toRiver, [1, check], [0, bet(20)], [1, call]).hand!.result!.showOrder).toEqual([0, 1]);
    expect(play(toRiver, [1, check], [0, bet(20)], [1, raise(60)], [0, call]).hand!.result!.showOrder).toEqual([1, 0]);
  });

  it('打公共牌时平分底池', () => {
    const s = checkDown(play(startHand(createMatch(), deckFor(0, '2c 3d', '4h 5c', 'As Ks Qs Js Ts')), [0, call]));
    const r = s.hand!.result!;
    expect(r.winners).toEqual([0, 1]);
    expect(r.won).toEqual([10, 10]);
    expect(r.hands![0].name).toBe('皇家同花顺');
    expect(s.stacks).toEqual([1000, 1000]);
  });

  it('同一对比踢脚', () => {
    const s = checkDown(play(startHand(createMatch(), deckFor(0, 'Kh Qc', 'Kd Js', 'Ks 9d 7c 4h 2s')), [0, call]));
    expect(s.hand!.result!.winners).toEqual([0]);
  });
});

describe('全下', () => {
  it('全下被跟注后直接发完公共牌并摊牌，输光的一方输掉本局', () => {
    let s = play(startHand(createMatch(), AA_VS_KK), [0, allin]);
    expect(s.hand!.players[0]).toMatchObject({ stack: 0, bet: 1000 });
    // 对方已全下，只能跟注或弃牌
    expect(legalActions(s, 1)).toMatchObject({ canRaise: false, canBet: false, canCall: true, callAmount: 990 });
    s = applyAction(s, 1, call);
    const h = s.hand!;
    expect(h.board).toHaveLength(5);
    expect(h.log.filter((e) => e.kind === 'street').map((e) => e.kind === 'street' && e.street)).toEqual(['flop', 'turn', 'river']);
    expect(h.result).toMatchObject({ reason: 'showdown', winners: [0], pot: 2000, showOrder: [0, 1] });
    expect(s.stacks).toEqual([2000, 0]);
    expect(s.matchWinner).toBe(0);
    expect(s.matchWins).toEqual([1, 0]);
    expect(() => startHand(s, AA_VS_KK)).toThrow('本局已结束');

    s = startNextMatch(s);
    expect(s).toMatchObject({ stacks: [1000, 1000], matchNumber: 2, matchWinner: null, matchWins: [1, 0], nextButton: 1 });
    s = startHand(s, deckFor(1, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s'));
    expect(s.hand!.button).toBe(1);
  });

  it('筹码多的一方全下，超出对方筹码的部分不会投入', () => {
    let s = startHand(withStacks([1500, 500]), deckFor(0, 'Kc Kd', 'As Ad', '2c 7d 9h Js 3s'));
    s = applyAction(s, 0, allin);
    expect(s.hand!.players[0]).toMatchObject({ bet: 500, stack: 1000 });
    s = applyAction(s, 1, call);
    expect(s.hand!.result).toMatchObject({ winners: [1], pot: 1000 });
    expect(s.stacks).toEqual([1000, 1000]);
    expect(s.matchWinner).toBeNull();
  });

  it('筹码少的一方全下后，对方不能再加注', () => {
    let s = startHand(withStacks([300, 1700]), AA_VS_KK);
    s = applyAction(s, 0, allin);
    expect(s.hand!.players[0]).toMatchObject({ bet: 300, stack: 0 });
    expect(legalActions(s, 1)).toMatchObject({ canRaise: false, canCall: true, callAmount: 290 });
    expect(() => applyAction(s, 1, raise(600))).toThrow(IllegalActionError);
    s = applyAction(s, 1, call);
    expect(s.stacks).toEqual([600, 1400]);
  });

  it('跟注不够时全下跟注，多出的下注退回', () => {
    let s = startHand(withStacks([1000, 300], 1), deckFor(1, 'As Ad', 'Kc Kd', '2c 7d 9h Js 3s'));
    // seat1 是庄家（小盲），seat0 大盲
    s = play(s, [1, call], [0, check]);
    // 下注上限按有效筹码封顶：seat1 只剩 290
    expect(() => applyAction(s, 0, bet(500))).toThrow('290');
    s = applyAction(s, 0, allin);
    expect(s.hand!.players[0]).toMatchObject({ bet: 290, stack: 700 });
    // seat1 的"全下"此时就是全部跟注
    s = applyAction(s, 1, allin);
    expect(s.hand!.log.filter((e) => e.kind === 'action').at(-1)).toMatchObject({ kind: 'action', action: 'call', amount: 290, allIn: true });
    expect(s.hand!.result).toMatchObject({ winners: [0], pot: 600 });
    expect(s.stacks).toEqual([1300, 0]);
    expect(s.matchWinner).toBe(0);
  });

  it('翻牌后全下：之后的街不再下注', () => {
    let s = play(startHand(createMatch(), AA_VS_KK), [0, call], [1, check], [1, bet(20)], [0, allin]);
    expect(s.hand!.players[0]).toMatchObject({ stack: 0, bet: 990 });
    s = applyAction(s, 1, fold);
    expect(s.hand!.result).toMatchObject({ reason: 'fold', winners: [0], pot: 60 });
    expect(s.stacks).toEqual([1030, 970]);
  });
});

describe('筹码不够盲注', () => {
  it('小盲筹码不足：放入全部，大盲无需行动，多出的退回', () => {
    const s = startHand(withStacks([3, 1997]), AA_VS_KK);
    const h = s.hand!;
    expect(h.log[0]).toEqual({ kind: 'blind', seat: 0, blind: 'sb', amount: 3, allIn: true });
    expect(h.log).toContainEqual({ kind: 'return', seat: 1, amount: 7 });
    expect(h.result).toMatchObject({ reason: 'showdown', pot: 6, winners: [0] });
    expect(s.stacks).toEqual([6, 1994]);
  });

  it('小盲正好等于筹码', () => {
    const s = startHand(withStacks([5, 1995]), AA_VS_KK);
    expect(s.hand!.result).toMatchObject({ pot: 10 });
    expect(s.stacks).toEqual([10, 1990]);
  });

  it('大盲筹码不足：小盲只能跟注或弃牌', () => {
    let s = startHand(withStacks([1994, 6]), AA_VS_KK);
    expect(s.hand!.players[1]).toMatchObject({ bet: 6, stack: 0 });
    expect(legalActions(s, 0)).toMatchObject({ canCall: true, callAmount: 1, canRaise: false });
    s = applyAction(s, 0, call);
    expect(s.hand!.result).toMatchObject({ pot: 12, winners: [0] });
    expect(s.stacks).toEqual([2000, 0]);
    expect(s.matchWinner).toBe(0);
  });
});

describe('玩家视角', () => {
  it('看不到对方底牌和牌堆，轮到自己时才有可选操作', () => {
    const s = startHand(createMatch(), AA_VS_KK);
    const v1 = viewFor(s, 1);
    expect(v1.hand!.players[1].hole).toEqual(['Kc', 'Kd']);
    expect(v1.hand!.players[0].hole).toBeNull();
    expect(v1.legal).toBeNull();
    expect(JSON.stringify(v1)).not.toContain('As');
    expect('deck' in v1.hand!).toBe(false);
    expect(viewFor(s, 0).legal).toMatchObject({ canCall: true });
    expect(v1.hand!.pot).toBe(15);
  });

  it('弃牌结束不亮牌，摊牌时双方都亮牌', () => {
    const folded = applyAction(startHand(createMatch(), AA_VS_KK), 0, fold);
    expect(viewFor(folded, 1).hand!.players[0].hole).toBeNull();
    const shown = checkDown(play(startHand(createMatch(), AA_VS_KK), [0, call]));
    expect(viewFor(shown, 1).hand!.players[0].hole).toEqual(['As', 'Ad']);
  });

  it('修改视图不会影响原状态', () => {
    const s = startHand(createMatch(), AA_VS_KK);
    const v = viewFor(s, 0);
    v.hand!.players[0].hole!.push('2c');
    v.hand!.log.length = 0;
    expect(s.hand!.players[0].hole).toEqual(['As', 'Ad']);
    expect(s.hand!.log.length).toBeGreaterThan(0);
  });
});
