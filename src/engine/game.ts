// 两人单挑无限注德州扑克的规则引擎。
// 纯数据、纯函数：applyAction 等函数不会修改传入的状态，而是返回新状态。
// 在线模式的完整状态只留在服务器；发给玩家的数据要经过 view.ts 裁剪。
import { type Card, cryptoRandomInt, isValidCard, newDeck, type RandomInt, shuffle } from './cards';
import { bestHand, compareHands, type HandValue } from './evaluate';

export type Seat = 0 | 1;
export const other = (s: Seat): Seat => (s === 0 ? 1 : 0);

export interface Config {
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}

export const DEFAULT_CONFIG: Config = { startingStack: 1000, smallBlind: 5, bigBlind: 10 };

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** bet / raise 的 to 是本轮下注后的总额，不是增加的额度 */
export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; to: number }
  | { type: 'raise'; to: number }
  | { type: 'allin' };

export interface PlayerState {
  /** 手上还没投入的筹码 */
  stack: number;
  /** 本轮已投入 */
  bet: number;
  /** 本手牌已投入合计（含本轮） */
  committed: number;
  hole: Card[];
  folded: boolean;
  /** 本轮自对方上次下注/加注以来是否行动过 */
  acted: boolean;
}

export type LogEntry =
  | { kind: 'blind'; seat: Seat; blind: 'sb' | 'bb'; amount: number; allIn: boolean }
  | {
    kind: 'action'; seat: Seat; street: Street; action: 'fold' | 'check' | 'call' | 'bet' | 'raise'; amount: number; to: number; allIn: boolean;
    /** 超时由系统代为操作 */
    timeout?: boolean;
  }
  | { kind: 'street'; street: Street; cards: Card[] }
  | { kind: 'return'; seat: Seat; amount: number };

export interface HandResult {
  reason: 'fold' | 'showdown';
  winners: Seat[];
  pot: number;
  /** 各自从底池分到的筹码 */
  won: [number, number];
  /** 摊牌时双方最好的 5 张牌；弃牌结束时为 null */
  hands: [HandValue, HandValue] | null;
  /** 摊牌亮牌顺序：河牌圈最后下注/加注的人先亮，都过牌则非庄家先亮 */
  showOrder: Seat[];
}

export interface HandState {
  number: number;
  /** 庄家 = 小盲 */
  button: Seat;
  street: Street;
  board: Card[];
  /** 剩余牌堆，从下标 0 开始发 */
  deck: Card[];
  players: [PlayerState, PlayerState];
  toAct: Seat | null;
  /** 本轮最高下注额 */
  currentBet: number;
  /** 最小加注增量 */
  minRaise: number;
  /** 本轮最后一个下注/加注的人 */
  lastAggressor: Seat | null;
  log: LogEntry[];
  result: HandResult | null;
}

export interface MatchState {
  config: Config;
  /** 两手牌之间的筹码；牌局进行中以 hand.players[i].stack 为准 */
  stacks: [number, number];
  hand: HandState | null;
  /** 下一手牌的庄家 */
  nextButton: Seat;
  handCount: number;
  matchNumber: number;
  matchWins: [number, number];
  /** 本局（打到一方输光为止）的胜者；不为 null 时需要 startNextMatch */
  matchWinner: Seat | null;
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** 跟注需要补的筹码 */
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** 下注/加注后本轮总额的范围 */
  minTo: number;
  maxTo: number;
}

export class IllegalActionError extends Error {
  override name = 'IllegalActionError';
}

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river'];

// ---------- 对局 ----------

export function createMatch(config: Config = DEFAULT_CONFIG, firstButton: Seat = 0): MatchState {
  const { startingStack, smallBlind, bigBlind } = config;
  if (![startingStack, smallBlind, bigBlind].every((n) => Number.isInteger(n) && n > 0) || smallBlind > bigBlind) {
    throw new Error('起始筹码和盲注必须是正整数，且小盲不大于大盲');
  }
  return {
    config: { ...config },
    stacks: [startingStack, startingStack],
    hand: null,
    nextButton: firstButton,
    handCount: 0,
    matchNumber: 1,
    matchWins: [0, 0],
    matchWinner: null,
  };
}

/** 一方输光后，双方筹码重置，开始新的一局；庄家继续轮换 */
export function startNextMatch(state: MatchState): MatchState {
  if (state.matchWinner === null) throw new IllegalActionError('本局还没结束');
  const next = structuredClone(state);
  next.stacks = [next.config.startingStack, next.config.startingStack];
  next.hand = null;
  next.matchNumber++;
  next.matchWinner = null;
  return next;
}

/**
 * 开始新的一手牌。
 * deck 可以传入一副完整的 52 张牌（测试用，从下标 0 开始发），
 * 或一个随机数函数；默认用加密随机数洗牌。
 */
export function startHand(state: MatchState, deck: Card[] | RandomInt = cryptoRandomInt): MatchState {
  if (state.matchWinner !== null) throw new IllegalActionError('本局已结束，请开始新的一局');
  if (state.hand && !state.hand.result) throw new IllegalActionError('当前这手牌还没结束');

  let cards: Card[];
  if (Array.isArray(deck)) {
    if (deck.length !== 52 || new Set(deck).size !== 52 || !deck.every(isValidCard)) {
      throw new Error('指定的牌堆必须是完整且不重复的 52 张牌');
    }
    cards = deck.slice();
  } else {
    cards = shuffle(newDeck(), deck);
  }

  const next = structuredClone(state);
  const button = next.nextButton;
  const bb = other(button);
  const blank = (stack: number): PlayerState => ({ stack, bet: 0, committed: 0, hole: [], folded: false, acted: false });
  const hand: HandState = {
    number: ++next.handCount,
    button,
    street: 'preflop',
    board: [],
    deck: cards,
    players: [blank(next.stacks[0]), blank(next.stacks[1])],
    toAct: null,
    currentBet: 0,
    minRaise: next.config.bigBlind,
    lastAggressor: null,
    log: [],
    result: null,
  };
  next.hand = hand;
  next.nextButton = bb;

  postBlind(hand, button, 'sb', next.config.smallBlind);
  postBlind(hand, bb, 'bb', next.config.bigBlind);
  hand.currentBet = Math.max(hand.players[0].bet, hand.players[1].bet);

  // 从大盲开始，每人轮流发一张，共两轮
  for (let i = 0; i < 2; i++) {
    for (const seat of [bb, button]) hand.players[seat].hole.push(draw(hand));
  }

  // 翻牌前庄家（小盲）先行动
  hand.toAct = nextToAct(hand, button);
  if (hand.toAct === null) closeRound(next);
  return next;
}

// ---------- 行动 ----------

export function legalActions(state: MatchState, seat: Seat): LegalActions | null {
  const hand = state.hand;
  if (!hand || hand.result || hand.toAct !== seat) return null;
  const me = hand.players[seat];
  const opp = hand.players[other(seat)];

  // 下注上限按有效筹码封顶：超出对方全部筹码的部分没人能跟
  const maxTo = Math.min(me.bet + me.stack, opp.bet + opp.stack);
  const canAggress = opp.stack > 0 && maxTo > hand.currentBet;
  const standardMin = hand.currentBet === 0 ? state.config.bigBlind : hand.currentBet + hand.minRaise;

  return {
    canFold: true,
    canCheck: me.bet === hand.currentBet,
    canCall: me.bet < hand.currentBet,
    callAmount: Math.min(hand.currentBet - me.bet, me.stack),
    canBet: canAggress && hand.currentBet === 0,
    canRaise: canAggress && hand.currentBet > 0,
    // 筹码不够一个最小下注/加注时，只能全下（下注到 maxTo）
    minTo: canAggress ? Math.min(standardMin, maxTo) : 0,
    maxTo: canAggress ? maxTo : 0,
  };
}

export function applyAction(state: MatchState, seat: Seat, action: Action): MatchState {
  const legal = legalActions(state, seat);
  if (!legal) {
    if (!state.hand || state.hand.result) throw new IllegalActionError('当前没有进行中的牌');
    throw new IllegalActionError('还没轮到你行动');
  }

  // 全下：能加注就加到上限，否则跟注，什么都不用补时就是过牌
  if (action.type === 'allin') {
    if (legal.canBet) action = { type: 'bet', to: legal.maxTo };
    else if (legal.canRaise) action = { type: 'raise', to: legal.maxTo };
    else if (legal.canCall) action = { type: 'call' };
    else action = { type: 'check' };
  }

  const next = structuredClone(state);
  const hand = next.hand!;
  const me = hand.players[seat];
  const opp = hand.players[other(seat)];
  const record = (kind: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount: number) =>
    hand.log.push({ kind: 'action', seat, street: hand.street, action: kind, amount, to: me.bet, allIn: me.stack === 0 && kind !== 'fold' });

  switch (action.type) {
    case 'fold':
      me.folded = true;
      record('fold', 0);
      break;

    case 'check':
      if (!legal.canCheck) throw new IllegalActionError('对方已下注，不能过牌');
      me.acted = true;
      record('check', 0);
      break;

    case 'call':
      if (!legal.canCall) throw new IllegalActionError('没有需要跟的注，请选择过牌');
      putIn(me, legal.callAmount);
      me.acted = true;
      record('call', legal.callAmount);
      break;

    case 'bet':
    case 'raise': {
      const allowed = action.type === 'bet' ? legal.canBet : legal.canRaise;
      if (!allowed) {
        throw new IllegalActionError(action.type === 'bet'
          ? (hand.currentBet > 0 ? '已经有人下注，请选择加注' : '现在不能下注')
          : (hand.currentBet === 0 ? '还没有人下注，请选择下注' : '现在不能加注'));
      }
      const to = action.to;
      if (!Number.isInteger(to) || to < legal.minTo || to > legal.maxTo) {
        throw new IllegalActionError(`${action.type === 'bet' ? '下注' : '加注'}金额必须在 ${legal.minTo} 到 ${legal.maxTo} 之间`);
      }
      const added = to - me.bet;
      putIn(me, added);
      // 只有完整的加注才会提高最小加注增量；不足额全下不改变它
      const raiseSize = to - hand.currentBet;
      if (raiseSize >= hand.minRaise) hand.minRaise = raiseSize;
      hand.currentBet = to;
      hand.lastAggressor = seat;
      me.acted = true;
      opp.acted = false;
      record(action.type, added);
      break;
    }

    default:
      throw new IllegalActionError('未知的行动');
  }

  hand.toAct = me.folded ? null : nextToAct(hand, other(seat));
  if (hand.toAct === null) closeRound(next);
  return next;
}

// ---------- 内部 ----------

function draw(hand: HandState): Card {
  const card = hand.deck.shift();
  if (!card) throw new Error('牌堆已空');
  return card;
}

function putIn(p: PlayerState, amount: number) {
  p.stack -= amount;
  p.bet += amount;
  p.committed += amount;
}

function postBlind(hand: HandState, seat: Seat, blind: 'sb' | 'bb', size: number) {
  const p = hand.players[seat];
  const amount = Math.min(size, p.stack); // 筹码不够时全部放入，视为全下
  putIn(p, amount);
  hand.log.push({ kind: 'blind', seat, blind, amount, allIn: p.stack === 0 });
}

function needsToAct(hand: HandState, seat: Seat): boolean {
  const me = hand.players[seat];
  const opp = hand.players[other(seat)];
  if (me.folded || me.stack === 0) return false;
  if (me.bet < hand.currentBet) return true;
  // 已跟平：对方还能行动时，自己没行动过就要行动（例如翻牌前大盲的"选择权"）
  return !me.acted && !opp.folded && opp.stack > 0;
}

function nextToAct(hand: HandState, preferred: Seat): Seat | null {
  if (needsToAct(hand, preferred)) return preferred;
  if (needsToAct(hand, other(preferred))) return other(preferred);
  return null;
}

/** 本轮下注结束：退还没人跟的部分，然后进入下一轮、一路发完或结算 */
function closeRound(state: MatchState) {
  const hand = state.hand!;
  for (;;) {
    returnUncalled(hand);
    if (hand.players.some((p) => p.folded)) return finishHand(state, 'fold');
    if (hand.street === 'river') return finishHand(state, 'showdown');
    dealNextStreet(hand);
    hand.toAct = nextToAct(hand, other(hand.button)); // 翻牌后非庄家（大盲）先行动
    if (hand.toAct !== null) {
      hand.lastAggressor = null;
      return;
    }
    // 有人全下：不再下注，继续发下一条街
  }
}

function returnUncalled(hand: HandState) {
  const [a, b] = hand.players;
  const diff = a.bet - b.bet;
  if (diff === 0) return;
  const seat: Seat = diff > 0 ? 0 : 1;
  const p = hand.players[seat];
  const amount = Math.abs(diff);
  p.bet -= amount;
  p.committed -= amount;
  p.stack += amount;
  hand.log.push({ kind: 'return', seat, amount });
}

function dealNextStreet(hand: HandState) {
  const street = STREET_ORDER[STREET_ORDER.indexOf(hand.street) + 1]!;
  draw(hand); // 烧牌
  const cards = Array.from({ length: street === 'flop' ? 3 : 1 }, () => draw(hand));
  hand.board.push(...cards);
  hand.street = street;
  hand.log.push({ kind: 'street', street, cards });
  hand.currentBet = 0;
  for (const p of hand.players) {
    p.bet = 0;
    p.acted = false;
  }
}

function finishHand(state: MatchState, reason: 'fold' | 'showdown') {
  const hand = state.hand!;
  const pot = hand.players[0].committed + hand.players[1].committed;
  const won: [number, number] = [0, 0];
  let winners: Seat[];
  let hands: [HandValue, HandValue] | null = null;
  let showOrder: Seat[] = [];

  if (reason === 'fold') {
    winners = [hand.players[0].folded ? 1 : 0];
  } else {
    hands = [
      bestHand([...hand.players[0].hole, ...hand.board]),
      bestHand([...hand.players[1].hole, ...hand.board]),
    ];
    const c = compareHands(hands[0], hands[1]);
    winners = c > 0 ? [0] : c < 0 ? [1] : [0, 1];
    const first = hand.lastAggressor ?? other(hand.button);
    showOrder = [first, other(first)];
  }

  if (winners.length === 1) {
    won[winners[0]!] = pot;
  } else {
    // 平分；单挑时双方投入相等，底池总是偶数，这里只是保险：多出的 1 个给非庄家
    const half = Math.floor(pot / 2);
    won[0] = half;
    won[1] = half;
    won[other(hand.button)] += pot - half * 2;
  }

  for (const seat of [0, 1] as const) {
    const p = hand.players[seat];
    p.stack += won[seat];
    p.bet = 0;
    state.stacks[seat] = p.stack;
  }
  hand.toAct = null;
  hand.result = { reason, winners, pot, won, hands, showOrder };

  const busted = state.stacks.findIndex((s) => s === 0);
  if (busted !== -1) {
    const winner = other(busted as Seat);
    state.matchWinner = winner;
    state.matchWins[winner]++;
  }
}
