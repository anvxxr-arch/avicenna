import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge, Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { apiGet, API_BASE, ApiRequestError } from '../lib/api';
import { animate, stagger } from 'animejs';
import { Loader2, Send } from 'lucide-react';

/**
 * Playground: drive any backend route by hand. The route catalogue mirrors the
 * Go server's table; free-form path entry stays available for new routes.
 */
const PRESETS: Array<{ label: string; path: string; params?: Record<string, string> }> = [
  { label: 'health', path: '/health' },
  { label: 'anime home', path: '/home' },
  { label: 'anime search', path: '/search', params: { q: 'one piece' } },
  { label: 'schedule', path: '/schedule' },
  { label: 'film list', path: '/lk21/list' },
  { label: 'film detail', path: '/lk21/detail', params: { args: 'uprising-2026' } },
  { label: 'spotify search', path: '/spotify/search', params: { args: 'bad habits' } },
  { label: 'yt music songs', path: '/ytmusic/search', params: { args: 'lofi', filter: 'songs' } },
  { label: 'tiktok user', path: '/tiktok/user', params: { args: 'nasa' } },
  { label: 'whitehouse news', path: '/whitehouse/news' },
  { label: 'drowify search', path: '/drowify/search', params: { args: 'lofi' } },
];

function parseParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    if (i === -1) out[pair] = '';
    else out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export function PlaygroundPage() {
  const [path, setPath] = React.useState('/home');
  const [params, setParams] = React.useState('');
  const [data, setData] = React.useState<unknown>(null);
  const [meta, setMeta] = React.useState<{ ms: number; status: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const outRef = React.useRef<HTMLPreElement>(null);

  const send = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    try {
      const payload = await apiGet<unknown>(path, parseParams(params));
      setData(payload);
      setMeta({ ms: Math.round(performance.now() - t0), status: '200' });
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.code}: ${e.message}` : String(e));
      setMeta({ ms: Math.round(performance.now() - t0), status: e instanceof ApiRequestError ? String(e.status) : 'err' });
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [path, params]);

  React.useEffect(() => {
    if (!outRef.current || !data) return;
    animate(outRef.current.querySelectorAll('.json-line'), {
      opacity: [0, 1],
      translateY: [4, 0],
      delay: stagger(6),
      duration: 200,
      ease: 'outQuad',
    });
  }, [data]);

  const lines = data ? JSON.stringify(data, null, 2).split('\n') : [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="max-w-2xl text-sm text-muted">
          Every response uses the same envelope: <code className="text-fg">{'{ api, version, data }'}</code> on success and{" "}
          <code className="text-fg">{'{ api, version, error: { code, message } }'}</code> on failure. Base:{" "}
          <code className="text-fg">{API_BASE}</code>
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={path === p.path ? 'default' : 'secondary'}
            onClick={() => {
              setPath(p.path);
              setParams(p.params ? new URLSearchParams(p.params).toString() : '');
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home" aria-label="path" />
            <Input
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder="args=nasa&page=1"
              aria-label="query string"
              onKeyDown={(e) => e.key === 'Enter' && void send()}
            />
            <Button onClick={() => void send()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} send
            </Button>
          </div>
          <p className="text-[11px] text-muted">
            GET {API_BASE}
            {path}
            {params ? `?${params}` : ''}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>result</CardTitle>
            <CardDescription>{meta ? `${meta.status} · ${meta.ms}ms` : 'not sent yet'}</CardDescription>
          </div>
          {error && <Badge className="border-red-600/50 text-red-400">error</Badge>}
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="rounded-[var(--radius)] border border-red-600/40 bg-red-950/30 p-3 text-xs text-red-300">{error}</p>
          ) : !data ? (
            <p className="text-xs text-muted">Press send.</p>
          ) : (
            <pre ref={outRef} className="max-h-[32rem] overflow-auto text-[11px] leading-relaxed">
              {lines.map((l, i) => (
                <div key={i} className="json-line whitespace-pre text-muted">
                  {l}
                </div>
              ))}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
