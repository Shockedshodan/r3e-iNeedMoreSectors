# RaceRoom bridge adapter and live-writing gate

The implementation sequence for the missing recorder, replay, analysis and live enablement is in [LIVE_VALIDATION_PLAN.md](LIVE_VALIDATION_PLAN.md). Its proposed commands are not implemented yet.

The application uses one polling WebSocket connection to the SealHUD-compatible `/r3e` bridge. Its default is `ws://localhost:8070/r3e`; it sends empty strings at a configurable 16 ms polling interval. Connection errors and closes reset the adapter and reconnect. Disposal cancels polling/reconnect timers and closes the socket. No unrelated CrewChief audio, CSS-reload socket, analytics, clipboard telemetry or debug-snapshot storage is started.

## Supported input

The implemented first protocol is shared-memory **3.6**, practice (`SessionType=0`), player control (`ControlType=0`). Raw field names follow the pinned API and SealHUD references in [PROJECT_BASELINE.md](PROJECT_BASELINE.md).

| Raw fields | Normalized interpretation |
| --- | --- |
| `LayoutId`, `LayoutLength`, `VehicleInfo.ModelId` | Layout/model identity and automatic sector definition; liveries do not split records |
| `CompletedLaps`, `LapDistanceFraction`, `LapTimeCurrentSelf` | Lap count, normalized distance and current elapsed clock |
| `LapValidState` | `0` current/next valid, `1` current invalid, `2` current/next invalid, other/unavailable unknown |
| `LapTimePreviousSelf`, `SectorTimesPreviousSelf` | Previous official total and cumulative native sector clocks |
| `PrevLapValid` | `1` valid, `0` invalid, otherwise unavailable |
| `SessionIteration`, `EventIndex`, simulation clock | Session identity/reset evidence; not an official result sequence ID |
| Replay/menu/pause/control/debug flags | Prohibited observations interrupt collection and cannot authorize finishes |

Seconds are rounded to integer microseconds. Cumulative native sector clocks become independent durations by subtraction after quantization; their third endpoint must equal the quantized official total. The native three sectors are not the configurable-count automatic custom sectors. The engine interpolates custom boundaries and rounds absolute boundary times once so durations sum exactly.

## Finish association

The adapter watches for lap-count progression plus distance and clock wrap. It can hold one pending result while forwarding the next lap. It accepts only a matching, fresh previous-result signature (total plus all cumulative sectors), valid final status, consistent times and a result received before the configured timeout. A changed total alone is insufficient. Equal totals can be distinguished if their sector signatures differ. An entirely unchanged signature remains ambiguous and is rejected, not assigned a fabricated native lap ID. Explicitly invalid fresh results cannot later be resurrected by a flag flip.

These checks are a **conservative candidate association**, not proof that native fields update atomically. A fresh signature can still be misleading if live fields arrive in an unobserved order. The native API documents no result sequence ID or guaranteed finish snapshot. For that reason, `createRaceRoomAdapter()` defaults to `enableRecordWrites: false`, producing normalized display/capture observations without authorized finish results.

The browser only enables the opt-in candidate association for `demo=1`, which uses separate storage and a prominent demo indication. Browser tests feed raw API-shaped JSON through a real local WebSocket and this same adapter; they do not inject trusted normalized finish IDs. No user-facing live override bypasses the gate.

## Thresholds and compatibility

The current runtime injects a 300 ms maximum frame gap, a maximum normalized distance step of 0.3 and a 500 ms finish timeout. They are explicit provisional fixture/development settings, not measured safe game defaults. Limits are inclusive. Interruptions, excessive gaps, backwards progression, inconsistent official timing and unresolved finishes discard captures while preserving records.

The browser build transpiles to ES2018 and includes polyfills for `Array.at`, `Object.fromEntries`, `structuredClone` and `AggregateError`. A browser test removes those APIs before startup and verifies actual record collection. This establishes the selected polyfill behavior, not full compatibility with RaceRoom's embedded Chromium or every older browser API.

## Evidence still needed before live saving

Capture real practice-mode traces from the chosen Windows bridge and add replayable adapter regressions for finish ordering, delayed final validity, unchanged consecutive results, invalidation crossing the line, session resets, interruptions and reconnects. Measure continuity limits and finish latency, compare the custom delta against an independent timing reference, and verify browser connectivity, persistence and hotkey delivery while driving. Only then select measured defaults and enable a validated live-writing path. The ordinary test suite cannot supply that evidence.
