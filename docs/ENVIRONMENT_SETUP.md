# Historical cloud onboarding validation

Validated on 2026-11-11. Read `PROJECT_BASELINE.md` for the user-supplied requirements and architecture handoff.

This report describes the initial onboarding validation. Subsequent TDD work implemented the timing core, rendered HUD and bridge adapter; use [RUNNING.md](RUNNING.md) for current application installation, startup and browser testing, and [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) for results. The original RED checkpoint remains in [TDD_RESULTS.md](TDD_RESULTS.md). The older proposed environment configuration file does not include the current application setup, and its platform save remains unconfirmed. This historical report does not establish publication of the current app environment.

## Prepared workflow

At onboarding, the application repository contained only a README. The initial validation inspected the RaceRoom API and built the pinned SealHUD reference without changing its tracked files; it did not validate the application implemented later.

| Checkout | Inspected commit |
| --- | --- |
| `/workspace/r3e-iNeedMoreSectors` | `e6397e00f07709f906bbdaec09938a96df1c08c3` |
| `/workspace/references/sealhud_source` | `d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b` (user pin) |
| `/workspace/references/r3e-api` | `e57a72fcafd74fcb1b0e7b5ca38a1a0aa59d74cb` (inspected revision) |

Existing Node.js v24.22.1, npm 11.9.0, Python Playwright, and `/usr/bin/chromium` were usable. No system packages or credentials were added. GitHub access worked through the existing configuration. Locked npm dependencies installed from `registry.npmjs.org` with integrity and TLS verification preserved. No network policy changes were needed for these operations.

## Current setup

Run the repository-owned commands in [RUNNING.md](RUNNING.md) from the actual checkout root. The onboarding installation, reference-server and smoke helpers lived outside the repository and are not a supported setup path. Their upstream bootstrap check used disposable browser storage and Chrome 64 detection; it did not emulate telemetry or validate RaceRoom's embedded browser.

## Validation evidence

| Check | Outcome |
| --- | --- |
| Frozen dependency installation (`npm ci`) | Passed; 605 packages |
| TypeScript (`./node_modules/.bin/tsc --noEmit`) | Passed |
| Production build (`npm run build`) | Passed; 3 bundle/performance size warnings |
| Development server compilation | Passed |
| Browser bootstrap and expected missing-feed rendering | Passed; HTTP 200, no uncaught page errors |
| Placement and zoom storage survive reload | Passed in disposable Chromium context |
| Timer engine / Best and Opt records / delta | Unrun at onboarding: implementation did not yet exist |
| Live RaceRoom behavior | Unrun: Windows game and bridge are not available here |

At onboarding, no existing automated test suite was found in the selected application or pinned HUD reference. The browser smoke demonstrates upstream bootstrap and browser preference persistence; it does not validate timing correctness. The onboarding checks left original tracked files and lockfiles unchanged. Only the requested baseline and this setup documentation were added to the application checkout; ignored dependencies and build outputs belong to the reference checkout.

## Live validation still required

The RaceRoom API samples depend on native Windows shared memory (`$R3E`) and a running game. SealHUD expects a separate bridge at `ws://localhost:8070/r3e`, configurable with `?ws=host:port`. Development may also attempt CSS-reload and CrewChief connections on port 8071. Those connections are not needed for the offline bootstrap check.

Before enabling timer record writes, validate finish-field update ordering and final validity, continuity limits and finish timeout, key delivery while driving, embedded-browser connectivity and persistence, and custom-reference delta accuracy. The supplied handoff explains these gates. Current cloud results do not satisfy them.

## Configuration persistence blocker

The environment configuration draft could not be read: `INVALID_ARGUMENT`, “The current environment draft could not be verified.” Retrying the read did not resolve it. An attempt to save complete `install_script`, `start_skill`, and all three inspected repository entries also returned `INVALID_ARGUMENT`: “Setup could not be completed; saving the draft could not be confirmed.” Draft persistence is therefore unconfirmed; nothing has been published or validated in a fresh task.

The proposed configuration and helper files were local onboarding artifacts outside this repository. Their availability is not guaranteed. Local build/test success does not establish a saved or published reusable platform environment; that requires a confirmed configuration save and fresh-task validation.
