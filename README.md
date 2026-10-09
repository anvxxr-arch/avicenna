# Avicenna

One normalised HTTP API over nineteen media sources — anime, film, manga, music, video and social — plus a
React frontend. Hardening (SSRF pinning, rate limits, body caps, timeouts, WAF detection) lives in the
transport, once, and is verified on the real surface.

- **API**: `nontonanime serve` (Go, standard library only) — uniform envelope, cache headers that reflect reality, OpenAPI emitted from the same route table that serves traffic.
- **Frontend**: React 19 + Tailwind v4 + anime.js, bundled and served by Bun. Pages: `/`, `/docs`, `/playground`, `/about`, and one page per source (`/anime`, `/film`, `/manga`, `/music`, `/youtube`, `/tiktok`, `/instagram`, `/facebook`, `/twitter`, `/drowify`, `/whitehouse`, `/tools`).
- **Scrapers**: 18 sources ported to Go (`scrapers/`), served both as CLI commands and as
  `/api/v1/<scraper>/<command>` routes generated from the same registry.
- **Reference implementation**: the TypeScript CLIs. The Go/Rust ports are diffed against them by a live parity suite.

## Quick start

```bash
# backend — build once, run the API
go build -o /tmp/avicenna .
/tmp/avicenna serve -addr 127.0.0.1:8899 -cors

# machine-readable schema
/tmp/avicenna openapi > openapi.json

# frontend (proxies /api -> 127.0.0.1:8899)
bun web/build.ts
bun web/serve.ts            # http://127.0.0.1:5173
```

Every route answers with the same envelope:

```json
{ "api": "nontonanime-go", "version": "1", "data": { } }
{ "api": "nontonanime-go", "version": "1", "error": { "code": "bad_request", "message": "…" } }
```

`error.code` is one of `bad_request`, `not_found`, `upstream_error`, `internal`. Nonce-derived routes
(`/stream`, `/resolve`, `/servers`, `/more`) and every error are `Cache-Control: no-store`.

## Scrapers

The Go binary is the backend: **one CLI for every source**, the same command surface as the
TypeScript reference (`avicenna <scraper> <command> [args…]`), plus the HTTP API.

```bash
/tmp/avicenna yt info dQw4w9WgXcQ           # the same surface as `bun yt.ts info …`
/tmp/avicenna help                          # every scraper + command
```

The TypeScript CLIs remain the *reference implementation* the Go/Rust ports are diffed against:

```bash
bun nontonanime.ts search "one piece"      # anime
bun animeindo.ts episode one-piece-episode-1180
bun otakudesu.ts episode wpoiec-episode-1180-sub-indo
bun lk21.ts sections                       # film
bun whitehouse.ts news
bun spotify.ts search "bad habits" --limit=5
bun ytmusic.ts search "avenged sevenfold" songs
bun yt.ts info dQw4w9WgXcQ
bun tiktok.ts user nasa
bun drowify.ts search lofi
bun codeengo.ts generate cyberpunk
bun freeconvert.ts compress downloads/input.mp4 40
bun view-page-source.ts view https://example.com
bun anilist.ts populer
bun sakana.ts chat "halo"
bun mangasusuku.ts search "solo leveling"   # manga (Themesia family)
bun kanzenin.ts azlist A
bun ngomik.ts genre action 2
bun sankanime.ts terbaru                     # manga (official Sankanime API)
```

All of them share `core/cli.ts`: `help` prints a command table, failures print `[ERROR] …` to stderr and
exit 1, and output is JSON on stdout.

## Verification gates

```bash
bun run check              # typecheck (app + web) + guards + contracts + secret scan
bun tools/parity.ts --guards-only   # 14 offline cross-runtime guard commands (22 pass · 6 n/a on Rust)
bun tools/parity.ts --live          # 105 commands × 3 runtimes (230 pass · 0 fail · 84 n/a · 1 empty-consistent; guards add 22 pass · 6 n/a)
bun tools/contract.ts --check       # 18 scrapers × live commands, payload shape contracts
bun tools/contract.ts --capture     # re-record contracts after a deliberate change
bun tools/scan-secrets.ts --all     # secret scan (also wired as .githooks/pre-commit)
```

Install the pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

## Layout

```
core/                  shared transport (fetch/limiter/cache/guards), CLI runner, HTML parsing
*.ts                   reference scrapers (one per source) + the API/parity tooling
nontonanime.go         Go port of the reference scraper + the HTTP server
nontonanime-rs/        Rust port (parity-checked against the TS reference)
scrapers/              Go ports of the non-anime scrapers
web/                   React frontend (src/, build.ts bundler, serve.ts SPA server)
tools/                 parity suite, contract gate, golden diff, secret scanner
specs/                 spec-kit feature specs, plans, tasks and contract files
legacy/                archived pre-migration .js originals (reference only)
```

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `API_ADDR` / `API_HOST` / `API_PORT` | Go server | bind address (default `127.0.0.1:8899`) |
| `API_ADMIN_TOKEN` | Go + Bun servers | enables `POST /admin/purge`; unset hides the route (404) |
| `API_CORS` | both | `1` emits `Access-Control-Allow-Origin: *` |
| `ANIME_BASE` | nontonanime | override the upstream anime host |
| `SAMEHADAKU_BASE` / `SAMEHADAKU_COOKIE` | samehadaku | override base host / supply a Cloudflare-session cookie |
| `SAKANA_FIREBASE_KEY` | sakana | required for chat/models — the key is not committed |
| `YT_ANDROID_VR_KEY`, `YTM_API_KEY` | yt / ytmusic | optional inner keys for the `download` paths |
| `PARITY_GO_BIN`, `PARITY_RS_BIN` | parity | override the port binaries under test |

Secrets are never committed: `.githooks/pre-commit` runs the scanner, and `deploy/api.env` (gitignored)
holds the real token for the systemd unit.
