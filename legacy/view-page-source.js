/*
· base : https://www.view-page-source.com/
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const fs = require('fs');

const BASE = 'https://www.view-page-source.com';

async function getToken() {
  const { data } = await axios.get(`${BASE}/api/token`);
  return data.token;
}

async function fetchSource(url, token) {
  const { data } = await axios.post(`${BASE}/api/fetch`, {
    url,
    token,
    stylize: false,
  });
  return data;
}

function buildMeta(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const meta = {};
  $('meta[name], meta[property], meta[itemprop]').each((_, el) => {
    const key = $(el).attr('name') || $(el).attr('property') || $(el).attr('itemprop');
    meta[key] = $(el).attr('content');
  });
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !/^(mailto:|javascript:|#)/.test(href)) links.push(href);
  });
  return { url, title, meta, links: [...new Set(links)] };
}

async function viewpagesource(target) {
  const token = await getToken();
  const result = await fetchSource(target, token);
  const html = result.html;
  const id = crypto.createHash('md5').update(target).digest('hex').slice(0, 8);
  const file = `source_${id}.html`;
  fs.writeFileSync(file, html, 'utf8');
  return {
    id,
    saved: file,
    bytes: Buffer.byteLength(html),
    metrics: result.metrics || null,
    serverInfo: result.serverInfo || null,
    pageInfo: result.pageInfo || null,
    meta: buildMeta(html, target),
  };
}

viewpagesource('https://example.com')
  .then(console.log)
  .catch(console.error);