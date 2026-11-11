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

Browser tests use `/usr/bin/chromium` when available, an executable specified by `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, or Playwright's installed Chromium. If none is installed, run `npx playwright install chromium` (and `npx playwright install-deps chromium` when the operating system lacks its runtime libraries). For Linux browser testing, use Ubuntu 24.04, supported by the locked Playwright 1.56.1. CI pins its test job to `ubuntu-24.04` and requires `npx playwright install --with-deps chromium` before the full browser suite; keep the committed dependency lockfile.

The browser suite includes a smoke check that serves the production `dist/` under `/r3e-iNeedMoreSectors/`, matching the GitHub Pages project path. Run `npm run build` before `npm run test:browser`; to run only this check, use `npx playwright test tests/browser/pages.spec.ts` after building.

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

[SealHUD's pinned setup instructions](https://github.com/sealhud/sealhud_source/blob/d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b/README.md) load the HUD from `https://sealhud.github.io/` through RaceRoom's `-webHudUrl=` option, with CrewChief or `dash.exe` running locally. This HUD follows the same arrangement: the website supplies the interface, and a bridge on the Windows game PC reads RaceRoom telemetry. Hosting the website on GitHub Pages does not move the game or its telemetry bridge to GitHub.

Choose the website address for your purpose:

| Purpose | Website address | What must run on the game PC |
| --- | --- | --- |
| Local normal UI | `http://127.0.0.1:3000/` | HUD server and one native telemetry bridge |
| Hosted normal UI, after Pages activation | `https://shockedshodan.github.io/r3e-iNeedMoreSectors/` | One native telemetry bridge; no local website server |
| Real-data evidence capture | `http://127.0.0.1:3200/?capture=1` | Local capture server and one native telemetry bridge |

For a local normal UI, run these commands in the checkout on Windows, using Node 24 and PowerShell:

```powershell
npm ci
npm run serve
```

Keep that terminal running. In Steam → RaceRoom → Properties → Launch Options, set:

```text
-webHudUrl=http://127.0.0.1:3000/
```

Run exactly one compatible CrewChief or `dash.exe` bridge exposing the SealHUD protocol at `ws://localhost:8070/r3e`; do not run both, and stop `npm run demo:bridge` before using real data. Record the exact bridge build for live testing. The native bridge and RaceRoom are external prerequisites, not installed by `npm ci`.

The app defaults to that bridge. The `ws` query parameter accepts a `host:port` or full `ws://` / `wss://` address, without embedded credentials. A host-only address receives the `/r3e` path. Port 8070 is the native bridge port; port 3000 serves the website.

The current adapter uses field-based compatibility for player-controlled **practice** sessions, including observed API **2.8** input. Version metadata is preserved rather than used as an intake gate. Missing or malformed required timing fields and unsupported sessions are reported specifically. The game and native Windows shared-memory reader are not bundled.

**Live record saving is disabled pending real telemetry validation.** The UI reports this state. Synthetic/browser tests establish implementation behavior, not raw field ordering in the game. Review [TELEMETRY_PROTOCOL.md](TELEMETRY_PROTOCOL.md) before enabling a live-writing path.

On a fresh origin, reference mode starts Off. The Reference button or Alt+T cycles Off → Opt → Best → Off; Edit layout displays placement previews. Connecting to live telemetry does not create saved Best/Opt references while the live-writing gate is disabled, so an empty reference is expected. Actual key delivery and connectivity in RaceRoom's embedded browser require the separate [in-game acceptance procedure](LIVE_TESTING.md).

Preferences and records use browser localStorage. HTTP versus HTTPS, different hosts (`localhost` versus `127.0.0.1`), and different ports have separate origins. Moving from port 3000 to the capture server or Pages therefore starts with separate settings and references. A desktop browser preview also does not prove what RaceRoom's embedded browser stores. Demo storage remains separate from live storage within each origin.

## Publish the normal UI with GitHub Pages

The **Tests and Pages** workflow runs the automated checks on pushes and pull requests. After all checks pass, a push to `main` publishes the tested production `dist/`; Actions → Tests and Pages → Run workflow can also publish when `main` is selected. Pull requests, other branches and manual runs on other refs do not publish. The deployment uses the `github-pages` environment.

[Remote run 43072244561, job 130702903941](https://github.com/Shockedshodan/r3e-iNeedMoreSectors/actions/runs/43072244561/job/130702903941) at revision `9f72a77139eb8981a988d578c8d75f4acb8c9db0` passed dependency installation, typecheck, all 336 unit/component tests and the build, then failed browser installation: `ubuntu-latest` selected Ubuntu 26.04.1, and locked Playwright 1.56.1 reported “Playwright does not support chromium on ubuntu26.04-x64”. The test runner is now pinned to Ubuntu 24.04. Remote verification is still pending: the next authorized run must pass browser installation and the full suite, and verify the published revision. Local validation does not establish remote or deployment success.

For initial activation, a repository administrator must select **Settings → Pages → Build and deployment → Source → GitHub Actions**. After the workflow has been published to the repository, inspect a successful `main` deployment and use its environment URL. The expected address below is **provisional until the first successful deployment**; this guide does not establish that the site is already online:

```text
-webHudUrl=https://shockedshodan.github.io/r3e-iNeedMoreSectors/
```

Verify the deployed revision, open the HUD, and check that `app.js` and `THIRD_PARTY_NOTICES.txt` load below the same project path. Normal hosted use still requires the local bridge and the current API/session scope described above. Test the HTTPS page's connection to the local bridge in RaceRoom itself; success in a desktop preview or the Pages asset check does not establish embedded-browser support. Use the local HTTP URL for diagnosis if the embedded browser rejects the connection, and retain the observed error for acceptance work.

GitHub Pages serves static files. It cannot provide `/api/capture/...`, and adding `capture=1` to the Pages address does not make recording available. Use the local capture server for evidence collection.

## Capture and evaluate real telemetry

On the Windows game PC, build and start the collector in PowerShell:

```powershell
npm run build
npm run capture -- --out captures/practice-01 --port 3200
```

Keep the collector running and use this RaceRoom launch option:

```text
-webHudUrl=http://127.0.0.1:3200/?capture=1
```

Do not add `demo=1` for real data. This local diagnostic page records the existing telemetry socket into a projected JSONL file and checksum manifest without enabling live lap-record writes. Stop capture and wait for **Saved** before reloading/exiting the HUD or stopping the collector.

Run `npm run replay -- <capture-directory> --out <new-report-directory>` and `npm run analyze:capture -- <capture-directory> --out <new-analysis-directory>` after stopping the capture. The full [Windows live-testing runbook](LIVE_TESTING.md) covers game setup, independent labels, deliberate invalid/interrupted laps, report interpretation and the evidence required before enabling a supported profile.

Analysis automatically extracts ordinary lap times and telemetry-reported validity from captured API values, without manual time entry or annotations. The terminal and JSON/HTML/CSV reports include every observed count crossing, available totals, unavailable totals, ambiguous associations, identity and receipt provenance. For the existing multi-lap recording, run:

```sh
npm run analyze:capture -- captures/practice-01/f489307d-60e5-4188-9e9b-fce95b169b88 --out reports/practice-01-laps
```

Screen/video annotations are optional independent checks for disputed protocol semantics and final profile acceptance. Automatic telemetry reports are not an independent oracle and do not authorize live writes. Live saving remains disabled pending separate confirmed profile authorization.

## Troubleshoot by connection layer

| Symptom | Check |
| --- | --- |
| Page does not load | For local use, keep the website/collector terminal running and match its port to the launch option. For Pages, inspect the deployment and preserve the trailing project-path slash. |
| Page loads but waits for telemetry | Start exactly one real CrewChief/dash bridge, check port 8070 for another service, stop the synthetic bridge, and verify any `ws=` override. Localhost refers to the machine running the HUD browser. |
| Unsupported telemetry or session | Inspect the reported missing/malformed timing fields or session error, confirm player-controlled practice and record the exact chosen bridge build. See [field-based compatibility](TELEMETRY_PROTOCOL.md); no version upgrade or manual approval is needed for compatible input. |
| Empty sectors or delta | Check Off mode and visibility first. Live saving is currently disabled, so no new live Best/Opt reference is expected; use Edit layout for previews or the isolated synthetic demo for rendered timing. |
| Capture start/save fails | Use the collector's local port-3200 page, not Pages or the normal port-3000 server. Inspect the collector terminal and output-directory permissions; incomplete captures do not qualify as evidence. |
| Settings appear reset | Check the URL's scheme, host and port, demo versus live mode, and whether this is the same browser/runtime. Storage is not shared between origins. |

## Add a module

Add `src/modules/<name>/module.ts`, export `createModule(services)` returning a `HudModule`, then rebuild. Webpack recursively discovers descriptors; the host, generic widget renderer and layout settings require no hardcoded entry for the new module. Widget IDs must be unique, and defaults must include finite positions, scale in `0.1..3` and enabled state. Dispose subscriptions and other resources in the module's disposer. See `src/modules/timing/module.ts` and the discovery tests for examples.

Upstream SealHUD provenance and its full MIT grant are preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `LICENSES/SealHUD-MIT.txt`, and are included with production build assets.
