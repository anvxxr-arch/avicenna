import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Link } from '../lib/router';
import { SECTIONS } from '../lib/sections';
import { Copy, Check } from 'lucide-react';

/** Route catalogue rendered from the shared section registry + live schemas. */
const CORE_ROUTES: Array<{ method: string; path: string; params: string; notes: string }> = [
  { method: 'GET', path: '/health', params: '—', notes: 'uptime + honest cache stats; no-store' },
  { method: 'GET', path: '/home', params: 'page?', notes: 'homepage grids' },
  { method: 'GET', path: '/latest', params: 'page?', notes: 'latest episodes' },
  { method: 'GET', path: '/list', params: 'page?', notes: 'anime catalogue' },
  { method: 'GET', path: '/search', params: 'q (2-100)', notes: 'title search' },
  { method: 'GET', path: '/advsearch', params: 'sort,status,type,…,page', notes: 'filtered search; WAF-safe fallback' },
  { method: 'GET', path: '/anime', params: 'url (site host)', notes: 'detail + episode list' },
  { method: 'GET', path: '/episode', params: 'url (site host)', notes: 'episode + servers + downloads' },
  { method: 'GET', path: '/stream', params: 'url, server 1-20', notes: 'nonce-derived; no-store' },
  { method: 'GET', path: '/resolve', params: 'url, server name|n', notes: 'nonce-derived; no-store' },
  { method: 'GET', path: '/servers', params: 'url', notes: 'nonce payload; no-store' },
  { method: 'GET', path: '/genre', params: 'slug (a-z0-9-), page?', notes: 'genre archive' },
  { method: 'GET', path: '/season', params: 'season, year, page?', notes: 'premiereds archive' },
  { method: 'GET', path: '/more', params: 'offset, ids[]', notes: 'loadmore AJAX; no-store' },
  { method: 'POST', path: '/admin/purge', params: 'Authorization: ***', notes: '404 unless a token is configured; token-gated, 5 per 10 min per client' },
];

function Copyable({ text }: { text: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

export function DocsPage() {
  const [filter, setFilter] = React.useState('');
  const f = filter.toLowerCase();
  const sections = SECTIONS.filter((s) => !f || s.label.toLowerCase().includes(f) || s.blurb.toLowerCase().includes(f));
  const routes = CORE_ROUTES.filter((r) => !f || r.path.includes(f) || r.notes.toLowerCase().includes(f));

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p className="max-w-2xl text-sm text-muted">
          One envelope, one error shape, cache headers that reflect reality. Responses are JSON only; the
          status code carries the outcome and <code className="text-fg">error.code</code> carries the class.
        </p>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter routes or sources…" className="max-w-md" />
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>success envelope</CardTitle>
            <CardDescription>2xx responses</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-[11px] text-muted">{`{ "api": "nontonanime-go", "version": "1", "data": <payload> }`}</pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>error envelope</CardTitle>
            <CardDescription>400 bad_request · 401 unauthorized · 404 not_found · 405 method_not_allowed · 429 rate_limited · 500 internal · 502 upstream_error</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-[11px] text-muted">{`{ "api": "nontonanime-go", "version": "1",
  "error": { "code": "bad_request", "message": "…" } }`}</pre>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Caching contract</h2>
        <div className="overflow-x-auto rounded-[var(--radius)] border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="p-3 font-medium">route class</th>
                <th className="p-3 font-medium">cache-control</th>
                <th className="p-3 font-medium">why</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['grids (home/latest/search)', 'public, max-age=300, s-maxage=600, swr=1200', 'fast-moving content'],
                ['settled detail (genres/popular/top)', 'public, max-age=1800, s-maxage=3600, swr=7200', 'changes hourly'],
                ['nonce-derived (stream/resolve/servers/more)', 'no-store', 'per-request secrets; stale nonces 500'],
                ['health + every error', 'no-store', 'must never be replayed'],
              ].map(([a, b, c]) => (
                <tr key={a} className="border-t border-border">
                  <td className="p-3 font-medium">{a}</td>
                  <td className="p-3"><code className="text-muted">{b}</code></td>
                  <td className="p-3 text-muted">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Core routes</h2>
        <div className="space-y-2">
          {routes.map((r) => (
            <div key={r.path} className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface p-3">
              <Badge className={r.method === 'GET' ? 'border-emerald-600/50 text-emerald-400' : 'border-amber-600/50 text-amber-400'}>{r.method}</Badge>
              <code className="text-xs">{r.path}</code>
              <span className="text-xs text-muted">{r.params}</span>
              <span className="ml-auto text-xs text-muted">{r.notes}</span>
              <Copyable text={`curl -s "http://127.0.0.1:8899/api/v1${r.path}" | jq`} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Sources</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {sections.map((s) => (
            <Card key={s.path}>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>
                    <Link to={s.path} className="hover:text-accent">
                      {s.label}
                    </Link>
                  </CardTitle>
                  <Badge
                    className={
                      s.status === 'live'
                        ? 'border-emerald-600/50 text-emerald-400'
                        : s.status === 'degraded'
                          ? 'border-amber-600/50 text-amber-400'
                          : 'border-zinc-600/50'
                    }
                  >
                    {s.status}
                  </Badge>
                </div>
                <CardDescription>{s.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1">
                {s.endpoints.map((e) => (
                  <code key={e} className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-muted">
                    {e}
                  </code>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">OpenAPI</h2>
        <p className="text-sm text-muted">
          The Go server emits a machine-readable spec:{" "}
          <code className="text-fg">nontonanime openapi</code> or{" "}
          <code className="text-fg">GET /api/v1/openapi.json</code>.
        </p>
        <Copyable text="curl -s http://127.0.0.1:8899/api/v1/openapi.json | jq '.paths | keys'" />
      </section>
    </div>
  );
}
