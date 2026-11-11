import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { analyzeCapture, formatAnalysisCsv, formatAnalysisHtml } from '../src/diagnostics/analyze.ts';
import { parseCapture } from '../src/diagnostics/capture-format.ts';
import type { CaptureDocument, CaptureEvent } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';

const fixtureUrl = new URL('./fixtures/lap-count-windows/', import.meta.url);

async function realWindows(): Promise<CaptureDocument> {
  const bytes = await readFile(new URL('capture.jsonl', fixtureUrl));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixtureUrl), 'utf8'));
  assert.equal(provenance.sourceCaptureId, 'f489307d-60e5-4188-9e9b-fce95b169b88');
  assert.equal(provenance.sourceSha256, '67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtureSha256);
  assert.deepEqual(provenance.observations.map((row: { sourceSeq: number }) => row.sourceSeq),
    [10141, 10142, 19158, 19159, 28103, 28104, 37067, 37068, 46014, 46015, 54985, 54986]);
  const document = parseCapture(bytes.toString('utf8'), { allowIncomplete: true });
  assert.equal(document.complete, false, 'Sparse windows must not claim continuous capture');
  const messages = document.events.filter(event => event.type === 'message');
  assert.deepEqual(messages.map(event => event.data!.CompletedLaps), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  assert.deepEqual(messages.filter(event => event.data!.LapTimeCurrentSelf === -1)
    .map(event => event.data!.CompletedLaps), [0, 1, 4, 5, 6]);
  return document;
}

function rawProgressionSequences(document: CaptureDocument): number[] {
  return analyzeCapture(document).boundaryObservations.filter(row => row.countProgression).map(row => row.seq);
}

test('real count increments remain observable when out-lap and invalid-lap clocks are unavailable', async () => {
  const document = await realWindows();
  const report = analyzeCapture(document);
  const replay = replayCapture(document);
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
  assert.equal(replay.liveWritesEnabled, false);
  assert.equal(replay.profileValidated, false);
  assert.deepEqual(replay.controlProposals, []);
  assert.deepEqual(replay.shadowProposals, []);
  assert.equal(report.summary.invalidTimingCount, 5);
  assert.deepEqual(report.finishes.map(row => row.completedLap), [3, 4],
    'Only pairs with available clocks qualify for timing finish windows; no native flag proves validity');
  assert.ok(report.finishes.every(row => row.finality === 'not-established'));
  assert.deepEqual(rawProgressionSequences(document), [3, 6, 9, 12, 15, 18],
    'All six raw count increments must survive unavailable clocks, independently of timing finishes');
});

// These are explicitly synthetic isolation cases derived from one real window.
// They assert reset and duplicate handling, not native-game semantics.
async function syntheticDocument(events: Omit<CaptureEvent, 'kind' | 'seq' | 'tMs'>[]): Promise<CaptureDocument> {
  const document = await realWindows();
  document.header.source = 'synthetic';
  document.events = events.map((event, index) => ({ ...event, kind: 'event', seq: index + 1, tMs: index * 20 }));
  document.footer = null;
  document.problems = ['Synthetic isolation case'];
  return document;
}

async function unavailableMessage(count: number, overrides: Record<string, unknown> = {}) {
  const document = await realWindows();
  return { type: 'message' as const, connectionId: 1,
    data: { ...structuredClone(document.events.find(event => event.type === 'message')!.data!), CompletedLaps: count,
      LapTimeCurrentSelf: -1, ...overrides } };
}

test('duplicate polling and clock recovery do not duplicate a raw count increment', async () => {
  const before = await unavailableMessage(0);
  const crossing = await unavailableMessage(1);
  const document = await syntheticDocument([before, crossing, structuredClone(crossing),
    { ...crossing, data: { ...crossing.data, LapTimeCurrentSelf: 0.2 } }, await unavailableMessage(2)]);
  assert.deepEqual(rawProgressionSequences(document), [2, 5]);
});

for (const [field, value] of [
  ['LayoutId', 999], ['VehicleInfo', { ModelId: 999 }], ['SessionType', 1],
  ['SessionIteration', 2], ['EventIndex', 1],
] as const) {
  test(`raw count increments stay within the observed ${field} identity`, async () => {
    const document = await syntheticDocument([
      await unavailableMessage(0), await unavailableMessage(1),
      await unavailableMessage(2, { [field]: value }), await unavailableMessage(3, { [field]: value }),
    ]);
    assert.deepEqual(rawProgressionSequences(document), [2, 4],
      'Suppress the unit increment across identities, then report the next increment within the new identity');
  });
}

for (const type of ['close', 'error', 'open', 'malformed', 'loss'] as const) {
  test(`raw count increments stay isolated across ${type} events`, async () => {
    const document = await syntheticDocument([
      await unavailableMessage(0), await unavailableMessage(1), { type, connectionId: 1 },
      await unavailableMessage(2), await unavailableMessage(3),
    ]);
    assert.deepEqual(rawProgressionSequences(document), [2, 5],
      'Suppress the unit increment across the interruption, then report the next increment');
  });
}

test('raw count increments are attributed independently to each connection', async () => {
  const document = await syntheticDocument([
    await unavailableMessage(0), { ...await unavailableMessage(1), connectionId: 2 },
    await unavailableMessage(1), { ...await unavailableMessage(2), connectionId: 2 },
  ]);
  assert.deepEqual(analyzeCapture(document).boundaryObservations.filter(row => row.countProgression)
    .map(row => [row.connectionId, row.seq]), [[1, 3], [2, 4]]);
});

test('simulation-clock rollback starts a fresh raw count baseline', async () => {
  const document = await syntheticDocument([
    await unavailableMessage(0, { Player: { GameSimulationTime: 10 } }),
    await unavailableMessage(1, { Player: { GameSimulationTime: 11 } }),
    await unavailableMessage(2, { Player: { GameSimulationTime: 1 } }),
    await unavailableMessage(3, { Player: { GameSimulationTime: 2 } }),
  ]);
  assert.deepEqual(rawProgressionSequences(document), [2, 4],
    'Suppress the unit increment across the clock rollback, then report the next increment');
});

test('lap-count rollback permits later increments without inventing a crossing at the reset', async () => {
  const document = await syntheticDocument([
    await unavailableMessage(4), await unavailableMessage(5),
    await unavailableMessage(0), await unavailableMessage(1),
  ]);
  assert.deepEqual(rawProgressionSequences(document), [2, 4]);
});

test('CSV includes raw count increments whose clocks cannot qualify a timing finish', async () => {
  const report = analyzeCapture(await realWindows());
  const csv = formatAnalysisCsv(report);
  // The formatter quotes every cell. Decode escaped quotes before inspecting
  // records; timeline field changes are not progression records.
  const [headers, ...rows] = csv.trimEnd().split('\n').map(line =>
    [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));
  const records = rows.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index]])))
    .filter(row => row.field === 'CompletedLaps' && row.record !== 'field');
  assert.deepEqual(records.map(row => [Number(row.connectionId), Number(row.sequence), Number(row.after)]),
    [[1, 3, 1], [1, 6, 2], [1, 9, 3], [1, 12, 4], [1, 15, 5], [1, 18, 6]],
    'Export each progression exactly once, separately from repeated timeline values');
  for (const row of records) {
    const count = Number(row.after);
    assertTimingClassification(count, Object.values(row).join(' '));
    if ([1, 2, 5, 6].includes(count)) {
      assert.doesNotMatch(row.record, /^(?:finish|timing[-_ ]qualified[-_ ]finish)$/i,
        `Progression ${count} must not be exported as a timing finish record`);
    }
  }
});

const unavailableTiming = /(?:clock|timing)[\s\S]{0,80}(?:unavailable|missing)|(?:unavailable|missing)[\s\S]{0,80}(?:clock|timing)/i;
const qualifiedTiming = /timing[- ]qualified|coherent(?: timing)? finish|finish candidate|(?:clock|timing)s? (?:is |are )?available/i;

function assertTimingClassification(count: number, status: string): void {
  if ([1, 2, 5, 6].includes(count)) {
    assert.match(status, unavailableTiming, `Progression ${count} must explain its unavailable timing`);
    assert.doesNotMatch(status, qualifiedTiming, `Progression ${count} must not claim timing qualification`);
  } else {
    assert.match(status, qualifiedTiming, `Progression ${count} must distinguish its timing-qualified evidence`);
    assert.doesNotMatch(status, unavailableTiming, `Progression ${count} has usable lap clocks`);
  }
}

function visibleText(element: Element, omitTables = false): string {
  if (element.matches('script, style, [hidden], [aria-hidden="true"]')
    || (omitTables && element.matches('table, [role="table"]'))
    || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.getAttribute('style') ?? '')) return '';
  return [...element.childNodes].map(node => node.nodeType === 1
    ? visibleText(node as Element, omitTables) : node.nodeType === 3 ? node.textContent : '').join(' ').replace(/\s+/g, ' ').trim();
}

function visibleProgressions(document: Document): { count: number; status: string }[] {
  const records: { count: number; status: string }[] = [];
  // A tabular report associates a count with the other cells through its column
  // header. No particular table position, CSS class or status column is required.
  for (const table of document.querySelectorAll('table, [role="table"]')) {
    const rows = [...table.querySelectorAll('tr, [role="row"]')];
    const header = rows.find(row => row.querySelector('th, [role="columnheader"]'));
    if (!header) continue;
    const columns = [...header.querySelectorAll('th, td, [role="columnheader"], [role="cell"]')];
    const countColumn = columns.findIndex(cell => /^(?:completedlaps?|(?:raw)?(?:lap)?count(?:progression)?)$/i
      .test(visibleText(cell).replace(/[\s-]/g, '')));
    if (countColumn < 0) continue;
    for (const row of rows.filter(row => row !== header)) {
      const cells = [...row.querySelectorAll('td, [role="cell"]')];
      const count = cells[countColumn] && visibleText(cells[countColumn]);
      if (count && /^\d+$/.test(count)) records.push({ count: Number(count), status: visibleText(row) });
    }
  }
  // Prose, cards and lists can instead label the count inline. Find the smallest
  // enclosing observation with its timing status, regardless of tag or heading.
  const label = /(?:completed\s*laps?|(?:raw |lap[- ]?)?count(?: progression)?)\s*(?:to|:|=|→)?\s*(\d+)\b/gi;
  const seen = new Set<Element>();
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest('table, [role="table"]')) continue;
    const matches = [...visibleText(element, true).matchAll(label)];
    if (matches.length !== 1 || [...element.children].some(child => visibleText(child, true).match(label))) continue;
    for (let observation: Element | null = element; observation; observation = observation.parentElement) {
      const status = visibleText(observation, true);
      if ([...status.matchAll(label)].length !== 1) break;
      if (!unavailableTiming.test(status) && !qualifiedTiming.test(status)) continue;
      if (!seen.has(observation)) {
        records.push({ count: Number(matches[0][1]), status });
        seen.add(observation);
      }
      break;
    }
  }
  return records;
}

test('HTML shows every raw progression with its own unavailable or qualified timing status', async () => {
  // Check that the observation reader accepts different presentations before
  // using it on production output; neither layout is a required HTML contract.
  const counts = [1, 2, 3, 4, 5, 6];
  const statusFor = (count: number) => [3, 4].includes(count) ? 'Timing-qualified finish' : 'Lap clock unavailable';
  for (const example of [
    `<table><tr><th>Completed laps</th><th>Timing</th></tr>${counts.map(count =>
      `<tr><td>${count}</td><td>${statusFor(count)}</td></tr>`).join('')}</table>`,
    counts.map(count => `<div><strong>CompletedLaps: ${count}</strong><span>${statusFor(count)}</span></div>`).join(''),
  ]) {
    const control = new JSDOM(example);
    try {
      const observations = visibleProgressions(control.window.document);
      assert.deepEqual(observations.map(row => row.count), counts, 'Read equivalent observations from tables and inline labels');
      observations.forEach(row => assertTimingClassification(row.count, row.status));
    } finally {
      control.window.close();
    }
  }
  const html = formatAnalysisHtml(analyzeCapture(await realWindows()));
  assert.match(html, /Live recording remains disabled/i);
  assert.match(html, /does not establish final validity/i);
  const dom = new JSDOM(html);
  try {
    const progressions = visibleProgressions(dom.window.document);
    assert.deepEqual(progressions.map(row => row.count).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6],
      'Show each raw progression exactly once with an associated timing status, in any report layout');
    for (const row of progressions) assertTimingClassification(row.count, row.status);
  } finally {
    dom.window.close();
  }
});

test('analysis CLI reports all six raw count progressions without authorizing live records', async t => {
  await realWindows(); // Verify the checked-in evidence before invoking the public CLI.
  const directory = await mkdtemp(join(tmpdir(), 'r3e-raw-count-analysis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(new URL('capture.jsonl', fixtureUrl));
  const input = join(directory, 'capture.jsonl');
  await writeFile(input, bytes);
  const output = join(directory, 'report');
  const stdout = execFileSync(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../scripts/analyze-capture.ts', import.meta.url)),
    input, '--out', output, '--allow-incomplete'], { encoding: 'utf8', timeout: 10_000 });
  const report = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
  assert.equal(report.complete, false);
  assert.match(stdout, /6 observed count progressions/,
    'CLI count must include unavailable-clock progressions rather than counting only timing finishes');
  assert.deepEqual(report.boundaryObservations.filter((row: { countProgression: boolean }) => row.countProgression)
    .map((row: { seq: number }) => row.seq), [3, 6, 9, 12, 15, 18]);
});
