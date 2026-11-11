import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ReportedLap } from '../../src/diagnostics/analyze.ts';

// Read the CSV users open, including quoted commas, quotes and newlines.
export function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell); cell = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else if (char !== '\r' || quoted) cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  assert.equal(quoted, false, 'CSV must close every quoted cell');
  return rows;
}

export function assertGeneratedLapSummaries(html: string, csv: string, laps: ReportedLap[]): void {
  assert.equal(laps.length, 6);
  const formats = [
    ['HTML', [...new JSDOM(html).window.document.querySelectorAll('tr')]
      .map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? ''))],
    ['CSV', csvRows(csv)],
  ] as const;
  for (const [format, rows] of formats) {
    const summaries = rows.filter(cells => /telemetry/i.test(cells.join(' ')) &&
      laps.some(lap => cells.some(cell => cell.includes(lap.sessionId))));
    assert.equal(summaries.length, 6, `Generated ${format} must include all six telemetry lap summaries`);
    for (const lap of laps) {
      const matches = summaries.filter(cells => cells.some(cell => cell === String(lap.seq)) &&
        cells.some(cell => cell.includes(lap.sessionId)));
      assert.equal(matches.length, 1, `Generated ${format} must identify receipt ${lap.seq}`);
      const text = matches[0].join(' ');
      for (const value of [lap.captureId, lap.connectionId, lap.completedLap, lap.atMs, lap.layoutId, lap.modelId, lap.coverage, lap.association]) {
        assert.ok(text.includes(String(value)), `${format} lap ${lap.completedLap} must preserve ${String(value)}`);
      }
      const validity = [3, 4].includes(lap.completedLap) ? 1 : 0;
      assert.match(text, new RegExp(`(?:PrevLapValid|reported validity)[^0-9]*${validity}(?![0-9])`, 'i'));
      assert.match(text, /not.established/i);
      if (lap.totalUs === null) assert.match(text, /unavailable/i);
      else assert.ok(text.includes(lap.completedLap === 3 ? '2:29.495' : '2:29.836'));
    }
  }
}
