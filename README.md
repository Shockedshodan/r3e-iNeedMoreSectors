I am pissed by lack of opt lap and sectors

Development starts with the [project baseline](docs/PROJECT_BASELINE.md) and
[TDD plan](docs/TDD_PLAN.md). With Node 24, run `npm ci`,
`npm run typecheck`, and `npm test`.

The rendered HUD, SealHUD-derived layout controls, configurable hotkey,
build-time module discovery and RaceRoom bridge adapter are implemented.
See [running instructions](docs/RUNNING.md) and [implementation progress](docs/IMPLEMENTATION_PROGRESS.md).

Use `npm start` for development, `npm run serve` for the production-mode server,
and `npm run demo:bridge` for synthetic practice telemetry. Run `npm test`,
`npm run typecheck`, `npm run build` and `npm run test:browser` for validation.

Live record saving remains gated until real RaceRoom telemetry semantics and
embedded-browser behavior are validated; demo data uses isolated storage.
