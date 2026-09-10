/**
 * core/parse.ts — shared HTML/JS parsing helpers (single source of truth).
 * Extracted verbatim from nontonanime.ts (spec 003 phase 0). Behavior frozen.
 */
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string } };

export type { Cheerio, CheerioAPI, AnyNode };

export function safeCheerio(html: string): CheerioAPI {
  const src = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  return cheerio.load(src);
}

/** Whitespace-collapse + trim + cap. max counts UTF-16 code units (JS .slice semantics). */
export function txt(s: string | undefined, max = 300): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  // JS .slice(max) semantics: count UTF-16 code units, never split a rune
  let n16 = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.codePointAt(i)!;
    n16 += c > 0xffff ? 2 : 1;
    if (c > 0xffff) i++; // surrogate pair consumed as one
    if (n16 > max) return t.slice(0, i);
  }
  return t;
}

export function num(s: string | undefined): string {
  return s ? s.replace(/[^0-9.]/g, '').trim() : '';
}

/** First non-empty text across selectors (title fallback chains). */
export function firstText($: CheerioAPI, sels: string[], max = 300): string {
  for (const s of sels) {
    const t = txt($(s).first().text(), max);
    if (t) return t;
  }
  return '';
}

export function img($el: Cheerio<AnyNode>): string {
  const $i = $el.find('img').first();
  return $i.attr('data-src') || $i.attr('data-lazy-src') || $i.attr('src') || '';
}

export function href($el: Cheerio<AnyNode>): string {
  return $el.find('a').first().attr('href') || '';
}

/** Nonce format guard (shared by player_ajax + loadmore). */
export function isNonce(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{6,20}$/i.test(s);
}

/** String-aware balanced-brace slice (braces inside "..." don't count). */
export function sliceBalanced(src: string, start: number, limit = 20000): string {
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(src.length, start + limit);
  for (let p = start; p < end; p++) {
    const ch = src[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, p + 1);
    }
  }
  return '';
}

export function extractEpisodeFromUrl(url: string): string {
  const m = url.match(/(?:episode[-/](\d+))|(?:\/(\d+)(?:\/|\.html|$))/i);
  return m ? (m[1] || m[2] || '') : '';
}

export function extractPostId(url: string): string {
  const m = url.match(/\/(\d{4,})\.html/i);
  return m ? m[1] : '';
}

/** Decode `data:text/javascript;base64,` script extras. Tries each var name (site rotates names). */
export function extractPageVar(html: string, ...varNames: string[]): Record<string, unknown> | null {
  const $ = safeCheerio(html);
  const scripts: string[] = [];
  $('script[src^="data:text/javascript;base64,"]').each((_, el) => {
    scripts.push(($(el).attr('src') || '').slice('data:text/javascript;base64,'.length));
  });
  $('script:not([src])').each((_, el) => {
    const t = $(el).html() || '';
    if (varNames.some((v) => t.includes(v))) scripts.push(Buffer.from(t).toString('base64'));
  });
  for (const b64 of scripts) {
    try {
      const js = Buffer.from(b64, 'base64').toString('utf-8');
      const hit = varNames.map((v) => js.indexOf('var ' + v + '=')).find((i) => i !== -1);
      if (hit === undefined) continue;
      const start = js.indexOf('{', hit);
      if (start === -1) continue;
      const slice = sliceBalanced(js, start);
      if (!slice) continue;
      return JSON.parse(slice) as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

export const IFRAME_SRC_RE = /<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/i;
export const URL_RE = /https?:\/\/[^\s"'\\<>]+/;

export function extractEmbedUrl(html: string): string {
  const $ = safeCheerio(html);
  const direct = $('iframe').first().attr('src') || $('iframe').first().attr('data-src')
    || $('video source').attr('src') || $('video').attr('src') || '';
  if (direct) return direct;
  const m = html.match(IFRAME_SRC_RE) || html.match(URL_RE);
  return m ? m[1] || m[0] : '';
}

/** Generic card parser — kills duplicated .each loops. */
export function parseCards(
  $: CheerioAPI, sel: string,
  pick: ($el: Cheerio<AnyNode>) => { title: string; url: string } | null,
): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  $(sel).each((_, el) => {
    const c = pick($(el));
    if (c && c.title && c.url) out.push(c);
  });
  return out;
}
