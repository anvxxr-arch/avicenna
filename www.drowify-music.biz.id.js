/*
· base : https://drowify-music.biz.id
· creator : phrzy
· channel : https://whatsapp.com/channel/0029VbD1zGq6mYPUbtVh6U0L/121
*/

const BASE = 'https://drowify-music.biz.id'

async function get(path) {
  const r = await fetch(BASE + path)
  return r.json()
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return r.json()
}

async function search(q) {
  return get('/api/search?query=' + encodeURIComponent(q) + '&type=all')
}

async function artist(id) {
  return get('/api/artist?id=' + encodeURIComponent(id))
}

async function album(id) {
  return get('/api/album?id=' + encodeURIComponent(id))
}

async function lyrics(id, title, artistName) {
  let path = '/api/lyrics?id=' + encodeURIComponent(id)
  if (title) path += '&title=' + encodeURIComponent(title)
  if (artistName) path += '&artist=' + encodeURIComponent(artistName)
  return get(path)
}

async function suggest(q) {
  return get('/api/suggest?q=' + encodeURIComponent(q))
}

async function audio(input) {
  let url = input
  if (!/^https?:\/\//i.test(input)) {
    url = 'https://youtube.com/watch?v=' + input
  }
  return post('/api/ytplay', { query: url })
}

const usage = `Usage: node scraper.js <command> [args]

Commands:
  search <query>                 Cari lagu, album, playlist & artis
  artist <channelId>             Detail artis (lagu, album, video, artis serupa)
  album  <browseId>              Detail album / playlist + daftar lagu
  lyrics <videoId> [judul] [artis]   Lirik lagu (tersinkronisasi)
  suggest <q>                    Suggestion autocomplete
  audio  <videoId|youtubeUrl>    Link audio / unduhan langsung

Contoh:
  node scraper.js search "dangdut koplo"
  node scraper.js artist UCbwAI7LydeNSRU-bywK0EHw
  node scraper.js album MPREb_Jt4xwnzvfze
  node scraper.js lyrics bAoxY1jQnqo "bergema sampai selamanya" "Nadhif Basalamah"
  node scraper.js suggest tak
  node scraper.js audio bAoxY1jQnqo`

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2)

  if (!cmd) {
    console.log(usage)
    return
  }

  try {
    let data
    switch (cmd) {
      case 'search':
        if (!a) { console.log(usage); return }
        data = await search(a)
        break
      case 'artist':
        if (!a) { console.log(usage); return }
        data = await artist(a)
        break
      case 'album':
        if (!a) { console.log(usage); return }
        data = await album(a)
        break
      case 'lyrics':
        if (!a) { console.log(usage); return }
        data = await lyrics(a, b, c)
        break
      case 'suggest':
        if (!a) { console.log(usage); return }
        data = await suggest(a)
        break
      case 'audio':
        if (!a) { console.log(usage); return }
        data = await audio(a)
        break
      default:
        console.log('Perintah tidak dikenal: ' + cmd)
        console.log(usage)
        return
    }
    console.log(JSON.stringify(data, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ status: false, message: error.message }, null, 2))
  }
}

main()