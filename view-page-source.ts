#!/usr/bin/env bun
/*
- base : https://www.view-page-source.com/
- creator : phrzy
- migrated to core/ (spec 003) — ESM, hardened transport, uniform CLI
*/

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { defineCli } from './core/cli';
import { createSite } from './core/fetch';
import { safeCheerio, txt } from './core/parse';

declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string; byteLength(s: string): number } };

const site = createSite({
  base: 'https://www.view-page-source.com',
  rateMs: 400,
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  },
});
const { fetchPage, postAjax } = site;

interface FetchResult {
  html: string;
  metrics: Record<string, unknown> | null;
  serverInfo: unknown;
  pageInfo: unknown;
}

async function getToken(): Promise<string> {
  const raw = await fetchPage('/api/token');
  const parsed = JSON.parse(raw) as { token?: string };
  if (!parsed.token || !/^[a-f0-9]{16,128}$/i.test(parsed.token)) throw new Error('Token API returned invalid token');
  return parsed.token;
}

async function fetchSource(url: string, token: string): Promise<FetchResult> {
  const body = JSON.stringify({ url, token, stylize: false });
  // site contract is JSON POST; postAjax forces form content-type but the API parses both.
  const raw = await postAjax('/api/fetch', body);
  const parsed = JSON.parse(raw) as Partial<FetchResult>;
  if (typeof parsed.html !== 'string' || !parsed.html) throw new Error('Fetch API returned no HTML');
  return {
    html: parsed.html,
    metrics: parsed.metrics ?? null,
    serverInfo: parsed.serverInfo ?? null,
    pageInfo: parsed.pageInfo ?? null,
  };
}

function buildMeta(html: string, url: string): { url: string; title: string | null; meta: Record<string, string>; links: string[] } {
  const $ = safeCheerio(html);
  const title = txt($('title').first().text(), 500) || null;
  const meta: Record<string, string> = {};
  $('meta[name], meta[property], meta[itemprop]').each((_, el) => {
    const $el = $(el);
    const key = $el.attr('name') || $el.attr('property') || $el.attr('itemprop');
    const content = $el.attr('content');
    if (key && content) meta[key] = content;
  });
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const hrefv = $(el).attr('href');
    if (hrefv && !/^(mailto:|javascript:|#)/.test(hrefv)) links.push(hrefv);
  });
  return { url, title, meta, links: [...new Set(links)] };
}

async function viewpagesource(target: string): Promise<unknown> {
  // target is intentionally off-site — validate scheme + block private hosts directly
  let u: URL;
  try { u = new URL(target); } catch { throw new Error('Target must be a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Target must be http(s)');
  const host = u.hostname.toLowerCase();
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === '::1') {
    throw new Error('Private/loopback targets blocked');
  }
  const token = await getToken();
  const result = await fetchSource(target, token);
  const html = result.html;
  const id = createHash('md5').update(target).digest('hex').slice(0, 8);
  const file = `source_${id}.html`;
  writeFileSync(file, html, 'utf8');
  return {
    id,
    saved: file,
    bytes: new TextEncoder().encode(html).length,
    metrics: result.metrics,
    serverInfo: result.serverInfo,
    pageInfo: result.pageInfo,
    meta: buildMeta(html, target),
  };
}

if (import.meta.main) {
  defineCli({
    name: 'viewpagesource',
    title: 'View-Page-Source Scraper',
    commands: {
      view: {
        desc: 'Fetch rendered source of a URL, save + return meta',
        usage: '<url>',
        run: async (pos) => {
          const url = pos[0];
          if (!url) throw new Error('Target URL required');
          return viewpagesource(url);
        },
      },
      token: {
        desc: 'Fetch a fresh API token',
        run: async () => ({ token: await getToken() }),
      },
    },
    examples: `  bun view-page-source.ts view https://example.com`,
  });
}
