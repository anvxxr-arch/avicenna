import * as React from 'react';

/**
 * Minimal hash-free SPA router (History API). No dependency: the app has one
 * level of static routes plus a handful of parameterised detail routes.
 */
type Params = Record<string, string>;

interface RouteMatch {
  path: string;
  params: Params;
}

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  for (const l of listeners) l();
}

export function currentPath(): string {
  return location.pathname;
}

/**
 * Percent-decodes one path segment. A malformed escape (`/anime/%zz`, a URL
 * anyone can type or a crawler can invent) makes `decodeURIComponent` throw a
 * URIError, which would take the whole SPA down during render — the raw segment
 * is the honest fallback.
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `/anime/:slug` style matcher. Returns named params or null. */
export function matchRoute(pattern: string, path: string): Params | null {
  const pp = pattern.split('/').filter(Boolean);
  const cp = path.split('/').filter(Boolean);
  if (pp.length !== cp.length) return null;
  const params: Params = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = safeDecode(cp[i]);
    else if (seg !== cp[i]) return null;
  }
  return params;
}

function usePathname(): string {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const pop = () => cb();
      window.addEventListener('popstate', pop);
      return () => {
        listeners.delete(cb);
        window.removeEventListener('popstate', pop);
      };
    },
    () => location.pathname,
  );
}

export function useRoute(routes: string[]): RouteMatch | null {
  const path = usePathname();
  for (const r of routes) {
    const params = matchRoute(r, path);
    if (params) return { path: r, params };
  }
  return null;
}

/** Anchor that routes client-side but keeps real hrefs (middle-click, SEO). */
export function Link({
  to,
  className,
  children,
  ...rest
}: { to: string; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
