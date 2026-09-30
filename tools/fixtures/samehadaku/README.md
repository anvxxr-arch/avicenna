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
| `detail.html` | `/anime/one-piece/` | `.infoanime`, `.whites.lsteps`, `.listbatch` |
| `episode.html` | `/one-piece-episode-1180/` | `.server_option`, `#downloadb` |
| `episode-head.html` | same | `h1.entry-title`, `.naveps` |
| `batch.html` | `/batch/one-piece-batch/` | `#downloadb` |

Refresh by re-capturing with a real browser session (the selectors above), then
re-run `go test ./scrapers/ -run Samehadaku`.
