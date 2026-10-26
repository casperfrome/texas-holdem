// 把房主手里的完整状态裁剪成某一方能看到的数据：
// 去掉牌堆，对方的底牌只在摊牌时才给出；观众两边的底牌都只在摊牌时给出。
import type { Card } from './cards';
import {
  type Config, type HandResult, legalActions, type LegalActions, type LogEntry,
  type MatchState, other, type Seat, type Street,
} from './game';

export interface PlayerSeatView {
  stack: number;
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  /** 对方的底牌在摊牌前为 null */
  hole: Card[] | null;
}

export interface HandView {
  number: number;
  button: Seat;
  street: Street;
  board: Card[];
  pot: number;
  currentBet: number;
  toAct: Seat | null;
  players: [PlayerSeatView, PlayerSeatView];
  log: LogEntry[];
  result: HandResult | null;
}

export interface PlayerView {
  you: Seat;
  config: Config;
  stacks: [number, number];
  handCount: number;
  matchNumber: number;
  matchWins: [number, number];
  matchWinner: Seat | null;
  hand: HandView | null;
  /** 轮到你时可以做的操作 */
  legal: LegalActions | null;
}

/** spectator 为 true 时是观众视角：以 you 号位为下方座位，但双方底牌都只在摊牌时给出，也不能操作 */
export function viewFor(state: MatchState, you: Seat, spectator = false): PlayerView {
  const hand = state.hand;
  let handView: HandView | null = null;
  if (hand) {
    const revealed = hand.result?.reason === 'showdown';
    const seatView = (seat: Seat): PlayerSeatView => {
      const p = hand.players[seat];
      return {
        stack: p.stack,
        bet: p.bet,
        committed: p.committed,
        folded: p.folded,
        allIn: p.stack === 0 && !p.folded,
        hole: (seat === you && !spectator) || revealed ? p.hole.slice() : null,
      };
    };
    handView = {
      number: hand.number,
      button: hand.button,
      street: hand.street,
      board: hand.board.slice(),
      pot: hand.players[0].committed + hand.players[1].committed,
      currentBet: hand.currentBet,
      toAct: hand.toAct,
      players: [seatView(0), seatView(1)],
      log: structuredClone(hand.log),
      result: structuredClone(hand.result),
    };
  }
  return {
    you,
    config: { ...state.config },
    stacks: [...state.stacks],
    handCount: state.handCount,
    matchNumber: state.matchNumber,
    matchWins: [...state.matchWins],
    matchWinner: state.matchWinner,
    hand: handView,
    legal: spectator ? null : legalActions(state, you),
  };
}

/** 对手的座位号 */
export const opponentOf = (view: PlayerView): Seat => other(view.you);
