# Implementation plan: real telemetry capture, replay and live recording

Status: proposed work, following commit `0b5e935`. The recorder, replayer, analyzer and validation-profile tooling described here do not exist yet. This plan does not enable live record saving.

## Goal and scope

Make the live-writing decision reproducible: capture what the Windows HUD actually receives, compare it with independently recorded game results, replay it through the adapter and engine, and enable only a supported configuration whose behavior is demonstrated.

Start with one identified CrewChief or dash build, API 3.6, and player-controlled practice. Keep demo data separate. Expand to other bridges, versions and modes only after their own evidence and regressions exist.

The current 300 ms frame-gap limit, 0.3 distance-step limit and 500 ms finish timeout remain provisional until measured. A repeated stable result is not, by itself, proof of authoritative final validity.

## Delivery order

| Phase | Deliverable | Dependency | Completion evidence |
| --- | --- | --- | --- |
| 1 | Versioned capture format and bounded recorder | Existing bridge receive path | RED→GREEN format, ordering, overflow and lifecycle tests |
| 2 | Local capture host and diagnostic UI | Phase 1 | One real telemetry connection; durable capture and clean shutdown in a browser test |
| 3 | Deterministic replay and isolated shadow results | Phase 1 | Repeatable output from the same capture, including disconnects and rejected input |
| 4 | Timeline and measurement reports | Phase 3 | Reports match hand-calculated synthetic fixtures |
| 5 | Windows practice capture campaign | Phases 2–4 | Complete captures plus independent lap-result annotations |
| 6 | Evidence-driven reconciliation fixes | Phase 5 | Regressions from real traces fail before each fix and pass afterward |
| 7 | Measured profiles and live acceptance | Phase 6 | Documented thresholds, supported scope and acceptance results |
| 8 | Enable the validated live-writing path | Phase 7 | Unknown/unvalidated configurations remain disabled; full suite passes |

Phases 1–4 can be implemented and exercised against the local synthetic bridge in this cloud environment. Phase 5 requires RaceRoom and its chosen bridge on the Windows game machine. Later phases must use those observations; synthetic fixtures cannot supply the missing evidence.

## 1. Capture format and recorder

Proposed files:

- `src/diagnostics/capture-format.ts`: schema, field projection, parser and format version.
- `src/diagnostics/recorder.ts`: recording lifecycle and a bounded, injectable sink.
- `tests/capture-format.test.ts`, `tests/capture-recorder.test.ts`.
- Synthetic examples under `tests/fixtures/captures/`, explicitly marked synthetic.

Instrument `src/telemetry/websocket-bridge.ts` at the receive boundary. Timestamp and sequence each observation before JSON parsing; preserve rejected-message and connection events even when adaptation returns no frame. `onObservation` alone is too late because it omits malformed and unsupported input. Reuse decoded raw values for the field projection where possible, without changing adapter execution order or polling cadence.

Use streaming JSONL with:

- A header containing format version, capture ID, UTC start time, timestamp units, HUD commit, API version, declared game/bridge versions, browser/runtime details, polling configuration and capture limits. Do not include credential-bearing URLs.
- Ordered events with a global sequence number, monotonic receive time relative to capture start, connection ID and event kind.
- Kinds for connection opening/closing/errors, messages, malformed/rejected messages, annotations, buffer loss and explicit capture completion/termination.
- A footer/manifest identifying complete versus incomplete capture, counts, truncation reason and checksums. Missing completion must never look like a successful recording.

For valid JSON messages, retain only a documented whitelist of **raw field values**: API version, layout/model identity and length, session identifiers, lap count/distance/current/previous clocks, current and previous native sector fields, validity flags, control/replay/menu/pause/debug flags, simulation time and optional vehicle speed. Preserve missing, null and unavailable values distinctly; do not quantize or normalize them during capture. Exclude `DriverData`, player names, ratings and unrelated car telemetry. Mark this as a projected capture, not a byte-for-byte copy of the whole wire packet.

For malformed input, save its arrival event, type/length and rejection reason without copying unrestricted payload text. Replay can reproduce the rejection/reset path with a clearly marked malformed-message substitute; it must not claim to recover omitted bytes.

Keep memory bounded. Proposed initial limits are a 4 MiB pending queue, 256 KiB batches, and a 30-minute/256 MiB session cap; make these configuration values. Never await file/network writes inside telemetry delivery. If the sink stalls or a limit is reached, stop or mark the capture incomplete with explicit loss boundaries. Continue the ordinary HUD read-only. A dropped or truncated finish window cannot qualify a profile.

Tests first: exact projection, missing/null preservation, equal-time event ordering, connection IDs, start/stop/disposal, sink failure, queue overflow, truncation, and an observer that cannot change delivered telemetry or start another bridge poller.

## 2. Local capture host and diagnostic UI

Proposed files:

- `scripts/capture-server.ts`: localhost-only static HUD host and capture-file sink.
- `src/diagnostics/capture-client.ts`: batched delivery to the same-origin sink.
- `src/ui/CaptureControls.tsx`: explicit start/stop/status controls in diagnostic mode.
- `tests/capture-server.test.ts`, component tests and capture browser tests.

The local host serves the built HUD and accepts capture batches into a selected output directory. This avoids depending on browser downloads or the File System Access API inside RaceRoom. The HUD keeps its existing single connection to the native bridge; diagnostics use batched HTTP to the local host rather than opening a second telemetry poller. Sequence and connection IDs preserve order across batches and retries.

Proposed commands, **to be added during implementation**:

```sh
npm run capture -- --out captures/practice-01 --port 3200
npm run replay -- captures/practice-01 --out reports/practice-01
npm run analyze:capture -- captures/practice-01 --out reports/practice-01
```

`capture` starts the local host and prints the diagnostic HUD address and output location. The operator uses that page in RaceRoom's `-webHudUrl` launch option. `capture=1` enables diagnostics only; it must leave live lap-record writes disabled. Demo captures must be explicitly identified and must never qualify a live profile.

Use bounded server-side streaming and deterministic filenames, handle write errors visibly, and finish/flush cleanly on stop. Add `captures/` and generated reports to `.gitignore`; only selected sanitized fixture excerpts belong in Git. Measure capture overhead and queue high-water marks so instrumentation-induced delays are visible.

Browser tests must verify one upstream telemetry socket, unchanged polling, recording while the HUD is Off, start/stop, durable saved data, storage/sink failure, reconnection and an incomplete-capture indication. Do not use localStorage to persist diagnostic snapshots.

## 3. Deterministic replay and shadow proposals

Proposed files:

- `src/diagnostics/replay.ts`: common replay pipeline.
- `scripts/replay-capture.ts`: CLI and machine-readable report.
- `tests/capture-replay.test.ts` and expected-result sidecars.

Replay ordered events through the same decoding, adapter and engine logic. Inject the captured clock and a controllable scheduler; no real sleeps are needed. Preserve sequence order when timestamps are equal. Reject backwards timestamps, sequence loss, unsupported format versions and damaged files, or explicitly report a non-qualifying partial replay. Never silently reorder the input to repair it.

Connection events must reset association and interrupt capture as the real transport does. Unknown/malformed observations must exercise their rejection behavior, not disappear from the replay. Preserve layout changes and use an isolated layout registry and in-memory record repository.

Run the existing live-disabled path as a control. In a separate **offline shadow run**, evaluate candidate finish associations and record proposals in memory, without writing the user's Best/Opt storage. The shadow configuration is not authorization to enable live saving.

Expected-result labels come from the game's official result display or a matched video/manual observation. Store them separately from raw captures. Do not generate the expected outcomes from the adapter being tested. Compare proposed lap identity, total, validity, write count and rejection reason against those labels. Unlabeled/ambiguous cases remain unresolved, not passes.

Tests first: repeatable output, equal timestamps, exact resets, corrupt/incomplete input, isolation from live/demo stores, valid lap accepted once, invalid/incomplete/stale lap never accepted, and no duplicate proposal on repeated messages.

## 4. Timeline and measurement reports

Proposed files:

- `src/diagnostics/analyze.ts`, `scripts/analyze-capture.ts`.
- `tests/capture-analysis.test.ts`.

Generate JSON plus a readable HTML/CSV report. For every crossing, show a configurable window around it, initially ±3 seconds, with changes in lap count, distance, clock, native sector fields, previous result and both validity indicators. Show observed values and association decisions together.

Report separately:

- Message arrival gaps and unique simulation-update gaps: 16 ms polling can repeat the same game frame.
- Relative ordering of count progression, distance/clock wrap, previous total, native sectors and validity changes. Include results that lead the count update.
- First-result and last-observed-change latency; do not label the last change as authoritative finality without supporting evidence.
- Duplicate messages, invalid/unavailable values, resets, interruptions, capture overhead, queue pressure and loss windows.
- Quantization differences between native clocks and totals, and distance movement versus elapsed time/speed/layout length.

Use hand-calculated fixtures for report tests. A synthetic report verifies the analyzer, not native semantics.

## 5. Windows capture campaign

Record the exact game, bridge and HUD builds. Start with one car/layout, then repeat with a second combination and a different frame-rate/load condition. An initial 10–15 complete clean laps is a useful sample, not a statistical guarantee or an automatic pass threshold. Collect the following cases as separate annotated runs where practical:

| Case | Evidence required |
| --- | --- |
| Clean consecutive laps | Correct lap identity, native totals/sectors and final validity; one proposal per accepted captured lap |
| Similar or tied previous results | No false freshness inference; naturally absent exact ties may need clearly identified derived regression fixtures |
| Cut early and immediately before the finish | Current/final validity timing; invalid laps never become records |
| Current-and-next invalid state | Correct effect across the following lap even if the raw flag clears |
| Pause, menus, pit/reset/teleport | Interrupted captures rejected without damaging saved references |
| Bridge loss/restart and HUD reload | No stitching across connection epochs; persistence behaves correctly |
| HUD opened mid-lap and nonzero first post-line sample | Partial initial lap rejected; subsequent complete capture starts correctly |
| Session/car/layout change | Correct identity isolation and reset behavior |

For each relevant lap, record official total and validity plus a timestamped annotation or cropped result-screen evidence. Explicitly investigate staggered wrap fields, a valid result later becoming invalid, new total/third-sector fields mixed with old first/second sectors, and completely unchanged result signatures. The synthetic cumulative-sector convention must also be checked against the chosen bridge's actual output.

No raw capture can prove a scenario that did not occur. Mark missing coverage and gather it or keep that behavior unsupported.

## 6. Evidence-driven reconciliation changes

Convert minimal, sanitized real capture windows into regression fixtures before changing `raceroom-adapter.ts` or `timing-engine.ts`. Retain enough preceding state to make the failure reproducible and keep source-capture provenance/checksums in a sidecar.

Likely decision points, to resolve from evidence:

- The adapter currently emits on the first fresh consistent result with `PrevLapValid=1`; determine whether that can still describe an earlier lap or later become invalid.
- A matching total and third sector do not prove the other sector fields belong to the same lap.
- The engine currently rejects inconsistent/staggered count/distance/clock transitions. Decide whether observed transitions can be reconciled without inventing a completion.
- Near-identical or entirely tied signatures must not be assigned a fabricated native result ID.

Implement explicit pending/rejected/accepted decisions and diagnostic reason codes. A settling rule may be part of a validated protocol, but **N stable samples or a locally generated counter alone cannot establish final validity**. If observations cannot establish reliable association/finality, retain rejection and the live-writing gate, and investigate authoritative upstream documentation or a bridge extension. Do not enable saving merely to complete a milestone.

## 7. Threshold profiles and in-game acceptance

Proposed files: `src/telemetry/profiles.ts`, versioned profile/evidence metadata, profile tests and a Windows acceptance runbook.

Derive frame-gap and finish-timeout settings from measured distributions with a documented margin, then test normal observations and deliberately interrupted runs against them. Use elapsed time, layout length and observed/plausible vehicle speed to evaluate a physical distance-step bound; do not keep 0.3 simply because synthetic tests pass. Validate float quantization before requiring exact normalized totals; do not loosen checks indiscriminately to admit mixed results.

Define the custom-delta accuracy target before evaluating it. Compare against an independently measured/reference timing curve and account for source precision, sampling and rendering latency. A test with an expected value computed by the same interpolation code is not independent accuracy evidence.

Verify in RaceRoom: embedded-browser startup, WebSocket connectivity, actual driving-key delivery, rebinding, lock behavior, profile/record persistence after restart, and visible delta behavior through pauses and disconnects. The normal UI and saved data must keep working with diagnostics disabled.

Profile provenance must identify the observed bridge/game/API and runtime conditions. The current raw JSON does not reliably identify the bridge executable build; do not promise automatic matching from API 3.6 alone. Document how identity/configuration is established, and leave unknown configurations disabled.

## 8. Enable live writing only for supported evidence

Acceptance criteria:

- Every independently labeled complete valid capture in the supported dataset has the correct outcome and at most one accepted proposal. Ties cause no unnecessary record write.
- No invalid, interrupted, ambiguous or wrong-lap result creates a Best/Opt improvement. Any such error blocks promotion.
- All required scenarios are covered or explicitly unsupported; no dropped/truncated finish window is counted as qualifying evidence.
- Measured settings and the delta accuracy target are documented and pass replay plus in-game checks.
- The entire unit/component/build/browser suite passes; diagnostic capture/replay cannot change live records or silently enable saving.

Replace the broad live-disabled branch with a narrow, tested supported-profile decision. Demo remains isolated. Unknown API/bridge configuration, unavailable finality or incompatible data keeps saving off and reports why. Add CI replay of approved sanitized captures and guard tests proving unsupported configurations remain disabled.

## Suggested commit boundaries

1. Capture schema, recorder and synthetic tests.
2. Local capture host, receive-path integration, controls and browser tests.
3. Replay/shadow runner and annotation format.
4. Analyzer and reports.
5. Sanitized Windows captures, ground truth and failing regressions.
6. Reconciliation fixes and measured profiles.
7. In-game acceptance evidence and supported live-writing enablement.

Implement commits 1–4 first. The next required external input is the Windows capture campaign; it should not block building or testing the tooling.
