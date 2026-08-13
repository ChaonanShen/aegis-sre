import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, LayoutGrid, Maximize2, X } from 'lucide-react';
import { CanvasPreview, SavedChartPreview } from '../model';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { ChartPreview } from './ChartPreview';
import { ChartQueryInfo } from './ChartQueryInfo';

const canvasLayoutLabels: Record<CanvasPreview['layout'], string> = {
  'grid-2x2': '2 × 2',
  'grid-3x2': '3 × 2',
  flex: '自适应',
};

interface CanvasStripProps {
  canvas: CanvasPreview;
  editingEnabled: boolean;
  onChange: (canvas: CanvasPreview) => void;
}

export function CanvasStrip({ canvas, editingEnabled, onChange }: CanvasStripProps) {
  const [editing, setEditing] = useState(false);
  const [fullscreenChart, setFullscreenChart] = useState<SavedChartPreview>();
  const fullscreenDialogRef = useDialogA11y<HTMLElement>(() => setFullscreenChart(undefined), {
    enabled: Boolean(fullscreenChart),
  });

  if (!canvas.visible) {
    return null;
  }

  return (
    <section aria-label="画布" className={`canvas-strip${canvas.charts.length === 0 ? ' empty' : ''}`}>
      <div className="canvas-header">
        <span>
          <strong>画布</strong>
          <span className="tag muted">
            {canvas.charts.length} 张图{canvas.charts.length > 1 ? ` · ${canvasLayoutLabels[canvas.layout]}` : ''}
          </span>
        </span>
        {editingEnabled && canvas.charts.length > 1 && (
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing((value) => !value)} type="button">
            {editing ? '完成' : '编辑布局'}
          </button>
        )}
        <button
          aria-label="关闭画布"
          className="icon-button"
          onClick={() => onChange({ ...canvas, visible: false })}
          type="button"
        >
          <X aria-hidden size={14} />
        </button>
      </div>
      {canvas.charts.length === 0 ? (
        <div className="canvas-empty">
          <span>
            <LayoutGrid aria-hidden size={22} />
          </span>
          <strong>还没有固定图表</strong>
          <p>让 Agent 查询指标并创建图表，证据会保留在这个会话中。</p>
        </div>
      ) : (
        <div className="canvas-grid" data-layout={canvas.layout} data-testid="session-canvas">
          {canvas.charts.map((chart, index) => (
            <article className="chart-card" key={chart.id}>
              <header className="chart-head">
                <span className="chart-title-with-query">
                  <span>{chart.title}</span>
                  <ChartQueryInfo chart={chart} />
                </span>
                <span className="chart-actions">
                  {editingEnabled && editing && (
                    <>
                      <button
                        aria-label={`前移 ${chart.title}`}
                        disabled={index === 0}
                        onClick={() => onChange(moveChart(canvas, index, index - 1))}
                        type="button"
                      >
                        <ArrowLeft aria-hidden size={12} />
                      </button>
                      <button
                        aria-label={`后移 ${chart.title}`}
                        disabled={index === canvas.charts.length - 1}
                        onClick={() => onChange(moveChart(canvas, index, index + 1))}
                        type="button"
                      >
                        <ArrowRight aria-hidden size={12} />
                      </button>
                    </>
                  )}
                  <button aria-label={`全屏 ${chart.title}`} onClick={() => setFullscreenChart(chart)} type="button">
                    <Maximize2 aria-hidden size={12} />
                  </button>
                  {editingEnabled && (
                    <button
                      aria-label={`删除 ${chart.title}`}
                      onClick={() => onChange({ ...canvas, charts: canvas.charts.filter(({ id }) => id !== chart.id) })}
                      type="button"
                    >
                      <X aria-hidden size={12} />
                    </button>
                  )}
                </span>
              </header>
              <div className="chart-body">
                <ChartPreview chart={chart} />
              </div>
            </article>
          ))}
        </div>
      )}
      {fullscreenChart && (
        <div className="workbench-modal-backdrop" role="presentation">
          <section
            aria-label={`${fullscreenChart.title} 全屏预览`}
            aria-modal="true"
            className="chart-fullscreen"
            ref={fullscreenDialogRef}
            role="dialog"
          >
            <header>
              <span className="chart-title-with-query">
                <strong>{fullscreenChart.title}</strong>
                <ChartQueryInfo chart={fullscreenChart} />
              </span>
              <button
                aria-label="关闭全屏预览"
                className="icon-button"
                onClick={() => setFullscreenChart(undefined)}
                type="button"
              >
                <X aria-hidden size={16} />
              </button>
            </header>
            <div>
              <ChartPreview chart={fullscreenChart} />
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function moveChart(canvas: CanvasPreview, from: number, to: number): CanvasPreview {
  if (to < 0 || to >= canvas.charts.length) {
    return canvas;
  }
  const charts = [...canvas.charts];
  const [chart] = charts.splice(from, 1);
  charts.splice(to, 0, chart);
  return { ...canvas, charts };
}
