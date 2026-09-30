import * as React from 'react';
import { Nav } from './components/nav';
import { HomePage } from './pages/home';
import { DocsPage } from './pages/docs';
import { PlaygroundPage } from './pages/playground';
import { AboutPage } from './pages/about';
import { SectionPage } from './pages/section';
import { Link, useRoute } from './lib/router';
import { SECTIONS } from './lib/sections';
import { Button } from './components/ui/button';

/** All static routes, in match order. */
const ROUTES = ['/', '/docs', '/playground', '/about', ...SECTIONS.map((s) => s.path)];

function NotFound({ path }: { path: string }) {
  return (
    <div className="space-y-4 py-16 text-center">
      <p className="text-5xl font-semibold tracking-tight">404</p>
      <p className="text-sm text-muted">
        No page at <code className="text-fg">{path}</code>.
      </p>
      <div className="flex justify-center gap-2">
        <Link to="/">
          <Button>Home</Button>
        </Link>
        <Link to="/docs">
          <Button variant="secondary">Docs</Button>
        </Link>
      </div>
    </div>
  );
}

function Router() {
  const match = useRoute(ROUTES);
  if (!match) return <NotFound path={location.pathname} />;
  switch (match.path) {
    case '/':
      return <HomePage />;
    case '/docs':
      return <DocsPage />;
    case '/playground':
      return <PlaygroundPage />;
    case '/about':
      return <AboutPage />;
    default: {
      const section = SECTIONS.find((s) => s.path === match.path);
      return section ? <SectionPage section={section} /> : <NotFound path={location.pathname} />;
    }
  }
}

export function App() {
  return (
    <div className="min-h-dvh">
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <Router />
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-muted">
        Avicenna · Go backend · <Link to="/docs" className="hover:text-fg">docs</Link> ·{" "}
        <Link to="/playground" className="hover:text-fg">playground</Link> ·{" "}
        <Link to="/about" className="hover:text-fg">about</Link>
      </footer>
    </div>
  );
}
