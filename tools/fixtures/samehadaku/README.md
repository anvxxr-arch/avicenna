# samehadaku fixtures

Real captures of `v2.samehadaku.how` pages, trimmed to the blocks each parser
reads. They exist because the site sits behind a Cloudflare managed challenge:
plain HTTP clients get `Just a moment...` (403), so `scrapers/samehadaku_test.go`
pins the parsers against these instead.

| file | source page | blocks kept |
|---|---|---|
| `home.html` | `/` | `div.post-show` |
| `list.html` | `/anime-terbaru/` | `div.post-show` + `.pagination` |
| `search.html` | `/?s=one piece` | `.content-area` (`article.animpost`) |
| `search-live.html` | `/?s=one piece` (2026-10-08) | `.content-area` (`article.animepost`) |
| `detail-live.html` | `/anime/one-piece/` (2026-10-08, Tailwind redesign) | `h1[itemprop="headline"]`, `span.w-28.font-medium`, `div[class*=aspect-] img`, `span.font-extrabold`, `div.flex.items-center.gap-3` |
| `detail.html` | `/anime/one-piece/` | `.infoanime`, `.whites.lsteps`, `.listbatch` |
| `episode.html` | `/one-piece-episode-1180/` | `.server_option`, `#downloadb` |
| `episode-head.html` | same | `h1.entry-title`, `.naveps` |
| `batch.html` | `/batch/one-piece-batch/` | `#downloadb` |
| `apk-search.json` | `/wp-json/apk/search?s=one piece` | raw JSON (mobile API) |
| `apk-episode.json` | `/wp-json/apk/episode?id=54232` | raw JSON (mobile API) |

Refresh by re-capturing with a real browser session (the selectors above), then
re-run `go test ./scrapers/ -run Samehadaku`.
