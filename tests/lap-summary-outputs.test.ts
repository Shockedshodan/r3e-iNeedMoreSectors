import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { analyzeCapture, formatAnalysisCsv, formatAnalysisHtml } from '../src/diagnostics/analyze.ts';
import { parseCapture } from '../src/diagnostics/capture-format.ts';

import { assertGeneratedLapSummaries, csvRows } from './fixtures/lap-summary-output-assertions.ts';

const fixture = new URL('./fixtures/lap-count-windows/', import.meta.url);
const expectedTotals = [null, null, 149_494_965, 149_835_876, null, null];

async function nativeCapture() {
  const bytes = await readFile(new URL('capture.jsonl', fixture));
  const provenance = JSON.parse(await readFile(new URL('provenance.json', fixture), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtureSha256);
  assert.deepEqual(provenance.independentValidityLabels, []);
  const document = parseCapture(bytes.toString('utf8'), { allowIncomplete: true });
  assert.equal(document.events.filter(event => event.type === 'annotation').length, 0);
  const report = analyzeCapture(document);
  assert.deepEqual(report.reportedLaps.map(row => row.totalUs), expectedTotals);
  assert.equal(report.liveValidated, false);
  assert.equal(report.recordingEnabled, false);
  return { bytes, document, report };
}

for (const format of ['HTML', 'CSV'] as const) {
  test(`${format} exposes all native lap summaries with telemetry validity identity and receipt provenance`, async () => {
    const { report } = await nativeCapture();
    // Exercise untrusted identity in the new summary rows, rather than only
    // existing report headings. Formatting must not mutate source evidence.
    const hostile = '=HYPERLINK("https://invalid.test","<script>steal()</script>")\n"quoted",session';
    report.reportedLaps[0].sessionId = hostile;
    const before = structuredClone(report);
    let rows: string[][];
    if (format === 'HTML') {
      const html = formatAnalysisHtml(report);
      const dom = new JSDOM(html);
      assert.equal(dom.window.document.querySelectorAll('script').length, 0);
      assert.match(dom.window.document.body.textContent!, /live.*disabled/i);
      rows = [...dom.window.document.querySelectorAll('tr')].map(row =>
        [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''));
    } else {
      rows = csvRows(formatAnalysisCsv(report));
      assert.ok(!rows.flat().some(cell => /^[=+@]/.test(cell)), 'Spreadsheet formulas must be neutralized');
    }
    assert.deepEqual(report, before);
    const summaries = rows.filter(row => /telemetry/i.test(row.join(' ')) &&
      report.reportedLaps.some(lap => row.some(cell => cell.includes(lap.sessionId))));
    assert.equal(summaries.length, 6, `${format} must expose one telemetry summary per raw count crossing, including unavailable totals`);
    for (const lap of report.reportedLaps) {
      const row = summaries.find(cells => cells.some(cell => cell.includes(lap.sessionId)) &&
        cells.some(cell => cell === String(lap.seq)));
      assert.ok(row, `Expose receipt sequence ${lap.seq} alongside session identity`);
      const text = row.join(' ');
      for (const value of [lap.captureId, lap.connectionId, lap.atMs, lap.completedLap, lap.layoutId, lap.modelId, lap.coverage, lap.association]) {
        assert.ok(text.includes(String(value)), `Lap ${lap.completedLap} must retain ${String(value)}`);
      }
      assert.match(text, /PrevLapValid|telemetry.reported validity|reported validity/i);
      assert.match(text, /not.established/i);
      if (lap.totalUs === null) assert.match(text, /unavailable/i, 'Unavailable invalid-lap totals need an explicit label');
      else assert.ok(text.includes(lap.completedLap === 3 ? '2:29.495' : '2:29.836'), 'Expose a readable native lap time');
      // The summary must retain the observed validity value, not infer it from
      // whether the timing engine accepted the lap (API 2.8 is unsupported).
      const validity = [3, 4].includes(lap.completedLap) ? 1 : 0;
      assert.match(text, new RegExp(`(?:PrevLapValid|reported validity)[^0-9]*${validity}(?![0-9])`, 'i'),
        'Display the observed previous-lap validity value with its telemetry label');
    }
    assert.ok(summaries[0].some(cell => cell.includes(hostile)), 'Escaping must preserve the original identity for the reader');
  });
}

for (const format of ['HTML', 'CSV'] as const) {
  test(`${format} marks shared native results ambiguous instead of advertising a lap total`, async () => {
    const { document } = await nativeCapture();
    const sample = document.events.find(event => event.type === 'message')!;
    document.events = [0, 1, 2, 2].map((count, index) => ({
      ...structuredClone(sample), seq: index + 1, tMs: index * 100,
      data: { ...structuredClone(sample.data), CompletedLaps: count,
        LapTimePreviousSelf: index === 3 ? 11 : -1, PrevLapValid: index === 3 ? 1 : -1,
        SectorTimesPreviousSelf: index === 3 ? { Sector1: 3, Sector2: 6, Sector3: 11 } : { Sector1: -1, Sector2: -1, Sector3: -1 },
        Player: { GameSimulationTime: 100 + index / 10 } },
    }));
    const report = analyzeCapture(document, { windowMs: 500 });
    assert.deepEqual(report.reportedLaps.map(row => [row.association, row.totalUs]),
      [['ambiguous', null], ['ambiguous', null]], 'First establish an actual ambiguous association');
    assert.equal(report.recordingEnabled, false);
    assert.equal(report.liveValidated, false);
    const rows = format === 'HTML'
      ? [...new JSDOM(formatAnalysisHtml(report)).window.document.querySelectorAll('tr')]
        .map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''))
      : csvRows(formatAnalysisCsv(report));
    const summaries = rows.filter(cells => /telemetry/i.test(cells.join(' ')) &&
      cells.some(cell => cell.includes(report.reportedLaps[0].sessionId)));
    assert.equal(summaries.length, 2, `${format} must retain both ambiguous crossings as summary rows`);
    for (const lap of report.reportedLaps) {
      const matches = summaries.filter(cells => cells.some(cell => cell === String(lap.seq)) &&
        cells.some(cell => cell === String(lap.atMs)));
      assert.equal(matches.length, 1, `Crossing ${lap.completedLap} must have its own receipt row`);
      const text = matches[0].join(' ');
      for (const value of [lap.captureId, lap.sessionId, lap.connectionId, lap.completedLap, lap.layoutId, lap.modelId]) {
        assert.ok(text.includes(String(value)), `Ambiguous crossing must preserve identity ${String(value)}`);
      }
      assert.match(text, /ambiguous/i, 'The affected row must explain its unresolved association');
      assert.match(text, /unavailable/i, 'The affected row must explicitly withhold an attributed total');
      assert.match(text, /not.established/i);
      assert.ok(!text.includes('0:11.000'), 'Do not advertise the shared observation as an attributed lap time');
    }
  });
}

test('capture analysis command prints native lap times and validity without annotations and preserves existing reports', async t => {
  const { bytes, report: expected } = await nativeCapture();
  const directory = await mkdtemp(join(tmpdir(), 'r3e-lap-summary-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'capture.jsonl');
  const output = join(directory, 'analysis');
  await writeFile(input, bytes);
  const args = ['run', 'analyze:capture', '--', input, '--out', output, '--allow-incomplete'];
  const stdout = execFileSync('npm', args, { encoding: 'utf8', timeout: 20_000,
    cwd: fileURLToPath(new URL('../', import.meta.url)) });
  const names = ['analysis.json', 'analysis.html', 'analysis.csv'];
  const before = await Promise.all(names.map(name => readFile(join(output, name), 'utf8')));
  const json = JSON.parse(before[0]);
  assert.deepEqual(json.reportedLaps, expected.reportedLaps);
  assert.equal(json.summary.annotationCount, 0);
  assert.equal(json.liveValidated, false);
  assert.equal(json.recordingEnabled, false);
  assert.equal(json.complete, false, 'An excerpt is still incomplete after automatic extraction');
  assert.deepEqual(await readFile(input), bytes);
  assert.throws(() => execFileSync('npm', args, { encoding: 'utf8', timeout: 20_000, stdio: 'pipe' }),
    /already exists|new output directory/i);
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(output, name), 'utf8'))), before);
  assertGeneratedLapSummaries(before[1], before[2], expected.reportedLaps);
  const lines = stdout.split(/\r?\n/);
  for (const lap of expected.reportedLaps) {
    // A lap's count, reported validity and total must occur together. A global
    // validity disclaimer cannot stand in for the six actual observed values.
    const identity = new RegExp(`(?:completed[ -]?lap(?:s)?|lap)\\s*(?:[:=#]\\s*)?${lap.completedLap}(?![0-9])`, 'i');
    const lapLines = lines.filter(line => identity.test(line));
    assert.equal(lapLines.length, 1, `Print one identifiable summary for completed lap ${lap.completedLap}`);
    const line = lapLines[0];
    const validity = [3, 4].includes(lap.completedLap) ? 1 : 0;
    assert.match(line, new RegExp(`(?:PrevLapValid|(?:telemetry[ -]?)?reported validity)\\s*[:=]?\\s*${validity}(?![0-9])`, 'i'),
      `Lap ${lap.completedLap} must display its observed validity ${validity}`);
    if (lap.totalUs === null) assert.match(line, /unavailable/i);
    else assert.ok(line.includes(lap.completedLap === 3 ? '2:29.495' : '2:29.836'));
  }
  assert.match(stdout, /6\s+(?:observed\s+|telemetry.reported\s+|reported\s+)*laps/i, 'Terminal summary must count the extracted lap rows');
  assert.match(stdout, /2:29\.495/);
  assert.match(stdout, /2:29\.836/);
  assert.match(stdout, /telemetry.reported|reported.*validity/i);
  assert.match(stdout, /unavailable/i);
  assert.match(stdout, /live.*disabled/i);
  assert.doesNotMatch(stdout, /independently validated|independent validation (?:passed|successful)/i);
});


for (const name of ['RUNNING.md', 'LIVE_TESTING.md']) {
  test(`${name} teaches automatic lap extraction with optional independent checks and separate live authorization`, async () => {
    const markdown = await readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8');
    const text = markdown.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
    const examples = markdown.split(/\r?\n/).filter(line => line.includes('npm run analyze:capture'));
    assert.ok(examples.length > 0, 'Keep an example of the existing analysis command');
    for (const example of examples) {
      assert.doesNotMatch(example, /--(?:annotations|labels|time|total)(?:[ =-]|$)/i,
        'Ordinary analysis examples must extract lap data without manual result arguments');
    }
    assert.match(text, /(?:automatic\w*|extract\w*)[^.]{0,350}(?:telemetry|captured API|game.reported)|(?:telemetry|captured API|game.reported)[^.]{0,350}(?:automatic\w*|extract\w*)/i,
      'Explain that ordinary lap times and validity come automatically from captured telemetry');
    assert.match(text, /(?:no|without|not (?:required|a prerequisite))[^.]{0,180}(?:manual|transcrib|time entry|annotations)|(?:manual[^.]{0,40}(?:entry|transcription)|annotations)[^.]{0,180}(?:not required|not a prerequisite|unnecessary)/i,
      'Explicitly remove manual time entry or annotations as a prerequisite to ordinary analysis');
    assert.match(text, /optional[^.]{0,250}independent|independent[^.]{0,250}optional/i,
      'Describe screen/video annotations as optional independent checks');
    assert.match(text, /(?:disputed|protocol semantics|final profile|profile acceptance)/i,
      'Explain the purpose of optional independent evidence');
    assert.match(text, /(?:telemetry|automatic|extract\w*|reports?)[^.]{0,250}(?:not|never|does not|do not)[^.]{0,120}(?:independent (?:oracle|validation|evidence)|authoriz\w*|enable[^.]{0,40}live)/i,
      'Automatic reports must not be presented as independent validation or live-write authorization');
    assert.match(text, /live[^.]{0,100}(?:disabled|separate[^.]{0,40}authoriz|confirmed[^.]{0,40}authoriz)/i,
      'Keep live-write authorization distinct from ordinary extraction');
  });
}
