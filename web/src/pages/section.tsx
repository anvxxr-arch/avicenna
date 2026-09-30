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
      { name: 'search', path: '/search', params: { q: 'one piece' }, input: { key: 'q', placeholder: 'search anime…' } },
      { name: 'schedule', path: '/schedule' },
      { name: 'genres', path: '/genres' },
      { name: 'season', path: '/season', params: { season: 'summer', year: '2026' } },
    ],
    summarize: (d) => {
      let count = Array.isArray(d) ? d.length : 0;
      if (!Array.isArray(d) && d && typeof d === 'object' && 'series' in d) {
        const series = d.series;
        if (series && typeof series === 'object') count = Object.keys(series).length;
      }
      return [
        { label: 'items', value: String(count) },
        { label: 'type', value: Array.isArray(d) ? 'list' : typeof d },
      ];
    },
  },
  '/samehadaku': {
    examples: [
      { name: 'home', path: '/samehadaku/home' },
      { name: 'search', path: '/samehadaku/search', params: { args: 'one piece' }, input: { key: 'args', placeholder: 'search anime…' } },
      { name: 'detail', path: '/samehadaku/detail', params: { args: 'one-piece' }, input: { key: 'args', placeholder: 'anime slug…' } },
      { name: 'episode', path: '/samehadaku/episode', params: { args: 'one-piece-episode-1180' } },
      { name: 'batch', path: '/samehadaku/batch', params: { args: 'one-piece-batch' } },
      { name: 'schedule', path: '/samehadaku/schedule', params: { args: 'sunday' }, input: { key: 'args', placeholder: 'monday…sunday' } },
      { name: 'api search', path: '/samehadaku/apksearch', params: { args: 'one piece' }, input: { key: 'args', placeholder: 'title → numeric ids…' } },
      { name: 'api episode', path: '/samehadaku/apk', params: { args: '54232' } },
    ],
  },
  '/film': {
    examples: [
      { name: 'detail', path: '/lk21/detail', params: { args: 'uprising-2026' }, input: { key: 'args', placeholder: 'film slug…' } },
      { name: 'list (slow)', path: '/lk21/list' },
      { name: 'sections (slow)', path: '/lk21/sections' },
    ],
  },
  '/music': {
    examples: [
      { name: 'track', path: '/spotify/track', params: { args: '6PQ88X9TkUIAUIZJHW2upE' } },
      { name: 'search', path: '/spotify/search', params: { args: 'bad habits' }, input: { key: 'args', placeholder: 'track, artist, album…' } },
      { name: 'home (slow)', path: '/spotify/home' },
    ],
  },
  '/youtube': {
    examples: [
      { name: 'video search', path: '/yt/search', params: { args: 'lofi hip hop' }, input: { key: 'args', placeholder: 'search videos…' } },
      { name: 'video info', path: '/yt/info', params: { args: 'dQw4w9WgXcQ' } },
      { name: 'related', path: '/yt/related', params: { args: 'dQw4w9WgXcQ' } },
      { name: 'music songs', path: '/ytmusic/search', params: { args: 'lofi', filter: 'songs' }, input: { key: 'args', placeholder: 'search songs…' } },
      { name: 'music lyrics', path: '/ytmusic/lyrics', params: { args: 'dQw4w9WgXcQ' } },
      { name: 'music related', path: '/ytmusic/related', params: { args: 'dQw4w9WgXcQ' } },
    ],
  },
  '/tiktok': {
    examples: [
      { name: 'user', path: '/tiktok/user', params: { args: 'nasa' }, input: { key: 'args', placeholder: 'username' } },
      { name: 'video', path: '/tiktok/video', params: { args: 'https://www.tiktok.com/@nasa/video/7550073333098442007' } },
    ],
  },
  '/drowify': {
    examples: [
      { name: 'search', path: '/drowify/search', params: { args: 'lofi' }, input: { key: 'args', placeholder: 'song…' } },
      { name: 'suggest', path: '/drowify/suggest', params: { args: 'lofi' } },
    ],
  },
  '/whitehouse': {
    examples: [
      { name: 'news', path: '/whitehouse/news' },
      { name: 'videos', path: '/whitehouse/videos' },
      { name: 'administration', path: '/whitehouse/administration' },
      { name: 'search', path: '/whitehouse/search', params: { args: 'executive order' }, input: { key: 'args', placeholder: 'keyword…' } },
    ],
  },
  '/tools': {
    examples: [
      { name: 'image styles', path: '/codeengo/styles' },
      { name: 'source token', path: '/viewpagesource/token' },
      { name: 'image styles', path: '/codeengo/styles' },
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
  /** No live endpoints wired yet: show the roadmap instead of an empty console. */
  const planned = section.status === 'planned' || cfg.examples.length === 0;

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
      {planned ? (
        <Card>
          <CardHeader>
            <CardTitle>not wired yet</CardTitle>
            <CardDescription>
              No backend route exists for this source yet. It is listed so the roadmap stays honest — the page becomes a
              live console the moment its scraper is registered under <code className="text-fg">/api/v1</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge>scraper: not ported</Badge>
              <Badge>runtime: {section.runtime}</Badge>
              <Badge>status: planned</Badge>
            </div>
            <p className="text-xs text-muted">
              Live instead: {SECTIONS.filter((s) => s.status !== 'planned').map((s) => s.label).join(' · ')}
            </p>
            <Link to="/docs">
              <Button size="sm" variant="secondary">see live routes</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
