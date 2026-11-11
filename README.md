I am pissed by lack of opt lap and sectors

Development starts with the [project baseline](docs/PROJECT_BASELINE.md) and
[TDD plan](docs/TDD_PLAN.md). With Node 24, run `npm ci`,
`npm run typecheck`, and `npm test`.

The rendered HUD, SealHUD-derived layout controls, configurable hotkey,
build-time module discovery and RaceRoom bridge adapter are implemented.
See [running instructions](docs/RUNNING.md) and [implementation progress](docs/IMPLEMENTATION_PROGRESS.md).
New agents should start with the [current handover](docs/NEXT_AGENT_HANDOVER.md).

Use `npm start` for development, `npm run serve` for the production-mode server,
and `npm run demo:bridge` for synthetic practice telemetry. Run `npm test`,
`npm run typecheck`, `npm run build` and `npm run test:browser` for validation.

Live record saving remains gated until real RaceRoom telemetry semantics and
embedded-browser behavior are validated; demo data uses isolated storage.

Capture and replay tooling is available with `npm run capture`, `npm run replay`
and `npm run analyze:capture`. Follow the [Windows live-testing runbook](docs/LIVE_TESTING.md)
to collect real evidence while keeping live record saving disabled.

## Acknowledgements

My water greedy llm agents shamelessly appropriated code from a repositories below, and it's fair to acknowledge that it's not my intellectual property, and I piggibacking on other people effort:

- [SealHUD (`sealhud/sealhud_source`)](https://github.com/sealhud/sealhud_source/tree/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b)
  — the user-pinned reference for the HUD architecture and reuse of
  configuration, widget placement/scaling, layout persistence, transport, and
  sector/delta presentation. Inspection of `r3e.ts`, `app.tsx`, and `progress.tsx`
  informed the design, including converting cumulative native sector times to
  individual durations. The rendered HUD integration is implemented; live
  RaceRoom validation remains outstanding.
- [RaceRoom API (`kwstudios-sweden/r3e-api`)](https://github.com/kwstudios-sweden/r3e-api/tree/e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb)
  — the inspected reference for native shared-memory telemetry fields, layout
  and car model identifiers, lap timing, validity flags, and unavailable-value
  conventions. It informed the timing contracts and validation requirements;
  the adapter now normalizes API-shaped telemetry and has synthetic/browser
  coverage; live validation remains outstanding. This API does not provide the
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
