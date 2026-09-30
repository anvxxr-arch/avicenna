# Tasks: Scraper Unification

**Branch**: `003-scraper-unification` · **Plan**: [plan.md](./plan.md) · **Status**: ✅ CONVERGED — 14/14 migrated; contract drift found in the 2026-09-30 audit was repaired and is now machine-checked by `bun tools/contract.ts --check`.

## Phase 0 — Core extraction (parity is the gate)

- [x] 0.1 `core/parse.ts` — extract txt/num/firstText/sliceBalanced/extractPageVar/extractEmbedUrl/parseCards + regexes from nontonanime.ts
- [x] 0.2 `core/fetch.ts` — `createSite({base, headers?, ttlMs?, rateMs?, maxRetries?})` returning isolated {fetchPage, postAjax, cacheApi}; nontonanime guards move in verbatim
- [x] 0.3 `core/cli.ts` — defineCLI command-table runner (help, [ERROR], exit 1, JSON out)
- [x] 0.4 Refactor nontonanime.ts onto core/ — ZERO behavior change
- [x] 0.5 GATE: `bun run parity` → 79/0 + tsc clean

## Phase 1 — Easy wins (static/simple sites)

- [x] 1.1 view-page-source (63L): golden → migrate → verify → git mv
- [x] 1.2 codeengo (103L): same loop
- [x] 1.3 freeconvert (100L): same loop (CJS→ESM)
- [x] 1.4 drowify (117L): same loop (mark offline-verify if site dead)
- [x] 1.5 whitehouse.gov (334L): same loop

## Phase 2 — Medium (anti-bot / multi-step)

- [x] 2.1 lk21official (264L): cookie/header logic into site config
- [x] 2.2 tiktok (298L): cookie-grab preserved via postAjax extra headers
- [x] 2.3 anilist (275L): ESM already; keep `export default handler` + add CLI entry
- [x] 2.4 sakana (332L): crypto stays; multipart → Bun FormData

## Phase 3 — Heavy (internal APIs + big scrapers)

- [x] 3.1 m.youtube.com (472L)
- [x] 3.2 music.youtube.com (582L): youtubei POST — add core postJson if required
- [x] 3.3 open.spotify.com (630L): token flows via postAjax/postJson
- [x] 3.4 animeindo (612L): own limiter replaced by core
- [x] 3.5 otakudesu (697L): own limiter + UA rotation replaced by core

## Phase 4 — Hygiene

- [x] 4.1 Deps: remove axios/node-fetch/form-data; package.json scripts for 14 scrapers
- [x] 4.2 Root clean: only .ts entries; legacy/ holds originals
- [x] 4.3 Final: tsc all entries, parity 79/0, per-scraper golden diffs all empty, cache-hit verification

## Audit + repair (2026-09-30)
The earlier "live-verified" claim did not hold. A deep audit found and this branch fixed:
- **whitehouse**: listing contract had been rewritten (pagination `total`/per-page objects dropped, `next` always null, `filters` always empty) and 5 section paths 404'd. Restored to the legacy shape; golden-diff on `golden/whitehouse.news.json` now passes.
- **lk21**: parser had been reduced (dropped `id/runtime/poster/info/tags/countries/synopsis/player/players/downloadUrl/trailerUrl`, dropped per-section `loadmore` pagination, and returned an all-null object on a WAF challenge). Restored to the legacy contract; the missing `legacy/lk21.js` original was recovered from history.
- **Dropped commands** restored: `animeindo supported|watch`, `otakudesu watch`, `sakana conversations|delete`, `codeengo --styles|--test`, `lk21 --sections`.
- **Cross-cutting**: CLI flag semantics (`--flag` was falsy, `--flag v` ate positionals) fixed in `core/cli.ts` with a per-command flag schema; `nontonanime` moved onto the same shared runner (unknown command now exits 1).
- **Transport**: every scraper now runs on `core/fetch.ts` — zero raw `fetch` remains in the scraper files. New `site.request()` / `site.requestExternal()` carry the SSRF guards, limiter, timeout, caps and a per-hop redirect allowlist.
- **Verification**: `bun tools/contract.ts --check` (14 scrapers, 38 live cases) replaces the hand-written contract prose and is negative-tested.

## Execution notes (2026-09-10)

- view-page-source: site API verified live (token+fetch), JSON POST via postAjax auto content-type
- freeconvert: END-TO-END compress verified (10890→5642 bytes); core got postAjax extraHeaders + 2xx accept + base-path join fix
- lk21: site behind Cloudflare challenge (cf-mitigated: challenge) — structural parity kept, WAF error actionable
- anilist: site is Vue SPA (0 server-rendered cards) AND official GraphQL API disabled server-side (403) — empty-state surfaces actionable error; bot handler preserved
- sakana: legacy FIREBASE_KEY was a redacted placeholder — SAKANA_FIREBASE_KEY env required; error message names it
- spotify: trackUnion {__typename,message} shape for dead ids handled; track live (playcount 1.17B)
- otakudesu: admin-ajax double-nonce flow (get nonce → getStreamUrl) live: 12 stream URLs resolved
- deps: axios/node-fetch/form-data eliminated; only cheerio remains
