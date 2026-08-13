import React from 'react';
import { IconButton, Tooltip } from '@grafana/ui';
import { SavedChartPreview } from '../model';

export function ChartQueryInfo({ chart }: { chart: SavedChartPreview }) {
  const expression = chart.query?.spec.expression.trim();
  if (!expression) {
    return null;
  }
  const range = chart.query?.spec.range;

  return (
    <Tooltip
      content={
        <div className="torchbearing-chart-query-tooltip">
          <span>PromQL</span>
          <code>{expression}</code>
          {range ? (
            <>
              <span>绝对时间范围</span>
              <code>{`${formatAbsoluteTime(range.from)} — ${formatAbsoluteTime(range.to)}`}</code>
            </>
          ) : null}
        </div>
      }
      interactive
      placement="bottom-start"
    >
      <IconButton
        aria-label={`查看“${chart.title}”的 PromQL 与时间范围`}
        className="chart-query-info-button"
        name="info-circle"
        size="sm"
      />
    </Tooltip>
  );
}

function formatAbsoluteTime(value: string): string {
  const trimmed = value.trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const millis = Number.isFinite(numeric) ? numeric : Date.parse(trimmed);
  return Number.isSafeInteger(millis) ? new Date(millis).toISOString() : value;
}
