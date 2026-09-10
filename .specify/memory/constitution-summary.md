# Avicenna — Project Constitution

> Ratified: 2026-09-09 · Version: 1.0.0
> Full canonical text: `.specify/memory/constitution.md`

## P1 — Spec-First, Execution-Backed
Specs live in `specs/NNN-<slug>/spec.md` before code. Every "done" claim requires live-verified tool output. Fabricated results are forbidden.

## P2 — Multi-Runtime Parity (NON-NEGOTIABLE)
Three runtimes ship one contract: TypeScript (`nontonanime.ts`), Go (`nontonanime.go`), Rust (`nontonanime-rs/`). Behavioral changes land in all 3 in the same task. JSON field names + CLI surface stay identical. TypeScript is the reference implementation; ports chase it.

## P3 — Hardened by Default
Every network path: SSRF origin-pinning, private-host blocks, scheme/credential guards, 15s timeout, ≤5 redirects, 3MB cap, backoff retry honoring Retry-After, WAF detection with actionable errors. All inputs sanitized at boundaries.

## P4 — Respect the Target
~350ms serial rate limit + jitter, in-flight dedupe, LRU cache (5min TTL, GET 200 HTML only). Never cache nonce-derived AJAX. Handle site-internal rotation via alias lists.

## P5 — Performance Is a Feature
Cold CLI <600ms/command; language overhead <130ms over network. API warm cache <50ms. Regressions need before/after benchmarks.

## P6 — Test Through the Real Surface
Smoke tests hit the public CLI/API only. Done = builds clean ×3 runtimes + live smoke passes ×3 + JSON shape diff vs TS = empty.

## Governance
- Workflow: `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement` → `/speckit.converge` (repeat 4–6 until Converged).
- New deps require: permissive license, toolchain compat check (go1.27 / rustc 1.75 — pin edition2024-unsafe crates), written justification in spec.
- Amendments: bump version, document rationale in the PR that changes this file.
