import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SplitHandle } from './SplitHandle';

describe('SplitHandle', () => {
  const nativePointerEvent = window.PointerEvent;

  beforeAll(() => {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: MouseEvent });
  });

  afterAll(() => {
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: nativePointerEvent });
  });

  test('supports keyboard resizing and resetting to the default width', () => {
    const onChange = jest.fn();
    renderHandle({ value: 400, onChange });
    const separator = screen.getByRole('separator', { name: '调整面板宽度' });

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(408);
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(368);
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(220);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.keyDown(separator, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(360);
    fireEvent.doubleClick(separator);
    expect(onChange).toHaveBeenLastCalledWith(360);
  });

  test('maps pointer movement to a right-hand pane', () => {
    const onChange = jest.fn();
    const onCommit = jest.fn();
    renderHandle({ value: 400, pointerDirection: -1, onChange, onCommit });
    const separator = screen.getByRole('separator', { name: '调整面板宽度' });
    separator.setPointerCapture = jest.fn();
    separator.hasPointerCapture = jest.fn(() => true);
    separator.releasePointerCapture = jest.fn();

    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerMove(separator, { clientX: 540, pointerId: 7, pointerType: 'mouse' });
    expect(onChange).toHaveBeenLastCalledWith(360);
    fireEvent.pointerUp(separator, { pointerId: 7, pointerType: 'mouse' });
    expect(onCommit).toHaveBeenLastCalledWith(360);
  });
});

function renderHandle({
  value,
  pointerDirection = 1,
  onChange,
  onCommit,
}: {
  value: number;
  pointerDirection?: 1 | -1;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}) {
  return render(
    <SplitHandle
      ariaLabel="调整面板宽度"
      className="test-handle"
      controlledId="controlled-pane"
      defaultValue={360}
      max={480}
      min={220}
      onChange={onChange}
      onCommit={onCommit}
      pointerDirection={pointerDirection}
      value={value}
    />
  );
}
