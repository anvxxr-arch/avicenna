#!/usr/bin/env bun
/*
- base : https://anilist.co
- creator : phrzy
- migrated to core/ (spec 003) — dual entry: bot handler (export default) + CLI
*/

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

import { defineCli } from './core/cli';
import { createSite } from './core/fetch';

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): void };

const site = createSite({
  base: 'https://anilist.co',
  rateMs: 600,
  headers: {
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
});
const { fetchPage } = site;

interface MediaCard { title: string; link: string; image: string; rank?: string; }

function grabCards($: CheerioAPI, section: string, withRank = false): MediaCard[] {
  const out: MediaCard[] = [];
  $(`.landing-section.${section} .results .media-card`).each((_, el) => {
    const $el = $(el);
    const title = $el.find('.title').text().trim();
    const hrefv = $el.find('a.cover').attr('href');
    const image = $el.find('img.image').attr('src') || '';
    if (!title || !hrefv) return;
    const card: MediaCard = { title, link: 'https://anilist.co' + hrefv, image };
    if (withRank) card.rank = $el.find('.rank').text().trim();
    out.push(card);
  });
  return out;
}

async function anilistPopuler(): Promise<{ trending: MediaCard[]; populer: MediaCard[]; upcoming: MediaCard[]; top: MediaCard[] } | null> {
  try {
    const html = await fetchPage('https://anilist.co');
    const $ = cheerio.load(html);
    const trending = grabCards($, 'trending');
    const populer = grabCards($, 'season');
    const upcoming = grabCards($, 'nextSeason');
    const top = grabCards($, 'top', true);
    // anilist.co is a Vue SPA (since ~2024): HTML ships no server-rendered cards, and
    // the GraphQL API is periodically disabled server-side. Surface that instead of [].
    if (!trending.length && !populer.length && !upcoming.length && !top.length) {
      throw new Error('anilist.co served no server-rendered cards (SPA) — official GraphQL API (graphql.anilist.co) is the data path when enabled; scraping path kept for parity');
    }
    return { trending, populer, upcoming, top };
  } catch (error) {
    console.error('Error scraping AniList:', error);
    return null;
  }
}

async function anilistSearch(query: string): Promise<Array<{ title: string; imageUrl: string; link: string }> | null> {
  try {
    const html = await fetchPage(`https://anilist.co/search/anime?query=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    const results: Array<{ title: string; imageUrl: string; link: string }> = [];
    $('.media-card').each((_, element) => {
      const title = $(element).find('.title').text().trim();
      const imageUrl = $(element).find('.image').attr('src') || '';
      const link = $(element).find('.cover').attr('href') || '';
      if (title && imageUrl && link) {
        results.push({ title, imageUrl, link: `https://anilist.co${link}` });
      }
    });
    return results;
  } catch (error) {
    console.error('Error fetching data:', error);
    return null;
  }
}

async function translate(text: string, lang = 'id'): Promise<{ status: boolean; result: { tr: string } }> {
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`);
    const data = await res.json() as unknown[];
    const hasil = (data?.[0] as unknown[])?.[0] as unknown[];
    return { status: true, result: { tr: String(hasil?.[0] ?? text) } };
  } catch {
    return { status: false, result: { tr: text } };
  }
}

async function anilistDetail(url: string): Promise<Record<string, unknown>> {
  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    const cleanText = (text: string) => text.replace(/\n\s+/g, ' ').trim();
    const safeTranslate = async (text: string) => (await translate(text)).result.tr;

    const descriptionText = cleanText($('.description.content-wrap').text());
    const descriptionParagraphs = descriptionText.split('\n').filter((p) => p.trim() !== '');
    const translatedParagraphs = await Promise.all(descriptionParagraphs.map((p) => safeTranslate(p)));

    const dataSet = (label: string) => cleanText($(`div.data-set:contains("${label}") .value`).text());
    const listIn = (label: string) => $(`div.data-set:contains("${label}") .value a`).map((_, el) => cleanText($(el).text())).get();

    return {
      title: {
        romaji: cleanText($('.content h1').first().text()),
        english: dataSet('English'),
        native: dataSet('Native'),
        translated: {
          romaji: await safeTranslate(cleanText($('.content h1').first().text())),
          english: await safeTranslate(dataSet('English')),
          native: await safeTranslate(dataSet('Native')),
        },
      },
      description: {
        original: descriptionText,
        translated: translatedParagraphs.join('\n\n'),
        paragraphs: { original: descriptionParagraphs, translated: translatedParagraphs },
      },
      cover: $('.cover-wrap-inner .cover').attr('src'),
      banner: $('.banner').css('background-image')
        ? $('.banner').css('background-image')!.replace(/^url\(\s*['"]?|['"]?\s*\)$/g, '')
        : null,
      details: {
        format: dataSet('Format'),
        episodes: dataSet('Episodes'),
        status: dataSet('Status'),
        season: dataSet('Season'),
        averageScore: dataSet('Average Score'),
        popularity: dataSet('Popularity'),
      },
      genres: {
        original: listIn('Genres').join(', '),
        translated: await Promise.all(listIn('Genres').map((g) => safeTranslate(g))),
      },
      studios: {
        original: listIn('Studios'),
        translated: await Promise.all(listIn('Studios').map((s) => safeTranslate(s))),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// === BOT HANDLER (dual entry — preserved for bot framework) ===
const handler = async (m: { chat: string; reply(s: string): Promise<unknown> }, { conn, usedPrefix, args }: { conn: { sendMessage(chat: string, msg: unknown, opts?: unknown): Promise<unknown> }; usedPrefix: string; args: string[] }) => {
  try {
    if (!args[0]) {
      return m.reply(`Contoh penggunaan: ${usedPrefix}anilist search <query>`);
    }
    const subCommand = args[0].toLowerCase();
    const query = args.slice(1).join(' ');

    switch (subCommand) {
      case 'search': {
        if (!query) return m.reply('Masukkan query pencarian!');
        const searchResults = await anilistSearch(query);
        if (!searchResults || searchResults.length === 0) return m.reply('Tidak ada hasil ditemukan.');
        const searchMessage = searchResults
          .map((result, index) => `${index + 1}. ${result.title}\nLink: ${result.link}`)
          .join('\n\n');
        await conn.sendMessage(m.chat, { image: { url: searchResults[0].imageUrl }, caption: `Hasil pencarian:\n\n${searchMessage}` }, { quoted: m });
        break;
      }
      case 'detail': {
        if (!query) return m.reply('Masukkan URL anime!');
        const detailResults = await anilistDetail(query) as Record<string, unknown>;
        if (detailResults.error) return m.reply('Gagal mengambil detail anime.');
        const d = detailResults as never; // shape documented in CLI path
        await conn.sendMessage(m.chat, { image: { url: (d as { cover: string }).cover }, caption: JSON.stringify(detailResults).slice(0, 3000) }, { quoted: m });
        break;
      }
      case 'populer': {
        const populerResults = await anilistPopuler();
        if (!populerResults) return m.reply('Gagal mengambil data anime populer.');
        const populerMessage = `
🎉 *Trending Anime:*
${populerResults.trending.map((anime, index) => `${index + 1}. ${anime.title}`).join('\n')}

🔥 *Populer Anime:*
${populerResults.populer.map((anime, index) => `${index + 1}. ${anime.title}`).join('\n')}

🚀 *Upcoming Anime:*
${populerResults.upcoming.map((anime, index) => `${index + 1}. ${anime.title}`).join('\n')}

🏆 *Top Anime:*
${populerResults.top.map((anime, index) => `${index + 1}. ${anime.title} (Rank: ${anime.rank})`).join('\n')}
`;
        await conn.sendMessage(m.chat, { image: { url: populerResults.trending[0]?.image }, caption: populerMessage }, { quoted: m });
        break;
      }
      default:
        return m.reply(`Subcommand tidak valid. Gunakan ${usedPrefix}anilist search, detail, atau populer.`);
    }
  } catch (error) {
    console.error('Error:', error);
    await m.reply('Terjadi kesalahan saat memproses permintaan.');
  }
};

handler.help = ['anilist'].map((v) => v + ' <search|detail|populer> <query>');
handler.command = /^(anilist)$/i;
handler.tags = ['anime'];
handler.limit = false;

export default handler;

// === CLI (second entry — same functions, JSON out) ===
if (import.meta.main) {
  defineCli({
    name: 'anilist',
    title: 'AniList Scraper',
    commands: {
      populer: { desc: 'Trending/populer/upcoming/top dari halaman utama', run: async () => anilistPopuler() },
      search: { desc: 'Cari anime', usage: '<query>', run: async (p) => { if (!p[0]) throw new Error('Query required'); return anilistSearch(p.join(' ')); } },
      detail: { desc: 'Detail anime + terjemahan ID', usage: '<url>', run: async (p) => { if (!p[0]) throw new Error('URL required'); return anilistDetail(p[0]); } },
    },
    examples: `  bun anilist.ts search "frieren"
  bun anilist.ts populer`,
  });
}
