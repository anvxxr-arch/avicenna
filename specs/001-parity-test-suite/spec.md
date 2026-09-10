# Feature Specification: Cross-Runtime Parity Test Suite

**Feature Branch**: `001-parity-test-suite`

**Created**: 2026-09-09

**Status**: Draft

**Input**: User description: "Automated parity test suite proving nontonanime.ts, nontonanime.go, and nontonanime-rs produce identical behavior — command surface, JSON shapes, guard behavior, and live-site results."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One-shot parity verification (Priority: P1)

A developer (or CI) runs a single command, `bun run parity`, and receives a pass/fail report comparing all 3 runtimes. Every CLI command in the shared surface (home, latest, recent, search, advsearch, list, anime, episode, stream, servers, resolve, nav, meta, genres, genre, ongoing, popular, schedule, top, season, more) executes on all 3 binaries with identical arguments, and their JSON outputs are normalized and compared field-by-field.

**Why this priority**: Without automated parity proof, the 3-runtime contract (Constitution §II) rots silently on every site layout change. This is the single highest-value guard.

**Independent Test**: Run `bun run parity` after intentionally renaming one JSON field in the Go port → the report must FAIL naming the command, runtime, and field. Fix → rerun → PASS.

**Acceptance Scenarios**:

1. **Given** all 3 binaries built, **When** `bun run parity` runs, **Then** every command returns PASS with a shape-diff of zero, and total wall time is under 10 minutes.
2. **Given** one runtime returns a structurally different JSON (missing/renamed/extra field), **When** parity runs, **Then** the specific command, runtime, field path, and both values are printed, and exit code is 1.
3. **Given** the live site is unreachable, **When** parity runs, **Then** it fails gracefully with a single clear network error, not per-command noise.

---

### User Story 2 - Guard contract verification (Priority: P2)

The suite verifies security guard behavior is identical across runtimes: traversal slug rejection, bad season rejection, short query rejection, evil-host rejection, SSRF private-host blocking. These tests are offline-safe (no live site needed).

**Why this priority**: Guards protect users and the target site; drift here is a security bug, not a cosmetic one.

**Independent Test**: Run `bun run parity:guards` in an airplane (no network) → all guard cases still execute and report.

**Acceptance Scenarios**:

1. **Given** no network, **When** guard tests run, **Then** each runtime rejects the same 8 malicious inputs with equivalent error semantics (exit 1 + non-empty stderr).
2. **Given** a runtime accepts an input the TS reference rejects, **When** guard tests run, **Then** FAIL names the input and the runtime.

---

### User Story 3 - CI-ready exit semantics (Priority: P3)

`bun run parity` exits 0 on full pass, 1 on any mismatch, 2 on environment failure (missing binary, no network for live suites). Machine-readable report at `specs/001-parity-test-suite/parity-report.json` (command × runtime × status × duration).

**Why this priority**: Enables wiring into cron/CI later; not blocking daily development.

**Independent Test**: Temporarily move one binary away → exit code 2 with "environment failure" message.

**Acceptance Scenarios**:

1. **Given** a missing binary, **When** parity runs, **Then** exit 2 within 2 seconds and no live-site traffic is sent.
2. **Given** a full pass, **When** parity runs, **Then** `parity-report.json` exists with 3 runtime entries per command and `"status": "pass"` for all.

---

### Edge Cases

- Live-site WAF challenge mid-suite → retry once per command, then mark that command × runtime as `skip-waf` (not fail) and continue.
- Non-deterministic fields (nonces, timestamps, rotating beacon var names) → excluded from deep-equal via explicit ignore-list (`postId` allowed to differ if structure matches; `nonce` compared by format regex only).
- Site layout change making a command return empty on ALL runtimes → reported as `empty-consistent` (pass with warning), not a parity failure.

## Requirements *(mandatory)*

- The suite is a single TypeScript script (`tools/parity.ts`) runnable via Bun; it shells out to the 3 binaries/entries with identical args.
- Deep JSON comparison ignores field order; arrays compare order-sensitively (scraper output order is meaningful).
- Every command's argument template lives in one table at the top of the file — adding a new CLI command = adding one row.
- Report artifacts land under `specs/001-parity-test-suite/`.
- Guard tests must be runnable offline; live tests must be runnable with `--live` flag (default on when network present).

## Review & Acceptance Checklist

- [ ] All 21 CLI commands covered with identical args across runtimes
- [ ] JSON deep-equal has explicit, documented ignore-list for volatile fields
- [ ] Guard suite runs offline
- [ ] Exit codes 0/1/2 implemented per story 3
- [ ] Report JSON written on every run
- [ ] Suite completes < 10 min on residential connection
