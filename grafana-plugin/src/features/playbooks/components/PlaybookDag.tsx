import React, { useId, useMemo } from 'react';
import { PlaybookStep, PlaybookStepType } from '../model';

const NODE_WIDTH = 178;
const NODE_HEIGHT = 68;
const COLUMN_GAP = 66;
const ROW_GAP = 26;

interface PositionedStep {
  step: PlaybookStep;
  layer: number;
  x: number;
  y: number;
}

export function PlaybookDag({ steps }: { steps: PlaybookStep[] }) {
  const markerId = useId().replace(/:/g, '');
  const positioned = useMemo(() => layoutSteps(steps), [steps]);
  if (steps.length === 0) {
    return <div className="playbook-empty">这个 Playbook 还没有 Step。</div>;
  }
  const positionById = new Map(positioned.map((item) => [item.step.id, item]));
  const layers = Math.max(...positioned.map(({ layer }) => layer)) + 1;
  const width = 40 + layers * (NODE_WIDTH + COLUMN_GAP);
  const height = Math.max(330, ...positioned.map(({ y }) => y + NODE_HEIGHT + 50));

  return (
    <div aria-label="Playbook DAG" className="playbook-dag" role="img">
      <svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
        <defs>
          <marker
            id={`arrow-${markerId}`}
            markerHeight="6"
            markerWidth="6"
            orient="auto"
            refX="9"
            refY="5"
            viewBox="0 0 10 10"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5794f2" />
          </marker>
        </defs>
        {positioned.flatMap(({ step, x, y }) =>
          step.dependsOn.map((dependency) => {
            const parent = positionById.get(dependency);
            if (!parent) {
              return null;
            }
            const x1 = parent.x + NODE_WIDTH;
            const y1 = parent.y + NODE_HEIGHT / 2;
            const x2 = x;
            const y2 = y + NODE_HEIGHT / 2;
            const middle = (x1 + x2) / 2;
            return (
              <path
                className="playbook-dag-edge"
                d={`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`}
                key={`${dependency}-${step.id}`}
                markerEnd={`url(#arrow-${markerId})`}
              />
            );
          })
        )}
        {positioned.map(({ step, x, y }) => (
          <g data-step-id={step.id} key={step.id} transform={`translate(${x}, ${y})`}>
            <rect className="playbook-dag-node" height={NODE_HEIGHT} rx="6" width={NODE_WIDTH} />
            <rect className={`playbook-dag-type ${step.type}`} height={NODE_HEIGHT} rx="2" width="4" />
            <text className="playbook-dag-kind" x="13" y="20">
              {step.type.toUpperCase()}
            </text>
            <text className="playbook-dag-label" x="13" y="40">
              {truncate(step.label, 22)}
            </text>
            <text className="playbook-dag-id" x="13" y="57">
              {truncate(step.id, 26)}
            </text>
            {step.sideEffect && <circle className="playbook-dag-side-effect" cx={NODE_WIDTH - 12} cy="12" r="4" />}
          </g>
        ))}
      </svg>
      <div className="playbook-dag-legend">
        {(['query', 'branch', 'loop', 'template', 'mcp_call', 'parallel'] as PlaybookStepType[]).map((type) => (
          <span key={type}>
            <i className={type} />
            {type}
          </span>
        ))}
      </div>
    </div>
  );
}

function layoutSteps(steps: PlaybookStep[]): PositionedStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const resolveLayer = (step: PlaybookStep): number => {
    const existing = layers.get(step.id);
    if (existing !== undefined) {
      return existing;
    }
    // A malformed draft can contain a dependency cycle. Break the recursive
    // walk at the back edge so the editor still renders the graph.
    if (visiting.has(step.id)) {
      return 0;
    }
    visiting.add(step.id);
    const layer =
      step.dependsOn.length === 0
        ? 0
        : Math.max(...step.dependsOn.map((id) => (byId.has(id) ? resolveLayer(byId.get(id)!) + 1 : 0)));
    visiting.delete(step.id);
    layers.set(step.id, layer);
    return layer;
  };
  steps.forEach(resolveLayer);
  const grouped = new Map<number, PlaybookStep[]>();
  steps.forEach((step) => {
    const layer = layers.get(step.id) ?? 0;
    grouped.set(layer, [...(grouped.get(layer) ?? []), step]);
  });
  return [...grouped.entries()].flatMap(([layer, items]) => {
    const totalHeight = items.length * NODE_HEIGHT + Math.max(0, items.length - 1) * ROW_GAP;
    const startY = Math.max(30, 180 - totalHeight / 2);
    return items.map((step, index) => ({
      step,
      layer,
      x: 36 + layer * (NODE_WIDTH + COLUMN_GAP),
      y: startY + index * (NODE_HEIGHT + ROW_GAP),
    }));
  });
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
