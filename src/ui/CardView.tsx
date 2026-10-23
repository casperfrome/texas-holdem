import type { Card } from '../engine';

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

interface Props {
  card: Card | null;
  size?: 'sm' | 'md' | 'lg';
  /** 摊牌时组成最终牌型的牌高亮，其余变暗 */
  highlight?: 'win' | 'dim' | undefined;
}

/** card 为 null 时显示牌背 */
export function CardView({ card, size = 'md', highlight }: Props) {
  if (!card) return <div className={`card card-${size} card-back`} aria-label="未知的牌" />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1]!;
  const red = suit === 'h' || suit === 'd';
  return (
    <div
      className={`card card-${size} ${red ? 'card-red' : 'card-black'} ${highlight ? `card-${highlight}` : ''}`}
      aria-label={`${SUIT_SYMBOL[suit]}${rank}`}
    >
      <span className="card-rank">{rank}</span>
      <span className="card-suit">{SUIT_SYMBOL[suit]}</span>
    </div>
  );
}

/** 公共牌区域：5 个位置，没发的显示空位 */
export function BoardView({ cards, winning }: { cards: Card[]; winning: Set<Card> | null }) {
  return (
    <div className="board">
      {Array.from({ length: 5 }, (_, i) => {
        const c = cards[i];
        if (!c) return <div key={i} className="card card-md card-slot" />;
        return <CardView key={c} card={c} highlight={winning ? (winning.has(c) ? 'win' : 'dim') : undefined} />;
      })}
    </div>
  );
}
