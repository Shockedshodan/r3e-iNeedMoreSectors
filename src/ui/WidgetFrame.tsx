import React, { useEffect, useRef } from 'react';
import type { WidgetSpec } from '../contracts.ts';
import type { WidgetLayout } from './layout.ts';

// SPDX-License-Identifier: MIT
// Pointer placement and fine/coarse wheel scaling adapted from SealHUD app.tsx,
// commit d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b.
// Copyright (c) 2026 Diego Junges and contributors. See THIRD_PARTY_NOTICES.md.

export interface WidgetFrameProps {
  descriptor: WidgetSpec;
  state: Readonly<WidgetLayout>;
  editing: boolean;
  locked: boolean;
  onPosition(position: { x: number; y: number }): void;
  onScale(scale: number): void;
  viewportScale?: number;
  children?: React.ReactNode;
}

export function WidgetFrame(props: WidgetFrameProps): React.ReactElement | null {
  const { descriptor, state, editing, locked, onPosition, onScale, children } = props;
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number; clientX: number; clientY: number; x: number; y: number;
  } | null>(null);
  const viewportScale = props.viewportScale && Number.isFinite(props.viewportScale) && props.viewportScale > 0
    ? props.viewportScale : 1;

  useEffect(() => {
    const widget = element.current;
    if (!widget) return;
    function wheel(event: WheelEvent): void {
      if (!editing || locked || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 0.2 : 0.01;
      const scale = Math.round((state.scale + (event.deltaY < 0 ? step : -step)) * 100) / 100;
      onScale(Math.max(0.1, Math.min(3, scale)));
    }
    // Native listener is non-passive so scroll gestures resize the widget
    // without scrolling the containing page during layout editing.
    widget.addEventListener('wheel', wheel, { passive: false });
    return () => { widget.removeEventListener('wheel', wheel); };
  }, [editing, locked, onScale, state.scale, state.enabled]);

  useEffect(() => {
    if (!editing || locked) drag.current = null;
  }, [editing, locked]);

  if (!state.enabled && !editing) return null;

  function stopDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* A cancelled pointer may already be released. */ }
  }

  return <div
    ref={element}
    role="group"
    aria-label={`${descriptor.id} widget`}
    data-testid={`widget-frame-${descriptor.id}`}
    data-widget-id={descriptor.id}
    data-preview={editing ? 'true' : undefined}
    data-locked={locked ? 'true' : 'false'}
    className={`widget-frame${editing ? ' is-editing' : ''}${locked ? ' is-locked' : ''}`}
    style={{
      position: 'absolute', left: `calc(50% + ${state.x}px)`, top: `calc(50% + ${state.y}px)`,
      transform: `translate(-50%, -50%) scale(${state.scale})`,
      transformOrigin: 'center', touchAction: editing && !locked ? 'none' : 'auto',
      cursor: editing && !locked ? 'move' : 'default',
    }}
    onPointerDown={event => {
      if (!editing || locked || event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('button,input,textarea,select,[contenteditable="true"],[data-no-drag]')) return;
      event.preventDefault();
      drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: state.x, y: state.y };
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* JSDOM and older browsers may not expose capture. */ }
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || !editing || locked || start.pointerId !== event.pointerId) return;
      onPosition({
        x: start.x + (event.clientX - start.clientX) / viewportScale,
        y: start.y + (event.clientY - start.clientY) / viewportScale,
      });
    }}
    onPointerUp={stopDrag}
    onPointerCancel={stopDrag}
    onLostPointerCapture={() => { drag.current = null; }}
  >{children}</div>;
}
