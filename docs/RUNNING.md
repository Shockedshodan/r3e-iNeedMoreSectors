# Running the HUD

Use Node 24 (the checked version is in `.nvmrc`). Install from the committed lockfile:

```sh
npm ci
```

## Develop and test

```sh
npm start
npm run typecheck
npm test
npm run build
npm run test:browser
```

`npm start` serves the app on port 3000 with Webpack development reload. `npm run build` generates the standalone `dist/` website. `npm run serve` serves a production build on port 3000 without a development WebSocket client or hot reload. Override the server port with `-- --port 3200` if another project uses 3000. The browser test server uses port 3100.

Browser tests use `/usr/bin/chromium` when available, an executable specified by `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, or Playwright's installed Chromium. If none is installed, run `npx playwright install chromium` (and `npx playwright install-deps chromium` when the operating system lacks its runtime libraries). CI installs the browser and dependencies explicitly.

## Try synthetic practice telemetry without the game

Run `npm run demo:bridge` in a second terminal. It serves raw API-shaped synthetic practice telemetry on local port 8070. Use the HUD page with query parameters `demo=1&ws=127.0.0.1:8070`. For example, on your own machine the production server can be opened at `http://127.0.0.1:3000/?demo=1&ws=127.0.0.1:8070`. This is a local development address, not a hosted cloud preview.

The demonstration accelerates lap progression while supplying plausible lap clocks and six custom sectors. Joining mid-lap intentionally does not create a record; let a complete lap finish. Both widgets start Off. Use the Reference button or Alt+T to cycle Off → Opt → Best → Off. Demo records and preferences use separate storage from live mode. Do not pass real driving data through demo mode to bypass the live-writing gate.

## Configure widgets and keys

- Settings controls visibility, hotkey binding and three layout profiles.
- Focus the Hotkey field and press a new combination. Input typing and held-key repeats do not cycle the reference.
- Edit layout shows honest placement previews, including hidden widgets. Drag with the left mouse button; scroll to scale. Shift increases the scaling step.
- Lock layout disables placement and scaling without disabling reference cycling.
- Position, scale, visibility, active profile, lock, selected reference and binding survive reload. Layout editing itself is session-only.
- Off and hidden widgets continue background collection. Best is one captured complete lap; Opt combines independently fastest valid sectors. Both widgets use the same lap-start reference snapshot.

## Connect RaceRoom

Run the HUD server on the game machine or host the built `dist/` website where RaceRoom can reach it. Set RaceRoom's `-webHudUrl=` launch option to that HUD page. Run one compatible CrewChief/dash bridge exposing the SealHUD protocol at `ws://localhost:8070/r3e`.

The app defaults to that bridge. The `ws` query parameter accepts a `host:port` or full `ws://` / `wss://` address, without embedded credentials. A host-only address receives the `/r3e` path. Port 8070 is the native bridge port; port 3000 serves the website.

The current adapter supports API **3.6**, player-controlled **practice** sessions. Unsupported versions and modes are reported rather than guessed. The game and native Windows shared-memory reader are not bundled.

**Live record saving is disabled pending real telemetry validation.** The UI reports this state. Synthetic/browser tests establish implementation behavior, not raw field ordering in the game. Review [TELEMETRY_PROTOCOL.md](TELEMETRY_PROTOCOL.md) before enabling a live-writing path.

## Capture and evaluate real telemetry

After building, run `npm run capture -- --out captures/practice-01 --port 3200` and use its diagnostic HUD page with `capture=1`. This captures the existing socket into a projected JSONL file and checksum manifest without enabling live lap-record writes.

Run `npm run replay -- <capture-directory> --out <new-report-directory>` and `npm run analyze:capture -- <capture-directory> --out <new-analysis-directory>` after stopping the capture. The full [Windows live-testing runbook](LIVE_TESTING.md) covers game setup, independent labels, deliberate invalid/interrupted laps, report interpretation and the evidence required before enabling a supported profile.

## Add a module

Add `src/modules/<name>/module.ts`, export `createModule(services)` returning a `HudModule`, then rebuild. Webpack recursively discovers descriptors; the host, generic widget renderer and layout settings require no hardcoded entry for the new module. Widget IDs must be unique, and defaults must include finite positions, scale in `0.1..3` and enabled state. Dispose subscriptions and other resources in the module's disposer. See `src/modules/timing/module.ts` and the discovery tests for examples.

Upstream SealHUD provenance and its full MIT grant are preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `LICENSES/SealHUD-MIT.txt`, and are included with production build assets.
