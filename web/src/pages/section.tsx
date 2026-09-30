import * as React from 'react';
import { animate, stagger } from 'animejs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge, Input, Select } from '../components/ui/input';
import { Link } from '../lib/router';
import { apiGet, ApiRequestError } from '../lib/api';
import { SECTIONS, type SectionDef } from '../lib/sections';
import { cn } from '../lib/utils';
import { Loader2, Play, RefreshCw, Search as SearchIcon } from 'lucide-react';

/** Per-section live examples: an endpoint + how to call it from the browser. */
export interface Example {
  name: string;
  /** relative to /api/v1 */
  path: string;
  params?: Record<string, string | number | undefined>;
  /** optional inline input driving the params */
  input?: { key: string; placeholder: string };
}

interface SectionConfig {
  examples: Example[];
  /** shape-aware summary of a payload, shown next to the JSON */
  summarize?: (data: unknown) => Array<{ label: string; value: string }>;
}

const config: Record<string, SectionConfig> = {
  '/anime': {
    examples: [
      { name: 'home', path: '/home' },
      { name: 'schedule', path: '/schedule' },
      { name: 'search', path: '/search', params: { q: 'one piece' }, input: { key: 'q', placeholder: 'search anime…' } },
    ],
    summarize: (d) => {
      let count = Array.isArray(d) ? d.length : 0;
      if (!Array.isArray(d) && d && typeof d === 'object' && 'series' in d) {
        const series = d.series;
        if (Array.isArray(series)) count = series.length;
      }
      return [
        { label: 'items', value: String(count) },
        { label: 'type', value: Array.isArray(d) ? 'list' : typeof d },
      ];
    },
  },
  '/youtube': {
    examples: [
      { name: 'search', path: '/youtube/search', params: { q: 'lofi hip hop' }, input: { key: 'q', placeholder: 'search videos…' } },
      { name: 'info', path: '/youtube/info', params: { id: 'dQw4w9WgXcQ' } },
      { name: 'music search', path: '/youtube-music/search', params: { q: 'bad habits', filter: 'songs' } },
    ],
  },
  '/music': {
    examples: [
      { name: 'home', path: '/music/home' },
      { name: 'search', path: '/music/search', params: { q: 'bad habits' }, input: { key: 'q', placeholder: 'track, artist, album…' } },
    ],
  },
  '/film': {
    examples: [
      { name: 'list', path: '/lk21/list' },
      { name: 'sections', path: '/lk21/sections' },
      { name: 'detail', path: '/lk21/detail', params: { slug: 'uprising-2026' }, input: { key: 'slug', placeholder: 'film slug…' } },
    ],
  },
  '/tiktok': {
    examples: [
      { name: 'user', path: '/tiktok/user', params: { username: 'nasa' }, input: { key: 'username', placeholder: 'username' } },
    ],
  },
  '/whitehouse': {
    examples: [
      { name: 'home', path: '/whitehouse/home' },
      { name: 'news', path: '/whitehouse/sections', params: { section: 'news' } },
    ],
  },
  '/drowify': {
    examples: [
      { name: 'search', path: '/drowify/search', params: { q: 'lofi' }, input: { key: 'q', placeholder: 'song…' } },
    ],
  },
  '/tools': {
    examples: [
      { name: 'styles', path: '/tools/image/styles' },
      { name: 'source', path: '/tools/source', params: { url: 'https://example.com' }, input: { key: 'url', placeholder: 'https://…' } },
    ],
  },
};

export function SectionPage({ section }: { section: SectionDef }) {
  const cfg = config[section.path] ?? { examples: [] };
  const [active, setActive] = React.useState(0);
  const [input, setInput] = React.useState('');
  const [data, setData] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const jsonRef = React.useRef<HTMLPreElement>(null);

  const example = cfg.examples[active];

  const load = React.useCallback(async () => {
    if (!example) return;
    setLoading(true);
    setError(null);
    const params = { ...example.params };
    if (example.input && input) params[example.input.key] = input;
    try {
      setData(await apiGet(example.path, params));
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.code}: ${e.message}` : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [example, input]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!data || !jsonRef.current) return;
    animate(jsonRef.current.querySelectorAll('.json-line'), {
      opacity: [0, 1],
      translateX: [-6, 0],
      delay: stagger(12),
      duration: 260,
      ease: 'outQuad',
    });
  }, [data]);

  const summary = cfg.summarize && data ? cfg.summarize(data) : null;
  const lines = data ? JSON.stringify(data, null, 2).split('\n') : [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
          <Badge className={cn(section.status === 'live' ? 'border-emerald-600/50 text-emerald-400' : 'border-amber-600/50 text-amber-400')}>
            {section.status}
          </Badge>
          <Badge>{section.runtime}</Badge>
          {section.source && <Badge>{section.source}</Badge>}
        </div>
        <p className="max-w-2xl text-sm text-muted">{section.blurb}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {cfg.examples.map((ex, i) => (
          <Button
            key={ex.path + ex.name}
            variant={i === active ? 'default' : 'secondary'}
            size="sm"
            onClick={() => {
              setActive(i);
              setInput('');
            }}
          >
            <Play className="h-3 w-3" /> {ex.name}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} run
        </Button>
      </div>

      {example?.input && (
        <div className="flex max-w-xl items-center gap-2">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted" />
          <Input
            value={input}
            placeholder={example.input.placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
          />
          <Button size="sm" onClick={() => void load()}>
            go
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>response</CardTitle>
              <CardDescription>
                GET {example?.path ?? '—'}
                {example?.params ? `?${new URLSearchParams(Object.entries(example.params).map(([k, v]) => [k, String(v)]))}` : ''}
              </CardDescription>
            </div>
            {error && <Badge className="border-red-600/50 text-red-400">error</Badge>}
          </CardHeader>
          <CardContent>
            {error ? (
              <p className="rounded-[var(--radius)] border border-red-600/40 bg-red-950/30 p-3 text-xs text-red-300">{error}</p>
            ) : loading ? (
              <p className="flex items-center gap-2 text-xs text-muted">
                <Loader2 className="h-3 w-3 animate-spin" /> fetching…
              </p>
            ) : (
              <pre ref={jsonRef} className="max-h-[28rem] overflow-auto text-[11px] leading-relaxed text-muted">
                {lines.map((l, i) => (
                  <div key={i} className="json-line whitespace-pre">
                    {l}
                  </div>
                ))}
              </pre>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>endpoints</CardTitle>
              <CardDescription>{section.endpoints.length} route(s) behind this page</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {section.endpoints.map((e) => (
                <code key={e} className="block truncate rounded-[var(--radius)] bg-bg px-2 py-1 text-[11px] text-muted">
                  {e}
                </code>
              ))}
            </CardContent>
          </Card>

          {summary && (
            <Card>
              <CardHeader>
                <CardTitle>summary</CardTitle>
                <CardDescription>shape of the current payload</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                {summary.map((s) => (
                  <div key={s.label} className="flex justify-between gap-4">
                    <span className="text-muted">{s.label}</span>
                    <span className="font-medium">{s.value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>other sources</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {SECTIONS.filter((s) => s.path !== section.path)
                .slice(0, 6)
                .map((s) => (
                  <Link key={s.path} to={s.path} className="text-xs text-muted hover:text-fg">
                    {s.label} →
                  </Link>
                ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
