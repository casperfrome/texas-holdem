// 随机对打：大量随机但合法的操作，检查不变量（筹码守恒、牌不重复、流程能正常结束）
import { describe, expect, it } from 'vitest';
import type { RandomInt } from './cards';
import {
  type Action, applyAction, type Config, createMatch, IllegalActionError, legalActions,
  type MatchState, type Seat, startHand, startNextMatch,
} from './game';
import { seededRandomInt } from './test-utils';
import { viewFor } from './view';

const CONFIGS: Config[] = [
  { startingStack: 1000, smallBlind: 5, bigBlind: 10 },
  { startingStack: 100, smallBlind: 5, bigBlind: 10 }, // 短筹码，经常出现盲注不足
  { startingStack: 37, smallBlind: 3, bigBlind: 7 }, // 奇数
  { startingStack: 500, smallBlind: 1, bigBlind: 1 },
];

function randomAction(state: MatchState, seat: Seat, rand: RandomInt): Action {
  const legal = legalActions(state, seat)!;
  const roll = rand(100);
  if (roll < 8) return { type: 'fold' };
  if (roll < 15) return { type: 'allin' };
  if (roll < 50 && (legal.canBet || legal.canRaise)) {
    const to = legal.minTo + rand(legal.maxTo - legal.minTo + 1);
    return { type: legal.canBet ? 'bet' : 'raise', to };
  }
  return legal.canCheck ? { type: 'check' } : { type: 'call' };
}

/** 偶尔故意发一个非法操作，确认会被拒绝且状态不变 */
function tryIllegal(state: MatchState, seat: Seat, rand: RandomInt) {
  const legal = legalActions(state, seat)!;
  const candidates: Action[] = [
    { type: 'bet', to: legal.maxTo + 1 + rand(50) },
    { type: 'raise', to: Math.max(0, legal.minTo - 1 - rand(5)) },
    legal.canCheck ? { type: 'call' } : { type: 'check' },
  ];
  const action = candidates[rand(candidates.length)]!;
  const before = JSON.stringify(state);
  // 金额正好合法的情况（例如 minTo 已经是上限）跳过
  try { applyAction(state, seat, action); } catch (e) { expect(e).toBeInstanceOf(IllegalActionError); }
  expect(JSON.stringify(state)).toBe(before);
  expect(() => applyAction(state, (1 - seat) as Seat, { type: 'fold' })).toThrow(IllegalActionError);
}

function checkInvariants(state: MatchState) {
  const total = state.config.startingStack * 2;
  const hand = state.hand;
  if (!hand) {
    expect(state.stacks[0] + state.stacks[1]).toBe(total);
    return;
  }
  const [a, b] = hand.players;
  expect(a.stack + a.committed + b.stack + b.committed - (hand.result ? hand.result.pot : 0)).toBe(total);
  for (const p of hand.players) {
    expect(p.stack).toBeGreaterThanOrEqual(0);
    expect(p.bet).toBeGreaterThanOrEqual(0);
    expect(p.bet).toBeLessThanOrEqual(p.committed);
    expect(p.hole).toHaveLength(2);
  }
  const seen = [...a.hole, ...b.hole, ...hand.board, ...hand.deck];
  expect(new Set(seen).size).toBe(seen.length);

  if (hand.result) {
    const r = hand.result;
    expect(hand.toAct).toBeNull();
    expect(r.won[0] + r.won[1]).toBe(r.pot);
    expect(state.stacks).toEqual([a.stack, b.stack]);
    expect(state.stacks[0] + state.stacks[1]).toBe(total);
    if (r.reason === 'showdown') {
      expect(hand.board).toHaveLength(5);
      // 摊牌时双方投入相等（没人跟的部分已经退回）
      expect(a.committed).toBe(b.committed);
    } else {
      expect(hand.players.filter((p) => p.folded)).toHaveLength(1);
    }
  } else {
    const seat = hand.toAct!;
    expect(seat === 0 || seat === 1).toBe(true);
    expect(legalActions(state, seat)).not.toBeNull();
    expect(legalActions(state, (1 - seat) as Seat)).toBeNull();
    expect(hand.players[seat].stack).toBeGreaterThan(0);
    // 视图里不能出现对方底牌
    const opp = (1 - seat) as Seat;
    const json = JSON.stringify(viewFor(state, seat));
    for (const c of hand.players[opp].hole) {
      if (!hand.board.includes(c) && !hand.players[seat].hole.includes(c)) expect(json).not.toContain(`"${c}"`);
    }
  }
}

describe('随机对打', () => {
  it('2 万手随机牌：筹码守恒、流程正常结束', () => {
    let hands = 0;
    let showdowns = 0;
    let matches = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rand = seededRandomInt(seed);
      const config = CONFIGS[seed % CONFIGS.length]!;
      let state = createMatch(config, (seed % 2) as Seat);
      let lastButton: Seat | null = null;

      for (let h = 0; h < 100; h++) {
        if (state.matchWinner !== null) {
          expect(state.stacks).toContain(0);
          state = startNextMatch(state);
          matches++;
        }
        state = startHand(state, rand);
        hands++;
        const button = state.hand!.button;
        if (lastButton !== null) expect(button).not.toBe(lastButton);
        lastButton = button;
        checkInvariants(state);

        let steps = 0;
        while (!state.hand!.result) {
          const seat = state.hand!.toAct!;
          if (rand(10) === 0) tryIllegal(state, seat, rand);
          state = applyAction(state, seat, randomAction(state, seat, rand));
          checkInvariants(state);
          expect(++steps).toBeLessThan(200);
        }
        if (state.hand!.result.reason === 'showdown') showdowns++;
      }
    }
    expect(hands).toBe(20000);
    // 确认测试真的覆盖到了各种结局
    expect(showdowns).toBeGreaterThan(1000);
    expect(matches).toBeGreaterThan(100);
  }, 120000);
});
