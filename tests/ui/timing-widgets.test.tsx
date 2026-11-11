import './dom.ts';
import React from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DeltaWidget, SectorPanel } from '../../src/ui/TimingWidgets.tsx';
import type { LapReference, TimingView } from '../../src/contracts.ts';
import { deepFreeze, lap } from '../helpers.ts';

afterEach(cleanup);

function reference(): LapReference {
  return deepFreeze(lap([30_123_000, 31_456_000, 31_000_000]));
}

function panel(overrides: Partial<TimingView['panel']> = {}): TimingView['panel'] {
  return { visible: true, preview: false, reference: reference(), ...overrides };
}

function delta(overrides: Partial<TimingView['delta']> = {}): TimingView['delta'] {
  return { visible: true, preview: false, reference: reference(), valueUs: -1_250_000, ...overrides };
}

test('Off or independently hidden widgets render no panel or delta', () => {
  render(<><SectorPanel mode="off" view={panel({ visible: false })} /><DeltaWidget mode="off" view={delta({ visible: false })} /></>);
  assert.equal(screen.queryByTestId('timing-sectors'), null);
  assert.equal(screen.queryByTestId('timing-delta'), null);
});

test('sector panel renders all selected saved sector durations and their complete total', () => {
  render(<SectorPanel mode="best" view={panel()} />);
  const widget = screen.getByTestId('timing-sectors');
  assert.equal(widget.getAttribute('data-reference-total-us'), '92579000');
  assert.ok(within(widget).getByRole('heading', { name: 'Best sectors' }));
  assert.ok(within(widget).getByText('0:30.123'));
  assert.ok(within(widget).getByText('0:31.456'));
  assert.ok(within(widget).getByText('0:31.000'));
  assert.ok(within(widget).getByText('1:32.579'));
  assert.equal(within(widget).getAllByRole('row').length, 4);
});

test('switching from Best to Opt renders the new saved reference rather than retaining old times', () => {
  const view = render(<SectorPanel mode="best" view={panel()} />);
  view.rerender(<SectorPanel mode="opt" view={panel({ reference: deepFreeze(lap([29_000_000, 30_000_000, 31_000_000])) })} />);
  assert.ok(screen.getByRole('heading', { name: 'Opt sectors' }));
  assert.ok(screen.getByText('1:30.000'));
  assert.equal(screen.queryByText('0:30.123'), null);
});

test('missing selected references are explicit in both widgets and never become a fake delta', () => {
  render(<><SectorPanel mode="opt" view={panel({ reference: null })} /><DeltaWidget mode="opt" view={delta({ reference: null, valueUs: 123_000 })} /></>);
  assert.equal(screen.getAllByText('No saved Opt lap').length, 2);
  assert.equal(screen.getByTestId('delta-value').textContent, '—');
  assert.equal(screen.queryByRole('table'), null);
});

test('layout previews are labelled and do not present saved data or synthetic delta as live values', () => {
  render(<><SectorPanel mode="best" view={panel({ preview: true })} /><DeltaWidget mode="best" view={delta({ preview: true })} /></>);
  assert.equal(screen.getAllByText('Preview').length, 2);
  assert.equal(screen.queryByText('0:30.123'), null);
  assert.equal(screen.queryByText('-1.250'), null);
  assert.equal(screen.getByTestId('delta-value').textContent, '—');
});

test('delta sign and visual direction distinguish faster, slower and equal references', () => {
  const rendered = render(<DeltaWidget mode="best" view={delta()} />);
  assert.equal(screen.getByTestId('delta-value').textContent, '-1.250');
  assert.equal(screen.getByTestId('timing-delta').getAttribute('data-delta-us'), '-1250000');
  assert.equal(screen.getByTestId('timing-delta').getAttribute('data-direction'), 'faster');
  rendered.rerender(<DeltaWidget mode="best" view={delta({ valueUs: 750_000 })} />);
  assert.equal(screen.getByTestId('delta-value').textContent, '+0.750');
  assert.equal(screen.getByTestId('timing-delta').getAttribute('data-direction'), 'slower');
  rendered.rerender(<DeltaWidget mode="best" view={delta({ valueUs: 0 })} />);
  assert.equal(screen.getByTestId('delta-value').textContent, '+0.000');
  assert.equal(screen.getByTestId('timing-delta').getAttribute('data-direction'), 'equal');
});

test('missing or nonfinite delta values remain unavailable instead of rendering NaN or Infinity', () => {
  const rendered = render(<DeltaWidget mode="best" view={delta({ valueUs: null })} />);
  for (const valueUs of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    rendered.rerender(<DeltaWidget mode="best" view={delta({ valueUs })} />);
    assert.equal(screen.getByTestId('delta-value').textContent, '—');
    assert.equal(screen.getByTestId('timing-delta').getAttribute('data-direction'), 'unavailable');
  }
});

test('delta precision rounds microseconds to milliseconds and avoids a misleading negative zero', () => {
  const rendered = render(<DeltaWidget mode="opt" view={delta({ valueUs: -1_234_567 })} />);
  assert.equal(screen.getByTestId('delta-value').textContent, '-1.235');
  rendered.rerender(<DeltaWidget mode="opt" view={delta({ valueUs: -1 })} />);
  assert.equal(screen.getByTestId('delta-value').textContent, '+0.000');
  assert.equal(screen.getByTestId('timing-delta').getAttribute('data-direction'), 'equal');
});

test('sector highlight follows the supplied layout boundaries, including exact transitions', () => {
  const rendered = render(<SectorPanel mode="best" view={panel()} currentDistance={0.25} boundaries={[0, 0.25, 0.75, 1]} />);
  assert.equal(screen.getByRole('row', { name: 'Sector 2 0:31.456' }).getAttribute('aria-current'), 'step');
  assert.equal(screen.getByRole('row', { name: 'Sector 1 0:30.123' }).getAttribute('aria-current'), null);
  rendered.rerender(<SectorPanel mode="best" view={panel()} currentDistance={1} boundaries={[0, 0.25, 0.75, 1]} />);
  assert.equal(screen.getByRole('row', { name: 'Sector 3 0:31.000' }).getAttribute('aria-current'), 'step');
});

test('sectors longer than an hour do not wrap the displayed total', () => {
  render(<SectorPanel mode="best" view={panel({ reference: lap([3_661_456_000]) })} />);
  assert.equal(screen.getAllByText('61:01.456').length, 2);
});
