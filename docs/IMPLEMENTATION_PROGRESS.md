# Implementation progress

## Diagnostic capture, replay and analysis — current milestone

Phases 1–4 of [LIVE_VALIDATION_PLAN.md](LIVE_VALIDATION_PLAN.md) are implemented. [LIVE_TESTING.md](LIVE_TESTING.md) contains the Windows procedure, driving scenarios, independent result labels, commands, report interpretation and acceptance criteria.

- **Capture:** versioned timing-only JSONL, monotonic receive timestamps before adaptation, connection epochs, explicit malformed/loss events, bounded queues/batches/session limits and asynchronous writes. Private driver data is excluded.
- **Local host and controls:** one existing telemetry connection, explicit diagnostic start/stop and annotations, loopback HTTP collection, durable completion manifests with SHA-256, idempotent batch retries and incomplete-capture reporting. Capture data is kept out of localStorage.
- **Replay:** deterministic adapter/engine execution with a live-disabled control and isolated offline shadow results. Independent labels compare lap identity, validity, total and acceptance count; ties need not improve records. Missing or ambiguous ground truth remains unresolved.
- **Analysis:** JSON/CSV/HTML timelines around crossings, message versus source-update gaps, duplicate observations, field/validity transitions, quantization, movement, reset and loss diagnostics. Last observed stability is not presented as proof of final validity.

The tools have been exercised together against the standalone synthetic bridge using the production HUD: a complete checksummed capture replayed and produced analysis reports. This demonstrates the tooling, not RaceRoom finish semantics. Reports retain `profileValidated: false` / `liveValidated: false`; ordinary live lap-record saving remains disabled.

Validation on 2026-11-11:

| Check | Result |
| --- | --- |
| `npm test` | 336 tests passed; no failed, skipped, cancelled or TODO tests |
| `npm run test:browser` | 15 Chromium tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; 3 standard Webpack bundle-size/performance warnings |
| Production HUD → collector → replay/analysis smoke | Complete synthetic capture, checksum verified, reports generated; unlabeled results stayed unresolved |
| `git diff --check` | Passed |

Review added failing-first regressions for unrepresentable projected values, a manifest-save retry after the data file closes, and ambiguous invalid-lap labels across repeated session lap counts. Generated test captures and reports remain ignored. The remaining development depends on real Windows evidence: reproduce failures as regression fixtures, correct reconciliation, choose measured profiles and pass in-game acceptance before enabling supported live saving.

## Rendered HUD, controls, discovery and adapter — previous milestone

The six implementation items requested after the timing-core commit are now present:

1. **Rendered widgets:** selected saved Best/Opt sector tables and continuous signed delta, explicit missing-reference states, and honest editing previews.
2. **SealHUD-derived layout controls:** drag, wheel scaling, fine/coarse increments, editing, locking, independently hidden widgets, three persisted profiles and frozen layout definitions across application starts.
3. **Keyboard/settings integration:** DOM forwarding, persisted rebinding, repeat/text-entry suppression and reference cycling while placement is locked.
4. **Build discovery:** new `modules/**/module.ts` factories register widgets/actions after rebuilding. Tests add a folder and build again without changing the host/render registry.
5. **Browser integration:** actual raw-JSON WebSocket fixtures drive the adapter, engine and React UI, including record collection while Off, saved delta, reconnect interruption, profiles, visibility, reload, demo isolation and selected missing-API polyfills. Disconnecting clears the displayed delta while retaining saved references; fresh telemetry is required before resuming comparison.
6. **Native-field adapter implementation:** RaceRoom API 3.6/practice/player normalization, unit conversion, native cumulative sectors, validity latching, conservative delayed-finish association, polling/reconnect and cleanup. **Real field ordering and measured operating thresholds remain live-validation prerequisites; the ordinary live path cannot authorize record writes.**

Focused SealHUD code/behavior and styling were adapted from the pinned reference. The complete upstream MIT notice is retained in source and emitted with the production build. No unrelated startup services or debug-snapshot persistence were imported.

Review added failing-first regressions for selection and unsaved-reference retention during layout changes when storage writes fail, and for overlapping default widgets. The shared application-lifetime repository and in-memory preferences now survive feature recreation. Existing saved positions are preserved.

Latest validation on 2026-11-11:

| Check | Result |
| --- | --- |
| `npm test` | 235 unit/component/build tests passed; no skipped, cancelled or TODO tests |
| `npm run test:browser` | 11 Chromium tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; 3 standard Webpack bundle-size/performance warnings |
| Production-mode server smoke | Bootstrap, settings and rebinding passed with no page errors |
| Standalone synthetic bridge smoke | Six custom sectors, saved references and continuous delta verified in the production-mode browser |

CI configuration now runs the unit/component suite, production build and browser suite. A remote CI run has not been claimed or verified. Tests and screenshots are retained under ignored `.test-results/`; see [RUNNING.md](RUNNING.md) for reproduction and [TELEMETRY_PROTOCOL.md](TELEMETRY_PROTOCOL.md) for the live gate.

## First green milestone: timing core and headless integration — historical

Implemented on 2026-11-11, following the RED tests from commit `826e507` and the sequence in [TDD_PLAN.md](TDD_PLAN.md).

## Implemented

- **Sector definitions and curves:** validated equal-distance boundaries, bounded 128-interval curves, nonlinear interpolation, stitched sector offsets, exact endpoints and signed saved-reference delta.
- **Best/Opt records:** complete Best replacement, independent Opt sector and curve replacement, tie preservation, layout/model isolation and immutable reference snapshots. Invalid/partial/malformed laps cannot improve records.
- **Storage:** schema and curve validation, corruption rejection, one record entry per combination, in-memory improvements while writes fail and later retries. Denied reads block overwriting unknown saved records; recovery merges complete Best and independent Opt before saving. Frozen layout boundaries are shared across car models within the repository lifetime.
- **Normalized capture engine:** bounded current and pending captures, coherent lap-count/distance/clock wrapping, validity latching, source/control filtering, inclusive injected continuity limits and finish timeout, associated result reconciliation, next-lap collection during pending reconciliation and stable lap-start comparisons.
- **Controller/view model:** Off → Opt → Best → Off, persisted mode/binding, exact key/modifier handling, ignored repeats/text entry, lock-independent selection, shared widget references, independent visibility and editing previews. Alt+T is a provisional default available through the controller API.
- **Module host and timing feature:** one injected transport, descriptors/actions, isolated module storage, rollback and disposal, `timing.cycleReference`, background collection in every mode and while hidden, model changes, recreation and recovery synchronization.

The engine callback now supplies the real complete captured candidate as well as its merged update. This prevents an Opt-only sector improvement from being serialized as an impossible Best lap. Recovered better references can be synchronized without restarting capture or changing the active comparison snapshot.

## TDD and validation

The original 123 tests were run RED before implementation. Additional regressions were also observed failing before fixes for reference aliasing, corrupt or denied preferences, cleanup errors, rounding/invalid telemetry, storage read recovery and Opt-only persistence. The tests were not weakened or skipped to achieve GREEN.

Latest current-instance validation:

| Check | Result |
| --- | --- |
| `npm test` | 160 passed; 0 failed, skipped, cancelled or TODO; exit 0 |
| `npm run typecheck` | Passed; exit 0 |
| `git diff --check` | Passed |

The full runner log is stored locally at `.test-results/implementation.log` (ignored). CI configuration now runs frozen installation, type checking and the full suite on pushes and pull requests; a remote CI run has not been claimed or verified.

All original throwing feature seams have been implemented and the unused placeholder helper removed. Upstream reference repositories remain unchanged. These checks validate normalized/headless behavior, not a rendered HUD or live game telemetry.

## Remaining live acceptance

Capture real practice traces from the chosen Windows bridge, establish finish-field ordering/final validity and measured continuity/timeout settings, and validate the embedded browser, persistence, hotkey delivery while driving and delta accuracy. Then add regressions from that evidence and enable a validated live record-writing path. The implemented conservative association and synthetic tests do not replace that evidence. Other session modes and bridge versions remain outside the initial practice/API 3.6 scope.
