# Feature Specification: Scraper Unification — 14 Legacy Scrapers → Core Framework

**Feature Branch**: `003-scraper-unification`

**Created**: 2026-09-10

**Status**: Draft

**Input**: User description: "Update 14 legacy scraper scripts (anilist, animeindo, codeengo, m.youtube.com, music.youtube.com, open.spotify.com, otakudesu, sakana, whitehouse.gov, drowify-music, freeconvert, tiktok, lk21official, view-page-source) onto the hardened nontonanime core (fetchPage/limiter/cache/guards), keeping every existing feature. Spec the migration."

## Current State (audited)

| file | LOC | module | style | deps beyond core |
|---|---|---|---|---|
| otakudesu.js | 697 | CJS | CLI (own limiter/UA-rotation) | axios, cheerio |
| open.spotify.com.js | 630 | script | CLI (internal API, tokens) | none visible |
| animeindo.js | 612 | CJS | CLI (own limiter/UA-rotation) | axios, cheerio |
| music.youtube.com.js | 582 | script | CLI (youtubei internal API) | none |
| m.youtube.com.js | 472 | script | CLI | none |
| whitehouse.gov.js | 334 | script | CLI | none |
| sakana.js | 332 | CJS | CLI (crypto/form uploads) | crypto, form-data |
| www.tiktok.com.js | 298 | script | CLI (cookie-grab) | none |
| anilist.js | 275 | ESM | bot-handler (default export) | axios, node-fetch, cheerio |
| www.tv12.lk21official.cc.js | 264 | script | CLI | none |
| www.drowify-music.biz.id.js | 117 | script | CLI | none |
| www.freeconvert.comvideo-compressor.js | 100 | CJS | CLI | none |
| codeengo.js | 103 | script | CLI | none |
| www.view-page-source.com.js | 63 | script | lib (no CLI) | none |

Common pathologies: 3 different module systems (CJS/ESM/loose script), 4 hand-rolled retry/limiter implementations, UA rotation duplicated 5×, no SSRF guards, no body caps, no cache, no in-flight dedupe, inconsistent error output (`console.log` mixing with results), CLI surfaces ad-hoc.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Core framework extracted as reusable module (Priority: P1)

`core/` package extracted from nontonanime.ts: `core/fetch.ts` (fetchPage, postAjax, doFetch, guards, limiter, cache — configurable per-site BASE/headers/TTL), `core/cli.ts` (shared CLI runner: arg parse, command table, JSON out, [ERROR]→stderr exit 1), `core/parse.ts` (txt/num/firstText/sliceBalanced/extractPageVar equivalents). `nontonanime.ts` refactored to import from `core/` — zero behavior change, proven by `bun run parity` staying 79/0.

**Why this priority**: Everything else migrates onto this module; it must exist first and nontonanime must prove the refactor is regression-free.

**Independent Test**: `bun run parity` after refactor → identical 79/0 result. Import graph: `grep -r "from './core" *.ts` shows nontonanime.ts uses core/.

**Acceptance Scenarios**:

1. **Given** the refactor, **When** parity suite runs, **Then** 79 pass / 0 fail (byte-identical behavior).
2. **Given** core/fetch.ts, **When** a consumer sets `new Site({base, ttl, rateMs})`, **Then** it gets isolated limiter+cache+guards without touching nontonanime's globals.

---

### User Story 2 — Uniform scraper shell (Priority: P2)

Each of the 14 scrapers becomes `<name>.ts` (or stays .js only if zero-change) with: ESM imports from `core/`, site-specific config object (BASE, headers, TTL, rateMs), all original feature functions preserved (same names, same JSON output shapes), uniform CLI via `core/cli.ts` (help text listing commands, `[ERROR]` stderr, exit 1). Anilist keeps its `export default handler` bot-handler shape AND gains a CLI via the shared runner.

**Why this priority**: This is the actual payload of the migration — feature parity per scraper with shared hardening.

**Independent Test**: For each migrated scraper: `bun <name>.ts help` lists its commands; a representative command per scraper returns JSON with the same keys as the legacy version (golden-file comparison captured during migration).

**Acceptance Scenarios**:

1. **Given** legacy `node otakudesu.js search "one piece"`, **When** migrated `bun otakudesu.ts search "one piece"` runs, **Then** same JSON keys, same result count semantics, plus `[ERROR]`/exit-1 on failures.
2. **Given** any migrated scraper, **When** two identical commands run back-to-back, **Then** second is served from cache (<50ms for cacheable routes).
3. **Given** SSRF-relevant scrapers (lk21, drowify — follow off-site links), **When** a private-host URL appears, **Then** it is rejected by core guards.

---

### User Story 3 — Deps consolidation & hygiene (Priority: P3)

- axios/node-fetch/form-data eliminated (core fetch + Bun FormData); crypto stays (node stdlib).
- Single package.json, `"type": "module"`; CJS files converted.
- Dead `console.log` demo code removed from library paths (kept behind CLI commands only).
- All 14 scrapers listed in `package.json` scripts or a single `bun run <name> -- <cmd>` convention.
- Legacy `.js` originals preserved under `legacy/` (git mv) for diff reference, deleted from root.

**Why this priority**: Cleanup that prevents regression of the codebase into 4 module systems again.

**Independent Test**: `grep -r "require(" *.js *.ts` at root → zero hits; `bun test`-style smoke per scraper passes; root contains only .ts entry points.

**Acceptance Scenarios**:

1. **Given** migration complete, **When** `bun install` runs, **Then** dependency list contains only cheerio (dom parsing) + devDeps.
2. **Given** legacy/ dir, **When** someone needs old behavior, **Then** originals are findable and untouched.

---

### Edge Cases

- Scrapers with internal/private APIs (spotify, youtube music, tiktok): token/cookie flows keep working — core must allow per-request extra headers and POST bodies (already supported by postAjax).
- sakana's crypto/form upload: Bun's FormData + fetch handles multipart natively; crypto stays node:crypto.
- anilist bot-handler: `export default handler` must survive for the bot framework — CLI is additive.
- Sites with aggressive anti-bot (tiktok cookie-grab, lk21): preserve their custom header/cookie logic via config, not core changes.
- Rate limiting differences: per-site `rateMs` config (youtube internal APIs tolerate faster; tiktok slower).

## Requirements *(mandatory)*

- Migration order (risk-ascending): view-page-source → codeengo → freeconvert → drowify → whitehouse → lk21 → tiktok → anilist → sakana → m.youtube → music.youtube → spotify → animeindo → otakudesu.
- Golden files: before touching each scraper, capture current output of 2–3 representative commands to `specs/003-scraper-unification/golden/<name>/`.
- Per-scraper acceptance = JSON key-shape diff vs golden = empty + live smoke.
- Core config surface: `{ base, headers?, ttlMs?, rateMs?, maxRetries? }` — site-specific, immutable.
- `bun run parity` must stay green throughout (nontonanime untouched behaviorally).
- This spec does NOT port scrapers to Go/Rust — TS unification only. Go/Rust parity remains nontonanime-scoped per Constitution P2.

## Review & Acceptance Checklist

- [ ] core/ extracted; nontonanime.ts consumes it; parity 79/0 unchanged
- [ ] 14/14 scrapers migrated to ESM + core/, feature-complete
- [ ] Golden-file key-shape diff = empty for every scraper
- [ ] axios/node-fetch/form-data removed from deps
- [ ] legacy/*.js preserved; root clean (only .ts entries)
- [ ] Every scraper: help text, [ERROR] semantics, cache hits on repeat
- [ ] anilist bot-handler export intact + CLI added
