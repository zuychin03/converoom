import { string, type RecordData } from './api.js';

const W = 300;
const LABEL = 100;
const ROW = 30;
const TOP = 22;
const AMP = 26;

function trace(values: number[], max: number, base: number, x0: number, width: number, amp: number) {
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => [x0 + i * step, base - (Math.sqrt(v) / Math.sqrt(max)) * amp]);
  let d = `M${x0} ${base} L${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const mx = (ax + bx) / 2;
    d += ` C${mx.toFixed(1)} ${ay.toFixed(1)} ${mx.toFixed(1)} ${by.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  return { line: d, area: `${d} L${x0 + width} ${base} L${x0} ${base} Z` };
}

const plotLabel = (name: string) => (name.length > 10 ? name.split(' ')[0].slice(0, 10) : name);

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function PulsePlot({
  seats,
  counts,
  live,
  selected,
}: {
  seats: RecordData[];
  counts: number[][];
  live: Set<string>;
  selected?: string;
}) {
  const max = Math.max(1, ...counts.flat());
  const height = TOP + seats.length * ROW + 6;
  const rows = seats.map((seat, i) => {
    const base = TOP + (i + 1) * ROW - 8;
    return { seat, base, ...trace(counts[i], max, base, LABEL, W - LABEL, AMP) };
  });
  const liveRow = rows.find((row) => live.has(string(row.seat, 'id')));
  const summary = seats
    .map((seat, i) => `${string(seat, 'name')} ${counts[i].reduce((a, b) => a + b, 0)} events`)
    .join(', ');
  return (
    <svg
      className="plot"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`Room activity since it opened: ${summary || 'no seats yet'}`}
    >
      {rows.map(({ seat, base, line, area }) => {
        const id = string(seat, 'id');
        return (
          <g key={id}>
            <text className="plot-label" x={0} y={base - 2}>
              {plotLabel(string(seat, 'name'))}
            </text>
            <path className="plot-fill" d={area} />
            <path
              className={`plot-line${live.has(id) ? ' live' : ''}${selected === id ? ' selected' : ''}`}
              d={line}
            />
          </g>
        );
      })}
      {liveRow && !reducedMotion() && (
        <circle className="plot-dot" r={2.4}>
          <animateMotion dur="9s" repeatCount="indefinite" path={liveRow.line} />
        </circle>
      )}
    </svg>
  );
}

export function Sparkline({ values, live }: { values: number[]; live: boolean }) {
  const max = Math.max(1, ...values);
  const { line } = trace(values, max, 15, 0, 56, 12);
  return (
    <svg className="spark" viewBox="0 0 56 17" aria-hidden="true">
      <path className={`plot-line${live ? ' live' : ''}`} d={line} />
    </svg>
  );
}
