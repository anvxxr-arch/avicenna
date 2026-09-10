# Feature Specification: Edge-Cached API Service

**Feature Branch**: `002-edge-cache`

**Created**: 2026-09-09

**Status**: Draft

**Input**: User description: "Productionize api/nontonanime/server.ts for the homeserver: hardened server config, systemd autostart, Cloudflare edge caching with correct TTL/no-store semantics, and health monitoring."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hardened server defaults (Priority: P1)

The API server (`api/nontonanime/server.ts`) runs with production-grade defaults: configurable request-body/header limits, graceful shutdown on SIGTERM/SIGINT, request logging with duration, error responses never leak stack traces, and a `/api/nontonanime/health` endpoint that reports process uptime + cache stats.

**Why this priority**: Everything else deploys on top of a server that can survive systemd lifecycle and won't leak internals.

**Independent Test**: Start server → send SIGTERM → process exits cleanly (exit 0) within 5s. Health endpoint returns JSON with `uptime_s > 0`.

**Acceptance Scenarios**:

1. **Given** the server is running, **When** SIGTERM is received, **Then** in-flight requests complete (≤5s grace) and process exits 0.
2. **Given** any unhandled route error, **When** a request hits it, **Then** response is JSON `{error}` with 4xx/5xx status — never a stack trace.
3. **Given** the server started N seconds ago, **When** `/health` is hit, **Then** response contains `ok:true`, `uptime_s ≥ 0`, and `cache` size.

---

### User Story 2 - Systemd autostart (Priority: P2)

A unit file (`deploy/nontonanime-api.service`) runs the server on the homeserver: starts on boot, auto-restarts on crash (Restart=on-failure, 5s), runs as user dwizzy, binds 127.0.0.1:PORT (localhost only — Cloudflare tunnels in via existing setup), logs to journald.

**Why this priority**: Without lifecycle management the service dies silently on reboot/crash.

**Independent Test**: `systemctl --user start nontonanime-api` → health OK → `kill` the process → systemd restarts it within 10s → health OK again.

**Acceptance Scenarios**:

1. **Given** the unit installed, **When** the host reboots, **Then** the API is healthy within 30s of boot without manual action.
2. **Given** the process crashes, **When** systemd detects exit, **Then** it restarts with backoff and journald captures the crash reason.

---

### User Story 3 - Cloudflare edge caching (Priority: P3)

All cacheable GETs emit `Cache-Control: public, max-age=X, s-maxage=Y` (already implemented — verified). This story adds: a deploy doc for the Cloudflare Cache Rule (`Cache Everything` on `/api/nontonanime/*`, respecting origin headers), `stale-while-revalidate` semantics on cacheable routes, and a cache-purge mechanism: `POST /api/nontonanime/admin/purge` (guarded by `API_ADMIN_TOKEN` env, always `no-store`) that clears the in-process LRU and returns count of evicted entries.

**Why this priority**: Edge is the payoff layer, but it depends on Stories 1–2 being solid.

**Independent Test**: With `API_ADMIN_TOKEN=secret` set, POST purge without token → 401. With token → 200 `{evicted: N}` and subsequent data requests re-fetch (cache miss → fresh).

**Acceptance Scenarios**:

1. **Given** cacheable route, **When** response inspected, **Then** `Cache-Control` includes `stale-while-revalidate`.
2. **Given** admin token configured, **When** purge called without token, **Then** 401 and cache untouched.
3. **Given** purge called with valid token, **When** next data request arrives, **Then** it's a cache miss (fresh fetch) — verified via response `x-cache: MISS` header (new).

---

### Edge Cases

- `x-cache` header: HIT/MISS/PASS on every data response — PASS for no-store routes (resolve/stream/admin).
- Purge while requests in-flight: LRU mutex makes it atomic; no torn state.
- Token mismatch: constant-time comparison (timing-safe), 401 with no info leak.
- Cloudflare respect-origin: doc must specify "Respect existing headers" so `no-store` routes never cached at edge.

## Requirements *(mandatory)*

- No new runtime dependencies; Bun stdlib only.
- `x-cache` response header on all `/api/nontonanime/*` routes.
- Purge endpoint: `POST`, token-guarded (env `API_ADMIN_TOKEN`; unset token → endpoint returns 404 to avoid probing surface).
- `deploy/nontonanime-api.service` + `deploy/README.md` (install steps + Cloudflare Cache Rule recipe).
- Graceful shutdown: `Bun.serve` `stop()` on signals with 5s in-flight grace.
- Health payload: `{ok, uptime_s, cache: {size, max}}`.

## Review & Acceptance Checklist

- [ ] SIGTERM → clean exit 0 with in-flight completion
- [ ] Health shows uptime + cache stats
- [ ] x-cache header on all routes (HIT/MISS/PASS)
- [ ] Purge endpoint token-guarded, 404 when token unset, constant-time compare
- [ ] stale-while-revalidate added to cacheable TTLs
- [ ] systemd unit + deploy README with Cloudflare recipe
- [ ] Live verification: boot → health → purge → x-cache MISS cycle
