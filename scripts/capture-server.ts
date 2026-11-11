/** Local diagnostic host. This never authorizes live lap-record writes. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createCaptureServer } from '../src/diagnostics/capture-server.ts';

const values = new Map<string, string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === '--help' || name === '-h') {
    console.log('Usage: npm run capture -- --out captures/practice-01 [--port 3200] [--static dist]');
    process.exit(0);
  }
  if (!['--out', '--port', '--static'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || values.has(name)) {
    throw new Error(`Invalid capture argument: ${name}`);
  }
  values.set(name, args[++index]);
}
const output = values.get('--out');
if (!output) throw new Error('Select a capture output directory with --out; build the HUD first with npm run build');
const port = Number(values.get('--port') ?? 3200);
let hudVersion = 'unknown';
try {
  hudVersion = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* Distributed source archives may not include Git metadata. */ }

const server = await createCaptureServer({
  outputDir: resolve(output), staticDir: resolve(values.get('--static') ?? 'dist'),
  port, host: '127.0.0.1', hudVersion,
});
console.log(`Capture HUD: ${server.url}/?capture=1`);
console.log(`Capture output: ${resolve(output)}`);
console.log('Live lap-record saving stays disabled. Enter the game and bridge versions before starting a capture.');
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await server.close(); }
  catch (error) {
    console.error(`Capture shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
