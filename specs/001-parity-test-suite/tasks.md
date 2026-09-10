# Tasks: Cross-Runtime Parity Test Suite

**Branch**: `001-parity-test-suite` · **Plan**: [plan.md](./plan.md) · **Status**: ✅ CONVERGED

## Phase 1 — Skeleton (offline-safe)

- [x] 1.1 Create `tools/parity.ts` with RUNTIMES table, binary discovery (env override → default paths), exit-2 on missing binary
- [x] 1.2 Implement GUARDS table (8 offline cases) + guard runner: spawn, exit-1+stderr check, no network
- [x] 1.3 Implement normalize() + deepEqual() with volatile-field policy (nonce/postId/resolve-embed)
- [x] 1.4 Implement report writer (console table + parity-report.json) and exit codes 0/1/2
- [x] 1.5 Wire package.json scripts (parity / parity:guards / parity:report)

## Phase 2 — Live suite

- [x] 2.1 Implement CASES table: all 21 commands with identical args + `--live` gate
- [x] 2.2 runCase(): 60s timeout, WAF single-retry → `skip-waf`, empty-on-all → `empty-consistent`
- [x] 2.3 Wire go build refresh check (source mtime > binary mtime → rebuild)

## Phase 3 — Verification

- [x] 3.1 Offline run: `bun run parity:guards` → 16/16 PASS, exit 0, report written
- [x] 3.2 Negative test: missing Go binary → exit 2, no live traffic
- [x] 3.3 Live run: 21 commands × 3 runtimes → initially 10 shape-diffs, all root-caused and fixed:
  - **UTF-16 truncation**: JS `.slice(n)` counts UTF-16 code units; Go/Rust truncated by bytes → `txt()` rewritten in both to UTF-16-length walks (Cyrillic/Lithuanian chars in synopses exposed it)
  - **NaN sort**: TS `parseFloat(x) || 0` coerces missing ratings to 0; Go `parseNum` returned NaN → broken `SliceStable` comparator (Steel Ball Run 9.1 stranded at idx 51). Added `parseNumOr0`.
- [x] 3.4 Converge check: 2 consecutive live runs → **79 pass · 0 fail · 0 skip-waf** both times (~62s). Deterministic.

## Artifacts

- `tools/parity.ts` — the suite
- `specs/001-parity-test-suite/parity-report.json` — machine-readable, written every run
