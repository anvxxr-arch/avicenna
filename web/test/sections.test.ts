/**
 * sections.ts — the section registry is the single source for the nav, the docs
 * page and the playground, so a malformed entry shows up as a broken link in
 * three places at once. These are the invariants the registry has to keep; the
 * server-side half of the contract (does the endpoint actually exist?) lives in
 * tools/webroutes.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PRIMARY_PAGES, SECTIONS, getSection } from '../src/lib/sections';

describe('section registry', () => {
  test('is not empty', () => {
    expect(SECTIONS.length).toBeGreaterThan(0);
  });

  test('paths are absolute and unique', () => {
    const paths = SECTIONS.map((s) => s.path);
    for (const p of paths) expect(p.startsWith('/')).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('labels are present and unique', () => {
    const labels = SECTIONS.map((s) => s.label);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('status and runtime stay inside their unions', () => {
    for (const s of SECTIONS) {
      expect(['live', 'degraded', 'planned']).toContain(s.status);
      expect(['go', 'bun', 'rust']).toContain(s.runtime);
    }
  });

  test('every section names at least one endpoint', () => {
    for (const s of SECTIONS) {
      expect(s.endpoints.length).toBeGreaterThan(0);
    }
  });

  test('endpoints are clean paths — no stray whitespace, no scheme', () => {
    for (const s of SECTIONS) {
      for (const e of s.endpoints) {
        // '(planned)' is the documented promise marker, so check the path part
        const path = e.replace(/ \(planned\)$/, '');
        expect(path).toBe(path.trim());
        expect(path.startsWith('/')).toBe(true);
        expect(path).not.toContain(' '); // a space inside the path is a typo
        expect(path).not.toContain('//');
        expect(path).not.toContain('://');
      }
    }
  });

  test('planned sections promise, live sections deliver', () => {
    for (const s of SECTIONS) {
      const promised = s.endpoints.every((e) => e.endsWith('(planned)'));
      if (s.status === 'planned') {
        expect(promised).toBe(true);
      } else {
        // a live row must not advertise a route as future work
        for (const e of s.endpoints) expect(e).not.toContain('(planned)');
      }
    }
  });

  test('a live row with more than one endpoint names them all distinctly', () => {
    for (const s of SECTIONS) {
      const seen = new Set<string>();
      for (const e of s.endpoints) {
        expect(seen.has(e)).toBe(false);
        seen.add(e);
      }
    }
  });
});

describe('primary pages', () => {
  test('hrefs are absolute and unique', () => {
    const hrefs = PRIMARY_PAGES.map((p) => p.href);
    for (const h of hrefs) expect(h.startsWith('/')).toBe(true);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test('every primary page has a label', () => {
    for (const p of PRIMARY_PAGES) expect(p.label.trim().length).toBeGreaterThan(0);
  });
});

describe('getSection', () => {
  test('finds a known section and reports an unknown one as undefined', () => {
    const first = SECTIONS[0];
    expect(getSection(first.path)).toBe(first);
    expect(getSection('/definitely-not-a-section')).toBeUndefined();
    expect(getSection('')).toBeUndefined();
  });
});
