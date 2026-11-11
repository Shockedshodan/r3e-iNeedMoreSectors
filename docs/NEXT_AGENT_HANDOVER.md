# Handover for the next agent

Originally prepared on 2026-11-11 against application implementation baseline `2beddbf`, accompanying the merge of remote `main` through `a66ce11`. That delivery preserved the user's README acknowledgements and Beads/workflow files. Its branch was `work`; the repository is `Shockedshodan/r3e-iNeedMoreSectors`. Check the actual branch, log and remote state when resuming.

## Current delivery tracking

Beads epic **`r3e-iNeedMoreSectors-p9z` — Deliver hosted HUD and validated live RaceRoom timing** is the durable source for remaining work and dependencies. Read it with:

```sh
bd prime
bd show r3e-iNeedMoreSectors-p9z
bd graph r3e-iNeedMoreSectors-p9z
```

The epic groups executable Alloy tasks and explicit manual gates; it is not an executable task itself. The current delivery adds a tested Pages workflow and updates the local/hosted guides. It also tracks the remote browser-install failure caused by the `ubuntu-latest` image moving beyond the locked Playwright version's supported platforms. Public deployment activation remains a manual task, and the expected Pages URL is provisional until verified. No real captures were available when the epic was created; the Windows campaign blocks evidence-dependent changes. Do not infer commit, push, sync or scheduler authority from historical handover wording; follow the active instructions in [../AGENTS.md](../AGENTS.md).

## Current outcome

The timing core, rendered HUD, SealHUD-derived controls, modular discovery, RaceRoom adapter and diagnostic capture/replay/analysis tools are implemented and tested. **Ordinary live Best/Opt record saving is still disabled.** No real RaceRoom capture campaign or in-game acceptance has been performed in this cloud environment. The next milestone is evidence collection on the Windows game machine, followed by regression-driven reconciliation fixes and measured live profiles.

## Read first

| Document | Purpose |
| --- | --- |
| [PROJECT_BASELINE.md](PROJECT_BASELINE.md) | Original user-supplied handoff, requirements and reference provenance |
| [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) | Delivered milestones and recorded verification |
| [LIVE_TESTING.md](LIVE_TESTING.md) | Exact Windows operator procedure, driving scenarios, independent labels and acceptance criteria |
| [LIVE_VALIDATION_PLAN.md](LIVE_VALIDATION_PLAN.md) | Phases 1–4 implemented; phases 5–8 require real evidence |
| [TELEMETRY_PROTOCOL.md](TELEMETRY_PROTOCOL.md) | Adapter assumptions, supported input and live-writing gate |
| [RUNNING.md](RUNNING.md) | Local/hosted setup, Pages activation, UI controls, troubleshooting and module extension |
| [TDD_PLAN.md](TDD_PLAN.md) | Test-first contracts and implementation approach |
| [../AGENTS.md](../AGENTS.md) | Current repository workflow, including Beads |

The original supplied handoff and RED checkpoint remain historical source material; use the implementation progress report for delivered behavior.

## Required product behavior

- Hotkey and UI cycle **Off → Opt → Best → Off**. Sector table and signed continuous delta use the same selected saved reference, snapshotted at the start of a lap.
- Collection continues while Off and while either widget is hidden. Placement, scaling, lock state, independent visibility, three layout profiles and rebinding persist. Layout editing mode is session-only. Actual key delivery while driving still needs in-game testing.
- Best is one complete valid captured lap. Opt uses independently fastest valid custom sectors and replaces each duration together with its curve. Ties preserve records.
- Records are separated by `LayoutId + VehicleInfo.ModelId`, sharing across liveries. One automatic definition is frozen per layout: `max(1, ceil(layoutLengthM / 1500))` equal-distance sectors, with 128 curve intervals per sector.
- Adding `src/modules/<name>/module.ts` and rebuilding discovers a module without changing a hardcoded host/render registry.

## Code map

| Area | Entry points |
| --- | --- |
| Browser wiring and module runtime | `src/browser.tsx`, `src/application.ts`, `src/module-host.ts`, `src/discover-modules.ts`, `src/modules/timing/module.ts` |
| Timing, curves and records | `src/timing-engine.ts`, `src/timing-feature.ts`, `src/curves.ts`, `src/records.ts`, `src/validation.ts`, `src/layout-definitions.ts`, `src/sector-definition.ts` |
| Mode and key binding | `src/reference-control.ts` |
| Raw telemetry adapter and one polling socket | `src/telemetry/raceroom-adapter.ts`, `src/telemetry/websocket-bridge.ts` |
| Widgets and layout controls | `src/ui/App.tsx`, `src/ui/TimingWidgets.tsx`, `src/ui/WidgetFrame.tsx`, `src/ui/layout.ts` |
| Capture format and bounded recorder | `src/diagnostics/capture-format.ts`, `src/diagnostics/recorder.ts` |
| Capture HTTP client, collector and UI | `src/diagnostics/capture-client.ts`, `src/diagnostics/capture-server.ts`, `src/ui/CaptureControls.tsx`, `scripts/capture-server.ts` |
| Replay and independent-label comparison | `src/diagnostics/replay.ts`, `scripts/replay-capture.ts` |
| Timeline and measurement reports | `src/diagnostics/analyze.ts`, `scripts/analyze-capture.ts` |
| Automated coverage | `tests/*.test.ts`, `tests/ui/*.test.tsx`, `tests/browser/*.spec.ts`, `tests/fixtures/browser-bridge.ts` |

The timing engine keeps a current capture and one pending finish. `onLapAccepted` is diagnostic acceptance of a structurally valid, fully captured normalized lap, including ties/slower laps. `onImprovement` fires only for actual Best/Opt improvements. Neither callback proves authoritative native final validity. Failures in the diagnostic `onLapAccepted` observer cannot change normal collection or record updates.

Storage failure handling retains improvements in memory, retries later, and avoids overwriting unknown stored records when reads are denied. Preserve reference immutability, combination isolation and recovery behavior.

## Protocol and integrity constraints

The first supported input shape is **RaceRoom API 3.6, player-controlled practice** (`SessionType=0`, `ControlType=0`). The game/native Windows bridge is external. Default socket: `ws://localhost:8070/r3e`, polled with empty messages every 16 ms. The `ws` query parameter can select another endpoint. Diagnostics reuse this socket; do not add another telemetry poller.

`LapValidState` and `PrevLapValid` are different flags. Native previous-sector values are treated as cumulative clocks, converted to durations after rounding seconds to integer microseconds. Their third endpoint must agree with the official total. These three native sectors differ from the configurable-count custom sectors.

Current limits are provisional: **300 ms frame gap, 0.3 normalized distance step, 500 ms finish timeout**. Synthetic tests establish implementation behavior, not safe live values. Finish association uses count/distance/clock progression and a fresh consistent previous-result signature. Entirely unchanged signatures remain ambiguous. Mixed old/new sectors, results leading the count, delayed validity and staggered wrap fields need real traces. Several stable samples do not establish authoritative finality.

Preserve the following diagnostic behavior:

- Captures are timing/identity **projections**, not whole wire-packet dumps. Driver names/data are omitted. Missing, null and unavailable values remain distinct. Malformed payload bytes are omitted; replay exercises rejection/reset behavior without reconstructing those bytes.
- Sequence order, monotonic receipt timestamps and connection epochs are retained before adaptation, including adapter-rejected input. A capture started on an already-open socket records that connection explicitly.
- Default capture bounds are a 4 MiB pending buffer, 256 KiB batches, 256 MiB session and 30-minute duration. Writes are asynchronous and normally batched at about 100 ms. Losses, limits and failures produce incomplete status. Stop duration excludes the time spent draining the sink.
- Each capture has its own ID directory containing `capture.jsonl` and `manifest.json`. Keep checksums, identity/count verification, exclusive file creation, idempotent batch retries and incomplete status. A failed manifest save can retry against the already-closed data file without rewriting it.
- Replay runs a live-disabled control and an offline shadow using isolated memory storage. Reports keep `liveWritesEnabled: false`, `profileValidated: false`; analysis keeps `liveValidated: false` and recording disabled. No report automatically enables live saving.
- `--allow-incomplete` permits diagnosis of partial captures. It does not repair corruption, reorder observations or qualify a capture as evidence.
- Labels must come independently from the game result display/video. Use native completed-lap count and connection/session identity where counts repeat. Reports expose `observedCrossings`; even rejected crossings participate in ambiguity detection. An ambiguous label stays unresolved.
- Official totals use integer microseconds. `totalToleranceUs` declares label uncertainty; UI-entered game display times use ±1000 µs. That tolerance does not relax native timing/validity checks.
- Replay exit **0** means report generation without labeled failures and can include unresolved/unlabeled results. Exit **2** means labeled mismatches with a report written; exit **1** means input/integrity/I/O failure. Existing report files are not overwritten.

The browser only opts into candidate record authorization for `demo=1`, using separate demo storage and an explicit indication. **Do not route real telemetry through demo mode to bypass validation.** The declared capture source is not proof of the packet origin; stop the synthetic bridge before collecting real data.

## Reproduce and verify

Use Node 24, the committed lockfile and the actual repository root.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser
```

Browser tests use `/usr/bin/chromium`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, or Playwright's browser. Install Chromium via Playwright if needed, as described in `RUNNING.md`. Browser tests use port 3100; normal development uses 3000. Build `dist/` before running the capture collector or its production-HUD browser tests.

For a tooling dry run, start these in separate terminals:

```sh
npm run demo:bridge
npm run capture -- --out captures/demo-check --port 3200
```

Open `http://127.0.0.1:3200/?capture=1&demo=1`, enter explicit synthetic build labels, start capture, wait for complete laps, stop and wait for **Saved**. Substitute the saved ID below:

```sh
npm run replay -- "captures/demo-check/PASTE-CAPTURE-ID" --out reports/demo-replay
npm run analyze:capture -- "captures/demo-check/PASTE-CAPTURE-ID" --out reports/demo-analysis
```

For real testing, follow [LIVE_TESTING.md](LIVE_TESTING.md) on Windows with RaceRoom and exactly one identified bridge. Use `-webHudUrl=http://127.0.0.1:3200/?capture=1` without `demo=1`. Keep a clean committed build, exact game/bridge versions, independent result labels and a scenario-to-capture record. Stop and wait for **Saved** before reloading/exiting the HUD or stopping the collector.

## Verification already performed

Recorded against implementation `2beddbf` on 2026-11-11:

| Check | Result |
| --- | --- |
| `npm test` | 336 passed; none failed, skipped, cancelled or TODO |
| `npm run test:browser` | 15 Chromium tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed, with 3 Webpack bundle-size/performance warnings |
| Production HUD → local collector → CLI replay/analysis | Complete checksummed synthetic capture; reports generated; unlabeled laps stayed unresolved |
| `git diff --check` | Passed |

Additional regressions were observed RED before fixing nonfinite projected values, manifest-save retry after closing the data file, and ambiguous invalid-lap labels across sessions. Prior core/UI work also used failing-first tests; see the TDD and progress documents.

Logs/screenshots are under ignored `.test-results/` in this workspace, including `diagnostics-full.log`, `diagnostics-browser.log`, `diagnostics-build.log` and `capture-ui-smoke.png`. They are not delivered by Git and may not exist in a fresh environment. `captures/`, `reports/`, dependencies and `dist/` are ignored. A remote CI result has not been verified.

## Next evidence-driven milestone

The detailed delivery order remains in `LIVE_VALIDATION_PLAN.md`; the operating procedure and acceptance conditions are in `LIVE_TESTING.md`. The next agent should first establish whether real traces are available.

If there are no real traces, help the operator run the Windows campaign. Cover clean consecutive laps, early/late/current-and-next invalidation, similar/tied results, pause/menu/reset/pit interruptions, bridge loss/restart, HUD mid-lap startup/reload, identity changes and load variation. Start with one known bridge/car/layout and repeat normal conditions with a second combination. Missing scenarios remain coverage gaps.

When traces arrive, verify the manifest and replay them with independent labels before changing code. Preserve minimal sanitized failing windows and provenance as fixtures, observe the new regression fail, then fix reconciliation. Investigate count/wrap/result/sector/validity ordering and distinguish message arrival gaps from unique game-update gaps. Do not infer finality from a fixed settle delay without evidence.

Only after those regressions pass should measured continuity/timeout/rounding settings and supported profiles be implemented. Define and verify custom-delta accuracy against an independent reference. Verify RaceRoom's embedded browser, connectivity, hotkey/rebinding delivery while driving, locking, persistence, pauses/disconnects and stale-delta clearing. Unknown bridge/game configurations must continue to keep live saving disabled. API 3.6 alone does not identify a bridge executable build.

If reliable final association cannot be established, preserve conservative rejection and investigate authoritative upstream semantics or a bridge extension. Do not mark a live profile validated simply because synthetic tests or an unlabeled replay pass.

## Repository workflow and environment caveats

Read [../.agents/skills/beads/SKILL.md](../.agents/skills/beads/SKILL.md), then use `bd prime` and the issue tracker for durable work tracking. Issues live in the local Dolt database; the passive JSONL export is ignored and must not be edited by hand. Generated Alloy state is also ignored; project recipes remain versioned. This document supplies product context; Beads supplies task status. Commit, push, publishing and Dolt remote sync authority comes from active session instructions, not this historical handover.

Upstream reference checkouts were `/workspace/references/sealhud_source` at user-pinned `d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b` and `/workspace/references/r3e-api` at inspected `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb`. They are separate from application source and may need fetching in a fresh environment. Sources are linked in `PROJECT_BASELINE.md`. Preserve [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the complete SealHUD MIT notice emitted with production assets.

`ENVIRONMENT_SETUP.md` records historical onboarding: the old platform configuration-draft save was unconfirmed. Current local build/test success does not prove that reusable environment configuration was published. Do not depend on old helper paths or running processes surviving a new task. The Windows game and native shared-memory reader are not supplied by this Linux cloud workspace.

Useful commit landmarks: `826e507` (original RED contracts), `c3fcf1a` (timing core), `0b5e935` (rendered HUD/adapter), `33bf0d5` (live-validation plan), `2beddbf` (capture/replay/analysis tooling). The merge carrying this document preserves both implementation history and the remote README/workflow changes.
