import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCapture } from '../src/diagnostics/analyze.ts';
import type { ObservedValue } from '../src/diagnostics/analyze.ts';
import { DEFAULT_CAPTURE_LIMITS, parseCapture } from '../src/diagnostics/capture-format.ts';
import type { CaptureDocument, CaptureEvent } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';

// Public, additive analysis JSON contract. Raw observations explain association;
// a normalized total belongs to a row only when it can be associated with it.
// None of these fields is an independent game-UI annotation or authorization.
interface ResultObservation {
  seq: number;
  tMs: number;
  offsetMs: number;
  fields: Record<string, ObservedValue>;
  totalUs: number | null;
  cumulativeSectorsUs: (number | null)[];
}
interface ReportedLap {
  captureId: string;
  source: 'telemetry';
  connectionId: number;
  sessionId: string;
  sessionType: number;
  sessionIteration: number;
  eventIndex: number;
  layoutId: number;
  modelId: number;
  completedLap: number;
  lapCountStep: number;
  seq: number;
  atMs: number;
  coverage: 'partial-start' | 'observed';
  association: 'reported' | 'unavailable' | 'stale' | 'ambiguous' | 'skipped';
  totalUs: number | null;
  finality: 'not-established';
  observations: ResultObservation[];
}

function reportedLaps(report: unknown): ReportedLap[] {
  assert.ok(report && typeof report === 'object' && 'reportedLaps' in report,
    'Capture analysis must automatically expose telemetry-reported lap summaries');
  assert.ok(Array.isArray(report.reportedLaps), 'reportedLaps must be an array');
  return report.reportedLaps as ReportedLap[];
}
function observation(row: ReportedLap, seq: number): ResultObservation {
  const value = row.observations.find(item => item.seq === seq);
  assert.ok(value, `Lap ${row.completedLap} must retain the result fields observed at receipt ${seq}`);
  return value;
}

const fixtureUrl = new URL('./fixtures/lap-count-windows/', import.meta.url);
async function realCapture(): Promise<CaptureDocument> {
  const bytes = await readFile(new URL('capture.jsonl', fixtureUrl));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureUrl), 'utf8'));
  assert.equal(provenance.sourceCaptureId, 'f489307d-60e5-4188-9e9b-fce95b169b88');
  assert.equal(provenance.sourceSha256, '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtureSha256);
  assert.deepEqual(provenance.independentValidityLabels, []);
  assert.deepEqual(provenance.observations.map((item: { sourceSeq: number }) => item.sourceSeq),
    [10141, 10142, 19158, 19159, 28103, 28104, 37067, 37068, 46014, 46015, 54985, 54986]);
  const document = parseCapture(bytes.toString('utf8'), { allowIncomplete: true });
  assert.equal(document.complete, false);
  assert.ok(document.events.filter(event => event.type === 'message').every(event =>
    event.data!.VersionMajor === 2 && event.data!.VersionMinor === 8), 'Use actual API 2.8, without spoofing 3.6');
  assert.equal(document.events.filter(event => event.type === 'annotation').length, 0);
  return document;
}

test('native capture analysis extracts all six crossings and only the two available reported totals', async () => {
  const document = await realCapture();
  const original = structuredClone(document);
  const report = analyzeCapture(document);
  assert.deepEqual(report.boundaryObservations.filter(item => item.countProgression).map(item => item.seq),
    [3, 6, 9, 12, 15, 18]);
  const rows = reportedLaps(report);
  assert.deepEqual(rows.map(row => [row.seq, row.completedLap, row.lapCountStep, row.totalUs]), [
    [3, 1, 1, null], [6, 2, 1, null], [9, 3, 1, 149_494_965],
    [12, 4, 1, 149_835_876], [15, 5, 1, null], [18, 6, 1, null],
  ]);
  assert.equal(rows[0].coverage, 'partial-start', 'The starting/out-lap must not masquerade as a fully observed lap');
  for (const row of rows) {
    const receipt = document.events.find(event => event.seq === row.seq)!;
    assert.equal(row.captureId, document.header.captureId);
    assert.equal(row.connectionId, 1);
    assert.equal(row.atMs, receipt.tMs);
    assert.equal(row.layoutId, 13256);
    assert.equal(row.modelId, 13398);
    assert.deepEqual([row.sessionType, row.sessionIteration, row.eventIndex], [0, 1, 0]);
    assert.ok(typeof row.sessionId === 'string' && row.sessionId.length > 0);
    assert.equal(row.source, 'telemetry');
    assert.equal(row.finality, 'not-established');
    const observed = observation(row, row.seq);
    assert.equal(observed.tMs, receipt.tMs);
    assert.equal(observed.offsetMs, 0);
    assert.deepEqual(observed.fields.LapTimePreviousSelf, { present: true, value: receipt.data!.LapTimePreviousSelf });
    assert.deepEqual(observed.fields.PrevLapValid, { present: true, value: [3, 4].includes(row.completedLap) ? 1 : 0 });
    assert.deepEqual(observed.fields.LapTimeCurrentSelf, { present: true, value: receipt.data!.LapTimeCurrentSelf });
  }
  assert.deepEqual(observation(rows[2], 9).cumulativeSectorsUs, [41_457_977, 111_552_826, 149_494_965]);
  assert.deepEqual(observation(rows[3], 12).cumulativeSectorsUs, [41_402_283, 111_804_688, 149_835_876]);
  assert.deepEqual(document, original, 'Analysis must preserve source telemetry, native version and annotation absence');
});

// Independent synthetic cases deliberately keep API 2.8 and omit all adapter
// authorization. Receipt times, rather than sleeps, exercise the analysis window.
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VersionMajor: 2, VersionMinor: 8, LayoutId: 10, LayoutLength: 3000,
    VehicleInfo: { ModelId: 20 }, SessionType: 0, SessionIteration: 1, EventIndex: 0,
    Player: { GameSimulationTime: 100 }, CompletedLaps: 0,
    LapDistanceFraction: 0.9, LapTimeCurrentSelf: 9, LapTimePreviousSelf: -1,
    PrevLapValid: -1, LapValidState: 0, CurrentLapValid: 1,
    SectorTimesCurrentSelf: { Sector1: 3, Sector2: 6, Sector3: -1 },
    SectorTimesPreviousSelf: { Sector1: -1, Sector2: -1, Sector3: -1 },
    ControlType: 0, GameInReplay: 0, GamePaused: 0, GameInMenus: 0,
    ...overrides,
  };
}
function result(total: number, validity = 1): Record<string, unknown> {
  return { LapTimePreviousSelf: total, PrevLapValid: validity,
    SectorTimesPreviousSelf: { Sector1: total / 4, Sector2: total / 2, Sector3: total } };
}
function message(tMs: number, count: number, overrides: Record<string, unknown> = {}, connectionId = 1): CaptureEvent {
  return { kind: 'event', type: 'message', connectionId, seq: 0, tMs,
    data: raw({ CompletedLaps: count, Player: { GameSimulationTime: 100 + tMs / 1000 }, ...overrides }) };
}
function capture(events: CaptureEvent[]): CaptureDocument {
  return {
    header: { kind: 'header', version: 1, captureId: 'synthetic-reported-laps',
      startedAt: '2026-11-11T00:00:00.000Z', source: 'synthetic', hudVersion: 'test',
      gameVersion: 'synthetic', bridgeVersion: 'synthetic', browser: 'synthetic', pollMs: 16,
      limits: { ...DEFAULT_CAPTURE_LIMITS } },
    events: events.map((event, index) => ({ ...event, seq: index + 1 })),
    complete: true, problems: [],
    footer: { kind: 'footer', complete: true, reason: 'stopped', eventCount: events.length,
      lastSeq: events.length, durationMs: events.at(-1)?.tMs ?? 0, queueHighWaterBytes: 0, lossCount: 0 },
  };
}
function analyze(events: CaptureEvent[], windowMs = 3000): ReportedLap[] {
  return reportedLaps(analyzeCapture(capture(events), { windowMs }));
}

test('a delayed native result is attached once to its crossing with receipt provenance', () => {
  const rows = analyze([
    message(0, 0), message(100, 1), message(200, 1, result(11)),
    message(220, 1, result(11)), message(220, 1, result(11)),
  ]);
  assert.equal(rows.length, 1, 'Repeated polling and equal timestamps must not duplicate the lap');
  assert.deepEqual([rows[0].seq, rows[0].atMs, rows[0].totalUs, rows[0].association], [2, 100, 11_000_000, 'reported']);
  assert.deepEqual(observation(rows[0], 2).fields.LapTimePreviousSelf, { present: true, value: -1 });
  const delayed = observation(rows[0], 3);
  assert.deepEqual([delayed.seq, delayed.tMs, delayed.offsetMs, delayed.totalUs], [3, 200, 100, 11_000_000]);
  assert.deepEqual(delayed.cumulativeSectorsUs, [2_750_000, 5_500_000, 11_000_000]);
  assert.equal(rows[0].finality, 'not-established', 'Repeated stability is not final validity');
});

test('conflicting totals and delayed invalidity remain visible instead of settling on the last sample', () => {
  const rows = analyze([
    message(0, 0), message(100, 1, result(11)), message(200, 1, result(12)),
    message(250, 1, result(12, 0)), message(300, 1, result(12, 0)),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].association, 'ambiguous');
  assert.equal(rows[0].totalUs, null, 'Conflicting reports must not become a single confidently associated time');
  assert.deepEqual([2, 3, 4].map(seq => {
    const item = observation(rows[0], seq);
    return [item.seq, item.offsetMs, item.fields.LapTimePreviousSelf, item.fields.PrevLapValid];
  }), [
    [2, 0, { present: true, value: 11 }, { present: true, value: 1 }],
    [3, 100, { present: true, value: 12 }, { present: true, value: 1 }],
    [4, 150, { present: true, value: 12 }, { present: true, value: 0 }],
  ]);
  assert.equal(rows[0].finality, 'not-established');
});

test('delayed native validity retains the unknown flag at the crossing and the later reported flag', () => {
  const rows = analyze([
    message(0, 0), message(100, 1, result(11, -1)), message(200, 1, result(11, 1)),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(observation(rows[0], 2).fields.PrevLapValid, { present: true, value: -1 });
  assert.deepEqual(observation(rows[0], 3).fields.PrevLapValid, { present: true, value: 1 });
  assert.deepEqual([observation(rows[0], 3).offsetMs, observation(rows[0], 3).totalUs], [100, 11_000_000]);
  assert.equal(rows[0].finality, 'not-established', 'A late valid flag is observed telemetry, not independent finality');
});

test('changing only native validity cannot turn stable result clocks into settled validity', () => {
  const rows = analyze([
    message(0, 0), message(100, 1, result(11, 1)), message(200, 1, result(11, 0)),
    message(300, 1, result(11, 0)),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].association, 'ambiguous');
  assert.deepEqual([2, 3].map(seq => observation(rows[0], seq).fields.PrevLapValid),
    [{ present: true, value: 1 }, { present: true, value: 0 }]);
  assert.deepEqual([2, 3].map(seq => observation(rows[0], seq).totalUs), [11_000_000, 11_000_000]);
  assert.equal(rows[0].finality, 'not-established');
});

test('staggered total and sector updates preserve mixed observations without inventing a coherent sample', () => {
  const rows = analyze([
    message(0, 0, result(10)),
    message(100, 1, { ...result(10), LapTimePreviousSelf: 11 }),
    message(200, 1, result(11)),
  ]);
  assert.equal(rows.length, 1);
  const mixed = observation(rows[0], 2);
  assert.equal(mixed.totalUs, 11_000_000);
  assert.deepEqual(mixed.cumulativeSectorsUs, [2_500_000, 5_000_000, 10_000_000]);
  const coherent = observation(rows[0], 3);
  assert.deepEqual(coherent.cumulativeSectorsUs, [2_750_000, 5_500_000, 11_000_000]);
  assert.equal(coherent.offsetMs, 100);
  assert.equal(rows[0].finality, 'not-established');
});

test('an unchanged previous-result signature cannot be reassigned to the next lap by stable polling', () => {
  const rows = analyze([
    message(0, 0), message(100, 1, result(11)), message(4000, 1, result(11)),
    message(4100, 2, result(11)), message(4200, 2, result(11)), message(4300, 2, result(11)),
  ]);
  assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs]), [[1, 11_000_000], [2, null]]);
  assert.equal(rows[1].association, 'stale');
  assert.equal(observation(rows[1], 4).totalUs, 11_000_000, 'Retain the stale native value without attributing it');
});

for (const unavailable of [undefined, null, -1]) {
  for (const cleared of [[1], [2], [3], [1, 2, 3]]) {
    test(`clearing previous sectors ${cleared.join(',')} to ${String(unavailable)} cannot refresh an unchanged total`, () => {
      const sectors: Record<string, number | null> = { Sector1: 2.75, Sector2: 5.5, Sector3: 11 };
      for (const sector of cleared) {
        if (unavailable === undefined) delete sectors[`Sector${sector}`];
        else sectors[`Sector${sector}`] = unavailable;
      }
      const clearedResult = { ...result(11), SectorTimesPreviousSelf: sectors };
      const rows = analyze([
        message(0, 0), message(100, 1, result(11)), message(7000, 1, result(11)),
        message(7100, 2, clearedResult), message(7200, 2, clearedResult),
      ]);
      assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs]), [[1, 11_000_000], [2, null]]);
      assert.ok(['stale', 'ambiguous'].includes(rows[1].association));
      const receipt = observation(rows[1], 4);
      assert.deepEqual([receipt.tMs, receipt.offsetMs, receipt.totalUs], [7100, 0, 11_000_000]);
      assert.deepEqual(receipt.fields.PrevLapValid, { present: true, value: 1 });
      for (const sector of cleared) {
        assert.deepEqual(receipt.fields[`SectorTimesPreviousSelf.Sector${sector}`],
          unavailable === undefined ? { present: false } : { present: true, value: unavailable });
        assert.equal(receipt.cumulativeSectorsUs[sector - 1], null);
      }
    });
  }
}

for (const unavailable of [undefined, null, -1]) {
  for (const cleared of [['total'], ['Sector1'], ['Sector2'], ['Sector3'],
    ['Sector1', 'Sector2', 'Sector3'], ['total', 'Sector1', 'Sector2', 'Sector3']]) {
    for (const restoreAt of [7000, 7100, 7200]) {
      test(`restoring ${cleared.join(',')} after ${String(unavailable)} at ${restoreAt} cannot refresh old results`, () => {
        const interrupted = result(11);
        const sectors: Record<string, unknown> = { Sector1: 2.75, Sector2: 5.5, Sector3: 11 };
        interrupted.SectorTimesPreviousSelf = sectors;
        for (const field of cleared) {
          const target = field === 'total' ? interrupted : sectors;
          const key = field === 'total' ? 'LapTimePreviousSelf' : field;
          if (unavailable === undefined) delete target[key];
          else target[key] = unavailable;
        }
        const events = [
          message(0, 0), message(100, 1, result(11)),
          message(6900, 1, interrupted),
          message(7000, 1, restoreAt <= 7000 ? result(11) : interrupted),
          message(7100, 2, restoreAt <= 7100 ? result(11) : interrupted),
          message(7200, 2, result(11)), message(7300, 2, result(11)),
        ];
        if (unavailable === undefined && cleared.includes('total')) {
          for (const event of events) {
            if (event.tMs >= 6900 && event.tMs < restoreAt && event.data) delete event.data.LapTimePreviousSelf;
          }
        }
        const rows = analyze(events);
        assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs]), [[1, 11_000_000], [2, null]]);
        assert.ok(['stale', 'ambiguous'].includes(rows[1].association));
        const interruption = observation(rows[1], 3);
        for (const field of cleared) {
          const path = field === 'total' ? 'LapTimePreviousSelf' : `SectorTimesPreviousSelf.${field}`;
          assert.deepEqual(interruption.fields[path], unavailable === undefined
            ? { present: false } : { present: true, value: unavailable });
        }
        const restored = observation(rows[1], restoreAt === 7000 ? 4 : restoreAt === 7100 ? 5 : 6);
        assert.equal(restored.totalUs, 11_000_000);
        assert.deepEqual(restored.cumulativeSectorsUs, [2_750_000, 5_500_000, 11_000_000]);
      });
    }
  }
}

test('changed available sectors can distinguish equal totals across nonoverlapping crossings', () => {
  const changedResult = { ...result(11), SectorTimesPreviousSelf: { Sector1: 3, Sector2: 6, Sector3: 11 } };
  const rows = analyze([
    message(0, 0), message(100, 1, result(11)), message(7000, 1, result(11)),
    message(7100, 2, changedResult), message(7200, 2, changedResult),
  ]);
  assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs, row.association]),
    [[1, 11_000_000, 'reported'], [2, 11_000_000, 'reported']]);
  assert.deepEqual(observation(rows[1], 4).cumulativeSectorsUs, [3_000_000, 6_000_000, 11_000_000]);
});

test('an available previous result at capture start stays unattributed through the first crossing and repeated polling', () => {
  const rows = analyze([
    message(0, 7, result(11)), message(100, 8, result(11)),
    message(120, 8, result(11)), message(140, 8, result(11)),
  ]);
  assert.deepEqual(rows.map(row => [row.seq, row.completedLap, row.totalUs, row.association]),
    [[2, 8, null, 'stale']], 'An unconsumed baseline result is not fresh merely because no earlier crossing used it');
  // One baseline snapshot suffices: unchanged polling receipts may be compressed.
  const baseline = observation(rows[0], 1);
  assert.deepEqual([baseline.tMs, baseline.offsetMs, baseline.totalUs], [0, -100, 11_000_000]);
  assert.deepEqual(baseline.fields.LapTimePreviousSelf, { present: true, value: 11 });
  assert.deepEqual(baseline.fields.PrevLapValid, { present: true, value: 1 });
  for (const [field, value] of [['Sector1', 2.75], ['Sector2', 5.5], ['Sector3', 11]] as const) {
    assert.deepEqual(baseline.fields[`SectorTimesPreviousSelf.${field}`], { present: true, value });
  }
  assert.deepEqual(baseline.cumulativeSectorsUs, [2_750_000, 5_500_000, 11_000_000]);
  assert.equal(rows[0].finality, 'not-established');
});

test('a partial starting lap and the following fully observed lap have distinct coverage', () => {
  const events: CaptureEvent[] = [];
  // Start halfway through a ten-second lap, then observe the entire next lap.
  // Frequent samples, two clock/distance wraps, and uninterrupted identity leave
  // no capture gap that could make the second lap partial too.
  for (let tMs = 0; tMs <= 17_000; tMs += 250) {
    const completedLap = tMs < 5000 ? 7 : tMs < 17_000 ? 8 : 9;
    const elapsed = tMs < 5000 ? 5 + tMs / 1000 : tMs < 17_000 ? (tMs - 5000) / 1000 : 0;
    const duration = tMs < 5000 ? 10 : 12;
    events.push(message(tMs, completedLap, {
      ...(tMs < 5000 ? {} : result(tMs < 17_000 ? 10 : 12)),
      LapDistanceFraction: elapsed / duration,
      LapTimeCurrentSelf: elapsed,
      SectorTimesCurrentSelf: {
        Sector1: elapsed >= duration / 4 ? duration / 4 : -1,
        Sector2: elapsed >= duration / 2 ? duration / 2 : -1,
        Sector3: -1,
      },
    }));
  }
  const rows = analyze(events);
  assert.deepEqual(rows.map(row => [row.completedLap, row.coverage, row.totalUs]),
    [[8, 'partial-start', 10_000_000], [9, 'observed', 12_000_000]],
    'Only the lap already in progress when capture begins has partial coverage');
  assert.equal(rows[0].sessionId, rows[1].sessionId, 'Both laps belong to one uninterrupted observed session');
  assert.ok(rows.every(row => row.source === 'telemetry' && row.finality === 'not-established'));
});

test('a changed sector signature preserves an equal native total as new telemetry evidence', () => {
  const rows = analyze([
    message(0, 0), message(100, 1, result(11)), message(4000, 1, result(11)),
    message(4100, 2, { ...result(11), SectorTimesPreviousSelf: { Sector1: 2, Sector2: 6, Sector3: 11 } }),
  ]);
  assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs, row.association]),
    [[1, 11_000_000, 'reported'], [2, 11_000_000, 'reported']]);
  assert.deepEqual(observation(rows[1], 4).cumulativeSectorsUs, [2_000_000, 6_000_000, 11_000_000]);
});

test('a result shared by overlapping crossings remains ambiguous for both laps', () => {
  const rows = analyze([
    message(0, 0), message(100, 1), message(200, 2), message(250, 2, result(11)),
  ], 500);
  assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs, row.association]),
    [[1, null, 'ambiguous'], [2, null, 'ambiguous']]);
  for (const row of rows) assert.equal(observation(row, 4).totalUs, 11_000_000);
});

test('a skipped completed count produces one unresolved progression rather than invented lap results', () => {
  const rows = analyze([message(0, 3), message(100, 6, result(11)), message(200, 6, result(11))]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].completedLap, rows[0].lapCountStep, rows[0].association, rows[0].totalUs],
    [6, 3, 'skipped', null]);
  assert.equal(observation(rows[0], 2).totalUs, 11_000_000, 'Inspect the observed value without guessing which skipped lap owns it');
});

test('missing null and sentinel clocks stay distinct and never become invalid-lap durations', () => {
  const missing = message(100, 1, { PrevLapValid: 0 });
  delete missing.data!.LapTimePreviousSelf;
  delete (missing.data!.SectorTimesPreviousSelf as Record<string, unknown>).Sector1;
  const rows = analyze([
    message(0, 0), missing,
    message(200, 1, { PrevLapValid: 0, LapTimePreviousSelf: null,
      SectorTimesPreviousSelf: { Sector1: null, Sector2: -1, Sector3: -1 } }),
    message(300, 1, { PrevLapValid: 0 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalUs, null);
  assert.equal(rows[0].association, 'unavailable');
  assert.deepEqual([2, 3, 4].map(seq => observation(rows[0], seq).fields.LapTimePreviousSelf),
    [{ present: false }, { present: true, value: null }, { present: true, value: -1 }]);
  assert.deepEqual([2, 3, 4].map(seq => observation(rows[0], seq).fields['SectorTimesPreviousSelf.Sector1']),
    [{ present: false }, { present: true, value: null }, { present: true, value: -1 }]);
  for (const seq of [2, 3, 4]) {
    assert.equal(observation(rows[0], seq).totalUs, null);
    assert.deepEqual(observation(rows[0], seq).cumulativeSectorsUs, [null, null, null]);
    assert.deepEqual(observation(rows[0], seq).fields.PrevLapValid, { present: true, value: 0 });
  }
});

test('results outside the configured finish window are not borrowed by an earlier crossing', () => {
  const rows = analyze([message(0, 0), message(100, 1), message(601, 1, result(11))], 500);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalUs, null);
  assert.equal(rows[0].association, 'unavailable');
  assert.ok(rows[0].observations.every(item => Math.abs(item.offsetMs) <= 500));
  assert.ok(!rows[0].observations.some(item => item.seq === 3));
});

test('result changes before the count crossing retain their negative receipt offsets', () => {
  const rows = analyze([message(0, 0), message(80, 0, result(11)), message(100, 1, result(11))]);
  assert.equal(rows.length, 1);
  const leading = observation(rows[0], 2);
  assert.deepEqual([leading.seq, leading.tMs, leading.offsetMs, leading.totalUs], [2, 80, -20, 11_000_000]);
  assert.equal(rows[0].finality, 'not-established');
});

test('result-field changes without completed-count progression do not invent a lap row', () => {
  assert.deepEqual(analyze([message(0, 3), message(100, 3, result(11)), message(200, 3, result(12))]), []);
});

const resets: { name: string; event?: CaptureEvent['type']; overrides?: Record<string, unknown>; count?: number }[] = [
  ...(['close', 'error', 'open', 'malformed', 'loss'] as const).map(event => ({ name: `${event} interruption`, event })),
  { name: 'layout change', overrides: { LayoutId: 99 } },
  { name: 'vehicle model change', overrides: { VehicleInfo: { ModelId: 99 } } },
  { name: 'session type change', overrides: { SessionType: 1 } },
  { name: 'session iteration change', overrides: { SessionIteration: 2 } },
  { name: 'event index change', overrides: { EventIndex: 2 } },
  { name: 'simulation clock rollback', overrides: { Player: { GameSimulationTime: 1 } } },
  { name: 'completed count rollback', count: 0 },
];
for (const reset of resets) {
  test(`${reset.name} clears available-clock history before an equal result in the new segment`, () => {
    const count = reset.count ?? 10;
    const events = [message(0, 7, result(11))];
    if (reset.event) events.push({ kind: 'event', type: reset.event, seq: 0, tMs: 50, connectionId: 1,
      reason: 'Synthetic interruption' });
    events.push(message(100, count, reset.overrides),
      message(200, count + 1, { ...result(11), ...reset.overrides }));
    const rows = analyze(events);
    assert.deepEqual(rows.map(row => [row.completedLap, row.totalUs, row.association]),
      [[count + 1, 11_000_000, 'reported']]);
    assert.ok(rows[0].observations.every(item => item.tMs >= 100));
  });

  test(`${reset.name} isolates pending reported results and permits a fresh crossing`, () => {
    const count = reset.count ?? 10;
    const events = [message(0, 0), message(100, 1)];
    if (reset.event) events.push({ kind: 'event', type: reset.event, seq: 0, tMs: 150, connectionId: 1,
      reason: 'Synthetic interruption' });
    events.push(message(200, count, { ...result(12), ...reset.overrides }),
      message(300, count + 1, { ...result(14), ...reset.overrides }));
    const rows = analyze(events);
    const baselineSeq = reset.event ? 4 : 3;
    assert.deepEqual(rows.map(row => [row.seq, row.completedLap, row.totalUs]),
      [[2, 1, null], [baselineSeq + 1, count + 1, 14_000_000]]);
    assert.ok(rows[0].observations.every(item => item.seq < baselineSeq), 'Later epoch must not fill the pending result');
    assert.ok(rows[1].observations.every(item => item.seq >= baselineSeq), 'Earlier epoch must not enter the new result window');
    assert.ok(rows.every(row => typeof row.sessionId === 'string' && row.sessionId.length > 0));
    assert.notEqual(rows[0].sessionId, rows[1].sessionId, 'Repeated counters need distinct observed session identities');
    assert.equal(observation(rows[1], baselineSeq + 1).totalUs, 14_000_000);
  });

  test(`an available previous result after ${reset.name} stays unattributed through the first crossing and repeated polling`, () => {
    const count = reset.count ?? 10;
    // There is no crossing before the reset. The new baseline differs from the
    // old epoch, but remains unchanged throughout the new epoch's first finish.
    const events = [message(0, 7, result(10))];
    if (reset.event) events.push({ kind: 'event', type: reset.event, seq: 0, tMs: 50, connectionId: 1,
      reason: 'Synthetic interruption' });
    events.push(message(100, count, { ...result(11), ...reset.overrides }),
      message(200, count + 1, { ...result(11), ...reset.overrides }),
      message(220, count + 1, { ...result(11), ...reset.overrides }),
      message(240, count + 1, { ...result(11), ...reset.overrides }));
    const rows = analyze(events);
    const baselineSeq = reset.event ? 3 : 2;
    assert.deepEqual(rows.map(row => [row.seq, row.completedLap, row.totalUs, row.association]),
      [[baselineSeq + 1, count + 1, null, 'stale']], 'A new epoch must establish its own previous-result baseline');
    assert.ok(rows[0].observations.every(item => item.seq >= baselineSeq), 'Discard observations from the old epoch');
    // Retain the new epoch's baseline; repeated identical fields need no copies.
    const baseline = observation(rows[0], baselineSeq);
    assert.deepEqual([baseline.tMs, baseline.offsetMs, baseline.totalUs], [100, -100, 11_000_000]);
    assert.deepEqual(baseline.fields.LapTimePreviousSelf, { present: true, value: 11 });
    assert.deepEqual(baseline.fields.PrevLapValid, { present: true, value: 1 });
    for (const [field, value] of [['Sector1', 2.75], ['Sector2', 5.5], ['Sector3', 11]] as const) {
      assert.deepEqual(baseline.fields[`SectorTimesPreviousSelf.${field}`], { present: true, value });
    }
    assert.deepEqual(baseline.cumulativeSectorsUs, [2_750_000, 5_500_000, 11_000_000]);
    assert.equal(rows[0].finality, 'not-established');
  });
}

test('interleaved connections keep their result windows and repeated lap counts separate', () => {
  const rows = analyze([
    message(0, 0), message(20, 0, {}, 2), message(100, 1),
    message(120, 1, result(12), 2), message(200, 1, result(11)), message(220, 1, result(12), 2),
  ]);
  assert.deepEqual(rows.map(row => [row.connectionId, row.completedLap, row.totalUs]),
    [[1, 1, 11_000_000], [2, 1, 12_000_000]]);
  for (const row of rows) {
    assert.ok(row.observations.length > 0);
    for (const item of row.observations) assert.equal([1, 2, 1, 2, 1, 2][item.seq - 1], row.connectionId);
  }
});

test('automatic telemetry summaries leave source evidence replay annotations and live-saving gates unchanged', async () => {
  const document = await realCapture();
  const original = structuredClone(document);
  const before = replayCapture(document);
  const report = analyzeCapture(document);
  const rows = reportedLaps(report);
  assert.equal(rows.filter(row => row.totalUs !== null).length, 2, 'Require actual extraction before checking its safety gates');
  assert.ok(rows.every(row => row.source === 'telemetry' && row.finality === 'not-established'));
  assert.equal(report.summary.annotationCount, 0);
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
  assert.deepEqual(document, original);
  const after = replayCapture(document);
  assert.deepEqual(after, before, 'Extracted telemetry must not become independent replay labels');
  assert.deepEqual(after.comparisons, []);
  assert.deepEqual(after.controlProposals, []);
  assert.deepEqual(after.shadowProposals, []);
  assert.equal(after.liveWritesEnabled, false);
  assert.equal(after.profileValidated, false);
});

test('capture analysis CLI writes automatic native results without operator labels or source-file changes', async t => {
  await realCapture();
  const directory = await mkdtemp(join(tmpdir(), 'r3e-reported-laps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(new URL('capture.jsonl', fixtureUrl));
  const input = join(directory, 'capture.jsonl');
  const output = join(directory, 'analysis');
  await writeFile(input, bytes);
  execFileSync(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../scripts/analyze-capture.ts', import.meta.url)), input,
    '--out', output, '--allow-incomplete'], { encoding: 'utf8', timeout: 10_000 });
  const report = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  const rows = reportedLaps(report);
  assert.deepEqual(rows.map(row => row.totalUs), [null, null, 149_494_965, 149_835_876, null, null]);
  assert.ok(rows.every(row => row.source === 'telemetry'));
  assert.equal(report.summary.annotationCount, 0);
  assert.equal(report.recordingEnabled, false);
  assert.equal(report.liveValidated, false);
  assert.equal(report.complete, false, 'An excerpt must remain incomplete even when results can be extracted');
  assert.deepEqual(await readFile(input), bytes);
});
