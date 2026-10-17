import { useId } from 'react';

/** Small dependency-free SVG line chart for metric history. */
export function Sparkline({
  values,
  max,
  height = 44,
  label,
}: {
  values: number[];
  /** Fixed upper bound (e.g. 100 for percentages). Defaults to the data maximum. */
  max?: number;
  height?: number;
  label: string;
}) {
  const id = useId();
  const w = 240;
  const h = height;
  const top = Math.max(max ?? 0, ...values, 1e-9);
  if (values.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label}: collecting data`}>
        <line x1="0" x2={w} y1={h - 1} y2={h - 1} className="spark-base" />
      </svg>
    );
  }
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 2 - (Math.max(0, v) / top) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${w},${h}L0,${h}Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label} history`}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="spark-stop-top" />
          <stop offset="1" className="spark-stop-bottom" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal usage bar with warning and critical thresholds. */
export function Meter({ value, label }: { value: number; label: string }) {
  const level = value >= 90 ? 'crit' : value >= 75 ? 'warn' : 'ok';
  return (
    <div className={`meter meter-${level}`} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}
