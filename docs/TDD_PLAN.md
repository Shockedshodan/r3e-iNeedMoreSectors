# Test-first implementation plan

## SealHUD test audit

The user-pinned SealHUD revision `d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b` has no automated project test suite. Inspection covered all 154 tracked files, hidden paths, package scripts and direct dependencies:

- `package.json` exposes only `start` and `build`; no test script or direct test-framework dependency.
- No test/spec files, test-runner configuration, fixture directories, or `.github` CI workflows were present.
- The “Widgets-TEST-Mode” in `src/components/app/app.tsx` is a manual widget preview. `src/components/progress/progress.tsx` supplies sample sector and delta values; it performs no assertions.
- The onboarding Playwright smoke was authored locally to validate bootstrap and browser settings. It is not an upstream test suite or a timing correctness test.

This conclusion applies to the pinned source inspected here. It is not a claim about private tests or uninspected revisions. The upstream reference checkout was left unchanged.

## Approach and current scope

Use the requirements in [PROJECT_BASELINE.md](PROJECT_BASELINE.md). First specify pure timing behavior, then connect it through the module host, then implement rendering and the real bridge adapter. Keep engine tests independent of SealHUD imports, which start network connections and unrelated services.

This change is the RED phase. `src/contracts.ts` defines proposed seams and other source files only export throwing placeholders. No sector algorithm, capture state machine, storage repository, host, or timer UI has been implemented. The tests are executable specifications, not skipped tests, TODOs, or a passing mock application.

Use Node 24's built-in test runner and TypeScript stripping. The test runner adds no dependency; the only development dependencies are pinned TypeScript and Node types. Test times and telemetry are supplied explicitly, so there are no sleeps, network calls, RaceRoom installations, or system-clock dependencies in these specifications. Storage and bridge fakes expose observable effects; expected timing values are hand-calculated rather than derived by a second timing algorithm.

From the application checkout:

```sh
npm ci
npm run typecheck
npm test
```

For local iterations, `npm run test:watch` watches the suite. Target a single file with `node --test tests/curves.test.ts` or a behavior with `node --test --test-name-pattern='snapshot' tests/timing-engine.test.ts`. The current RED suite intentionally exits nonzero. Type checking must pass even while behavior is unimplemented. Never mask that exit code, mark tests as expected failures, loosen assertions merely to turn the report green, or turn an empty run into a success claim.

## Initial executable specifications

| File | Behavior to implement |
| --- | --- |
| `tests/sector-definition.test.ts` | Equal-distance sectors, exact 1500 m cutoffs, unavailable/invalid layout rejection |
| `tests/curves.test.ts` | Bounded resampling, nonlinear interpolation, sector offsets, delta sign, endpoints, invalid trace rejection |
| `tests/records.test.ts` | Atomic Best and Opt updates, ties, identity isolation, curve validation, versioned storage, corrupted data, write failures and retry |
| `tests/timing-engine.test.ts` | Complete captures, coherent wraps, delayed finish association, validity latching, continuity boundaries, interruptions, snapshots and disposal |
| `tests/reference-control.test.ts` | Configurable hotkey, exact modifiers, repeats/text entry, lock behavior, persisted selection, shared widget references and edit previews |
| `tests/module-host.test.ts` | One transport, module descriptors/actions, hidden collection, namespaced storage, cleanup, duplicate IDs and failed initialization |
| `tests/timing-feature.test.ts` | Headless host → timing feature → records integration; collection in every mode and while both widgets are disabled, restart recovery |

The last two layers specify headless behavior. They do not prove React rendering, Webpack discovery, dragging/scaling gestures, real WebSocket compatibility, or embedded-browser behavior.

## Proposed test contracts and decisions

These are implementation proposals made for deterministic tests, separately from the user's requirements. Change a proposal deliberately in this document and its tests when evidence requires it; preserve the original handoff.

### Timing and records

- Normalized authoritative durations use integer microseconds. Interpolated intermediate values may be fractional microseconds. The future bridge adapter must define float32-seconds quantization before exact sum checks; these tests do not validate that normalization.
- A sector curve uses local fractions `0..1` and elapsed time starting at zero. Custom lap distance uses the stored boundary array. Samples must cover endpoints, have strictly increasing distance, finite values and nondecreasing time. Resampling is linear between measured points, not an assumption of constant speed.
- The 128-interval grid is the handoff's provisional choice: 129 points per sector, subject to live accuracy checks. Curves must never be extrapolated outside `0..1`; unavailable/out-of-range comparison inputs yield no delta.
- Complete Best replacement and independent Opt sector replacement include the matching curves. Equal times preserve existing references. Non-record and invalid captures generate no writes. Old references are immutable, including an active lap's comparison snapshot.
- `updateRecords` treats a combination/boundary mismatch as caller misuse (`RangeError`); invalid/partial/malformed candidate laps produce no improvement. Invalid lengths/curve definitions also raise `RangeError`.
- Root-storage record keys are `r3e-sectors:v1:records:<layoutId>:<modelId>`. The v1 envelope contains only version, layout/model identity, boundary compatibility information, and the two active references. It contains no livery ID, non-record laps, or previous versions. Layout-definition metadata and UI preferences remain separate. Host-provided module storage adds isolation; its prefix spelling is deliberately unspecified.
- Unknown/corrupt/incompatible saved records are ignored without rewriting them on read. An actual improvement may replace the entry. Storage failures keep the latest improvement in memory and mark it dirty for retry.

### Capture and finish association

- `TimingFrame` is a normalized synthetic contract, not the native API schema. Its source/control/replay/pause/menu flags let the engine reject prohibited input. Invalid or unavailable validity contaminates the capture and remains latched. A frame from a new identity discards the old active/pending capture.
- Completion requires lap-count progression plus distance and clock wrap. Joining mid-lap cannot create a complete record. A pending finish does not block collecting the next lap. At most one current capture and one pending finish are retained.
- `FinishResult` contains an **adapter-proven** session/layout/model/completed-lap association. No such result ID is documented by the native RaceRoom API. The adapter must leave it absent when association is ambiguous. Matching a number or seeing a changed previous time does not establish freshness.
- Associated official sector durations are normalized independent durations for the native three sectors. They are **not** the custom sectors and **not** raw cumulative sector timestamps. Upstream `progress.tsx` subtracts cumulative native sector fields before displaying durations. Test captures use two custom sectors against three native official sectors to enforce this separation.
- Official total/sector consistency and final valid status are necessary before a capture can improve records. Tests do not claim these alone prove raw data freshness.
- Continuity settings are injected. Fixtures use a maximum 300 ms frame gap, a maximum 0.3 normalized distance step and a 500 ms finish timeout; equality is accepted at the configured boundary. These are synthetic values, **not measured safe operating defaults**. Duplicate observations must not duplicate writes; backwards progression or excessive gaps discard capture. Timeout is evaluated from supplied observation times when frames arrive; any future independent timer must use an injectable clock and be tested separately.
- A new lap snapshots its comparison references before delayed reconciliation can change that lap's comparison. This favors stable comparisons; both widgets read the same snapshot and selection.

### Selection and module integration

- Fresh selection starts Off. Persist mode and configurable physical `KeyboardEvent.code` plus exact modifiers at `r3e-sectors:v1:preferences:timing` as `{mode,binding}`. The tests configure their own binding and do not prescribe a driving-safe default key.
- Off → Opt → Best → Off controls both widgets; it does not control collection. No selected saved reference means no comparison, rather than silently switching to the other type.
- Ignore repeated keys and input, textarea, select and contenteditable targets. Placement locking does not block the reference action. A future DOM adapter must forward the actual target/editability state correctly.
- The headless view model supports independent visibility and editing previews. Tests do not prescribe pixel styling or mock sample times as real deltas.
- Modules register descriptors and actions through the host. The timing module uses `timing.cycleReference`. The host owns one telemetry connection and isolated module storage, removes subscriptions on disposal, and rolls back partial initialization. Runtime registration tests precede a separate Webpack discovery test; they do not prove build-time discovery already exists.

## Implementation sequence: red → green → refactor

For each slice, inspect a failing behavior, implement the minimum real behavior, run that file, then run the whole suite and type checker. Once green, refactor without changing observable results. Do not rewrite tests around a faulty implementation.

1. **Definitions and curves.** Implement validation, boundaries, bounded resampling and interpolation. Use known nonlinear examples and endpoint assertions as the oracle.
2. **Records and storage.** Implement pure immutable updates, then the repository. Prove complete Best vs independently improved Opt, identity isolation, ties, corruption and quota failure before persisting real telemetry.
3. **Capture engine.** Implement normalized frame handling, continuous capture, associated finish reconciliation, validity rejection and snapshots. Keep configuration explicit; do not select live defaults from synthetic fixtures.
4. **Reference selection and headless module integration.** Connect the shared store to controller/view models and host; make timing-feature tests prove collection in all modes and persistence across recreation.
5. **SealHUD UI and build discovery.** Before implementing each adapter, add React Testing Library tests for both widgets reading the shared store, missing references, editing previews, independently persisted placement/scale, and command registration/unregistration. Add a Webpack fixture with an extra `modules/**/module.ts` and verify it appears after rebuild without editing a hardcoded registry. Preserve upstream notices and keep unrelated services/debug persistence disabled.
6. **Browser integration.** Before the real UI integration, add a project-local Playwright harness and a local deterministic WebSocket bridge. Test rendered sector values and continuous saved-reference delta, drag/scale/edit/lock behavior, rebinding, reload persistence, connection interruption, and adding/removing a module. Reuse deterministic fixtures; verify requests/messages and visible output, not just an open port. These are future RED tests, not checks claimed as already written or run.
7. **Real bridge and live acceptance.** Capture consented practice-mode telemetry on Windows, document actual native field order and units, and write replayable adapter regressions **before enabling writes**. Verify unchanged consecutive previous times, invalidity timing, reconnections, finish timeout/continuity limits, embedded-browser WebSocket access, persistence, hotkey delivery while driving and delta accuracy. Keep record writes disabled until association and validity are demonstrated; a synthetic normalized association is not evidence that the bridge can produce one safely.

After the initial suite becomes green, CI should run `npm ci`, type checking, and the tests; then add production-build and browser jobs when those workflows exist. Do not introduce a permanently green job by excluding the current RED specifications. A default `npm test` failure is intentional at this stage and must be visible to the next implementer.

## Current verification

See [TDD_RESULTS.md](TDD_RESULTS.md) for the measured test count and exit statuses of this RED baseline. No live RaceRoom acceptance has been performed.
