# First green milestone: timing core and headless integration

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

## Remaining work

Next is plan step 5: add failing React and Webpack-discovery tests, then integrate the actual SealHUD configuration/placement/scaling UI and both widgets. The current widget descriptors deliberately render nothing. DOM key forwarding, rendered settings/rebinding, persistent layout-definition registry, persistent widget placement/scale and module discovery by rebuild still need that integration. The feature currently operates on one supplied layout definition and supports model/session changes within it.

Then add browser tests with a deterministic WebSocket bridge, followed by the native adapter and live practice-mode acceptance. No adapter currently creates the normalized, proven finish association required by this engine. Real finish ordering/validity, continuity thresholds, embedded-browser connectivity/persistence, driving-hotkey delivery and delta accuracy remain unverified. No live record-writing path is enabled by this headless milestone.
