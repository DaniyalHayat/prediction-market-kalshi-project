import type {CSSProperties} from 'react';

type Forecast = {probability?: number; interval?: number[]; model_name?: string; outcomes?: {win?: number; loss?: number; tie?: number}; expected_settlement_value?: number};
type Props = {bid: number | null; ask: number | null; age: number | null; forecast?: Forecast; stale?: boolean; loading?: boolean};
const validProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const percentage = (value: number) => new Intl.NumberFormat('en-US', {style: 'percent', maximumFractionDigits: 1}).format(value);
const tone = (value: number) => value >= .65 ? 'high' : value <= .35 ? 'low' : 'balanced';

function ProbabilityPair({probability, unavailable, outcomes}: {probability: number | null; unavailable: string; outcomes?: [string, number][]}) {
  if (probability === null && !outcomes) return <p className="probability-unavailable">{unavailable}</p>;
  const entries=outcomes || [['YES', probability!], ['NO', 1 - probability!]];
  return <div className={'probability-pair' + (outcomes ? ' probability-three' : '')}>{entries.map(([label, value]) => {
    const chance = value as number;
    const outcomeTone = label === 'Tie' ? 'balanced' : tone(label === 'Loss' ? 1 - chance : chance);
    return <div className={'probability-outcome probability-' + outcomeTone} key={label}><span>{label}</span><strong>{percentage(chance)}</strong><div className="probability-track" aria-hidden="true"><span style={{'--chance': (chance * 100).toFixed(2) + '%'} as CSSProperties}/></div></div>;
  })}</div>;
}

export default function QuoteComparison({bid, ask, age, forecast, stale = false, loading = false}: Props) {
  const market = validProbability(bid) && validProbability(ask) && bid <= ask && age !== null && age >= 0 && age <= 90 ? (bid + ask) / 2 : null;
  const model = !stale && !forecast?.outcomes && validProbability(forecast?.probability) ? forecast.probability : null;
  const rawOutcomes=forecast?.outcomes;
  const outcomes: [string,number][] | undefined=!stale && rawOutcomes && validProbability(rawOutcomes.win) && validProbability(rawOutcomes.loss) && validProbability(rawOutcomes.tie) && Math.abs(rawOutcomes.win+rawOutcomes.loss+rawOutcomes.tie-1)<.001 ? [['Win',rawOutcomes.win],['Loss',rawOutcomes.loss],['Tie',rawOutcomes.tie]] : undefined;
  const value=outcomes && validProbability(forecast?.expected_settlement_value) ? forecast.expected_settlement_value : model;
  const gap = market !== null && value !== null ? (value - market) * 100 : null;
  const interval = model !== null && forecast?.interval?.length === 2 && forecast.interval.every(validProbability) && forecast.interval[0] <= forecast.interval[1] ? forecast.interval : null;
  return <section className="quote-comparison" aria-label="Market and Predictir probability comparison">
    <div className="probability-card"><span className="probability-heading">{forecast?.outcomes ? 'Market price equivalent' : 'Market price implied'}</span><ProbabilityPair probability={market} unavailable="Awaiting a fresh quote"/><small>Observed bid–ask midpoint{forecast?.outcomes ? '; tie pays half' : ''}</small></div>
    <div className="probability-card"><span className="probability-heading">Predictir model</span><ProbabilityPair probability={model} outcomes={outcomes} unavailable={loading ? 'Calculating…' : stale ? 'Refreshing estimate…' : 'Estimate unavailable'}/><small>{forecast?.model_name || 'Independent source model'}{interval && <> · YES range {percentage(interval[0])}–{percentage(interval[1])}</>}{outcomes && validProbability(value) && <> · Expected YES payout {(value*100).toFixed(1)}¢</>}</small></div>
    <p className="probability-caption">{gap !== null && <span className={'probability-gap ' + (gap > 0 ? 'gap-positive' : gap < 0 ? 'gap-negative' : '')}>{gap > 0 ? '+' : ''}{gap.toFixed(1)}{outcomes ? '¢: expected YES payout vs market price.' : ' percentage points: model YES vs market.'} </span>}{outcomes ? 'Win colors show likelihood; Loss colors show downside risk. Tie stays neutral.' : 'Colors show YES/NO likelihood.'} Color is not a profit signal. Compare price, fees and model uncertainty to judge trade value.</p>
  </section>;
}
