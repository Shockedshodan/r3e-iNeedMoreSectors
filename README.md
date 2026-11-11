I am pissed by lack of opt lap and sectors

Development starts with the [project baseline](docs/PROJECT_BASELINE.md) and
[TDD plan](docs/TDD_PLAN.md). With Node 24, run `npm ci`,
`npm run typecheck`, and `npm test`.

The timing core and headless module integration are implemented; all 160 tests
pass. See [implementation progress](docs/IMPLEMENTATION_PROGRESS.md) for the
completed TDD steps and the remaining SealHUD UI and live-bridge work.

## Acknowledgements

Thank you to the authors and contributors of these upstream repositories:

- [SealHUD (`sealhud/sealhud_source`)](https://github.com/sealhud/sealhud_source/tree/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b)
  — the user-pinned reference for the HUD architecture and planned reuse of
  configuration, widget placement/scaling, layout persistence, transport, and
  sector/delta presentation. Inspection of `r3e.ts`, `app.tsx`, and `progress.tsx`
  informed the design, including converting cumulative native sector times to
  individual durations. The rendered SealHUD UI integration remains future work.
- [RaceRoom API (`kwstudios-sweden/r3e-api`)](https://github.com/kwstudios-sweden/r3e-api/tree/e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb)
  — the inspected reference for native shared-memory telemetry fields, layout
  and car model identifiers, lap timing, validity flags, and unavailable-value
  conventions. It informed the timing contracts and validation requirements;
  the current engine consumes synthetic normalized telemetry, and the native
  adapter and live validation remain future work. This API does not provide the
  WebSocket bridge expected by SealHUD.

The [project baseline](docs/PROJECT_BASELINE.md) records these sources, inspected
revisions, and the original architecture handoff; the
[test-first plan](docs/TDD_PLAN.md) explains how they informed the contracts.
The baseline also records SealHUD's MIT `LICENSE`/README versus ISC
`package.json` metadata discrepancy. Preserve upstream attribution and license
notices when reusing source, and resolve that discrepancy before redistribution.

For development tooling, [Beads (`gastownhall/beads`)](https://github.com/gastownhall/beads)
provides the issue tracker and repository agent-workflow guidance recorded in
[AGENTS.md](AGENTS.md).
