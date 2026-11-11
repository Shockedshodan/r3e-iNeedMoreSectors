import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CAPTURE_LIMITS, parseCapture, parseCaptureRow, projectRawTelemetry } from '../src/diagnostics/capture-format.ts';
import type { CaptureHeader } from '../src/diagnostics/capture-format.ts';

export function header(): CaptureHeader {
  return { kind: 'header', version: 1, captureId: 'test-capture', startedAt: '2026-11-11T12:00:00.000Z',
    source: 'synthetic', hudVersion: 'test', gameVersion: 'test', bridgeVersion: 'test', browser: 'test', pollMs: 16,
    limits: { ...DEFAULT_CAPTURE_LIMITS } };
}
function text(events: unknown[], footer: unknown = {
  kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length, lastSeq: events.length,
  durationMs: 50, queueHighWaterBytes: 500, lossCount: 0,
}): string {
  return [header(), ...events, ...(footer ? [footer] : [])].map(row => JSON.stringify(row)).join('\n') + '\n';
}
const event = { kind: 'event', seq: 1, tMs: 0, connectionId: 1, type: 'message', data: { CompletedLaps: 0 } };

test('capture projection preserves raw values, null and missing without private driver data', () => {
  const projected = projectRawTelemetry({ CompletedLaps: 0, LapTimePreviousSelf: -1, LapValidState: null,
    VehicleInfo: { ModelId: 20, Name: 'private' }, Player: { GameSimulationTime: 1.234567, Name: 'private' },
    SectorTimesCurrentSelf: { Sector1: 10.000001, Sector2: null, Name: 'private' },
    DriverData: [{ Name: 'private' }], DriverName: 'private' });
  assert.deepEqual(projected, { CompletedLaps: 0, LapTimePreviousSelf: -1, LapValidState: null,
    VehicleInfo: { ModelId: 20 }, Player: { GameSimulationTime: 1.234567 },
    SectorTimesCurrentSelf: { Sector1: 10.000001, Sector2: null } });
  assert.equal(Object.hasOwn(projected, 'LapTimeCurrentSelf'), false);
});

test('projection copies nested raw fields so later mutation cannot change the capture', () => {
  const data = { VehicleInfo: { ModelId: 20 } };
  const projected = projectRawTelemetry(data);
  data.VehicleInfo.ModelId = 99;
  assert.deepEqual(projected.VehicleInfo, { ModelId: 20 });
});

test('parser preserves equal timestamps and sequence order', () => {
  const doc = parseCapture(text([event, { ...event, seq: 2, data: { CompletedLaps: 1 } }]));
  assert.equal(doc.complete, true);
  assert.deepEqual(doc.events.map(row => row.data?.CompletedLaps), [0, 1]);
});

for (const [name, rows] of [
  ['missing sequence', [event, { ...event, seq: 3 }]],
  ['backwards timestamp', [{ ...event, tMs: 20 }, { ...event, seq: 2, tMs: 19 }]],
  ['private payload', [{ ...event, data: { DriverData: [{ Name: 'private' }] } }]],
  ['nonfinite timestamp', [{ ...event, tMs: null }]],
] as const) {
  test(`parser rejects ${name} without silently repairing input`, () => {
    assert.throws(() => parseCapture(text([...rows])));
  });
}

test('parser rejects unsupported versions, unknown rows, and duplicate headers', () => {
  assert.throws(() => parseCaptureRow({ ...header(), version: 2 }));
  assert.throws(() => parseCaptureRow({ kind: 'future-event' }));
  assert.throws(() => parseCapture(text([header()])));
});

test('missing footer is explicitly partial only when requested', () => {
  assert.throws(() => parseCapture(text([event], null)));
  const doc = parseCapture(text([event], null), { allowIncomplete: true });
  assert.equal(doc.complete, false);
  assert.ok(doc.problems.includes('missing-footer'));
});

test('footer event counts and end time must match the recorded stream', () => {
  const parsed = JSON.parse(text([event]).trim().split('\n').at(-1)!);
  assert.throws(() => parseCapture(text([event], { ...parsed, eventCount: 0 })));
  assert.throws(() => parseCapture(text([{ ...event, tMs: 100 }], parsed)));
});

test('loss is never reported as a qualifying complete capture', () => {
  const loss = { kind: 'event', seq: 1, tMs: 0, connectionId: 0, type: 'loss', reason: 'buffer-overflow' };
  const footer = { kind: 'footer', complete: false, reason: 'buffer-overflow', eventCount: 1, lastSeq: 1,
    durationMs: 10, queueHighWaterBytes: 1000, lossCount: 1 };
  assert.throws(() => parseCapture(text([loss], footer)));
  assert.equal(parseCapture(text([loss], footer), { allowIncomplete: true }).complete, false);
});

test('annotations are independent labels and optional totals remain optional', () => {
  const row = parseCaptureRow({ kind: 'event', seq: 1, tMs: 1, connectionId: 0, type: 'annotation',
    annotation: { completedLap: 1, outcome: 'invalid', notes: 'Game result screen' } });
  assert.equal(row.kind, 'event');
  assert.throws(() => parseCaptureRow({ ...event, type: 'annotation', data: undefined,
    annotation: { completedLap: -1, outcome: 'valid' } }));
});
