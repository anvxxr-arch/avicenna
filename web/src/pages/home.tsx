import * as React from 'react';
import { animate, stagger } from 'animejs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Link } from '../lib/router';
import { SECTIONS, PRIMARY_PAGES } from '../lib/sections';
import { apiGet } from '../lib/api';
import { ArrowRight, CheckCircle2, CircleDashed } from 'lucide-react';

function useHealth() {
  const [state, setState] = React.useState<'checking' | 'ok' | 'down'>('checking');
  const [detail, setDetail] = React.useState<string>('');
  React.useEffect(() => {
    let alive = true;
    apiGet<{ uptime_s?: number }>('/health')
      .then((d) => {
        if (!alive) return;
        setState('ok');
        setDetail(`up ${d?.uptime_s ?? 0}s`);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setState('down');
        setDetail(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { state, detail };
}

export function HomePage() {
  const { state, detail } = useHealth();
  const gridRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!gridRef.current) return;
    animate(gridRef.current.querySelectorAll('.tile'), {
      opacity: [0, 1],
      translateY: [14, 0],
      delay: stagger(40),
      duration: 420,
      ease: 'outQuint',
    });
  }, []);

  const counts = {
    live: SECTIONS.filter((s) => s.status === 'live').length,
    degraded: SECTIONS.filter((s) => s.status === 'degraded').length,
    planned: SECTIONS.filter((s) => s.status === 'planned').length,
  };

  return (
    <div className="space-y-10">
      <section className="space-y-5 pt-6">
        <Badge className="border-accent/50 text-accent">single backend · uniform envelope</Badge>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Every media source behind{" "}
          <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">one honest API</span>.
        </h1>
        <p className="max-w-2xl text-sm text-muted">
          Avicenna normalises anime, film, music, video and social scrapers onto a single JSON envelope with
          SSRF-pinned fetches, per-host rate limits and cache headers that mean what they say. The backend is
          Go; the reference behaviour is TypeScript, cross-checked by a live parity suite.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/playground">
            <Button size="lg">
              Try the playground <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link to="/docs">
            <Button size="lg" variant="secondary">
              Read the docs
            </Button>
          </Link>
          <span className="flex items-center gap-2 text-xs text-muted">
            {state === 'ok' ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CircleDashed className={`h-3.5 w-3.5 ${state === 'checking' ? 'animate-spin' : 'text-red-400'}`} />
            )}
            backend {state}
            {detail ? ` · ${detail}` : ''}
          </span>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { k: 'live sources', v: counts.live },
          { k: 'degraded (site-side)', v: counts.degraded },
          { k: 'planned', v: counts.planned },
        ].map((s) => (
          <Card key={s.k}>
            <CardContent className="pt-4">
              <div className="text-2xl font-semibold">{s.v}</div>
              <div className="text-xs text-muted">{s.k}</div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Sources</h2>
        <div ref={gridRef} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map((s) => (
            <Link key={s.path} to={s.path} className="tile group block">
              <Card className="h-full transition hover:border-accent">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="group-hover:text-accent">{s.label}</CardTitle>
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
                  {s.endpoints.slice(0, 3).map((e) => (
                    <code key={e} className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-muted">
                      {e}
                    </code>
                  ))}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Pages</h2>
        <div className="flex flex-wrap gap-2">
          {PRIMARY_PAGES.map((p) => (
            <Link key={p.href} to={p.href} className="text-sm text-muted hover:text-fg">
              {p.label} →
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
