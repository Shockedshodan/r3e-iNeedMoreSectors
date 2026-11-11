# Cloud development setup

Validated on 2026-11-11. Read `PROJECT_BASELINE.md` for the user-supplied requirements and architecture handoff.

This report describes the initial onboarding validation. Subsequent TDD work implemented the timing core, rendered HUD and bridge adapter; use [RUNNING.md](RUNNING.md) for current application installation, startup and browser testing, and [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) for results. The original RED checkpoint remains in [TDD_RESULTS.md](TDD_RESULTS.md). The older proposed environment configuration file does not include the current application setup, and its platform save remains unconfirmed. This historical report does not establish publication of the current app environment.

## Prepared workflow

The selected application repository initially contains only a README. No timer implementation, package manifest, test suite, or application server exists yet. The cloud machine is prepared to inspect the RaceRoom API and build and develop the pinned SealHUD reference without changing its tracked files.

| Checkout | Inspected commit |
| --- | --- |
| `/workspace/r3e-iNeedMoreSectors` | `e6397e00f07709f906bbdaec09938a96df1c08c3` |
| `/workspace/references/sealhud_source` | `d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b` (user pin) |
| `/workspace/references/r3e-api` | `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb` (inspected revision) |

Existing Node.js v24.22.1, npm 11.9.0, Python Playwright, and `/usr/bin/chromium` were usable. No system packages or credentials were added. GitHub access worked through the existing configuration. Locked npm dependencies installed from `registry.npmjs.org` with integrity and TLS verification preserved. No network policy changes were needed for these operations.

## Repeatable installation and startup

Use the existing isolated checkout; do not create a Git worktree unless explicitly requested. The helper files below are stored outside application and upstream source trees.

Install/refresh dependencies and validate the pinned HUD:

```sh
bash /workspace/environment-setup/install.sh
```

This checks the SealHUD commit, runs `npm ci` using `/workspace/.cache/npm`, runs TypeScript with `--noEmit`, and builds production assets using the committed Webpack configuration. Stop only a development server started for this task before reinstalling dependencies; reuse existing valid dependencies when no refresh is needed. The script was executed successfully after its individual commands passed, establishing repeatability in this instance.

Start the reference development server in a managed command session:

```sh
bash /workspace/environment-setup/start-sealhud.sh
```

Its working directory is `/workspace/references/sealhud_source` and its command is `npm start -- --no-open --host 127.0.0.1`. Wait for Webpack compilation to complete, then run the internal browser check:

```sh
python3 /workspace/environment-setup/smoke-sealhud.py
```

The smoke check requests the local server internally; no user-facing loopback preview is required. It uses disposable browser storage and emulates upstream's Chrome 64 detection to exercise the missing-feed UI. It does not emulate telemetry or validate RaceRoom's embedded browser. An ordinary current browser without telemetry displays an empty HUD, as expected by upstream rendering guards. Build output is retained in ignored `dist/`; development assets are served from memory. Dependencies persist on disk, but server/browser processes need restarting in future tasks.

## Validation evidence

| Check | Outcome |
| --- | --- |
| Frozen dependency installation (`npm ci`) | Passed; 605 packages |
| TypeScript (`./node_modules/.bin/tsc --noEmit`) | Passed |
| Production build (`npm run build`) | Passed; 3 bundle/performance size warnings |
| Development server compilation | Passed |
| Browser bootstrap and expected missing-feed rendering | Passed; HTTP 200, no uncaught page errors |
| Placement and zoom storage survive reload | Passed in disposable Chromium context |
| Timer engine / Best and Opt records / delta | Unrun: implementation does not exist |
| Live RaceRoom behavior | Unrun: Windows game and bridge are not available here |

No existing automated test suite was found in the selected application or pinned HUD reference. The browser smoke demonstrates upstream bootstrap and browser preference persistence; it does not validate timing correctness. All original tracked files and lockfiles remain unchanged. Only the requested baseline and this setup documentation were added to the application checkout; ignored dependencies and build outputs belong to the reference checkout.

## Live validation still required

The RaceRoom API samples depend on native Windows shared memory (`$R3E`) and a running game. SealHUD expects a separate bridge at `ws://localhost:8070/r3e`, configurable with `?ws=host:port`. Development may also attempt CSS-reload and CrewChief connections on port 8071. Those connections are not needed for the offline bootstrap check.

Before enabling timer record writes, validate finish-field update ordering and final validity, continuity limits and finish timeout, key delivery while driving, embedded-browser connectivity and persistence, and custom-reference delta accuracy. The supplied handoff explains these gates. Current cloud results do not satisfy them.

## Configuration persistence blocker

The environment configuration draft could not be read: `INVALID_ARGUMENT`, “The current environment draft could not be verified.” Retrying the read did not resolve it. An attempt to save complete `install_script`, `start_skill`, and all three inspected repository entries also returned `INVALID_ARGUMENT`: “Setup could not be completed; saving the draft could not be confirmed.” Draft persistence is therefore unconfirmed; nothing has been published or validated in a fresh task.

The complete intended fields are retained at `/workspace/environment-setup/proposed-environment-config.json`, with startup instructions in `/workspace/environment-setup/START.md`. The current machine's verified toolchain is usable, but reusable environment setup remains incomplete until the draft-saving service is available and the configuration can be saved, reviewed in environment settings, and published. Do not treat these local files as proof of a successful platform save.
