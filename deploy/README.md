# Deploy — avicenna API + web

Two processes, one origin:

| process | command | port | role |
|---|---|---|---|
| `avicenna-api` | `avicenna serve -addr 127.0.0.1:8899` | 8899 | **all** `/api/v1/*` routes (Go, stdlib only) |
| `avicenna-web` | `bun web/serve.ts` | 5173 | static frontend + same-origin `/api` proxy |

The Bun API server (`api/nontonanime/server.ts`) is **retired**: it is kept only as a compatibility shim
while the frontend is pointed at the Go server. See `specs/004-go-api-cutover/spec.md`.

## 1. Build

```bash
go build -o ~/.local/bin/avicenna .          # API + scrapers, single binary
bun install && bun web/build.ts              # frontend bundle -> web/dist
```

## 2. API — systemd user unit

```bash
mkdir -p ~/.config/systemd/user
cp deploy/avicenna-api.service ~/.config/systemd/user/
# admin token (optional, enables POST /api/v1/admin/purge):
mkdir -p deploy && echo 'API_ADMIN_TOKEN=<generate-one>' > deploy/api.env   # chmod 600, gitignored
systemctl --user daemon-reload
systemctl --user enable --now avicenna-api
loginctl enable-linger "$USER"
```

Health: `curl http://127.0.0.1:8899/api/v1/health`

## 3. Web — systemd user unit

```bash
cp deploy/avicenna-web.service ~/.config/systemd/user/
systemctl --user enable --now avicenna-web
```

`web/serve.ts` serves `web/dist`, resolves SPA deep links (`/anime`, `/docs`, …) to `index.html`, and
proxies `/api/*` to the Go server, so the browser never needs CORS in production.

## 4. Cloudflare Cache Rule (dashboard)

**Rules → Cache Rules → Create rule**

- Name: `avicenna-api-cache`
- Match: `hostname eq <your-domain> and starts_with(http.request.uri.path, "/api/v1/")`
- Action: **Cache eligibility → Eligible for cache**
- Edge TTL: leave "respect origin" — the API emits `s-maxage`
- **Key point**: because the API sets `Cache-Control: no-store` on nonce-derived routes
  (`/stream`, `/resolve`, `/servers`, `/more`) and on every error, those bypass the edge automatically.
- Cache Key: default (full URI incl. query string) — query params are part of the contract

## 5. Purge flow

```bash
curl -X POST -H "Authorization: Bearer $API_ADMIN_TOKEN" \
  http://127.0.0.1:8899/api/v1/admin/purge
# -> {"api":"nontonanime-go","version":"1","data":{"purged":N}}
```

The token is accepted **only** via the `Authorization` header — never as a query parameter, which would
leak it into access logs and browser history. Full edge purge stays dashboard-side
(Cloudflare → Caching → Purge Everything).

## 6. Verify cycle

```bash
curl -sD- -o /dev/null http://127.0.0.1:8899/api/v1/schedule | grep -iE 'cache-control|x-cache'
# cacheable route: public, max-age=300, s-maxage=600, stale-while-revalidate=1200

curl -sD- -o /dev/null "http://127.0.0.1:8899/api/v1/servers?url=<ep>" | grep -i cache-control
# nonce route: no-store

curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8899/api/v1/anime?url=https://evil.com/x"
# 400 (caller error, not 500)

curl -s http://127.0.0.1:8899/api/v1/openapi.json | jq '.paths | keys'
```

## 7. Logs

```bash
journalctl --user -u avicenna-api -f
journalctl --user -u avicenna-web -f
```

## 8. Hardening notes

- The API process only listens on loopback; expose it through the web proxy or a tunnel.
- `deploy/avicenna-api.service` mounts the checkout read-only: the API performs no filesystem writes.
- Secrets live in `deploy/api.env` (gitignored). `.githooks/pre-commit` blocks accidental commits;
  enable it per clone with `git config core.hooksPath .githooks`.
