# Original RED baseline results

This historical report records the tests-first commit `826e507`. The current implementation has moved to GREEN; see [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md).

Executed on 2026-11-11 in `/workspace/r3e-iNeedMoreSectors`, with Node v24.22.1 and npm 11.9.0.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --cache /workspace/.cache/npm --no-audit --no-fund` | 0 | Frozen installation succeeded; 3 development packages including the transitive Node types dependency |
| `npm run typecheck` | 0 | Source contracts, fixtures, and all test files type-check |
| `npm test` | 1 | 123 tests executed, 0 passed, 123 failed, 0 skipped, 0 cancelled, 0 TODO |

The failures are intentional: every behavior reaches a named `Not implemented: …` source seam, or an assertion rejects that placeholder instead of the required result/error. There are no missing-module, loader, or syntax failures. No feature implementation was added to turn the tests green.

| Test file | Executed / RED |
| --- | --- |
| `curves.test.ts` | 28 |
| `module-host.test.ts` | 10 |
| `records.test.ts` | 23 |
| `reference-control.test.ts` | 20 |
| `sector-definition.test.ts` | 10 |
| `timing-engine.test.ts` | 26 |
| `timing-feature.test.ts` | 6 |
| **Total** | **123** |

The last full runner output is retained locally at `.test-results/red.log` (ignored by Git). Test logs are not portable evidence of a future run; use [RUNNING.md](RUNNING.md) to verify the current implementation. The default test command preserves its nonzero exit status. No expected-failure or skip mechanism is used.

Review also checked the nonlinear timing arithmetic, the verbatim handoff, and the distinction between synthetic normalized finish associations and unproven native field order. The upstream SealHUD and RaceRoom API checkouts remain unchanged.

See [TDD_PLAN.md](TDD_PLAN.md) for the audit, proposed contracts, implementation order, and subsequent browser integration and outstanding live acceptance. At this original checkpoint the whole suite was intentionally RED; that checkpoint has now been superseded by the green implementation report. This historical report does not assert coverage percentages or validated application behavior.
