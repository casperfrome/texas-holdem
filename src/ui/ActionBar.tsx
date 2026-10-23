import { useState } from 'react';
import type { Action, LegalActions, PlayerView } from '../engine';
import { potSizedTo } from './format';

interface Props {
  view: PlayerView;
  legal: LegalActions;
  onAct: (action: Action) => void;
}

const PRESETS: { label: string; fraction: number }[] = [
  { label: '½ 池', fraction: 0.5 },
  { label: '¾ 池', fraction: 0.75 },
  { label: '1 池', fraction: 1 },
];

export function ActionBar({ view, legal, onAct }: Props) {
  const canAggress = legal.canBet || legal.canRaise;
  const [amount, setAmount] = useState(legal.minTo);
  const [confirmFold, setConfirmFold] = useState(false);
  const clamped = Math.min(legal.maxTo, Math.max(legal.minTo, Number.isFinite(amount) ? Math.round(amount) : legal.minTo));
  const isAllIn = clamped === legal.maxTo;
  const verb = legal.canBet ? '下注' : '加注到';

  const fold = () => {
    // 可以免费过牌时弃牌，多确认一次
    if (legal.canCheck && !confirmFold) { setConfirmFold(true); return; }
    onAct({ type: 'fold' });
  };

  return (
    <div className="action-bar">
      {canAggress && legal.maxTo > legal.minTo && (
        <div className="sizing">
          <div className="presets">
            <button type="button" onClick={() => setAmount(legal.minTo)}>最小</button>
            {PRESETS.map((p) => (
              <button type="button" key={p.label} onClick={() => setAmount(potSizedTo(view, legal, p.fraction))}>{p.label}</button>
            ))}
            <button type="button" onClick={() => setAmount(legal.maxTo)}>全下</button>
          </div>
          <div className="slider-row">
            <input
              type="range" min={legal.minTo} max={legal.maxTo} step={1} value={clamped}
              onChange={(e) => setAmount(Number(e.target.value))} aria-label="下注金额"
            />
            <input
              type="number" inputMode="numeric" min={legal.minTo} max={legal.maxTo} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))} onBlur={() => setAmount(clamped)} aria-label="下注金额"
            />
          </div>
        </div>
      )}
      <div className="buttons">
        <button type="button" className="btn btn-fold" onClick={fold}>{confirmFold ? '确定弃牌？' : '弃牌'}</button>
        {legal.canCheck && <button type="button" className="btn btn-call" onClick={() => onAct({ type: 'check' })}>过牌</button>}
        {legal.canCall && (
          <button type="button" className="btn btn-call" onClick={() => onAct({ type: 'call' })}>
            跟注 {legal.callAmount}{legal.callAmount === view.hand!.players[view.you].stack ? '（全下）' : ''}
          </button>
        )}
        {canAggress && (
          <button
            type="button" className="btn btn-raise"
            onClick={() => onAct({ type: legal.canBet ? 'bet' : 'raise', to: clamped })}
          >
            {isAllIn ? `全下 ${clamped}` : `${verb} ${clamped}`}
          </button>
        )}
      </div>
    </div>
  );
}
