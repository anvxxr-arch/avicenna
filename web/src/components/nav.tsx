import * as React from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/input';
import { SECTIONS, PRIMARY_PAGES } from '../lib/sections';
import { Link, useRoute } from '../lib/router';
import { cn } from '../lib/utils';
import { Menu, X } from 'lucide-react';

const NAV_ROUTES = [
  ...PRIMARY_PAGES.map((p) => p.href),
  ...SECTIONS.map((s) => s.path),
];

const STATUS_TONE: Record<string, string> = {
  live: 'border-emerald-600/50 text-emerald-400',
  degraded: 'border-amber-600/50 text-amber-400',
  planned: 'border-zinc-600/50 text-zinc-400',
};

export function Nav() {
  const [open, setOpen] = React.useState(false);
  const match = useRoute(NAV_ROUTES);
  const active = match?.path ?? '/';

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-[var(--radius)] bg-accent text-accent-fg">A</span>
          Avicenna
        </Link>
        <Badge className="hidden sm:inline-flex">api v1 · go backend</Badge>

        <nav className="ml-auto hidden items-center gap-1 lg:flex">
          {PRIMARY_PAGES.map((p) => (
            <Link
              key={p.href}
              to={p.href}
              className={cn(
                'rounded-[var(--radius)] px-3 py-1.5 text-sm text-muted transition hover:text-fg',
                active === p.href && 'bg-surface text-fg',
              )}
            >
              {p.label}
            </Link>
          ))}
          {SECTIONS.slice(0, 6).map((s) => (
            <Link
              key={s.path}
              to={s.path}
              className={cn(
                'rounded-[var(--radius)] px-3 py-1.5 text-sm text-muted transition hover:text-fg',
                active === s.path && 'bg-surface text-fg',
              )}
            >
              {s.label}
            </Link>
          ))}
          <Link to="/docs" className="rounded-[var(--radius)] px-3 py-1.5 text-sm text-muted transition hover:text-fg">
            Docs
          </Link>
        </nav>

        <Button variant="ghost" size="icon" className="ml-auto lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </Button>
      </div>

      {open && (
        <div className="border-t border-border bg-surface lg:hidden">
          <div className="mx-auto grid max-w-7xl gap-1 p-3 sm:grid-cols-2">
            {[...PRIMARY_PAGES, ...SECTIONS].map((entry) => {
              const path = 'path' in entry ? entry.path : entry.href;
              const label = entry.label;
              const status = 'status' in entry ? entry.status : undefined;
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center justify-between rounded-[var(--radius)] px-3 py-2 text-sm text-muted hover:bg-bg hover:text-fg',
                    active === path && 'bg-bg text-fg',
                  )}
                >
                  {label}
                  {status && (
                    <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', STATUS_TONE[status])}>{status}</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}
