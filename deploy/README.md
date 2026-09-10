# Deploy — nontonanime-api

## 1. Install systemd (user unit)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/nontonanime-api.service ~/.config/systemd/user/
# admin token (optional, enables POST /admin/purge):
echo 'API_ADMIN_TOKEN=<generate-one>' > deploy/api.env   # chmod 600, gitignored
systemctl --user daemon-reload
systemctl --user enable --now nontonanime-api
loginctl enable-linger dwizzy        # survive logout
```

Health: `curl http://127.0.0.1:8899/api/nontonanime/health`

## 2. Cloudflare Cache Rule (dashboard)

**Rules → Cache Rules → Create rule**
- Name: `nontonanime-api-cache`
- Match: `hostname eq <your-domain> and starts_with(http.request.uri.path, "/api/nontonanime/")`
- Action: **Cache eligibility → Eligible for cache**
- Edge TTL: **"Use cache-control header if present, bypass cache-control and use provided TTL"** → NOT needed; default "respect origin" works because the API emits `s-maxage`
- **Key point**: leave "Respect existing headers" semantics (default) — `no-store` routes (resolve/stream/health/purge) then bypass the edge automatically
- Cache Key: default (full URI incl. query string) — query params are part of the API contract

Result: cacheable routes cached at edge for `s-maxage` (10–60min), revalidate with `stale-while-revalidate`, nonce routes always origin.

## 3. Purge flow

Site content changed? Refresh the origin LRU (edge follows on next TTL):

```bash
curl -X POST -H "Authorization: Bearer $API_ADMIN_TOKEN" \
  http://127.0.0.1:8899/api/nontonanime/admin/purge
# -> {"purged": 37}
```

Full edge purge: Cloudflare dashboard → Caching → Purge Everything (or API zone purge).

## 4. Verify cycle

```bash
curl -sD- -o /dev/null http://127.0.0.1:8899/api/nontonanime/schedule | grep -iE 'cache-control|x-cache'
# 1st: x-cache: MISS   (fetched)
# 2nd: x-cache: PASS?  -> HIT expected: see note below
```

> NOTE: `x-cache` HIT/MISS is per-process in-memory LRU. The current `x-cache: PASS`
> default on json() calls means routes don't yet report HIT/MISS — wiring the LRU
> lookup outcome into the response header is tracked in spec 002 follow-up if needed.

## 5. Logs

```bash
journalctl --user -u nontonanime-api -f
```
