import { useEffect, useState } from 'react';
import type { Action, LegalActions, PlayerView } from '../engine';
import { potSizedTo } from './format';

interface Props {
  view: PlayerView;
  legal: LegalActions;
  onAct: (action: Action) => void;
}

const PRESETS: { label: string; fraction: number }[] = [
  { label: '½池', fraction: 0.5 },
  { label: '¾池', fraction: 0.75 },
  { label: '1池', fraction: 1 },
];

/** 快捷金额：最小、按底池比例、全下。底池小时几个按钮可能是同一个金额，所以按钮上直接写出金额 */
export const presetAmounts = (view: PlayerView, legal: LegalActions): { label: string; to: number }[] => [
  { label: '最小', to: legal.minTo },
  ...PRESETS.map((p) => ({ label: p.label, to: potSizedTo(view, legal, p.fraction) })),
  { label: '全下', to: legal.maxTo },
];

export function ActionBar({ view, legal, onAct }: Props) {
  const canAggress = legal.canBet || legal.canRaise;
  const [amount, setAmount] = useState(legal.minTo);
  const [confirmFold, setConfirmFold] = useState(false);
  const clamped = Math.min(legal.maxTo, Math.max(legal.minTo, Number.isFinite(amount) ? Math.round(amount) : legal.minTo));
  const isAllIn = clamped === legal.maxTo;
  const verb = legal.canBet ? '下注' : '加注到';

  // 弃牌确认几秒后自动取消，免得之后误点
  useEffect(() => {
    if (!confirmFold) return;
    const t = setTimeout(() => setConfirmFold(false), 3000);
    return () => clearTimeout(t);
  }, [confirmFold]);

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
            {presetAmounts(view, legal).map((p) => (
              <button
                type="button" key={p.label} className={p.to === clamped ? 'preset-on' : undefined}
                aria-pressed={p.to === clamped} onClick={() => setAmount(p.to)}
              >
                {p.label}<span className="preset-amount">{p.to}</span>
              </button>
            ))}
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
