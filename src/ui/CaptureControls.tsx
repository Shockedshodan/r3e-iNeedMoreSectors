import React, { useState, useSyncExternalStore } from 'react';
import type { CaptureClient } from '../diagnostics/capture-client.ts';
import type { CaptureAnnotation } from '../diagnostics/capture-format.ts';

export interface CaptureControlsProps { client: CaptureClient; source: 'live' | 'synthetic' }

export function CaptureControls({ client, source }: CaptureControlsProps): React.ReactElement {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [gameBuild, setGameBuild] = useState('');
  const [bridgeBuild, setBridgeBuild] = useState('');
  const [lap, setLap] = useState('1');
  const [outcome, setOutcome] = useState<CaptureAnnotation['outcome']>('unknown');
  const [officialTime, setOfficialTime] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const status = state.manifest && !state.manifest.complete ? 'incomplete' : state.status;
  const busy = ['starting', 'recording', 'stopping'].includes(status);
  const canStop = status === 'recording' || (status === 'incomplete' && state.captureId !== null && state.manifest === null);
  const canStart = !busy && !canStop && gameBuild.trim().length > 0 && bridgeBuild.trim().length > 0;
  const labels = {
    idle: 'Ready to capture', starting: 'Starting capture', recording: 'Capturing telemetry',
    stopping: 'Finishing capture', complete: 'Capture complete', incomplete: 'Capture incomplete',
  };

  async function start(): Promise<void> {
    setError(null);
    try {
      await client.start({ source, gameVersion: gameBuild.trim(), bridgeVersion: bridgeBuild.trim(), browser: navigator.userAgent, pollMs: 16 });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start capture'); }
  }
  async function stop(): Promise<void> {
    setError(null);
    try { await client.stop(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not finalize capture'); }
  }
  function annotate(): void {
    setError(null);
    const completedLap = Number(lap);
    if (!lap.trim() || !Number.isSafeInteger(completedLap) || completedLap < 0) {
      setError('Completed lap must be a nonnegative whole number.'); return;
    }
    const time = officialTime.trim() === '' ? undefined : Number(officialTime);
    if ((outcome === 'valid' && time === undefined) || (time !== undefined && (!Number.isFinite(time) || time <= 0 || !Number.isSafeInteger(Math.round(time * 1_000_000))))) {
      setError('Enter the official positive lap time in seconds for a valid result.'); return;
    }
    const annotation: CaptureAnnotation = {
      completedLap, outcome,
      ...(time === undefined ? {} : { totalUs: Math.round(time * 1_000_000), totalToleranceUs: 1000 }),
      ...(note.trim() ? { notes: note.trim() } : {}),
    };
    try { client.annotate(annotation); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not mark lap'); }
  }

  return <section className="hud-capture" aria-label="Telemetry capture">
    <h2>Telemetry capture</h2>
    <p>Diagnostic capture does not enable live lap-record saving.</p>
    <p>Source: <strong>{source === 'synthetic' ? 'Synthetic demo' : 'Live telemetry'}</strong></p>
    <p role="status" data-testid="capture-status">{labels[status]}</p>
    {state.reason && <p className="capture-reason">{state.reason}</p>}
    {state.manifest && state.manifest.problems.length > 0 && <ul aria-label="Capture completion issues">
      {state.manifest.problems.map((problem, index) => <li key={index}>{problem}</li>)}
    </ul>}
    <div className="capture-metrics">
      <output aria-label="Captured events" aria-live="off">{state.eventCount} events</output>
      <output aria-label="Captured bytes" aria-live="off">{Math.round(state.bytes / 1024)} KiB</output>
    </div>
    <label>Game build<input aria-label="Game build" value={gameBuild} maxLength={256} disabled={busy || canStop} onChange={event => setGameBuild(event.target.value)} /></label>
    <label>Bridge build<input aria-label="Bridge build" value={bridgeBuild} maxLength={256} disabled={busy || canStop} onChange={event => setBridgeBuild(event.target.value)} /></label>
    <div className="capture-buttons">
      <button onClick={() => { void start(); }} disabled={!canStart}>Start capture</button>
      <button onClick={() => { void stop(); }} disabled={!canStop}>Stop capture</button>
    </div>
    <output data-testid="capture-output">{state.manifest
      ? `${state.manifest.complete ? 'Saved' : 'Partial data'}: ${state.manifest.outputPath}`
      : state.outputPath ? `Writing: ${state.outputPath}` : 'No capture saved yet'}</output>
    <fieldset>
      <legend>Official result annotation</legend>
      <p>Enter the result shown by the game. These labels are independent of the adapter.</p>
      <label>Completed lap<input aria-label="Completed lap" type="number" min="0" step="1" value={lap} onChange={event => setLap(event.target.value)} /></label>
      <label>Result<select aria-label="Result" value={outcome} onChange={event => setOutcome(event.target.value as CaptureAnnotation['outcome'])}>
        <option value="unknown">Unknown</option><option value="valid">Valid</option><option value="invalid">Invalid</option><option value="incomplete">Incomplete</option>
      </select></label>
      <label>Official time seconds<input aria-label="Official time seconds" type="number" min="0" step="any" value={officialTime} onChange={event => setOfficialTime(event.target.value)} /></label>
      <p className="field-help">Game result screen precision: comparisons allow ±1 ms.</p>
      <label>Note<input aria-label="Note" value={note} maxLength={512} onChange={event => setNote(event.target.value)} /></label>
      <button onClick={annotate} disabled={status !== 'recording'}>Mark lap</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </section>;
}
