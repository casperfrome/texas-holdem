import { type ReactNode, useState } from 'react';
import { type Action, bestHand, type Card, type PlayerSeatView, type PlayerView, type Seat } from '../engine';
import { ActionBar } from './ActionBar';
import { BoardView, CardView } from './CardView';
import { describeEntry, describeHand, describeResult, STREET_NAME } from './format';

interface Props {
  view: PlayerView;
  /** 操作已发出、等待房主确认 */
  pending?: boolean;
  /** 显示在顶栏的连接状态 */
  statusDot?: ReactNode;
  onAct: (action: Action) => void;
  onNext: () => void;
}

export function Table({ view, pending = false, statusDot, onAct, onNext }: Props) {
  const hand = view.hand;
  const you = view.you;
  const opp: Seat = you === 0 ? 1 : 0;
  if (!hand) return <div className="center-note">等待开始…</div>;

  const result = hand.result;
  // 摊牌时高亮赢家的 5 张牌
  const winning = result?.hands
    ? new Set<Card>(result.winners.flatMap((w) => result.hands![w].cards))
    : null;
  const me = hand.players[you];
  const myHandName = me.hole && hand.board.length >= 3 ? describeHand(bestHand([...me.hole, ...hand.board])) : null;

  return (
    <div className="table-wrap">
      <header className="scorebar">
        <span>{statusDot}第 {view.matchNumber} 局 · 第 {hand.number} 手</span>
        <span>盲注 {view.config.smallBlind}/{view.config.bigBlind}</span>
        <span>比分 {view.matchWins[you]} : {view.matchWins[opp]}</span>
      </header>

      <div className="felt">
        <SeatView
          name="对手" seat={hand.players[opp]} isButton={hand.button === opp}
          isToAct={hand.toAct === opp} winning={winning} cardSize="md"
        />

        <div className="middle">
          <div className="pot">底池 {hand.pot}</div>
          <BoardView cards={hand.board} winning={winning} />
          <div className="street">{result ? '本手结束' : STREET_NAME[hand.street]}</div>
        </div>

        <SeatView
          name="你" seat={me} isButton={hand.button === you}
          isToAct={hand.toAct === you} winning={winning} cardSize="lg" hint={myHandName}
        />
      </div>

      <div className="controls">
        {pending ? (
          <div className="waiting">发送中…</div>
        ) : result ? (
          <ResultPanel view={view} onNext={onNext} />
        ) : view.legal ? (
          <ActionBar key={`${hand.number}-${hand.log.length}`} view={view} legal={view.legal} onAct={onAct} />
        ) : (
          <div className="waiting">等待对手行动…</div>
        )}
      </div>

      <HandLog view={view} />
    </div>
  );
}

function SeatView({ name, seat, isButton, isToAct, winning, cardSize, hint }: {
  name: string;
  seat: PlayerSeatView;
  isButton: boolean;
  isToAct: boolean;
  winning: Set<Card> | null;
  cardSize: 'md' | 'lg';
  hint?: string | null;
}) {
  const status = seat.folded ? '已弃牌' : seat.allIn ? '全下' : isToAct ? (name === '你' ? '轮到你' : '思考中…') : '';
  const cards = seat.hole ?? [null, null];
  return (
    <div className={`seat ${isToAct ? 'seat-active' : ''} ${seat.folded ? 'seat-folded' : ''}`}>
      <div className="seat-info">
        <span className="seat-name">{name}</span>
        {isButton && <span className="dealer" title="庄家（小盲）">D</span>}
        <span className="seat-stack">{seat.stack}</span>
        {status && <span className="seat-status">{status}</span>}
      </div>
      <div className="seat-cards">
        {cards.map((c, i) => (
          <CardView key={c ?? i} card={c} size={cardSize} highlight={c && winning ? (winning.has(c) ? 'win' : 'dim') : undefined} />
        ))}
      </div>
      <div className="seat-bet">{seat.bet > 0 ? <span className="chip">{seat.bet}</span> : <span className="chip chip-empty" />}</div>
      {hint && <div className="seat-hint">{hint}</div>}
    </div>
  );
}

function ResultPanel({ view, onNext }: { view: PlayerView; onNext: () => void }) {
  const result = view.hand!.result!;
  const { title, detail } = describeResult(result, view.you);
  const matchOver = view.matchWinner !== null;
  const youWonMatch = view.matchWinner === view.you;
  const opp: Seat = view.you === 0 ? 1 : 0;
  return (
    <div className={`result ${result.winners.length === 1 && result.winners[0] === view.you ? 'result-win' : ''}`}>
      <div className="result-title">{title}</div>
      {detail && <div className="result-detail">{detail}</div>}
      {result.hands && (
        <div className="result-hands">
          {([view.you, opp] as const).map((seat) => (
            <div key={seat} className={`result-hand ${result.winners.includes(seat) ? 'result-hand-win' : ''}`}>
              <span className="result-who">{seat === view.you ? '你' : '对手'}</span>
              <span className="result-cards">
                {result.hands![seat].cards.map((c) => <CardView key={c} card={c} size="sm" />)}
              </span>
              <span className="result-name">{describeHand(result.hands![seat])}</span>
            </div>
          ))}
        </div>
      )}
      {matchOver && (
        <div className="result-match">{youWonMatch ? `你赢下了第 ${view.matchNumber} 局！` : `对手赢下了第 ${view.matchNumber} 局`}</div>
      )}
      <button type="button" className="btn btn-raise" onClick={onNext}>{matchOver ? '再来一局' : '下一手'}</button>
    </div>
  );
}

function HandLog({ view }: { view: PlayerView }) {
  const [open, setOpen] = useState(false);
  const log = view.hand!.log;
  return (
    <details className="hand-log" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>本手记录（{log.length}）</summary>
      <ol>
        {log.map((e, i) => <li key={i} className={`log-${e.kind}`}>{describeEntry(e, view.you)}</li>)}
      </ol>
    </details>
  );
}
