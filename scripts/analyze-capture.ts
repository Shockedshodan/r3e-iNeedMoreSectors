import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCaptureFile } from './replay-capture.ts';
import { analyzeCapture, formatAnalysisCsv, formatAnalysisHtml, formatReportedLapSummary } from '../src/diagnostics/analyze.ts';

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const positional: string[] = [];
  let output = '';
  let windowMs = 3000;
  let allowIncomplete = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--out' || value === '--window-ms') {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      if (value === '--out') output = next;
      else {
        windowMs = Number(next);
        if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError('Analysis window must be finite and nonnegative');
      }
    } else if (value === '--allow-incomplete') allowIncomplete = true;
    else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
    else positional.push(value);
  }
  if (positional.length !== 1 || !output) {
    throw new Error('Usage: npm run analyze:capture -- <capture-directory|capture.jsonl> --out <report-directory> [--window-ms <milliseconds>] [--allow-incomplete]');
  }
  const loaded = await readCaptureFile(positional[0], { allowIncomplete });
  const report = analyzeCapture(loaded.document, { windowMs });
  const directory = resolve(output);
  const files = [
    { name: 'analysis.json', content: JSON.stringify({ ...report,
      integrity: { manifestVerified: loaded.manifestVerified, sha256: loaded.manifest?.sha256 ?? null } }, null, 2) + '\n' },
    { name: 'analysis.csv', content: formatAnalysisCsv(report) },
    { name: 'analysis.html', content: formatAnalysisHtml(report) },
  ];
  // Do not silently replace an earlier report or a user's evidence artifacts.
  for (const file of files) {
    try {
      await access(join(directory, file.name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Report already exists: ${join(directory, file.name)}; choose a new output directory`);
  }
  await mkdir(directory, { recursive: true });
  for (const file of files) await writeFile(join(directory, file.name), file.content, { flag: 'wx' });
  console.log(`Capture observations saved: ${directory}`);
  console.log(`${report.reportedLaps.length} telemetry-reported laps (captured API values, not independent validation):`);
  for (const lap of report.reportedLaps) console.log(formatReportedLapSummary(lap));
  console.log(`${report.summary.messageCount} messages, ${report.boundaryObservations.filter(row => row.countProgression).length} observed count progressions, ${report.finishes.length} timing-qualified finish candidates; final validity remains unestablished and live writes remain disabled.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
