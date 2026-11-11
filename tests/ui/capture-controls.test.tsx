import './dom.ts';
import React from 'react';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CaptureClient, CaptureClientState } from '../../src/diagnostics/capture-client.ts';
import type { CaptureAnnotation, CaptureManifest } from '../../src/diagnostics/capture-format.ts';
import { CaptureControls } from '../../src/ui/CaptureControls.tsx';

afterEach(cleanup);

class Client implements CaptureClient {
  state: CaptureClientState = {
    status: 'idle', captureId: null, eventCount: 0, bytes: 0,
    reason: null, outputPath: null, manifest: null,
  };
  listeners = new Set<() => void>();
  starts: unknown[] = [];
  labels: CaptureAnnotation[] = [];
  failStart = false;
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(value: Partial<CaptureClientState>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  async start(meta: Parameters<CaptureClient['start']>[0]) {
    if (this.failStart) throw new Error('Capture host is unavailable');
    this.starts.push(meta);
    this.update({ status: 'recording', captureId: 'capture-1', outputPath: 'captures/capture-1' });
  }
  async stop(): Promise<CaptureManifest> {
    const manifest: CaptureManifest = {
      version: 1, captureId: 'capture-1', complete: true, source: 'live',
      byteCount: 2048, eventCount: 8, sha256: 'a'.repeat(64), outputPath: 'captures/capture-1', problems: [],
    };
    this.update({ status: 'complete', manifest, bytes: 2048, eventCount: 8 });
    return manifest;
  }
  recordIngress() {}
  annotate(annotation: CaptureAnnotation) { this.labels.push(annotation); }
  dispose() {}
}

function fillProvenance() {
  fireEvent.change(screen.getByLabelText('Game build'), { target: { value: 'RaceRoom test build' } });
  fireEvent.change(screen.getByLabelText('Bridge build'), { target: { value: 'CrewChief test build' } });
}

test('requires explicit build provenance before starting a live diagnostic capture', async () => {
  const client = new Client();
  render(<CaptureControls client={client} source="live" />);
  assert.equal((screen.getByRole('button', { name: 'Start capture' }) as HTMLButtonElement).disabled, true);
  fillProvenance();
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
  await waitFor(() => assert.equal(client.starts.length, 1));
  assert.deepEqual(client.starts[0], {
    source: 'live', gameVersion: 'RaceRoom test build', bridgeVersion: 'CrewChief test build',
    browser: navigator.userAgent, pollMs: 16,
  });
  assert.match(screen.getByTestId('capture-status').textContent!, /capturing/i);
  assert.equal((screen.getByLabelText('Game build') as HTMLInputElement).disabled, true);
  assert.match(screen.getByText(/diagnostic capture does not enable/i).textContent!, /live lap-record/i);
});

test('synthetic source remains explicit and is passed unchanged to the client', async () => {
  const client = new Client();
  render(<CaptureControls client={client} source="synthetic" />);
  assert.match(screen.getByText(/synthetic demo/i).textContent!, /synthetic/i);
  fillProvenance();
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
  await waitFor(() => assert.equal(client.starts.length, 1));
  assert.equal((client.starts[0] as { source: string }).source, 'synthetic');
});

test('stop waits for a durable manifest and reports the saved output location', async () => {
  const client = new Client();
  client.update({ status: 'recording', captureId: 'capture-1', outputPath: 'captures/capture-1' });
  render(<CaptureControls client={client} source="live" />);
  assert.doesNotMatch(screen.getByTestId('capture-output').textContent!, /^Saved:/);
  fireEvent.click(screen.getByRole('button', { name: 'Stop capture' }));
  await waitFor(() => assert.match(screen.getByTestId('capture-status').textContent!, /complete/i));
  assert.match(screen.getByTestId('capture-output').textContent!, /Saved: captures\/capture-1/);
  assert.match(screen.getByLabelText('Captured events').textContent!, /8/);
});

test('operator annotations use independently entered outcome and official time', () => {
  const client = new Client();
  client.update({ status: 'recording', captureId: 'capture-1' });
  render(<CaptureControls client={client} source="live" />);
  fireEvent.change(screen.getByLabelText('Completed lap'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'valid' } });
  fireEvent.change(screen.getByLabelText('Official time seconds'), { target: { value: '91.234567' } });
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Confirmed on result screen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark lap' }));
  assert.deepEqual(client.labels, [{
    completedLap: 3, outcome: 'valid', totalUs: 91_234_567, totalToleranceUs: 1000,
    notes: 'Confirmed on result screen',
  }]);
});

test('official screen times carry an explicit one-millisecond comparison tolerance', () => {
  const client = new Client();
  client.update({ status: 'recording', captureId: 'capture-1' });
  render(<CaptureControls client={client} source="live" />);
  fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'valid' } });
  fireEvent.change(screen.getByLabelText('Official time seconds'), { target: { value: '91.235' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark lap' }));
  assert.equal(client.labels[0].totalToleranceUs, 1000);
  assert.match(screen.getByText(/screen precision/i).textContent!, /±1 ms/);
});

test('invalid annotation input never creates a ground-truth label', () => {
  const client = new Client();
  client.update({ status: 'recording', captureId: 'capture-1' });
  render(<CaptureControls client={client} source="live" />);
  fireEvent.change(screen.getByLabelText('Completed lap'), { target: { value: '-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark lap' }));
  assert.equal(client.labels.length, 0);
  assert.match(screen.getByRole('alert').textContent!, /lap/i);
});

test('client errors are visible and never imply a completed capture', async () => {
  const client = new Client();
  client.failStart = true;
  render(<CaptureControls client={client} source="live" />);
  fillProvenance();
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }));
  await waitFor(() => assert.match(screen.getByRole('alert').textContent!, /unavailable/i));
  assert.doesNotMatch(screen.getByTestId('capture-output').textContent!, /^Saved:/);
});

test('incomplete captures display the reason and can finalize their partial data', async () => {
  const client = new Client();
  client.update({ status: 'incomplete', captureId: 'capture-1', reason: 'buffer-overflow' });
  render(<CaptureControls client={client} source="live" />);
  assert.match(screen.getByTestId('capture-status').textContent!, /incomplete/i);
  assert.match(screen.getByText('buffer-overflow').textContent!, /buffer/);
  assert.equal((screen.getByRole('button', { name: 'Stop capture' }) as HTMLButtonElement).disabled, false);
});

test('subscription cleanup does not dispose the client owned by the application', () => {
  const client = new Client();
  let disposed = false;
  client.dispose = () => { disposed = true; };
  render(<CaptureControls client={client} source="live" />);
  assert.equal(client.listeners.size, 1);
  cleanup();
  assert.equal(client.listeners.size, 0);
  assert.equal(disposed, false);
  act(() => client.update({ eventCount: 1 }));
});

test('authoritative manifest problems remain visible when a stop reason is generic', () => {
  const client = new Client();
  client.update({ status: 'incomplete', reason: 'stopped', manifest: {
    version: 1, captureId: 'capture-1', complete: false, source: 'live',
    byteCount: 2048, eventCount: 8, sha256: 'a'.repeat(64), outputPath: 'captures/capture-1',
    problems: ['Capture file could not be synchronized'],
  } });
  render(<CaptureControls client={client} source="live" />);
  assert.match(screen.getByRole('list', { name: 'Capture completion issues' }).textContent!, /could not be synchronized/);
  assert.match(screen.getByTestId('capture-status').textContent!, /incomplete/i);
});
