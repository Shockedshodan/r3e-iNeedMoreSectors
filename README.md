I am pissed by lack of opt lap and sectors

With Node 24, run `npm ci`, `npm run typecheck`, and `npm test`.

The rendered HUD, SealHUD-derived layout controls, configurable hotkey,
build-time module discovery and RaceRoom bridge adapter are implemented.
See the [running instructions](docs/RUNNING.md) for setup and usage.

Use `npm start` for development, `npm run serve` for the production-mode server,
and `npm run demo:bridge` for synthetic practice telemetry. Run `npm test`,
`npm run typecheck`, `npm run build` and `npm run test:browser` for validation.

Live record saving remains gated until real RaceRoom telemetry semantics and
embedded-browser behavior are validated; demo data uses isolated storage.

Capture and replay tooling is available with `npm run capture`, `npm run replay`
and `npm run analyze:capture`. Follow the [Windows live-testing runbook](docs/LIVE_TESTING.md)
to collect real evidence while keeping live record saving disabled.

The [local and hosted setup guide](docs/RUNNING.md#connect-raceroom) explains
the SealHUD-style arrangement: a website plus one telemetry bridge running on
the Windows game PC. The Pages workflow publishes successful `main` builds;
the expected site is `https://shockedshodan.github.io/r3e-iNeedMoreSectors/`,
pending [initial activation and deployment verification](docs/RUNNING.md#publish-the-normal-ui-with-github-pages).
Real-data capture uses the local collector because Pages cannot provide its API.

## Acknowledgements

This HUD builds on work from the following projects:

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

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[LICENSES/SealHUD-MIT.txt](LICENSES/SealHUD-MIT.txt) for preserved upstream
attribution and license notices, including SealHUD's MIT LICENSE/README versus
ISC package metadata discrepancy.
