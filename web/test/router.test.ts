/**
 * router.tsx — matchRoute decides which page renders for a deep link, so it is
 * reachable by anything a crawler or a user can type. It must return null for a
 * non-match (the app renders 404) and must never throw.
 */
import { describe, expect, test } from 'bun:test';
import { matchRoute } from '../src/lib/router';

describe('matchRoute', () => {
  test('matches a static route, with or without a trailing slash', () => {
    expect(matchRoute('/docs', '/docs')).toEqual({});
    expect(matchRoute('/docs', '/docs/')).toEqual({});
    expect(matchRoute('/', '/')).toEqual({});
  });

  test('returns null for a non-match so the app can render 404', () => {
    expect(matchRoute('/docs', '/nope')).toBeNull();
    expect(matchRoute('/docs', '/docs/extra')).toBeNull();
    expect(matchRoute('/docs', '/')).toBeNull();
  });

  test('is case-sensitive and exact', () => {
    expect(matchRoute('/docs', '/DOCS')).toBeNull();
    expect(matchRoute('/docs', '/docss')).toBeNull();
  });

  test('extracts named params', () => {
    expect(matchRoute('/anime/:slug', '/anime/black-torch')).toEqual({ slug: 'black-torch' });
    expect(matchRoute('/anime/:slug/:ep', '/anime/black-torch/1')).toEqual({ slug: 'black-torch', ep: '1' });
  });

  test('a param route requires the segment to exist', () => {
    expect(matchRoute('/anime/:slug', '/anime')).toBeNull();
    expect(matchRoute('/anime/:slug', '/anime/')).toBeNull();
    expect(matchRoute('/anime/:slug', '/anime/a/b')).toBeNull();
  });

  test('percent-decodes params, including unicode', () => {
    expect(matchRoute('/anime/:slug', '/anime/black%20torch')).toEqual({ slug: 'black torch' });
    expect(matchRoute('/anime/:slug', '/anime/%E6%97%A5%E6%9C%AC')).toEqual({ slug: '日本' });
  });

  // Regression: decodeURIComponent throws a URIError on a malformed escape, which
  // used to take the whole SPA down during render (a URL anyone can type).
  test('a malformed escape falls back to the raw segment instead of throwing', () => {
    expect(() => matchRoute('/anime/:slug', '/anime/%zz')).not.toThrow();
    expect(matchRoute('/anime/:slug', '/anime/%zz')).toEqual({ slug: '%zz' });
    expect(matchRoute('/anime/:slug', '/anime/100%')).toEqual({ slug: '100%' });
    expect(matchRoute('/anime/:slug', '/anime/%E6%97')).toEqual({ slug: '%E6%97' });
  });
});
