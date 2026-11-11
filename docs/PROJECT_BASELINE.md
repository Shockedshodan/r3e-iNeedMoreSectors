# R3E Sector Timer — project baseline

This is the working baseline selected by the user on 2026-11-11. Read it before making implementation decisions or continuing environment setup.

## Authority and scope

The handoff below was supplied by the user as the final-message content of https://chatgpt.com/s/cx_6af47e935f548191ac4f2762bde2387c. The uploaded text is the source used here; the shared-chat URL itself could not be retrieved. Preserve the distinction in the handoff between user requirements and recommended implementation choices. New decisions should be recorded separately, rather than silently changing this baseline.

This baseline originated during environment onboarding. The user subsequently requested a test-first implementation approach; see [TDD_PLAN.md](TDD_PLAN.md) for the contracts and [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) for the green timing core and headless integration. The rendered timer and native adapter have not been implemented or validated in RaceRoom.

## Reference sources

- SealHUD: https://github.com/sealhud/sealhud_source/tree/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b — pinned by the user. Local checkout: `/workspace/references/sealhud_source`.
- RaceRoom API: https://github.com/kwstudios-sweden/r3e-api — inspected at `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb` on 2026-11-11. Local checkout: `/workspace/references/r3e-api`. This revision records the inspected version, not a user-selected version pin.
- Development checkout: `/workspace/r3e-iNeedMoreSectors`. It initially contains only `README.md`; implementation has not started.

## Supplied handoff (verbatim)

```text
R3E Sector Timer — analysis and architecture handoff

Status: Original plan and relevant SealHUD source reviewed. No implementation or live RaceRoom validation performed. Requirements below come from the user; implementation choices are recommendations.

The user requires:
- A configurable hotkey cycling Off → Opt → Best → Off.
- Both the sector panel and delta to use the selected saved Opt/Best reference.
- Configuration, placement, and scaling reused from SealHUD.
- Best/Opt records per car/track combination.
- Extension by adding new modules.
The original plan has a sound core: one complete Best lap, independently fastest Opt sectors, interpolation, localStorage, and collection independent of visibility.
Weak point	Recommended simplification
Finish reconciliation and final validity are unproven. Similar consecutive times can make stale results look plausible.	Verify live field ordering and validity before enabling record writes.
“Coherent,” “untrustworthy gap,” and similar rules lack explicit limits.	Establish measured continuity limits and a finish timeout. Discard interrupted captures in v1.
Sector overrides require compatibility checks and resets across cars.	Freeze one automatic definition per layout; defer overrides.
Hidden SealHUD widgets can leave shared services running; debug snapshots can persist.	Explicitly disable unrelated startup services and debug persistence.
Import merging and broad bridge/mode support enlarge initial scope.	Prove one bridge and practice mode first; expand afterward.


The proposed architecture is a small host with modules discovered during the build:
Telemetry bridge → HUD host → Timing module → Sector panel
                       │           │        → Delta widget
                       │           ↕
                       │       localStorage
                       └──→ Additional modules
The host owns one WebSocket connection, frame distribution, commands/keybindings, namespaced preferences/storage access, and widget placement/settings. Reuse SealHUD’s existing toolchain, transport, drag/scale/edit/lock behavior, and layout persistence. Preserve licence notices and upstream provenance.

Refactor SealHUD’s hardcoded widget defaults/rendering once to consume registered descriptors. Each widget provides a stable ID, component, and default settings/placement.

Modules follow this contract:
interface HudModule {
  id: string;
  create(ctx: ModuleContext): {
    widgets: WidgetSpec[];
    actions?: ActionSpec[];
    Settings?: React.ComponentType;
    dispose(): void;
  };
}
Discover modules/**/module.ts through Webpack. Adding a folder and descriptor, then rebuilding, adds a module. Context supplies core services; modules own feature state and subscription cleanup.

Keep the engine, records, curves, shared MobX store, and both widgets in one timing module initially. Background collection starts once and continues while widgets are hidden.
Mode	Both timing widgets	Collection
Off	Hidden	Continues
Opt	Saved optimal reference	Continues
Best	Saved best complete lap	Continues


Register timing.cycleReference; persist its binding and last mode. Widgets remain independently placeable/configurable, with previews during layout editing. Ignore key repeats/text entry and allow cycling while placement is locked.

Verify hotkey delivery while driving early. Browser handlers do not establish that RaceRoom forwards the chosen key. If forwarding is unavailable, the existing bridge would need an extension to emit the same command.

Continuous saved-reference delta requires revising the original “no traces” rule. Retain bounded distance/time curves inside the two active references. SealHUD’s calculation reads the game’s TimeDeltaBestSelf; reuse its presentation with a custom saved-reference calculation.

Freeze one sector definition per LayoutId:
N = max(1, ceil(layoutLengthM / 1500))
boundaries = i / N
Proposed curve grid: 128 intervals per sector, subject to live accuracy checks.
- Best improvements replace the entire lap, sector durations, and curves.
- Opt improvements replace each faster sector’s duration and curve together.
- Stitch Opt curves using preceding sector durations as offsets.
- Calculate delta = currentLapElapsed − referenceElapsedAt(currentDistance).
- Snapshot comparison references for the active lap. Both widgets select from that snapshot.
- Accept only complete, game-valid captured laps; preserve existing references on ties.
Key records by LayoutId + VehicleInfo.ModelId, sharing across liveries. Store both references and curves in one versioned localStorage entry per combination. Keep layout definitions and UI preferences separately. Persist improvements only; retain no non-record laps or previous reference versions.

The engine keeps one current capture plus one pending finish. Detect completion through lap-count progression and distance/clock wrap—not previous-time inequality. Continue the next capture while reconciling the previous result. Reject debug/replay/opponent/AI data, latch invalidity, and discard ambiguous or interrupted captures. Validate curve endpoints, monotonic times, and exact agreement between official totals and sector sums. Storage failures retain unsaved improvements in memory.

Implementation order:
1. Verify telemetry semantics, hotkey delivery, embedded-browser connectivity, and persistence.
2. Build/test the pure engine, curves, and Best/Opt updates.
3. Integrate module registration, SealHUD configuration, and both widgets.
4. Validate complete live behavior and delta accuracy before expanding compatibility.
Sources: Pinned SealHUD development source, especially r3e.ts, app.tsx, and progress.tsx; RaceRoom API.
```

## Additional source findings from onboarding

These observations supplement the handoff; they do not replace its requirements.

- SealHUD uses React, TypeScript, MobX, Webpack, and a committed `package-lock.json`. Its scripts are `npm run build` and `npm start`; it has no existing automated test script.
- SealHUD opens `ws://localhost:8070/r3e`, with a `?ws=host:port` override. Development also attempts a separate CSS-reload connection on port 8071. Its browser key handlers do not prove key delivery while driving.
- SealHUD restores debug telemetry from `localStorage.stateJson` and can persist pasted/paused frames there. Future timing record collection must distinguish or reject debug input as specified in the handoff.
- The upstream `LICENSE` and README specify MIT licensing, while `package.json` says ISC. Preserve the upstream notices and resolve this metadata inconsistency explicitly before redistribution.
- The RaceRoom API is native Windows shared memory (`$R3E`, API 3.6); its samples require a running `RRRE.exe`. The API repository does not supply a WebSocket bridge.
- `CompletedLaps`, `LapDistanceFraction`, lap timing, `LayoutId`, and `VehicleInfo.ModelId` exist. Model and livery IDs are distinct. Most timing fields use `-1` for unavailable; `TimeDeltaBestSelf` uses `-1000`.
- `LapValidState` documents `-1` unavailable, `0` current/next valid, `1` current invalid, and `2` current/next invalid. `PrevLapValid` documents `-1` unavailable, `0` invalid, and `1` valid. Do not treat the flags as interchangeable.
- The API documentation does not guarantee field update order or an atomic finish snapshot. Finish reconciliation, continuity thresholds, hotkey delivery, embedded-browser connectivity, persistence in RaceRoom, and delta accuracy require live validation.

## Environment working rules

Use the existing development checkout. Each cloud task is isolated; do not create a Git worktree unless the user explicitly requests one. Reference checkouts remain separate from application source. During onboarding, keep tracked source, tests, dependency declarations, and lockfiles unchanged. Installing and building the reference HUD validates that toolchain, not the unimplemented timer.

Current setup commands, results, and external blockers are recorded in `ENVIRONMENT_SETUP.md` alongside this document.
