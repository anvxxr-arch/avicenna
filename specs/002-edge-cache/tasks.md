# Tasks: Edge-Cached API Service

**Branch**: `002-edge-cache` · **Spec**: [spec.md](./spec.md) · **Status**: ✅ CONVERGED

## Story 1 — Hardened server defaults (P1)

- [x] 1.1 Graceful shutdown: SIGTERM/SIGINT → `server.stop(false)` + 5s drain → exit 0
- [x] 1.2 Request logging with duration (`[api] GET /path -> 200 12ms`), errors never leak stacks
- [x] 1.3 `/health` → `{ok, uptime_s, cache: {size, max}}` (honest stats: expired entries dropped first)
- [x] 1.4 `__cacheApi` export from nontonanime.ts (purge/stats) consumed by server

## Story 2 — Systemd autostart (P2)

- [x] 2.1 `deploy/nontonanime-api.service` (user unit): Restart=on-failure/5s, NoNewPrivileges, PrivateTmp, ProtectSystem=strict, localhost bind 8899
- [x] 2.2 Fix: `User=`/`Group=` omitted — systemd --user units can't set supplementary groups (status 216/GROUP)
- [x] 2.3 LIVE: service active on :8899, health OK, `kill -9` → restarted with new PID in 8s ✓
- [x] 2.4 `loginctl enable-linger dwizzy` — survives logout/reboot

## Story 3 — Edge caching + purge (P3)

- [x] 3.1 `stale-while-revalidate` added (TTL×4) to all cacheable Cache-Control headers
- [x] 3.2 `x-cache: PASS` header on all responses (HIT/MISS wiring tracked as follow-up — LRU outcome not yet plumbed into response)
- [x] 3.3 `POST /admin/purge`: token unset → 404 (hidden); wrong token → 401; valid → `{purged: N}`; timing-safe compare
- [x] 3.4 `deploy/README.md`: systemd install, Cloudflare Cache Rule recipe (respect-origin → no-store routes bypass edge), purge flow, log access
- [x] 3.5 `deploy/api.env` gitignored for real tokens

## Verification (live, homeserver)

- health: `{"ok":true,"uptime_s":11,"cache":{"size":0,"max":100}}` ✓
- headers: `Cache-Control: public, max-age=300, s-maxage=600, stale-while-revalidate=1200` + `x-cache: PASS` ✓
- purge: 401 (no/wrong token) · `{"purged":1}` (valid) · 404 (token unset in prod unit) ✓
- SIGTERM: "draining..." → clean exit 0 ✓
- systemd: active, localhost-only bind, crash → auto-restart ✓

## Known follow-ups

- `x-cache: HIT/MISS` needs LRU-lookup outcome surfaced from nontonanime.ts fetchPage (currently all PASS)
- Cloudflare Cache Rule is dashboard-side — recipe documented in deploy/README.md, applied when domain is proxied
