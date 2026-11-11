# Windows live telemetry testing runbook

This runbook uses the implemented capture, replay and analysis tools. It prepares evidence for live recording; it does not enable live Best/Opt writes. The real driving portion requires RaceRoom and one chosen bridge on the Windows game PC.

For normal UI setup and the comparison with SealHUD's hosted-page/local-bridge approach, start with [Running the HUD](RUNNING.md#connect-raceroom). Normal local UI uses port 3000; this evidence campaign uses the collector on port 3200. Both connect to the same kind of locally running native bridge on port 8070. GitHub Pages can serve the normal HUD, but cannot run the capture API: all capture steps below use the local collector address.

## 1. Prepare a reproducible build

Use Node 24 and run these commands in the repository in PowerShell:

```powershell
git rev-parse HEAD
git status --short
npm ci
npm run typecheck
npm test
npm run build
```

Use a clean committed checkout for the real campaign, and rebuild after changing commits. The collector records the checkout commit as HUD provenance, so do not serve an old `dist/` from another build. Keep the commit ID, RaceRoom build, exact CrewChief/dash version, Windows/browser conditions, car, layout and relevant graphics/frame-rate settings in the session notes. API 3.6 alone does not identify the bridge executable build.

## 2. Optional dry run without RaceRoom

In one terminal:

```powershell
npm run demo:bridge
```

In another:

```powershell
npm run capture -- --out captures/demo-check --port 3200
```

Open the local capture HUD with `capture=1&demo=1`, for example `http://127.0.0.1:3200/?capture=1&demo=1`. Enter `synthetic-demo` for both build fields, start a capture, wait through several complete laps, and stop. Confirm **Saved** and a capture directory. Demo captures must say `source: "synthetic"` and cannot qualify a live profile.

Before live testing, stop `demo:bridge` and the dry-run collector with Ctrl+C. Port 8070 must belong to the actual game bridge. The source label is declared by the selected capture mode, not cryptographic proof of where packets originated.

## 3. Start a real practice capture

1. Run exactly one compatible CrewChief or `dash.exe` bridge. Do not run both. Verify its exact version and API support, and stop any synthetic bridge from the dry run. Port 8070 must be available to the real bridge.
2. Start the collector:

   ```powershell
   npm run capture -- --out captures/practice-01 --port 3200
   ```

3. Set RaceRoom's launch option to the local diagnostic HUD page:

   ```text
   -webHudUrl=http://127.0.0.1:3200/?capture=1
   ```

   Do **not** add `demo=1` for real captures. The default telemetry endpoint is `ws://localhost:8070/r3e`. For a different bridge port, add `&ws=127.0.0.1:PORT` to the HUD page.

4. Open an API 3.6 player-controlled practice session. Confirm the HUD reports practice telemetry and that live lap-record saving remains disabled. On a fresh origin the reference is Off; the Reference button or Alt+T cycles modes, but no new live Best/Opt references are expected while saving is disabled. Edit layout offers placement previews. Preferences on port 3200 are separate from port 3000 and the hosted origin.
5. Enter the exact **Game build** and **Bridge build** in the capture panel. Click **Start capture** before the driving sequence. The diagnostic tool uses the HUD's existing telemetry socket and retains messages even when the adapter rejects them.
6. Drive the scenario. HUD reference mode may remain Off; diagnostic collection continues. Avoid opening other HUDs that poll the bridge during the measurement run.
7. Click **Stop capture**, wait for **Saved**, and copy the displayed capture directory. Do this before exiting/reloading the HUD or stopping the collector.
8. Stop the collector with Ctrl+C after the saved confirmation.

Each start creates an exclusive subdirectory under the selected output folder:

```text
captures/practice-01/<capture-id>/
  capture.jsonl
  manifest.json
```

The manifest contains counts, SHA-256, source and complete/incomplete status. Raw values are projected onto the timing/identity whitelist; driver names/data are omitted. No diagnostic snapshots are stored in localStorage.

If the HUD exits abruptly, a sink fails, a limit is reached or a capture is interrupted, do not call the resulting file complete. Stop the collector to finalize it as incomplete, restart it and begin a new capture. A page reload resets the browser's capture session; it is not transparent continuation. Keep partial captures for debugging, not qualifying finish evidence.

## 4. Record independent ground truth

Record the game's official completed-lap time and validity using its result display, preferably with a timestamped screen recording or cropped screenshots. Do not label a lap valid solely because the bridge or replay says so.

Use **Mark lap** in the diagnostic panel when practical, or add an annotation sidecar after reviewing the run. The label uses the native **completed lap count**, not the current lap ordinal: a count of 6 means the car is driving lap 7. The first crossing after starting a mid-lap capture is incomplete coverage even if the game's lap itself was valid.

The **Official time seconds** input expects seconds, e.g. `91.567` for `1:31.567`. Entered screen times carry an explicit ±1 ms annotation tolerance, because the display does not prove microsecond precision. This tolerance affects label comparison only; native validity and timing checks are unchanged. Valid labels in the panel require a total; a sidecar label without one remains unresolved for valid-lap total matching.

For an external `labels.json`, use an independent array such as:

```json
[
  {
    "connectionId": 1,
    "completedLap": 2,
    "layoutId": 10,
    "modelId": 20,
    "outcome": "valid",
    "totalUs": 91567000,
    "totalToleranceUs": 1000,
    "notes": "Game result 1:31.567; video 00:03:12"
  },
  {
    "connectionId": 1,
    "completedLap": 3,
    "layoutId": 10,
    "modelId": 20,
    "outcome": "invalid",
    "notes": "Game displayed invalid lap after final-corner cut"
  }
]
```

Replace the example identities with the captured ones. Outcomes are `valid`, `invalid`, `incomplete`, or `unknown`. Use `sessionId` from replay output when a file includes multiple sessions with the same lap count; ambiguous labels must remain unresolved. Prefer separate captures per session/scenario. Use either an event label or a sidecar label for a result, avoiding accidental duplicates.

## 5. Required driving scenarios

Keep an evidence checklist recording which capture and result label cover each case. Begin with one car/layout and the chosen bridge, then repeat normal operation with a second combination and different rendering/load conditions.

| Run | What to do | What we need to establish |
| --- | --- | --- |
| Clean baseline | Out-lap followed by 10–15 clean complete laps | Actual field order, source precision, ordinary receive/update gaps and consistent totals |
| Early invalidation | Trigger a cut early in a lap; continue across the line | Invalidity remains effective; no invalid acceptance |
| Late invalidation | Trigger an invalid lap immediately before the finish | Whether final validity arrives after times/count and whether valid-looking fields later turn invalid |
| Next-lap invalidation | Exercise a game situation that invalidates the following lap | Semantics of `LapValidState=2` and later flag clearing |
| Similar/tied results | Drive similar laps and retain any exact ties that occur | No assignment of an unchanged stale signature to another lap; missing natural ties stay a coverage gap |
| Interruption | Pause, enter menus, reset/teleport or return to pits mid-lap | Partial/interrupted captures never become records |
| Bridge restart | Lose/restart the bridge mid-lap, then complete a fresh lap | Connection epochs prevent stitching old and new observations |
| HUD startup/reload | Open the HUD mid-lap; run separate captures before/after reload | Incomplete initial lap is rejected; later complete laps can be collected; reload/persistence checks are recorded separately |
| Session/car/layout changes | Change one identity at a time | No cross-combination records or stale finish association |
| Load variation | Repeat normal laps at the intended low/high performance conditions | Threshold evidence reflects actual receipt and source-update behavior, not only an idle desktop |

Never manufacture a real-data pass for a scenario that did not occur. Clearly marked derived/synthetic regressions can test an algorithm, but they do not prove native field ordering.

## 6. Replay and analyze a saved capture

Replace the placeholder ID with the directory shown by the Saved confirmation:

```powershell
$CapturePath = "captures\practice-01\PASTE-CAPTURE-ID-HERE"
npm run replay -- "$CapturePath" --out reports/practice-01-replay
$LASTEXITCODE
npm run analyze:capture -- "$CapturePath" --out reports/practice-01-analysis
```

If annotations were supplied separately:

```powershell
npm run replay -- "$CapturePath" --annotations labels.json --out reports/practice-01-labeled
```

Existing report files are not overwritten; choose a new report directory for another comparison. Capture directories require their manifest. Checksums and identity/counts are verified before processing. Keep `capture.jsonl` unchanged; keep labels separate when annotating afterward.

Outputs:

- `replay.json`: live-disabled control, isolated shadow adapter results, engine acceptances, actual Best/Opt improvements, label comparisons and unresolved cases.
- `analysis.json`, `analysis.csv`, `analysis.html`: observed gap distributions, duplicate/source updates, raw finish-field timelines, validity transitions, resets, movement and loss diagnostics.

Replay exit codes are **0** for report generation with no labeled failures, **2** for labeled mismatches (the report is still written), and **1** for input/integrity/I/O errors. Exit 0 with unresolved cases is not a live-validation pass. Reports always leave `profileValidated`/`liveValidated` false and live writing disabled.

For partial files only:

```powershell
npm run replay -- "$CapturePath" --allow-incomplete --out reports/partial-replay
npm run analyze:capture -- "$CapturePath" --allow-incomplete --out reports/partial-analysis
```

These switches preserve incomplete status. They do not repair corruption, reorder events or turn partial data into qualifying evidence.

## 7. Review the results

For each labeled crossing, inspect the ±3-second analysis window (configurable with `--window-ms`). Establish the order of count progression, distance/clock wrap, previous total, all three native sector fields and final validity. Specifically look for result fields leading the count, mixed old/new sectors, valid→later-invalid transitions and nonzero first post-line samples.

Compare normal message-arrival gaps separately from unique simulation-update gaps; repeated 16 ms polls may contain the same game frame. Review resets and lost/truncated windows. Use timing and speed/layout observations to propose a physical continuity bound and a measured finish timeout. Do not declare the provisional 300 ms / 0.3 / 500 ms values safe because the synthetic tests pass.

Recorder queue pressure and losses are reported. Ordinary telemetry is batched to the sink at about 100 ms rather than sending one HTTP request per frame. If recording causes visible performance changes, capture an external performance trace or compare controlled runs with capture on/off before using the measurements. Queue metrics alone do not prove zero instrumentation overhead.

Opening the report does not prove native finality: several unchanged samples may still share a stale validity flag. If the evidence cannot establish authoritative association, keep rejecting ambiguous finishes and investigate bridge/API support rather than guessing a settle delay.

## 8. What must pass before live saving

- Independently labeled complete valid laps have correct identity and official total at the label's declared precision, with one engine acceptance; a tie need not improve a record.
- Invalid, interrupted, stale, ambiguous or wrong-lap results never create accepted records. Any such mismatch blocks enabling the profile.
- Required scenarios are covered by complete loss-free windows, or are explicitly unsupported; unresolved results and missing scenarios are not passes.
- Thresholds and source rounding are documented from observed evidence, and replay regressions are added before each reconciliation fix.
- A separately agreed delta-accuracy target is checked against an independent timing reference. The same interpolation routine cannot be its own accuracy oracle.
- In-game startup, connectivity, actual driving hotkeys/rebinding/lock behavior, restart persistence and stale-delta clearing pass in RaceRoom's embedded browser.
- The chosen game/bridge/API configuration is identifiable, the normal automated suite remains green, and unknown configurations remain disabled.

## 9. Evidence to return for implementation fixes

Provide the capture folder (`capture.jsonl` and `manifest.json`), independent labels, replay/analysis reports, build/version notes and the scenario checklist. Include the matching result-screen evidence where needed. The manifest's local `outputPath` may be redacted without changing the captured file or its checksum.

The next development work after receiving this evidence is: preserve sanitized failing windows as fixtures, correct reconciliation from those tests, choose measured profile settings, run the in-game acceptance checks, and only then implement supported live-profile enablement. No capture command or report currently removes that gate automatically.
