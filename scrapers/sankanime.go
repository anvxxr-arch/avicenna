// sankanime.go — sankanime.web.id (Sankanime) adapter over the site's OFFICIAL
// API at www.sankavollerei.web.id.
//
// sankanime.web.id is a React SPA whose HTML carries an explicit notice to
// scrapers: "Please use our official API instead of scraping our site." The
// API docs live at https://www.sankavollerei.web.id/{anime,comic}; this
// adapter uses the comic surface (the anime surface proxies otakudesu /
// samehadaku, which already have adapters here).
//
// The API enforces 30 requests/minute with a 3-strike permanent ban, so the
// transport runs at 2.2s spacing (RateMS below) — slower than the site minimum.
//
// Payloads pass through as the API emits them (inside the usual
// {creator, page, url, data} envelope), except one upstream defect is fixed:
// /comic/chapter/ double-escapes unicode in manga_title (`\u2019` arrives as
// six literal chars), so escaped \uXXXX runs are decoded before output.
package scrapers

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

const (
	sankaBase = "https://www.sankavollerei.web.id"
	sankaUA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

var (
	sankaSite   *Site
	sankaSlugRe = regexp.MustCompile(`^[a-z0-9-]+$`)
	sankaURe    = regexp.MustCompile(`\\u([0-9a-fA-F]{4})`)
)

func init() {
	sankaSite = NewSite(SiteConfig{
		Base:   sankaBase,
		RateMS: 2200, // official limit: 30 req/min, 3 strikes → permanent ban
		Headers: map[string]string{
			"user-agent":      sankaUA,
			"accept":          "application/json, text/plain, */*",
			"accept-language": "id-ID,id;q=0.9,en;q=0.8",
		},
	})
	register(sankaScraper())
}

// sankaUnescape decodes \uXXXX runs the chapter endpoint double-escaped.
func sankaUnescape(s string) string {
	return sankaURe.ReplaceAllStringFunc(s, func(m string) string {
		n, err := strconv.ParseUint(m[2:], 16, 32)
		if err != nil {
			return m
		}
		return string(rune(n))
	})
}

// sankaFix walks the decoded payload and repairs double-escaped strings.
func sankaFix(v any) any {
	switch t := v.(type) {
	case string:
		return sankaUnescape(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = sankaFix(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = sankaFix(e)
		}
		return out
	default:
		return v
	}
}

// sankaGet GETs one API path and decodes the JSON object.
func sankaGet(path string) (map[string]any, string, error) {
	u := sankaBase + path
	res, err := siteRequest(sankaSite, u, "GET", nil, nil, true, []string{"www.sankavollerei.web.id"})
	if err != nil {
		return nil, u, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, u, errors.New("upstream error (HTTP " + strconv.Itoa(res.Status) + ")")
	}
	m, err := apiDecodeMap(res.Body)
	if err != nil {
		return nil, u, err
	}
	if msg := GetStr(m, "message"); msg != "" && GetStr(m, "status") == "" && m["data"] == nil && m["comics"] == nil {
		return nil, u, errors.New(msg)
	}
	return m, u, nil
}

func sankaBuild(page, u string, data map[string]any) map[string]any {
	return ScraperEnvelope("avicenna", page, u, data)
}

func sankaArg(args []string, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	return args[i]
}

func sankaPage(args []string, i int) int {
	n, err := strconv.Atoi(sankaArg(args, i))
	if err != nil || n < 1 {
		return 1
	}
	return n
}

func sankaScraper() Scraper {
	cmds := map[string]Command{
		"home": {Name: "home", Desc: "Section homepage (populer, terbaru, ranking)",
			Run: func(_ []string, _ map[string]string) (any, error) {
				m, u, err := sankaGet("/comic/homepage")
				if err != nil {
					return nil, err
				}
				return sankaBuild("home", u, map[string]any{
					"popular": m["popular"],
					"latest":  m["latest"],
					"ranking": m["ranking"],
				}), nil
			}},
		"terbaru": {Name: "terbaru", Desc: "Komik terbaru (per halaman)", Usage: "[page]",
			Run: func(args []string, _ map[string]string) (any, error) {
				m, u, err := sankaGet("/comic/terbaru?page=" + strconv.Itoa(sankaPage(args, 0)))
				if err != nil {
					return nil, err
				}
				return sankaBuild("terbaru", u, map[string]any{"items": m["comics"], "pagination": m["pagination"]}), nil
			}},
		"populer": {Name: "populer", Desc: "Komik populer", Run: func(_ []string, _ map[string]string) (any, error) {
			m, u, err := sankaGet("/comic/populer")
			if err != nil {
				return nil, err
			}
			return sankaBuild("populer", u, map[string]any{"items": m["comics"], "pagination": m["pagination"]}), nil
		}},
		"search": {Name: "search", Desc: "Cari komik", Usage: "<query>",
			Run: func(args []string, _ map[string]string) (any, error) {
				q := strings.Join(args, " ")
				if strings.TrimSpace(q) == "" {
					return nil, errors.New("Query required")
				}
				m, u, err := sankaGet("/comic/search?q=" + EncodeURIComponent(q))
				if err != nil {
					return nil, err
				}
				return sankaBuild("search", u, map[string]any{"query": q, "items": m["data"], "total": m["total"]}), nil
			}},
		"genrelist": {Name: "genrelist", Desc: "Daftar genre", Run: func(_ []string, _ map[string]string) (any, error) {
			m, u, err := sankaGet("/comic/genres")
			if err != nil {
				return nil, err
			}
			return sankaBuild("genreList", u, map[string]any{"genres": m["data"]}), nil
		}},
		"genre": {Name: "genre", Desc: "Komik per genre", Usage: "<slug> [page]",
			Run: func(args []string, _ map[string]string) (any, error) {
				slug := sankaArg(args, 0)
				if slug == "" {
					return nil, errors.New("Genre slug required")
				}
				if !sankaSlugRe.MatchString(slug) {
					return nil, errors.New("Invalid slug (a-z 0-9 - only)")
				}
				m, u, err := sankaGet("/comic/genre/" + slug + "?page=" + strconv.Itoa(sankaPage(args, 1)))
				if err != nil {
					return nil, err
				}
				return sankaBuild("genre", u, map[string]any{
					"genre": slug, "items": m["comics"], "pagination": m["pagination"], "metadata": m["metadata"],
				}), nil
			}},
		"detail": {Name: "detail", Desc: "Detail komik + daftar chapter", Usage: "<slug>",
			Run: func(args []string, _ map[string]string) (any, error) {
				slug := sankaArg(args, 0)
				if slug == "" {
					return nil, errors.New("Series slug required")
				}
				if !sankaSlugRe.MatchString(slug) {
					return nil, errors.New("Invalid slug (a-z 0-9 - only)")
				}
				m, u, err := sankaGet("/comic/comic/" + slug)
				if err != nil {
					return nil, err
				}
				delete(m, "creator") // the upstream attribution, not a series field
				return sankaBuild("detail", u, sankaFix(m).(map[string]any)), nil
			}},
		"chapter": {Name: "chapter", Desc: "Chapter + daftar gambar", Usage: "<slug>",
			Run: func(args []string, _ map[string]string) (any, error) {
				slug := sankaArg(args, 0)
				if slug == "" {
					return nil, errors.New("Chapter slug required")
				}
				if !sankaSlugRe.MatchString(slug) {
					return nil, errors.New("Invalid slug (a-z 0-9 - only)")
				}
				m, u, err := sankaGet("/comic/chapter/" + slug)
				if err != nil {
					return nil, err
				}
				delete(m, "creator")
				delete(m, "imagesproxy") // proxy mirrors of `images`; callers use the originals
				return sankaBuild("chapter", u, sankaFix(m).(map[string]any)), nil
			}},
		"supported": {Name: "supported", Desc: "List supported pages/features", Run: func(_ []string, _ map[string]string) (any, error) {
			return sankaBuild("supportedPages", sankaBase+"/", map[string]any{
				"home": true, "terbaru": true, "populer": true, "search": true,
				"genreList": true, "genre": true, "detail": true, "chapter": true,
			}), nil
		}},
	}
	return Scraper{Name: "sankanime", Title: "Sankanime Scraper (sankanime.web.id / official API)", Commands: cmds}
}
