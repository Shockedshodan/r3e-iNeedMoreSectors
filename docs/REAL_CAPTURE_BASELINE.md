# Provided capture baseline

Audit for `r3e-iNeedMoreSectors-p9z.7`, performed on 2026-11-11 against
`a7f0307376e0419949951667c326d81f8f66d666`, after field-based compatibility.
This records observed behavior for reconciliation task 8. It does not validate
the full campaign (task 6), a live profile, or independent game-screen results.

## Evidence and integrity

The local, untracked original is
`captures/practice-01/f489307d-60e5-4188-9e9b-fce95b169b88/`.
Its manifest and freshly generated replay/analysis verify:

| Item | Value |
| --- | --- |
| Capture ID | `f489307d-60e5-4188-9e9b-fce95b169b88` |
| SHA-256 | `67e59c0b3f83e05e4d0d1989fef1507bc83342788799cc40ea87ea3ba32cb88b` |
| Bytes / events / messages | 45,541,348 / 56,940 / 56,939 |
| Complete / manifest verified | true / true |
| Source loss / annotation / malformed events | 0 / 0 / 0 |
| Raw API version | 2.8 throughout |
| Layout / model | 13256 / 13398 |
| Session type / iteration / event index | 0 / 1 / 0 |

Header game version `0.9.2`, bridge version `3.6` and HUD revision
`55af1be1d56eec6c6848ed28113e555e9cc8cec2` are recorded metadata, not
independently verified build identities. The raw API 2.8 values remain unchanged.

Reuse [the sanitized fixture](../tests/fixtures/lap-count-windows/capture.jsonl)
and [its provenance](../tests/fixtures/lap-count-windows/provenance.json).
Fixture SHA-256 is
`bb110b3ea564b86aa5c6b9a82db6acfe54ccf556db24d8ecb997e60dbfb85be6`.
All 12 retained message receipts and the connection-open event were compared
with the original: timestamps, connection identity, projected data and event
metadata match exactly, except for documented sequence compaction. The existing
full-capture acceptance check now repeats that comparison automatically.

The excerpt retains the adjacent preceding receipt for every crossing, sufficient
for raw count/clock/validity analysis. Inserted loss markers and its incomplete
footer correctly prohibit stitching the omitted intervals into captured laps.
It is **not sufficient preceding state for an engine full-lap acceptance
regression**. Task 8 can use the original continuous recording to reproduce the
baseline and preserve the necessary contiguous preceding state when selecting an
engine regression window. Do not remove the excerpt's loss markers, manufacture
continuity, or substitute it for the original in full-capture checks. No duplicate
capture fixture was added by this audit.

## Automatic telemetry results

These are captured API observations, not independent expected labels. Raw
`LapTimePreviousSelf` is in seconds; normalized totals are in microseconds.
Every row has `source: telemetry` and `finality: not-established`.

| Completed lap | Source crossing seq | Excerpt seq | Raw previous total | Total us | Raw `PrevLapValid` | Analysis association / coverage |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 10142 | 3 | -1 | null | 0 | unavailable / partial-start |
| 2 | 19159 | 6 | -1 | null | 0 | unavailable / observed |
| 3 | 28104 | 9 | 149.494965 | 149494965 | 1 | reported / observed |
| 4 | 37068 | 12 | 149.835876 | 149835876 | 1 | reported / observed |
| 5 | 46015 | 15 | -1 | null | 0 | unavailable / observed |
| 6 | 54986 | 18 | -1 | null | 0 | unavailable / observed |

At crossings 1, 2, 5 and 6 the previous-sector clocks are also present as `-1`,
not missing or null. At crossing 3, raw cumulative previous sectors are
`41.4579773, 111.552826, 149.494965`; at crossing 4 they are
`41.4022827, 111.804688, 149.835876`. These are cumulative native clocks,
not three individual sector durations. The CLI rounds the two totals to
`2:29.495` and `2:29.836`; the JSON preserves the normalized precision.
`PrevLapValid` is the native reported flag, not proof of authoritative finality
or the cause/timing of a driving invalidation.

## Current replay and analysis outcomes

Both public CLIs exited 0 using their default settings and no annotations or
profile overrides. Reports generated for this audit are local artifacts under
`/tmp/p9z7-a7f0307-replay/` and `/tmp/p9z7-a7f0307-analysis/`.

Analysis exposes six count progressions and two timing-qualified finish
candidates (laps 3 and 4). It reports 27,444 unavailable/malformed player-timing
samples and nine duplicate messages. It reports no transport resets, observed
state resets, malformed messages or loss events. Unavailable clocks do not erase
the raw count progression and are not fabricated durations.

Replay reports zero control proposals, zero shadow improvements, zero accepted
laps and zero records. Its two observed normalized crossings are laps 3 and 4.
Lap 3 produces one shadow adapter result at seq 28104, total 149494965 us,
with `engineAccepted: false` and `engineImprovement: false`. Lap 4 has no shadow
adapter result; its replay crossing's `totalUs: 0` is not the native reported
149835876 us total. Replay records 27,444 issues, all
`Unavailable or malformed player timing`; none is a version rejection.

There are no labeled comparisons or labeled failures. There are **two unresolved
rows**, not two passes: lap 3 has an unlabeled adapter result without independent
ground truth; lap 4 has an unresolved/ambiguous crossing. In particular, the two
analysis totals do not establish two engine acceptances. Task 8 has concrete
receipt identities to investigate the lap-3 engine rejection and lap-4 result
association without changing the compatibility policy or guessing final labels.
This audit does not assign a root cause or fix either reconciliation outcome.

Replay `infrastructureEligible: true` means a complete loss-free input, not
validated driving semantics. Replay `liveWritesEnabled` and `profileValidated`,
and analysis `recordingEnabled` and `liveValidated`, all remain false.

## Available and missing campaign coverage

Available now: one player-controlled practice identity and connection, six
consecutive raw count increments, unavailable out-lap/invalid-state clocks,
two consecutive telemetry-reported totals, nonzero first post-line samples,
duplicate polling, and raw validity states 0/1/2 with current/previous validity
flags 0/1. The first analysis lap is partial-start. This is enough to start
targeted reconciliation regressions; ordinary totals need no manual transcription.

Not established here: independently confirmed clean/invalid labels and their
driving causes, exact ties or unchanged consecutive result signatures, delayed
final invalidation semantics, deliberately timed early/late cuts, reset/teleport
behavior, bridge restart, HUD reload, session/car/layout transitions, a second
combination/load condition, or actual embedded-browser hotkeys and persistence.
All recorded pause/menu/replay flags are 0, with control type 0; there are no
close/error/reopen events. Those interruption scenarios are missing real coverage,
not passes. States 1/2 alone do not prove the full current-and-next invalidation
scenario. Task 6 remains responsible for missing scenarios and independent checks
needed for eventual profile acceptance.

## Reproduce

Use Node 24. The full original must be available; do not substitute the excerpt.
Choose fresh output directories because the CLIs intentionally refuse overwrite:

```sh
audit_dir=$(mktemp -d /tmp/r3e-baseline-XXXXXX)
npm run replay -- captures/practice-01/f489307d-60e5-4188-9e9b-fce95b169b88 --out "$audit_dir/replay"
npm run analyze:capture -- captures/practice-01/f489307d-60e5-4188-9e9b-fce95b169b88 --out "$audit_dir/analysis"
R3E_FULL_CAPTURE=captures/practice-01/f489307d-60e5-4188-9e9b-fce95b169b88 node --import tsx --test --test-reporter=spec tests/acceptance/full-capture-lap-summaries.test.ts
node --import tsx --test --test-reporter=spec tests/raw-lap-count-analysis.test.ts tests/telemetry-reported-laps.test.ts tests/capture-replay.test.ts tests/capture-analysis.test.ts tests/replay-compatible-telemetry.test.ts tests/telemetry-version-compatibility.test.ts
npm run typecheck
git diff --check
```

The full-capture check verifies source and excerpt checksums, receipt equality,
six automatic native summaries, JSON/HTML/CSV output and unchanged input bytes.
The fixture/replay/analysis checks exercise the incomplete windows and compatible
API 2.8 intake without granting live record authorization.
