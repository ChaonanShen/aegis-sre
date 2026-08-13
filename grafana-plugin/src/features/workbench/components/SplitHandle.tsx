import React, { useEffect, useRef, useState } from 'react';

interface SplitHandleProps {
  ariaLabel: string;
  className: string;
  controlledId: string;
  defaultValue: number;
  max: number;
  min: number;
  pointerDirection: 1 | -1;
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startValue: number;
  currentValue: number;
}

export function SplitHandle({
  ariaLabel,
  className,
  controlledId,
  defaultValue,
  max,
  min,
  pointerDirection,
  value,
  onChange,
  onCommit,
  onDraggingChange,
}: SplitHandleProps) {
  const dragRef = useRef<DragState>();
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => {
      if (dragRef.current) {
        onDraggingChange?.(false);
      }
    },
    [onDraggingChange]
  );

  const finishDragging = () => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = undefined;
    setDragging(false);
    onDraggingChange?.(false);
    onCommit?.(drag.currentValue);
  };

  const stopPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    finishDragging();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      aria-label={ariaLabel}
      aria-controls={controlledId}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      aria-valuetext={`${value} 像素`}
      className={`split-handle ${className}`}
      data-resizing={dragging ? 'true' : 'false'}
      onDoubleClick={() => {
        onChange(defaultValue);
        onCommit?.(defaultValue);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        let next: number | undefined;
        if (event.key === 'ArrowLeft') {
          next = value - step * pointerDirection;
        } else if (event.key === 'ArrowRight') {
          next = value + step * pointerDirection;
        } else if (event.key === 'Enter' || event.key === ' ') {
          next = defaultValue;
        } else if (event.key === 'Home') {
          next = min;
        } else if (event.key === 'End') {
          next = max;
        }
        if (next !== undefined) {
          event.preventDefault();
          const changed = clamp(next, min, max);
          onChange(changed);
          onCommit?.(changed);
        }
      }}
      onLostPointerCapture={finishDragging}
      onPointerCancel={stopPointer}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startValue: value,
          currentValue: value,
        };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) {
          return;
        }
        event.preventDefault();
        const delta = (event.clientX - drag.startX) * pointerDirection;
        const changed = clamp(drag.startValue + delta, min, max);
        drag.currentValue = changed;
        onChange(changed);
      }}
      onPointerUp={stopPointer}
      role="separator"
      tabIndex={0}
      title="拖动调整宽度；双击或按 Enter 恢复默认值"
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
