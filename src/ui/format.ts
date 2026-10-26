import {
  Category, formatCard, type HandResult, type HandValue, type LegalActions, type LogEntry, type PlayerView, type Seat, type Street,
} from '../engine';

const rankName = (n: number) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' } as Record<number, string>)[n] ?? String(n);

/** 带点数的牌型名称，例如 "一对 6"、"葫芦（Q 带 5）"、"顺子（7 到 J）" */
export function describeHand(v: HandValue): string {
  const [a = 0, b = 0] = v.tiebreak;
  const run = (high: number) => `${high === 5 ? 'A' : rankName(high - 4)} 到 ${rankName(high)}`;
  switch (v.category) {
    case Category.HighCard: return `高牌 ${rankName(a)}`;
    case Category.OnePair: return `一对 ${rankName(a)}`;
    case Category.TwoPair: return `两对 ${rankName(a)} 和 ${rankName(b)}`;
    case Category.ThreeOfAKind: return `三条 ${rankName(a)}`;
    case Category.Straight: return `顺子（${run(a)}）`;
    case Category.Flush: return `同花（${rankName(a)} 高）`;
    case Category.FullHouse: return `葫芦（${rankName(a)} 带 ${rankName(b)}）`;
    case Category.FourOfAKind: return `四条 ${rankName(a)}`;
    case Category.StraightFlush: return a === 14 ? '皇家同花顺' : `同花顺（${run(a)}）`;
  }
}

export const STREET_NAME: Record<Street, string> = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };

/** 座位号 → 显示的称呼 */
export type Namer = (seat: Seat) => string;

/**
 * 玩家看：自己叫"你"，对面用名字（没有名字时叫"对手"）。
 * 观众看（spectator）：两边都用名字。
 */
export function namer(you: Seat, names?: readonly (string | null)[] | null, spectator = false): Namer {
  return (seat) => {
    if (seat === you && !spectator) return '你';
    return names?.[seat] ?? (spectator ? `${seat + 1} 号位` : '对手');
  };
}

export function describeEntry(e: LogEntry, who: Namer): string {
  switch (e.kind) {
    case 'blind':
      return `${who(e.seat)} 放${e.blind === 'sb' ? '小盲' : '大盲'} ${e.amount}${e.allIn ? '（全下）' : ''}`;
    case 'street':
      return `${STREET_NAME[e.street]}：${e.cards.map(formatCard).join(' ')}`;
    case 'return':
      return `退还${who(e.seat)}没被跟的 ${e.amount}`;
    case 'action': {
      const allIn = e.allIn ? '（全下）' : '';
      const timeout = e.timeout ? '（超时自动）' : '';
      const text = {
        fold: '弃牌',
        check: '过牌',
        call: `跟注 ${e.amount}`,
        bet: `下注 ${e.to}`,
        raise: `加注到 ${e.to}`,
      }[e.action];
      return `${who(e.seat)} ${text}${allIn}${timeout}`;
    }
  }
}

export function describeResult(r: HandResult, who: Namer): { title: string; detail: string | null } {
  if (r.winners.length === 2) return { title: `平分底池，各得 ${r.won[0]}`, detail: null };
  const winner = r.winners[0]!;
  const title = `${who(winner)}赢了 ${r.pot}`;
  if (r.reason === 'fold') return { title, detail: `${who(winner === 0 ? 1 : 0)}弃牌了` };
  return { title, detail: null };
}

/**
 * 按底池比例算下注/加注后的总额：先跟平，再加上（跟注后底池 × 比例）。
 * 结果夹在允许范围内。
 */
export function potSizedTo(view: PlayerView, legal: LegalActions, fraction: number): number {
  const hand = view.hand!;
  const myBet = hand.players[view.you].bet;
  const potAfterCall = hand.pot + legal.callAmount;
  const to = myBet + legal.callAmount + Math.round(potAfterCall * fraction);
  return Math.min(legal.maxTo, Math.max(legal.minTo, to));
}
