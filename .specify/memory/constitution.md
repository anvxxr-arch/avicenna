# Avicenna Constitution

## Core Principles

### I. Spec-First, Execution-Backed
Every feature starts as a spec in `specs/NNN-<slug>/spec.md` BEFORE code. No code without an approved spec. No claim of "done" without live-verified tool output — fabricated results are forbidden. Results, not intentions.

### II. Multi-Runtime Parity (NON-NEGOTIABLE)
The scraper contract exists in 3 runtimes: TypeScript (`nontonanime.ts`), Go (`nontonanime.go`), Rust (`nontonanime-rs/`). Any behavioral change lands in all 3 in the same task. Output JSON field names and CLI command surface MUST stay byte-identical across runtimes. One runtime drifting = bug.

### III. Hardened by Default
Every network path enforces: SSRF origin-pinning (site fetches only from BASE host; embeds validated), private-host blocking, URL scheme/credential guards, 15s timeout, max 5 redirects, 3MB body cap, retry with backoff on 429/5xx honoring Retry-After, Cloudflare WAF detection with actionable errors. Input sanitization at every boundary: page 1–50, slug `^[a-z0-9-]+$`, query 2–100 chars, season whitelist. No exceptions, no "just this once".

### IV. Respect the Target
Serial rate limiting (~350ms + jitter) on all site requests. In-flight dedupe + LRU cache (5min TTL). Cache only GET HTML 200s; never cache nonce-derived AJAX (player_ajax, loadmore) responses. Identify as a real browser; handle rotation of site internals (beacon var names, DOM changes) via alias lists, not hardcoded assumptions.

### V. Performance Is a Feature
Cold CLI: sub-600ms per command. Language overhead target: <130ms on top of network. API mode: warm cache hits <50ms. Regression = benchmark before/after in the same PR. The fastest correct implementation wins; the fastest wrong one gets deleted.

### VI. Test Through the Real Surface
Smoke tests hit the live site through the public CLI/API surface only — never poke internals. A feature is done when: tsc/go build/cargo build clean AND live smoke passes on all 3 runtimes AND output matches the TS reference shape.

## Additional Constraints

- TypeScript is the reference implementation. Go and Rust ports chase it; when in doubt, TS behavior wins and ports get patched.
- No new runtime deps without: license check (permissive only), MSRV/Go-version check against installed toolchains (go1.27, rustc 1.75 — pin edition2024-unsafe crates), and a written reason in the spec.
- Secrets, nonces, session data: never logged, never cached, never committed.
- Error messages are actionable: name the cause and the workaround (e.g. WAF message names the filter-combo trigger and the genre-page fallback).

## Development Workflow

1. `/speckit.specify` → spec with measurable acceptance criteria
2. `/speckit.clarify` → kill ambiguity before planning
3. `/speckit.plan` → runtime-by-runtime implementation notes
4. `/speckit.tasks` → parity-checked task list (TS+Go+Rust land together)
5. `/speckit.implement` → code + build + live smoke per runtime
6. `/speckit.converge` → repeat until Converged; all 3 runtimes verified

Quality gates before merge: lint clean, build clean ×3, live smoke ×3 runtimes, JSON shape diff vs TS reference = empty.
