import React from 'react';
import { SavedChartPreview } from '../model';
import { GrafanaPanelPreview } from './GrafanaPanelPreview';

const fixtureColors = ['var(--accent)', 'var(--green)', 'var(--orange)', 'var(--purple)'];

export function ChartPreview({ chart }: { chart: SavedChartPreview }) {
  if (chart.renderMode !== 'fixture') {
    return <GrafanaPanelPreview chart={chart} />;
  }
  const type = chart.visualization;
  if (type === 'stat') {
    return (
      <div className="chart-stat">
        <strong>320 ms</strong>
        <span>当前 p95 latency</span>
        <small className="fixture-stat-delta">较上周 +14%</small>
      </div>
    );
  }
  if (type === 'gauge') {
    return <Gauge />;
  }
  return type === 'bar' ? <BarChart chart={chart} /> : <LineChart chart={chart} />;
}

function LineChart({ chart }: { chart: SavedChartPreview }) {
  const errorRate = chart.id.includes('error');
  const labels = errorRate ? ['5xx', '基线'] : ['本周 p95', '上周 p95'];
  const series = labels.map((label, index) => ({
    label,
    color: fixtureColors[index],
    values: deterministicSeries(36, seedFrom(chart.id) + index * 71, errorRate ? 14 - index * 7 : 62 - index * 12),
  }));
  const width = 400;
  const height = 160;
  const plot = { left: 34, right: 394, top: 8, bottom: 128 };
  const values = series.flatMap(({ values }) => values);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(1, maximum - minimum);
  const lower = minimum - spread * 0.12;
  const upper = maximum + spread * 0.12;
  const pointFor = (value: number, index: number, count: number): readonly [number, number] => [
    plot.left + (index / (count - 1)) * (plot.right - plot.left),
    plot.top + (1 - (value - lower) / (upper - lower)) * (plot.bottom - plot.top),
  ];

  return (
    <div className="fixture-chart">
      <svg
        aria-label={`${chart.title} 折线图预览`}
        className="chart-svg"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[0, 0.5, 1].map((position) => {
          const y = plot.top + position * (plot.bottom - plot.top);
          const value = upper - position * (upper - lower);
          return (
            <g key={position}>
              <line stroke="var(--border-strong)" strokeWidth="0.7" x1={plot.left} x2={plot.right} y1={y} y2={y} />
              <text className="fixture-axis-label" textAnchor="end" x={plot.left - 5} y={y + 3}>
                {formatFixtureValue(value, errorRate)}
              </text>
            </g>
          );
        })}
        {[0, 0.33, 0.66, 1].map((position, index) => {
          const x = plot.left + position * (plot.right - plot.left);
          return (
            <g key={position}>
              <line stroke="var(--border)" strokeWidth="0.6" x1={x} x2={x} y1={plot.top} y2={plot.bottom} />
              <text
                className="fixture-axis-label"
                textAnchor={index === 0 ? 'start' : index === 3 ? 'end' : 'middle'}
                x={x}
                y="145"
              >
                {['13:10', '13:20', '13:30', '13:40'][index]}
              </text>
            </g>
          );
        })}
        {series.map(({ color, label, values }) => {
          const points = values.map((value, index) => pointFor(value, index, values.length));
          const path = points
            .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
            .join(' ');
          return (
            <path d={path} fill="none" key={label} stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          );
        })}
      </svg>
      <div aria-label="图例" className="fixture-chart-legend">
        {series.map(({ color, label, values }) => (
          <span key={label}>
            <i style={{ background: color }} />
            {label}
            <strong>{formatFixtureValue(values.at(-1) ?? 0, errorRate)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function BarChart({ chart }: { chart: SavedChartPreview }) {
  const data = deterministicSeries(24, seedFrom(chart.id), 48);
  const maximum = Math.max(...data);
  return (
    <div className="fixture-chart">
      <svg
        aria-label={`${chart.title} 柱状图预览`}
        className="chart-svg"
        preserveAspectRatio="none"
        viewBox="0 0 400 160"
      >
        {[40, 80, 120].map((y) => (
          <line key={y} stroke="var(--border-strong)" strokeWidth="0.7" x1="28" x2="396" y1={y} y2={y} />
        ))}
        {data.map((value, index) => {
          const barHeight = (value / maximum) * 118;
          return (
            <rect
              fill="var(--green)"
              height={barHeight}
              key={index}
              opacity="0.78"
              rx="1"
              width="10"
              x={32 + index * 15}
              y={130 - barHeight}
            />
          );
        })}
        <text className="fixture-axis-label" x="28" y="148">
          13:10
        </text>
        <text className="fixture-axis-label" textAnchor="end" x="396" y="148">
          13:40
        </text>
      </svg>
      <div aria-label="图例" className="fixture-chart-legend">
        <span>
          <i style={{ background: 'var(--green)' }} />
          请求速率<strong>1.84k/s</strong>
        </span>
      </div>
    </div>
  );
}

function Gauge() {
  const value = 88;
  const angle = (value / 100) * 180 - 90;
  const radians = (angle * Math.PI) / 180;
  const x = 100 + 70 * Math.cos(radians);
  const y = 90 + 70 * Math.sin(radians);

  return (
    <svg aria-label="PG 连接池 88%" className="chart-svg" preserveAspectRatio="xMidYMid meet" viewBox="0 0 200 115">
      <path
        d="M 30 90 A 70 70 0 0 1 170 90"
        fill="none"
        stroke="var(--border-strong)"
        strokeLinecap="round"
        strokeWidth="10"
      />
      <path
        d="M 30 90 A 70 70 0 0 1 122 24"
        fill="none"
        opacity="0.55"
        stroke="var(--purple)"
        strokeLinecap="round"
        strokeWidth="10"
      />
      <line stroke="var(--text-primary)" strokeWidth="2" x1="100" x2={x} y1="90" y2={y} />
      <circle cx="100" cy="90" fill="var(--text-primary)" r="4" />
      <text fill="var(--text-secondary)" fontSize="11" textAnchor="middle" x="100" y="110">
        PG 连接池: 88%
      </text>
    </svg>
  );
}

function deterministicSeries(length: number, initialSeed: number, baseline: number): number[] {
  let seed = initialSeed;
  return Array.from({ length }, (_, index) => {
    seed = (seed * 9301 + 49297) % 233280;
    const incident =
      index > length * 0.56 && index < length * 0.76 ? Math.sin(((index / length - 0.56) / 0.2) * Math.PI) * 18 : 0;
    return baseline + Math.sin(index / 3.4) * 4 + (seed / 233280) * 5 + incident;
  });
}

function seedFrom(value: string): number {
  return Array.from(value).reduce((seed, character) => (seed * 31 + character.charCodeAt(0)) % 233280, 42);
}

function formatFixtureValue(value: number, percentage: boolean): string {
  return percentage ? `${Math.max(0, value / 10).toFixed(1)}%` : `${Math.round(value * 5)}ms`;
}
