/*
· base : https://tv12.lk21official.cc
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const BASE = 'https://tv12.lk21official.cc'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DELAY = 500

const headers = {
  'user-agent': UA,
  'accept': '*/*'
}

function decodeEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

async function get(url) {
  const res = await fetch(url, { headers, redirect: 'manual' })
  const text = await res.text()
  return { status: res.status, location: res.headers.get('location'), text }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseItem(block) {
  const item = {}
  const href = block.match(/<a href="\/([^\/\?"]+)"/)
  item.slug = href ? href[1] : null
  let m = block.match(/<meta itemprop="genre" content="([^"]+)"/)
    || block.match(/<div class="genre">([\s\S]*?)<\/div>/)
  item.genres = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  m = block.match(/<h3 class="poster-title"[^>]*>([\s\S]*?)<\/h3>/)
  item.title = m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : null
  m = block.match(/itemprop="ratingValue">([\s\S]*?)<\/span>/)
    || block.match(/<span class="rating">[\s\S]*?<\/i>([\s\S]*?)<\/span>/)
  item.rating = m ? m[1].trim() : null
  m = block.match(/itemprop="ratingCount" content="([^"]+)"/)
  item.ratingCount = m ? m[1] : null
  m = block.match(/class="year"[^>]*>([\s\S]*?)<\/span>/)
  item.year = m ? m[1].trim() : null
  item.isSeries = /class="episode/.test(block)
  m = block.match(/class="episode[^"]*">[\s\S]*?<strong>([\s\S]*?)<\/strong>/)
  item.episodes = m ? m[1].trim() : null
  m = block.match(/class="duration"[^>]*>([\s\S]*?)<\/span>/)
  item.duration = m ? m[1].trim() : null
  m = block.match(/class="label[^"]*"[^>]*>([\s\S]*?)<\/span>/)
  item.quality = m ? m[1].trim() : null
  m = block.match(/<img[^>]*data-src="([^"]+)"/) || block.match(/<img[^>]*src="([^"]+)"/)
  item.poster = m ? m[1] : null
  item.url = item.slug ? BASE + '/' + item.slug : null
  return item
}

function parseList(html, idHint) {
  let region = html
  if (idHint) {
    const start = html.indexOf('id="' + idHint + '"')
    if (start !== -1) {
      const end = html.indexOf('id="adHome5"', start)
      region = html.slice(start, end === -1 ? start + 500000 : end)
    }
  }
  return [...region.matchAll(/<article[\s\S]*?<\/article>/g)].map((m) => parseItem(m[0]))
}

async function getCompleteList() {
  const items = {}
  const home = await get(BASE + '/')
  if (home.status !== 200) throw new Error('Gagal memuat halaman utama: HTTP ' + home.status)
  for (const it of parseList(home.text, 'post-container')) if (it.slug) items[it.slug] = it

  for (let page = 2; ; page++) {
    const r = await get(BASE + '/loadmore-home/page/' + page)
    if (r.status !== 200 || !r.text.trim()) break
    const parsed = parseList(r.text)
    if (!parsed.length) break
    for (const it of parsed) if (it.slug) items[it.slug] = it
    await sleep(DELAY)
  }
  return Object.values(items)
}

function parseSectionItems(html) {
  const ul = html.match(/<ul class="sliders"[\s\S]*?<\/ul>/)
  if (!ul) return []
  return [...ul[0].matchAll(/<li class="slider"[\s\S]*?<\/li>/g)].map((m) => parseItem(m[0]))
}

async function getSections() {
  const home = await get(BASE + '/')
  if (home.status !== 200) throw new Error('Gagal memuat halaman utama: HTTP ' + home.status)

  const marks = [...home.text.matchAll(/<div class="widget"[^>]*>/g)].map((m) => m.index)
  const sections = []

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]
    const end = i + 1 < marks.length ? marks[i + 1] : home.text.indexOf('<footer', start)
    const slice = home.text.slice(start, end === -1 ? start + 400000 : end)
    const label = slice.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
    if (!label) continue
    const name = decodeEntities(label[1].replace(/<[^>]*>/g, '')).trim()
    const urlMatch = slice.match(/<a href="([^"]+)" class="btn btn-small">/)
    const type = (slice.match(/<div class="widget"[^>]*data-type="([^"]*)"/) || [])[1] || ''
    const items = parseSectionItems(slice)

    if (type) {
      for (let page = 2; ; page++) {
        const r = await get(BASE + '/loadmore/' + type + '/page/' + page)
        if (r.status !== 200 || !r.text.trim()) break
        const more = [...r.text.matchAll(/<li class="slider"[\s\S]*?<\/li>/g)].map((m) => parseItem(m[0]))
        if (!more.length) break
        items.push(...more)
        await sleep(DELAY)
      }
    }

    sections.push({
      name,
      type,
      url: urlMatch ? urlMatch[1] : null,
      total: items.length,
      items
    })
  }
  return sections
}

function parseDetail(html, item) {
  const d = { ...item }

  let m = html.match(/<script id="watch-history-data" type="application\/json">([\s\S]*?)<\/script>/)
  if (m) {
    try {
      const j = JSON.parse(m[1])
      d.id = j.id
      d.title = j.title
      d.year = j.year
      d.runtime = j.runtime
      d.rating = j.rating
      d.poster = j.poster
    } catch (e) {}
  }

  m = html.match(/<div class="main-player"[^>]*data-post_id="([^"]+)"[^>]*data-related_type="([^"]+)"/)
  if (m) {
    d.id = m[1]
    d.type = m[2]
  }

  m = html.match(/<h1>([\s\S]*?)<\/h1><div class="info-tag">([\s\S]*?)<\/div><div class="tag-list">([\s\S]*?)<\/div>/)
  if (m) {
    d.title = d.title || decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim()
    d.info = m[2].match(/<span>([\s\S]*?)<\/span>/g)
      ? m[2].match(/<span>([\s\S]*?)<\/span>/g).map((s) => s.replace(/<\/?span>/g, '').trim())
      : []
    d.tags = [...m[3].matchAll(/<span class="tag"><a href="([^"]+)">([\s\S]*?)<\/a><\/span>/g)]
      .map((t) => ({ url: t[1], name: decodeEntities(t[2].replace(/<[^>]*>/g, '')).trim() }))
    d.genres = d.tags.filter((t) => t.url.startsWith('/genre/')).map((t) => t.name)
    d.countries = d.tags.filter((t) => t.url.startsWith('/country/')).map((t) => t.name)
  }

  m = html.match(/<div class="synopsis[^"]*">([\s\S]*?)<\/div>/)
  d.synopsis = m ? decodeEntities(m[1].replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '')).trim() : null

  m = html.match(/<div class="detail hidden">([\s\S]*?)<\/div>/)
  if (m) {
    const detail = {}
    for (const dm of m[1].matchAll(/<p><span>[\s\S]*?<\/span>\s*([\s\S]*?)<\/p>/g)) {
      const raw = dm[1].replace(/<[^>]*>/g, '').trim()
      const keyMatch = dm[0].match(/<span>([\s\S]*?)<\/span>/)
      if (keyMatch) detail[decodeEntities(keyMatch[1]).replace(/<\/?span>/g, '').replace(/:$/, '').trim()] = decodeEntities(raw)
    }
    d.details = detail
  }

  m = html.match(/<iframe id="main-player"[^>]*src="([^"]+)"/)
  d.player = m ? m[1] : null

  m = html.match(/id="player-list"\s*([\s\S]*?)<\/ul>/)
  if (m) {
    d.players = [...m[1].matchAll(/<li><a href="([^"]+)"[^>]*data-server="([^"]*)">/g)]
      .map((p) => ({ server: p[2], url: p[1] }))
  }

  m = html.match(/<a href="([^"]*dadadidi[^"]*)"[^>]*title="Download[^"]*"/)
  d.downloadUrl = m ? m[1] : null

  m = html.match(/<a href="(https:\/\/www\.youtube\.com\/watch\?v=[^"]+)"[^>]*class="yt-lightbox"/)
  d.trailerUrl = m ? m[1] : null

  return d
}

async function getDetail(slug) {
  const r = await get(BASE + '/' + slug)
  if (r.status === 302) {
    return { slug, status: 'redirect', redirectUrl: r.location }
  }
  if (r.status !== 200) {
    return { slug, status: 'error', message: 'HTTP ' + r.status }
  }
  if (!/watch-history-data/.test(r.text)) {
    const m = r.text.match(/href="(https:\/\/[^"]+)"[^>]*id="openNow"/)
    if (m) return { slug, status: 'redirect', redirectUrl: m[1] }
    throw new Error('Respon tidak dikenali untuk ' + slug)
  }
  return parseDetail(r.text, { slug })
}

async function main() {
  const arg = process.argv[2]

  if (arg === '--sections') {
    console.error('Mengambil semua bagian halaman utama ' + BASE + ' ...')
    const sections = await getSections()
    console.log(JSON.stringify(sections, null, 2))
    return
  }

  if (arg && arg !== '--detail' && !arg.startsWith('--')) {
    const d = await getDetail(arg.trim())
    console.log(JSON.stringify(d, null, 2))
    return
  }

  if (arg && !['--detail'].includes(arg)) {
    console.log('Usage:')
    console.log('  node scraper.js              Ambil seluruh daftar lengkap film terbaru')
    console.log('  node scraper.js --sections   Ambil semua bagian di halaman utama (film terbaru, rekomendasi bulan ini, dll)')
    console.log('  node scraper.js --detail     Ambil daftar lengkap + detail tiap film')
    console.log('  node scraper.js <slug>       Ambil detail satu film (contoh: night-nurse-2026)')
    return
  }

  console.error('Mengambil daftar lengkap film dari ' + BASE + ' ...')
  const list = await getCompleteList()
  console.error('Total film ditemukan: ' + list.length + '\n')

  let result = list
  if (arg === '--detail') {
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      try {
        result[i] = await getDetail(it.slug)
      } catch (e) {
        result[i] = { ...it, status: 'error', message: e.message }
      }
      console.error('[' + (i + 1) + '/' + list.length + '] ' + it.title)
      await sleep(DELAY)
    }
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => console.log(JSON.stringify({ status: false, message: e.message }, null, 2)))