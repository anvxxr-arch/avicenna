# Feature Specification: Go API cutover

**Status**: Delivered · **Created**: 2026-09-30

## Why
The objective is that backend weight sits on Go/Rust. Today `api/nontonanime/server.ts` (Bun) owns the
route table while `scrapers/*.ts` own the scraping, and a Go server is being introduced. Two servers with
two route tables and two envelopes is a defect waiting to happen.

## Delivered (verified 2026-09-30)
- All 14 sources are ported into the Go `scrapers/` package and registered in one CLI/route registry.
- `nontonanime serve` owns `/api/v1/*`: 104 route entries (101 HTTP + admin/openapi index entries),
  envelope + cache policy emitted from the same table that generates OpenAPI.
- `api/nontonanime/server.ts` is deleted together with its package script and systemd unit; Bun builds
  and serves the frontend only.
- Filesystem-touching commands (`freeconvert compress`, `viewpagesource view`) are marked `LocalOnly` and
  never get an HTTP route — a query string cannot name a server-side path.
- Client-argument errors answer 400 (`bad_request`); upstream refusals (any upstream 4xx/5xx, WAF) answer
  502 (`upstream_error`); unknown routes answer 404 — verified across all routes.

## Contract
- Exactly **one** public API process: the Go binary (`nontonanime serve`).
- Exactly **one** envelope (`{api,version,data}` / `{api,version,error:{code,message}}`) and **one**
  cache-header policy, emitted from the Go route table.
- The Bun API server is retired once every route is served by Go; Bun remains the **frontend runtime**
  (bundler + static server) and nothing else.

## Route ownership (target)
| Route family | Owner |
|---|---|
| `/api/v1/*` (anime, film, music, video, social, tools) | Go (`scrapers/` package + `nontonanime.go`) |
| `/api/v1/openapi.json` | Go (generated from the same table) |
| static assets + SPA deep links | Bun (`web/serve.ts`) |
| `POST /admin/purge` | Go (origin cache); Cloudflare purge stays dashboard-side |

## Acceptance
1. `nontonanime serve` answers every route in the table with the envelope, correct status codes and
   correct `Cache-Control`; nonce-derived routes are `no-store`.
2. `nontonanime openapi` emits a spec covering every route.
3. The frontend's `web/serve.ts` proxy targets only `nontonanime serve`; the Bun API server is deleted from
   the default startup path and documented as retired.
4. `bun tools/contract.ts --check` still passes after the cutover (behaviour unchanged for CLI consumers).
5. `go vet ./...`, `go build ./...` and `bun run typecheck` are clean.

## Migration order
1. Go server ships all anime routes (parity with the Bun server's outputs).
2. `scrapers/` package ports land for the remaining sources; each is shape-checked against its TS CLI.
3. Frontend points at the Go server.
4. `api/nontonanime/server.ts` is deleted (gone from the tree and from scripts).
