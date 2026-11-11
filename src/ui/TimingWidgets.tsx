/*
 * Presentation adapted from SealHUD progress.tsx/progress.scss, commit
 * d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b.
 * Copyright (c) 2026 Diego Junges and contributors. MIT License.
 * See THIRD_PARTY_NOTICES.md for the upstream notice.
 *
 * The upstream game's delta is deliberately replaced with the supplied shared
 * saved-reference view model. Importing SealHUD's telemetry services is avoided.
 */
import React from 'react';
import type { ReferenceMode, TimingView } from '../contracts.ts';
import { isValidBoundaries } from '../validation.ts';

export interface SectorPanelProps {
  view: TimingView['panel'];
  mode: ReferenceMode;
  currentDistance?: number;
  boundaries?: readonly number[];
}

export interface DeltaWidgetProps {
  view: TimingView['delta'];
  mode: ReferenceMode;
}

function modeLabel(mode: ReferenceMode): string {
  return mode === 'best' ? 'Best' : mode === 'opt' ? 'Opt' : 'Off';
}

/** Avoid Date-based formatting, which wraps after an hour. */
function durationLabel(microseconds: number): string {
  if (!Number.isFinite(microseconds) || microseconds < 0) return '—';
  const milliseconds = Math.round(microseconds / 1000);
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function SectorPanel({ view, mode, currentDistance, boundaries }: SectorPanelProps): React.ReactNode {
  if (!view.visible) return null;
  const label = modeLabel(mode);
  const reference = view.reference;
  const count = reference?.sectors.length ?? (boundaries && isValidBoundaries(boundaries) ? boundaries.length - 1 : 3);
  const usableBoundaries = boundaries && isValidBoundaries(boundaries) && boundaries.length === count + 1 ? boundaries : null;
  let currentIndex = -1;
  if (usableBoundaries && currentDistance !== undefined && Number.isFinite(currentDistance) && currentDistance >= 0 && currentDistance <= 1) {
    currentIndex = currentDistance === 1 ? count - 1 : usableBoundaries.findIndex((start, index) =>
      index < count && currentDistance >= start && currentDistance < usableBoundaries[index + 1]);
  }

  return (
    <section className="timing-widget timing-sectors" data-testid="timing-sectors" data-reference-total-us={!view.preview ? reference?.totalUs : undefined} aria-label={`${label} sector times`}>
      <header className="timing-widget-heading">
        <h2>{label} sectors</h2>
        {view.preview && <span className="timing-widget-preview">Preview</span>}
      </header>
      {!view.preview && reference === null ? (
        <div className="timing-widget-empty">No saved {label} lap</div>
      ) : (
        <table className="timing-sector-table" aria-label={`${label} saved sectors`}>
          <tbody>
            {Array.from({ length: count }, (_, index) => (
              <tr key={index} aria-current={!view.preview && index === currentIndex ? 'step' : undefined}>
                <th scope="row">Sector {index + 1}</th>
                <td data-testid={`sector-time-${index}`}>{view.preview ? '—' : durationLabel(reference!.sectors[index].durationUs)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{label} lap</th>
              <td data-testid="sector-total">{view.preview ? '—' : durationLabel(reference!.totalUs)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

export function DeltaWidget({ view, mode }: DeltaWidgetProps): React.ReactNode {
  if (!view.visible) return null;
  const label = modeLabel(mode);
  const available = !view.preview && view.reference !== null && view.valueUs !== null && Number.isFinite(view.valueUs);
  const milliseconds = available ? Math.round(Math.abs(view.valueUs!) / 1000) : null;
  const direction = milliseconds === null ? 'unavailable' : milliseconds === 0 ? 'equal' : view.valueUs! < 0 ? 'faster' : 'slower';
  const value = milliseconds === null ? '—' : `${direction === 'faster' ? '-' : '+'}${(milliseconds / 1000).toFixed(3)}`;
  // Like SealHUD's centered good/bad strip, the numeric sign is also present so
  // comparison direction does not depend on color alone.
  const barWidth = milliseconds === null ? 0 : Math.min(milliseconds / 1000, 1) * 50;

  return (
    <section className="timing-widget timing-delta" data-testid="timing-delta" data-direction={direction} data-reference-total-us={!view.preview ? view.reference?.totalUs : undefined} data-delta-us={available ? view.valueUs! : undefined} aria-label={`${label} saved-reference delta`}>
      <header className="timing-widget-heading">
        <h2>{label} delta</h2>
        {view.preview && <span className="timing-widget-preview">Preview</span>}
      </header>
      <div className="timing-delta-value" data-testid="delta-value">{value}</div>
      <div className="timing-delta-track" aria-hidden="true">
        <div className="timing-delta-fill" style={{ width: `${barWidth}%`, left: direction === 'faster' ? '50%' : undefined, right: direction === 'slower' ? '50%' : undefined }} />
      </div>
      {!view.preview && view.reference === null && <div className="timing-widget-empty">No saved {label} lap</div>}
      {!view.preview && view.reference !== null && !available && <div className="timing-widget-empty">Waiting for current lap</div>}
    </section>
  );
}
