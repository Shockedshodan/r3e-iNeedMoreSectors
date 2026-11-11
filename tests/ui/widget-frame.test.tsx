import './dom.ts';
import React from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { WidgetFrame } from '../../src/ui/WidgetFrame.tsx';
import type { WidgetFrameProps } from '../../src/ui/WidgetFrame.tsx';

afterEach(cleanup);
const base: WidgetFrameProps = {
  descriptor: { id: 'timing.delta', component: null, defaults: { x: 0, y: -150, scale: 1, enabled: true } },
  state: { x: 20, y: -40, scale: 1.25, enabled: true },
  editing: true, locked: false,
  onPosition() {}, onScale() {},
};

test('frame renders the registered widget at persisted placement and scale', () => {
  const view = render(<WidgetFrame {...base}><span>Delta content</span></WidgetFrame>);
  assert.ok(view.getByText('Delta content'));
  const element = view.getByTestId('widget-frame-timing.delta');
  assert.equal(element.style.left, 'calc(50% + 20px)');
  assert.equal(element.style.top, 'calc(50% - 40px)');
  assert.ok(element.style.transform.includes('scale(1.25)'));
});

test('drag updates placement by pointer displacement, independent of widget scale', () => {
  const positions: { x: number; y: number }[] = [];
  const view = render(<WidgetFrame {...base} onPosition={position => positions.push(position)} />);
  const element = view.getByTestId('widget-frame-timing.delta');
  fireEvent.pointerDown(element, { button: 0, clientX: 100, clientY: 200, pointerId: 1 });
  fireEvent.pointerMove(element, { clientX: 140, clientY: 220, pointerId: 1 });
  fireEvent.pointerUp(element, { pointerId: 1 });
  fireEvent.pointerMove(element, { clientX: 180, clientY: 300, pointerId: 1 });
  assert.deepEqual(positions, [{ x: 60, y: -20 }]);
});

test('viewport zoom is accounted for during drag', () => {
  const positions: { x: number; y: number }[] = [];
  const view = render(<WidgetFrame {...base} viewportScale={0.5} onPosition={position => positions.push(position)} />);
  const element = view.getByTestId('widget-frame-timing.delta');
  fireEvent.pointerDown(element, { button: 0, clientX: 100, clientY: 200 });
  fireEvent.pointerMove(element, { clientX: 120, clientY: 210 });
  assert.deepEqual(positions, [{ x: 60, y: -20 }]);
});

test('wheel follows upstream fine and Shift-coarse scaling steps', () => {
  const scales: number[] = [];
  const view = render(<WidgetFrame {...base} onScale={scale => scales.push(scale)} />);
  const element = view.getByTestId('widget-frame-timing.delta');
  fireEvent.wheel(element, { deltaY: -1 });
  fireEvent.wheel(element, { deltaY: 1, shiftKey: true });
  assert.deepEqual(scales, [1.26, 1.05]);
});

test('locked or nonediting frame cannot move or scale', () => {
  for (const overrides of [{ locked: true }, { editing: false }]) {
    let interactions = 0;
    const view = render(<WidgetFrame {...base} {...overrides} onPosition={() => interactions++} onScale={() => interactions++} />);
    const element = view.getByTestId('widget-frame-timing.delta');
    fireEvent.pointerDown(element, { button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerMove(element, { clientX: 200, clientY: 300 });
    fireEvent.wheel(element, { deltaY: -1 });
    assert.equal(interactions, 0);
    view.unmount();
  }
});

test('disabled widgets are hidden normally and receive an editing preview frame', () => {
  const view = render(<WidgetFrame {...base} state={{ ...base.state, enabled: false }} editing={false}>Preview</WidgetFrame>);
  assert.equal(view.queryByText('Preview'), null);
  view.rerender(<WidgetFrame {...base} state={{ ...base.state, enabled: false }}>Preview</WidgetFrame>);
  assert.ok(view.getByText('Preview'));
  assert.equal(view.getByTestId('widget-frame-timing.delta').getAttribute('data-preview'), 'true');
});
