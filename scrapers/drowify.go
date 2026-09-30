// drowify.go — Go port of drowify.ts (Drowify Music API on drowify-music.biz.id).
//
// Reference: drowify.ts — base https://drowify-music.biz.id, rateMs 500, plain
// JSON GET/POST endpoints. Every endpoint's payload is returned verbatim (the
// TS version is a thin JSON passthrough), so numbers are decoded with
// json.Number to round-trip exactly as JSON.parse → JSON.stringify would.
package scrapers

import (
	"errors"
	"strings"
)

// NewDrowify builds the Drowify scraper (exposed so a host binary can embed it).
func NewDrowify() Scraper { return drowifyScraper() }

func init() { register(drowifyScraper()) }

var drowifySite = NewSite(SiteConfig{
	Base:   "https://drowify-music.biz.id",
	RateMS: 500,
})

func drowifyGET(path string) (any, error) {
	raw, err := drowifySite.Fetch(path)
	if err != nil {
		return nil, err
	}
	return DecodeAny(raw)
}

func drowifyPOST(path string, body map[string]any) (any, error) {
	payload, err := JSONStringify(body)
	if err != nil {
		return nil, err
	}
	raw, err := drowifySite.PostJSON(path, payload, "")
	if err != nil {
		return nil, err
	}
	return DecodeAny(raw)
}

func drowifyScraper() Scraper {
	return Scraper{
		Name:  "drowify",
		Title: "Drowify Music Scraper",
		Commands: map[string]Command{
			"search": {
				Desc:  "Cari lagu, album, playlist & artis",
				Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					q := argAt(args, 0)
					if q == "" {
						return nil, errors.New("Query required")
					}
					return drowifyGET("/api/search?query=" + EncodeURIComponent(q) + "&type=all")
				},
			},
			"artist": {
				Desc:  "Detail artis",
				Usage: "<channelId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					id := argAt(args, 0)
					if id == "" {
						return nil, errors.New("channelId required")
					}
					return drowifyGET("/api/artist?id=" + EncodeURIComponent(id))
				},
			},
			"album": {
				Desc:  "Detail album / playlist + lagu",
				Usage: "<browseId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					id := argAt(args, 0)
					if id == "" {
						return nil, errors.New("browseId required")
					}
					return drowifyGET("/api/album?id=" + EncodeURIComponent(id))
				},
			},
			"lyrics": {
				Desc:  "Lirik lagu (tersinkronisasi)",
				Usage: "<videoId> [judul] [artis]",
				Run: func(args []string, _ map[string]string) (any, error) {
					id := argAt(args, 0)
					if id == "" {
						return nil, errors.New("videoId required")
					}
					path := "/api/lyrics?id=" + EncodeURIComponent(id)
					if t := argAt(args, 1); t != "" {
						path += "&title=" + EncodeURIComponent(t)
					}
					if a := argAt(args, 2); a != "" {
						path += "&artist=" + EncodeURIComponent(a)
					}
					return drowifyGET(path)
				},
			},
			"suggest": {
				Desc:  "Suggestion autocomplete",
				Usage: "<q>",
				Run: func(args []string, _ map[string]string) (any, error) {
					q := argAt(args, 0)
					if q == "" {
						return nil, errors.New("Query required")
					}
					return drowifyGET("/api/suggest?q=" + EncodeURIComponent(q))
				},
			},
			"audio": {
				Desc:  "Link audio / unduhan langsung",
				Usage: "<videoId|youtubeUrl>",
				Run: func(args []string, _ map[string]string) (any, error) {
					in := argAt(args, 0)
					if in == "" {
						return nil, errors.New("videoId or URL required")
					}
					// input becomes a body value, never a fetch target — no guard implications
					target := in
					low := strings.ToLower(in)
					if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
						target = "https://youtube.com/watch?v=" + in
					}
					return drowifyPOST("/api/ytplay", map[string]any{"query": target})
				},
			},
		},
	}
}

// argAt returns args[i] or "" (bounds-safe positional access).
func argAt(args []string, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	return args[i]
}
