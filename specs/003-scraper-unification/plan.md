# Implementation Plan: Scraper Unification

**Branch**: `003-scraper-unification` · **Spec**: [spec.md](./spec.md)

## Architecture

```
core/
├── fetch.ts    # createSite({base, headers?, ttlMs?, rateMs?, maxRetries?}) → { fetchPage, postAjax, guards, cacheApi }
├── cli.ts      # defineCLI({ name, commands: {name: {desc, run(args, flags)}} }) → main() with help/[ERROR]/exit codes
└── parse.ts    # txt(UTF-16-aware), num, firstText, sliceBalanced, extractPageVar, extractEmbedUrl, parseCards
```

- `nontonanime.ts` becomes a *consumer* of core/ — its globals become a `createSite()` instance. Behavior frozen (parity suite is the referee).
- Each migrated scraper = thin file: config + feature functions + `defineCLI` registration.
- Per-site limiter/cache isolation: `createSite()` returns closures over its own Maps — no cross-site cache pollution.

## Migration protocol per scraper (the loop)

1. **Golden capture**: run legacy via node/bun, save 2–3 command outputs to `specs/003-scraper-unification/golden/<name>/*.json`
2. **Migrate**: create `<name>.ts` on core/; port functions; convert CJS→ESM; strip demo console.logs from lib paths
3. **Verify**: run same commands, key-shape diff vs golden = empty; repeat-command cache hit <50ms; `help` works
4. **Relocate**: `git mv <name>.js legacy/`
5. **Commit** per scraper (atomic rollback unit)

## Runtime-specific notes

- **spotify/youtube music (internal APIs)**: postAjax carries tokens; keep their header builders as site config. youtubei POST bodies — core POST already URL-encoded; add `postJson()` if needed (raw body, content-type override).
- **sakana**: multipart → Bun native `FormData` + fetch; crypto stays `node:crypto`.
- **tiktok/lk21 cookie flows**: site config `headers` per-request override already in postAjax signature.
- **anilist**: dual entry — `export default handler` (bot) + `if (import.meta.main) cli()` (CLI).

## Risks

- Sites may have died since the scripts were written (drowify.biz.id, lk21official mirror churn) — golden capture may fail: mark scraper `verify: offline-only` (guards + help + shape of error path), note in tasks.md, don't block migration on dead targets.
- axios response shapes used implicitly (`res.data`) — mechanical replace with `fetchPage` strings; JSON.parse where the scraper expected JSON.
- otakudesu/animeindo have their own retry logic (retries=5) — replaced by core withRetry; verify no behavior change on 429 sites.

## Verification

- `bun run parity` green after EVERY phase (core extraction is phase 0 — the risky one)
- Per-scraper golden diff + cache-hit timing
- Final: `bunx tsc --noEmit` across all entry points; dep list = cheerio only
