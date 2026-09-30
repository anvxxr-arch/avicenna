import * as React from 'react';
import { animate, stagger } from 'animejs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/input';
import { Link } from '../lib/router';
import { SECTIONS } from '../lib/sections';

const PRINCIPLES = [
  {
    title: 'One envelope, always',
    body: 'Every route — success or failure — answers with { api, version, data } or { api, version, error:{code,message} }. One parser, one error class.',
  },
  {
    title: 'Go owns the backend',
    body: 'The server, the cache headers and the route table live in the Go binary. TypeScript remains the behavioural reference the Go port is diffed against on every release.',
  },
  {
    title: 'Hardened by default',
    body: 'SSRF-pinned fetches, private-host blocking, per-host serial rate limits, redirect allowlists, body caps, timeouts and Cloudflare-challenge detection are transport-level, not per-scraper.',
  },
  {
    title: 'Cache what is cacheable',
    body: 'Nonce-derived routes are always no-store. Anything sharing a CDN key without a nonce is explicitly marked, so a stale secret can never be served.',
  },
  {
    title: 'Real-surface verification',
    body: 'A live parity suite diffs three runtimes command-by-command, and a per-scraper contract gate re-runs real commands and compares payload shapes.',
  },
  {
    title: 'Honest about breakage',
    body: 'When an upstream site blocks scrapers or disables its API, the route says so with an actionable error instead of returning an empty list.',
  },
];

const RUNTIMES = [
  { name: 'Go', role: 'API server + reference port', detail: 'net/http, stdlib only, OpenAPI emitted from the same table that serves traffic' },
  { name: 'Rust', role: 'heavy-path port', detail: 'reqwest + scraper; kept byte-identical to the TypeScript reference by the parity suite' },
  { name: 'Bun / TypeScript', role: 'reference implementation + this UI', detail: 'the behavioural contract every port chases; React frontend served by Bun' },
];

export function AboutPage() {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ref.current) return;
    animate(ref.current.querySelectorAll('.card-in'), {
      opacity: [0, 1],
      translateY: [10, 0],
      delay: stagger(50),
      duration: 400,
      ease: 'outQuart',
    });
  }, []);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Badge className="border-accent/50 text-accent">about</Badge>
        <h1 className="text-2xl font-semibold tracking-tight">What Avicenna is</h1>
        <p className="max-w-2xl text-sm text-muted">
          A single normalised HTTP surface over {SECTIONS.length} media sources — anime, film, manga, music,
          video and social — with the hardening and cache semantics done once, in the transport, and verified
          on the real surface instead of in mocks.
        </p>
      </header>

      <div ref={ref} className="grid gap-4 sm:grid-cols-2">
        {PRINCIPLES.map((p) => (
          <Card key={p.title} className="card-in">
            <CardHeader>
              <CardTitle>{p.title}</CardTitle>
              <CardDescription>{p.body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Runtimes</h2>
        <div className="space-y-2">
          {RUNTIMES.map((r) => (
            <div key={r.name} className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-border bg-surface p-3 text-xs">
              <span className="font-semibold">{r.name}</span>
              <Badge>{r.role}</Badge>
              <span className="text-muted">{r.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Sources covered</h2>
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <Link key={s.path} to={s.path}>
              <Badge className="hover:border-accent hover:text-fg">{s.label}</Badge>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Operate it</h2>
        <Card>
          <CardContent className="space-y-2 pt-4 text-xs">
            <pre className="overflow-auto rounded-[var(--radius)] bg-bg p-3 text-muted">{`# backend (Go, stdlib only)
go build -o /tmp/avicenna .
/tmp/avicenna serve -addr 127.0.0.1:8899 -cors

# machine-readable schema
/tmp/avicenna openapi > openapi.json

# frontend
bun web/build.ts
bun web/serve.ts            # proxies /api -> 127.0.0.1:8899

# verification gates
bun tools/parity.ts --guards-only     # cross-runtime guards
bun tools/parity.ts --live            # 3-runtime live diff
bun tools/contract.ts --check         # per-scraper payload contracts`}</pre>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
