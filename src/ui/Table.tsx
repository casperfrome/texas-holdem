import { type ReactNode, useEffect, useState } from 'react';
import { type Action, bestHand, type Card, type PlayerSeatView, type PlayerView, type Seat } from '../engine';
import { TURN_MS, type Turn } from '../game/client';
import type { RoomInfo } from '../net/protocol';
import { ActionBar } from './ActionBar';
import { BoardView, CardView } from './CardView';
import { describeEntry, describeHand, describeResult, type Namer, namer, STREET_NAME } from './format';

interface Props {
  view: PlayerView;
  room: RoomInfo | null;
  turn: Turn | null;
  /** 操作已发出、等待房主确认 */
  pending?: boolean;
  /** 显示在顶栏的连接状态 */
  statusDot?: ReactNode;
  canNudge: boolean;
  onAct: (action: Action) => void;
  onNext: () => void;
  onNudge: () => void;
  onSit: () => void;
}

export function Table({ view, room, turn, pending = false, statusDot, canNudge, onAct, onNext, onNudge, onSit }: Props) {
  const hand = view.hand;
  const you = view.you;
  const opp: Seat = you === 0 ? 1 : 0;
  const watching = room?.you === 'watcher';
  const who = namer(you, room?.seats, watching);
  const seatFree = room !== null && room.seats.some((name) => name === null);

  if (!hand) {
    return (
      <div className="table-wrap">
        <header className="scorebar"><span>{statusDot}{room?.name ?? ''}</span></header>
        <div className="center-note">
          {seatFree ? '等待对手坐下…' : '等待开始…'}
          {seatFree && watching && <div><button type="button" className="btn btn-raise sit-btn" onClick={onSit}>坐下打牌</button></div>}
          {seatFree && room?.you === 'host' && <div className="muted small">把邀请链接发给朋友，朋友进房后选"坐下"就开始</div>}
        </div>
      </div>
    );
  }

  const result = hand.result;
  // 摊牌时高亮赢家的 5 张牌
  const winning = result?.hands
    ? new Set<Card>(result.winners.flatMap((w) => result.hands![w].cards))
    : null;
  const me = hand.players[you];
  const myHandName = !watching && me.hole && hand.board.length >= 3 ? describeHand(bestHand([...me.hole, ...hand.board])) : null;
  const seatTurn = (seat: Seat) => (turn && turn.seat === seat && !result ? turn : null);

  return (
    <div className="table-wrap">
      <header className="scorebar">
        <span>{statusDot}第 {view.matchNumber} 局 · 第 {hand.number} 手</span>
        <span>盲注 {view.config.smallBlind}/{view.config.bigBlind}</span>
        <span>比分 {view.matchWins[you]} : {view.matchWins[opp]}</span>
      </header>

      <div className="felt">
        <SeatView
          name={who(opp)} seat={hand.players[opp]} isButton={hand.button === opp}
          isToAct={hand.toAct === opp} turn={seatTurn(opp)} mine={false} winning={winning} cardSize="md"
        />

        <div className="middle">
          <div className="pot">底池 {hand.pot}</div>
          <BoardView cards={hand.board} winning={winning} />
          <div className="street">{result ? '本手结束' : STREET_NAME[hand.street]}</div>
        </div>

        <SeatView
          name={who(you)} seat={me} isButton={hand.button === you}
          isToAct={hand.toAct === you} turn={seatTurn(you)} mine={!watching} winning={winning}
          cardSize={watching ? 'md' : 'lg'} hint={myHandName}
        />
      </div>

      <div className="controls">
        {watching ? (
          <div className="waiting">
            观战中{result ? `：${describeResult(result, who).title}` : ''}
            {seatFree && <div><button type="button" className="btn btn-raise sit-btn" onClick={onSit}>坐下打牌</button></div>}
          </div>
        ) : pending ? (
          <div className="waiting">发送中…</div>
        ) : result ? (
          <ResultPanel view={view} who={who} onNext={onNext} />
        ) : view.legal ? (
          <ActionBar key={`${hand.number}-${hand.log.length}`} view={view} legal={view.legal} onAct={onAct} />
        ) : (
          <div className="waiting">
            等待{who(opp)}行动…
            <div>
              <button type="button" className="btn nudge-btn" disabled={!canNudge} onClick={onNudge}>
                {canNudge ? '催一催' : '已催过'}
              </button>
            </div>
          </div>
        )}
      </div>

      <HandLog view={view} who={who} />
    </div>
  );
}

/** 剩余秒数，每 0.25 秒刷新一次 */
function useRemaining(turn: Turn | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turn) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [turn]);
  return turn ? Math.max(0, turn.deadline - now) : 0;
}

/** 行动倒计时：进度条 + 秒数，最后 5 秒变红；轮到自己剩 5 秒时震动一下 */
function TurnClock({ turn, mine }: { turn: Turn; mine: boolean }) {
  const remaining = useRemaining(turn);
  const seconds = Math.ceil(remaining / 1000);
  const urgent = seconds <= 5;
  useEffect(() => {
    if (mine && urgent && remaining > 0) navigator.vibrate?.(150);
    // 只在进入最后 5 秒时触发一次
  }, [mine, urgent]);
  return (
    <div className={`turn-clock ${urgent ? 'turn-urgent' : ''}`} role="timer" aria-label={`剩余 ${seconds} 秒`}>
      <div className="turn-bar"><div className="turn-fill" style={{ width: `${(remaining / TURN_MS) * 100}%` }} /></div>
      <span className="turn-sec">{seconds}s</span>
    </div>
  );
}

function SeatView({ name, seat, isButton, isToAct, turn, mine, winning, cardSize, hint }: {
  name: string;
  seat: PlayerSeatView;
  isButton: boolean;
  isToAct: boolean;
  turn: Turn | null;
  mine: boolean;
  winning: Set<Card> | null;
  cardSize: 'md' | 'lg';
  hint?: string | null;
}) {
  const status = seat.folded ? '已弃牌' : seat.allIn ? '全下' : isToAct ? (mine ? '轮到你' : '思考中…') : '';
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
      {turn && <TurnClock turn={turn} mine={mine} />}
      <div className="seat-bet">{seat.bet > 0 ? <span className="chip">{seat.bet}</span> : <span className="chip chip-empty" />}</div>
      {hint && <div className="seat-hint">{hint}</div>}
    </div>
  );
}

function ResultPanel({ view, who, onNext }: { view: PlayerView; who: Namer; onNext: () => void }) {
  const result = view.hand!.result!;
  const { title, detail } = describeResult(result, who);
  const matchOver = view.matchWinner !== null;
  const opp: Seat = view.you === 0 ? 1 : 0;
  return (
    <div className={`result ${result.winners.length === 1 && result.winners[0] === view.you ? 'result-win' : ''}`}>
      <div className="result-title">{title}</div>
      {detail && <div className="result-detail">{detail}</div>}
      {result.hands && (
        <div className="result-hands">
          {([view.you, opp] as const).map((seat) => (
            <div key={seat} className={`result-hand ${result.winners.includes(seat) ? 'result-hand-win' : ''}`}>
              <span className="result-who">{who(seat)}</span>
              <span className="result-cards">
                {result.hands![seat].cards.map((c) => <CardView key={c} card={c} size="sm" />)}
              </span>
              <span className="result-name">{describeHand(result.hands![seat])}</span>
            </div>
          ))}
        </div>
      )}
      {matchOver && (
        <div className="result-match">{`${who(view.matchWinner!)}赢下了第 ${view.matchNumber} 局！`}</div>
      )}
      <button type="button" className="btn btn-raise" onClick={onNext}>{matchOver ? '再来一局' : '下一手'}</button>
    </div>
  );
}

function HandLog({ view, who }: { view: PlayerView; who: Namer }) {
  const [open, setOpen] = useState(false);
  const log = view.hand!.log;
  return (
    <details className="hand-log" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>本手记录（{log.length}）</summary>
      <ol>
        {log.map((e, i) => <li key={i} className={`log-${e.kind}`}>{describeEntry(e, who)}</li>)}
      </ol>
    </details>
  );
}
