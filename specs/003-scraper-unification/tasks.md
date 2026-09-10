# Tasks: Scraper Unification

**Branch**: `003-scraper-unification` · **Plan**: [plan.md](./plan.md)

## Phase 0 — Core extraction (parity is the gate)

- [ ] 0.1 `core/parse.ts` — extract txt/num/firstText/sliceBalanced/extractPageVar/extractEmbedUrl/parseCards + regexes from nontonanime.ts
- [ ] 0.2 `core/fetch.ts` — `createSite({base, headers?, ttlMs?, rateMs?, maxRetries?})` returning isolated {fetchPage, postAjax, cacheApi}; nontonanime guards move in verbatim
- [ ] 0.3 `core/cli.ts` — defineCLI command-table runner (help, [ERROR], exit 1, JSON out)
- [ ] 0.4 Refactor nontonanime.ts onto core/ — ZERO behavior change
- [ ] 0.5 GATE: `bun run parity` → 79/0 + tsc clean

## Phase 1 — Easy wins (static/simple sites)

- [ ] 1.1 view-page-source (63L): golden → migrate → verify → git mv
- [ ] 1.2 codeengo (103L): same loop
- [ ] 1.3 freeconvert (100L): same loop (CJS→ESM)
- [ ] 1.4 drowify (117L): same loop (mark offline-verify if site dead)
- [ ] 1.5 whitehouse.gov (334L): same loop

## Phase 2 — Medium (anti-bot / multi-step)

- [ ] 2.1 lk21official (264L): cookie/header logic into site config
- [ ] 2.2 tiktok (298L): cookie-grab preserved via postAjax extra headers
- [ ] 2.3 anilist (275L): ESM already; keep `export default handler` + add CLI entry
- [ ] 2.4 sakana (332L): crypto stays; multipart → Bun FormData

## Phase 3 — Heavy (internal APIs + big scrapers)

- [ ] 3.1 m.youtube.com (472L)
- [ ] 3.2 music.youtube.com (582L): youtubei POST — add core postJson if required
- [ ] 3.3 open.spotify.com (630L): token flows via postAjax/postJson
- [ ] 3.4 animeindo (612L): own limiter replaced by core
- [ ] 3.5 otakudesu (697L): own limiter + UA rotation replaced by core

## Phase 4 — Hygiene

- [ ] 4.1 Deps: remove axios/node-fetch/form-data; package.json scripts for 14 scrapers
- [ ] 4.2 Root clean: only .ts entries; legacy/ holds originals
- [ ] 4.3 Final: tsc all entries, parity 79/0, per-scraper golden diffs all empty, cache-hit verification
