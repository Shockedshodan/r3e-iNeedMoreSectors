import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseCapture } from '../src/diagnostics/capture-format.ts';
import type { CaptureDocument, CaptureManifest } from '../src/diagnostics/capture-format.ts';
import { replayCapture } from '../src/diagnostics/replay.ts';
import type { ReplayAnnotation } from '../src/diagnostics/replay.ts';

export interface CaptureFileInput {
  document: CaptureDocument;
  manifest: CaptureManifest | null;
  manifestVerified: boolean;
  inputPath: string;
}

export async function readCaptureFile(input: string, options: { allowIncomplete?: boolean } = {}): Promise<CaptureFileInput> {
  const inputPath = resolve(input);
  const directory = (await stat(inputPath)).isDirectory();
  const capturePath = directory ? join(inputPath, 'capture.jsonl') : inputPath;
  const manifestPath = join(directory ? inputPath : dirname(inputPath), 'manifest.json');
  let manifest: CaptureManifest | null = null;
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!validManifest(value)) throw new Error('Invalid capture manifest shape');
    manifest = value;
  } catch (error) {
    if (directory || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new Error(`A valid capture manifest is required: ${error instanceof Error ? error.message : error}`);
    }
  }
  const bytes = await readFile(capturePath);
  if (manifest) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (manifest.version !== 1 || manifest.byteCount !== bytes.length || !/^[a-f0-9]{64}$/.test(manifest.sha256) || digest !== manifest.sha256) {
      throw new Error('Capture manifest checksum/byte integrity verification failed');
    }
  }
  let document = parseCapture(bytes.toString('utf8'), options);
  if (manifest) {
    if (manifest.captureId !== document.header.captureId || manifest.source !== document.header.source || manifest.eventCount !== document.events.length) {
      throw new Error('Capture manifest identity or event-count integrity verification failed');
    }
    if (manifest.complete !== true || !Array.isArray(manifest.problems) || manifest.problems.length > 0) {
      if (!options.allowIncomplete) throw new Error('Capture manifest marks this session incomplete');
      document = { ...document, complete: false,
        problems: [...document.problems, 'Capture manifest marks this session incomplete'] };
    }
  }
  return { document, manifest, manifestVerified: manifest !== null, inputPath: capturePath };
}

function validManifest(value: unknown): value is CaptureManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as CaptureManifest;
  return manifest.version === 1 && typeof manifest.captureId === 'string' && manifest.captureId.length > 0
    && typeof manifest.complete === 'boolean' && ['live', 'synthetic'].includes(manifest.source)
    && Number.isSafeInteger(manifest.byteCount) && manifest.byteCount >= 0
    && Number.isSafeInteger(manifest.eventCount) && manifest.eventCount >= 0
    && typeof manifest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(manifest.sha256)
    && typeof manifest.outputPath === 'string' && Array.isArray(manifest.problems)
    && manifest.problems.every(problem => typeof problem === 'string');
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const positional: string[] = [];
  let output = '';
  let annotationsFile = '';
  let allowIncomplete = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--out' || value === '--annotations') {
      const next = args[++index];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a path`);
      if (value === '--out') output = next; else annotationsFile = next;
    } else if (value === '--allow-incomplete') allowIncomplete = true;
    else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
    else positional.push(value);
  }
  if (positional.length !== 1 || !output) {
    throw new Error('Usage: npm run replay -- <capture-directory|capture.jsonl> --out <report-directory> [--annotations <json>] [--allow-incomplete]');
  }
  const loaded = await readCaptureFile(positional[0], { allowIncomplete });
  let annotations: ReplayAnnotation[] = [];
  if (annotationsFile) {
    const value: unknown = JSON.parse(await readFile(resolve(annotationsFile), 'utf8'));
    if (!Array.isArray(value)) throw new Error('Annotation sidecar must be a JSON array of independent game-result labels');
    annotations = value as ReplayAnnotation[];
  }
  const report = replayCapture(loaded.document, { annotations });
  const outputDirectory = resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, 'replay.json');
  await writeFile(path, JSON.stringify({ ...report, integrity: { manifestVerified: loaded.manifestVerified,
    sha256: loaded.manifest?.sha256 ?? null } }, null, 2) + '\n', { flag: 'wx' });
  const failures = report.comparisons.filter(value => value.status === 'fail').length;
  console.log(`Replay report saved: ${path}`);
  console.log(`${report.shadowProposals.length} shadow improvements, ${failures} labeled failures, ${report.unresolved.length} unresolved; live writes remain disabled.`);
  if (failures > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
