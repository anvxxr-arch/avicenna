#!/usr/bin/env bun
/**
 * web/serve.ts — static+SPA server for the built frontend, with an optional
 * same-origin /api proxy to the Go backend.
 *
 *   bun web/serve.ts                      # http://127.0.0.1:5173
 *   API_ORIGIN=http://127.0.0.1:8899 bun web/serve.ts
 *
 * Deep links resolve to index.html (single-page app); assets are served from
 * web/dist with immutable caching.
 */
const PORT = parseInt(process.env.WEB_PORT || '5173', 10);
const HOST = process.env.WEB_HOST || '127.0.0.1';
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:8899';
const DIST = 'web/dist';

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // same-origin API proxy — the browser never needs CORS in production
    if (url.pathname.startsWith('/api/')) {
      const target = API_ORIGIN + url.pathname + url.search;
      const upstream = await fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      }).catch(() => null);
      // keep the backend's envelope contract even when the backend is down
      if (!upstream) {
        return new Response(
          JSON.stringify({ api: 'avicenna-web', version: '1', error: { code: 'upstream_error', message: `api unreachable at ${API_ORIGIN}` } }),
          { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
        );
      }
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`${DIST}${path}`);
    if (await file.exists()) {
      const immutable = /\.[0-9a-f]{8,}\./.test(path);
      return new Response(file, {
        headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
      });
    }
    // client-side routing fallback
    const shell = Bun.file(`${DIST}/index.html`);
    if (await shell.exists()) return new Response(shell, { headers: { 'cache-control': 'no-cache' } });
    return new Response('not built — run: bun web/build.ts', { status: 503 });
  },
});

console.log(`[web] http://${server.hostname}:${server.port}  (api -> ${API_ORIGIN})`);
