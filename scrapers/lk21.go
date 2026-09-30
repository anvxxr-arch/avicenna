// lk21.go — Go port of lk21.ts (tv12.lk21official.cc).
//
// Reference: lk21.ts — base https://tv12.lk21official.cc, rateMs 500, pure
// regex HTML parsing (no cheerio). Reproduces the legacy field sets of
// parseItem/parseDetail verbatim, including the "Respon tidak dikenali untuk
// <slug>" guard for a Cloudflare challenge/soft block.
package scrapers

import (
	"errors"
	"regexp"
	"strings"
	"time"
)

// NewLK21 builds the LK21 scraper (embeddable).
func NewLK21() Scraper { return lk21Scraper() }

func init() { register(lk21Scraper()) }

const (
	lk21Base    = "https://tv12.lk21official.cc"
	lk21DelayMS = 500
)

var lk21Site = NewSite(SiteConfig{
	Base:   lk21Base,
	RateMS: 500,
	Headers: map[string]string{
		"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		"accept":     "*/*",
	},
})

var lk21EntityReplacer = strings.NewReplacer(
	"&quot;", `"`,
	"&#039;", "'",
	"&#39;", "'",
	"&amp;", "&",
	"&lt;", "<",
	"&gt;", ">",
	"&nbsp;", " ",
)

func decodeEntities(s string) string { return lk21EntityReplacer.Replace(s) }

var lk21TagRe = regexp.MustCompile(`<[^>]*>`)

func stripTags(s string) string { return lk21TagRe.ReplaceAllString(s, "") }

// lk21Regexes — the TS patterns, translated one-for-one.
var (
	lk21ArticleRe = regexp.MustCompile(`(?s)<article.*?</article>`)
	// parseItem patterns
	lk21ItemHrefRe      = regexp.MustCompile(`<a href="/([^/?"]+)"`)
	lk21GenreMetaRe     = regexp.MustCompile(`<meta itemprop="genre" content="([^"]+)"`)
	lk21GenreDivRe      = regexp.MustCompile(`(?s)<div class="genre">(.*?)</div>`)
	lk21PosterTitleRe   = regexp.MustCompile(`(?s)<h3 class="poster-title"[^>]*>(.*?)</h3>`)
	lk21RatingValueRe   = regexp.MustCompile(`(?s)itemprop="ratingValue">(.*?)</span>`)
	lk21RatingSpanRe    = regexp.MustCompile(`(?s)<span class="rating">.*?</i>(.*?)</span>`)
	lk21RatingCountRe   = regexp.MustCompile(`itemprop="ratingCount" content="([^"]+)"`)
	lk21YearRe          = regexp.MustCompile(`(?s)class="year"[^>]*>(.*?)</span>`)
	lk21EpisodeClassRe  = regexp.MustCompile(`class="episode`)
	lk21EpisodeStrongRe = regexp.MustCompile(`(?s)class="episode[^"]*">.*?<strong>(.*?)</strong>`)
	lk21DurationRe      = regexp.MustCompile(`(?s)class="duration"[^>]*>(.*?)</span>`)
	lk21LabelRe         = regexp.MustCompile(`(?s)class="label[^"]*"[^>]*>(.*?)</span>`)
	lk21ImgDataSrcRe    = regexp.MustCompile(`<img[^>]*data-src="([^"]+)"`)
	lk21ImgSrcRe        = regexp.MustCompile(`<img[^>]*src="([^"]+)"`)
	// sections
	lk21SlidersRe    = regexp.MustCompile(`(?s)<ul class="sliders".*?</ul>`)
	lk21SliderLiRe   = regexp.MustCompile(`(?s)<li class="slider".*?</li>`)
	lk21WidgetRe     = regexp.MustCompile(`<div class="widget"[^>]*>`)
	lk21WidgetTypeRe = regexp.MustCompile(`<div class="widget"[^>]*data-type="([^"]*)"`)
	lk21H2Re         = regexp.MustCompile(`(?s)<h2[^>]*>(.*?)</h2>`)
	lk21SectionBtnRe = regexp.MustCompile(`<a href="([^"]+)" class="btn btn-small">`)
	// detail
	lk21WatchHistoryRe = regexp.MustCompile(`(?s)<script id="watch-history-data" type="application/json">(.*?)</script>`)
	lk21MainPlayerRe   = regexp.MustCompile(`<div class="main-player"[^>]*data-post_id="([^"]+)"[^>]*data-related_type="([^"]+)"`)
	lk21InfoBlockRe    = regexp.MustCompile(`(?s)<h1>(.*?)</h1><div class="info-tag">(.*?)</div><div class="tag-list">(.*?)</div>`)
	lk21SpanRe         = regexp.MustCompile(`(?s)<span>(.*?)</span>`)
	lk21TagItemRe      = regexp.MustCompile(`(?s)<span class="tag"><a href="([^"]+)">(.*?)</a></span>`)
	lk21SynopsisRe     = regexp.MustCompile(`(?s)<div class="synopsis[^"]*">(.*?)</div>`)
	lk21BrRe           = regexp.MustCompile(`<br\s*/?>`)
	lk21DetailHiddenRe = regexp.MustCompile(`(?s)<div class="detail hidden">(.*?)</div>`)
	lk21DetailPRe      = regexp.MustCompile(`(?s)<p><span>.*?</span>\s*(.*?)</p>`)
	lk21IframeRe       = regexp.MustCompile(`<iframe id="main-player"[^>]*src="([^"]+)"`)
	lk21PlayerListRe   = regexp.MustCompile(`(?s)id="player-list"\s*(.*?)</ul>`)
	lk21PlayerItemRe   = regexp.MustCompile(`<li><a href="([^"]+)"[^>]*data-server="([^"]*)">`)
	lk21DownloadRe     = regexp.MustCompile(`<a href="([^"]*dadadidi[^"]*)"[^>]*title="Download[^"]*"`)
	lk21TrailerRe      = regexp.MustCompile(`<a href="(https://www\.youtube\.com/watch\?v=[^"]+)"[^>]*class="yt-lightbox"`)
	lk21OpenNowRe      = regexp.MustCompile(`href="(https://[^"]+)"[^>]*id="openNow"`)
	lk21SlugRe         = regexp.MustCompile(`^[a-z0-9-]+$`)
)

func lk21Abs(href string) any {
	if href == "" {
		return nil
	}
	if strings.HasPrefix(href, "http") {
		return href
	}
	return lk21Base + href
}

// parseItem mirrors parseItem() — the full legacy field set.
func parseItem(block string) map[string]any {
	item := map[string]any{}
	if m := lk21ItemHrefRe.FindStringSubmatch(block); m != nil {
		item["slug"] = m[1]
	} else {
		item["slug"] = nil
	}
	genres := []any{}
	m := lk21GenreMetaRe.FindStringSubmatch(block)
	if m == nil {
		m = lk21GenreDivRe.FindStringSubmatch(block)
	}
	if m != nil {
		for _, part := range strings.Split(m[1], ",") {
			if t := strings.TrimSpace(part); t != "" {
				genres = append(genres, t)
			}
		}
	}
	item["genres"] = genres
	if m := lk21PosterTitleRe.FindStringSubmatch(block); m != nil {
		item["title"] = strings.TrimSpace(decodeEntities(stripTags(m[1])))
	} else {
		item["title"] = nil
	}
	m = lk21RatingValueRe.FindStringSubmatch(block)
	if m == nil {
		m = lk21RatingSpanRe.FindStringSubmatch(block)
	}
	if m != nil {
		item["rating"] = strings.TrimSpace(m[1])
	} else {
		item["rating"] = nil
	}
	if m := lk21RatingCountRe.FindStringSubmatch(block); m != nil {
		item["ratingCount"] = m[1]
	} else {
		item["ratingCount"] = nil
	}
	if m := lk21YearRe.FindStringSubmatch(block); m != nil {
		item["year"] = strings.TrimSpace(m[1])
	} else {
		item["year"] = nil
	}
	item["isSeries"] = lk21EpisodeClassRe.MatchString(block)
	if m := lk21EpisodeStrongRe.FindStringSubmatch(block); m != nil {
		item["episodes"] = strings.TrimSpace(m[1])
	} else {
		item["episodes"] = nil
	}
	if m := lk21DurationRe.FindStringSubmatch(block); m != nil {
		item["duration"] = strings.TrimSpace(m[1])
	} else {
		item["duration"] = nil
	}
	if m := lk21LabelRe.FindStringSubmatch(block); m != nil {
		item["quality"] = strings.TrimSpace(m[1])
	} else {
		item["quality"] = nil
	}
	m = lk21ImgDataSrcRe.FindStringSubmatch(block)
	if m == nil {
		m = lk21ImgSrcRe.FindStringSubmatch(block)
	}
	if m != nil {
		item["poster"] = m[1]
	} else {
		item["poster"] = nil
	}
	if slug, ok := item["slug"].(string); ok && slug != "" {
		item["url"] = lk21Base + "/" + slug
	} else {
		item["url"] = nil
	}
	return item
}

// parseList mirrors parseList().
func parseList(html, idHint string) []map[string]any {
	region := html
	if idHint != "" {
		if start := strings.Index(html, `id="`+idHint+`"`); start != -1 {
			end := strings.Index(html[start:], `id="adHome5"`)
			if end == -1 {
				end = start + 500000
			} else {
				end += start
			}
			if end > len(html) {
				end = len(html)
			}
			region = html[start:end]
		}
	}
	out := []map[string]any{}
	for _, m := range lk21ArticleRe.FindAllString(region, -1) {
		out = append(out, parseItem(m))
	}
	return out
}

func toAnyList(in []map[string]any) []any {
	out := make([]any, 0, len(in))
	for _, v := range in {
		out = append(out, v)
	}
	return out
}

// getCompleteList mirrors getCompleteList(): home page + /loadmore-home/page/N.
func getCompleteList() (any, error) {
	items := map[string]map[string]any{}
	order := []string{}
	add := func(list []map[string]any) {
		for _, it := range list {
			slug, _ := it["slug"].(string)
			if slug == "" {
				continue
			}
			if _, seen := items[slug]; !seen {
				order = append(order, slug)
			}
			items[slug] = it
		}
	}
	home, err := lk21Site.Fetch("/")
	if err != nil {
		return nil, err
	}
	add(parseList(home, "post-container"))
	for page := 2; ; page++ {
		text, err := lk21Site.Fetch("/loadmore-home/page/" + itoa(page))
		if err != nil {
			// 404 = end of list; WAF/5xx must surface instead of silently truncating
			if strings.Contains(err.Error(), "HTTP 404") {
				break
			}
			return nil, err
		}
		if strings.TrimSpace(text) == "" {
			break
		}
		parsed := parseList(text, "")
		if len(parsed) == 0 {
			break
		}
		add(parsed)
		time.Sleep(lk21DelayMS * time.Millisecond)
	}
	out := make([]any, 0, len(order))
	for _, slug := range order {
		out = append(out, items[slug])
	}
	return out, nil
}

func parseSectionItems(html string) []map[string]any {
	ul := lk21SlidersRe.FindString(html)
	if ul == "" {
		return nil
	}
	out := []map[string]any{}
	for _, m := range lk21SliderLiRe.FindAllString(ul, -1) {
		out = append(out, parseItem(m))
	}
	return out
}

func getSections() (any, error) {
	home, err := lk21Site.Fetch("/")
	if err != nil {
		return nil, err
	}
	marks := []int{}
	for _, loc := range lk21WidgetRe.FindAllStringIndex(home, -1) {
		marks = append(marks, loc[0])
	}
	sections := []any{}
	for i, start := range marks {
		end := -1
		if i+1 < len(marks) {
			end = marks[i+1]
		} else {
			end = strings.Index(home[start:], "<footer")
			if end != -1 {
				end += start
			}
		}
		if end == -1 {
			end = start + 400000
		}
		if end > len(home) {
			end = len(home)
		}
		if start > end {
			continue
		}
		slice := home[start:end]
		label := lk21H2Re.FindStringSubmatch(slice)
		if label == nil {
			continue
		}
		name := strings.TrimSpace(decodeEntities(stripTags(label[1])))
		var url any
		if m := lk21SectionBtnRe.FindStringSubmatch(slice); m != nil {
			url = m[1]
		}
		typ := ""
		if m := lk21WidgetTypeRe.FindStringSubmatch(slice); m != nil {
			typ = m[1]
		}
		items := parseSectionItems(slice)
		// legacy: sections carrying a `data-type` continue over /loadmore/<type>/page/N
		if typ != "" {
			for page := 2; ; page++ {
				text, err := lk21Site.Fetch(lk21Base + "/loadmore/" + typ + "/page/" + itoa(page))
				if err != nil {
					if strings.Contains(err.Error(), "HTTP 404") {
						break
					}
					return nil, err
				}
				if strings.TrimSpace(text) == "" {
					break
				}
				more := []map[string]any{}
				for _, m := range lk21SliderLiRe.FindAllString(text, -1) {
					more = append(more, parseItem(m))
				}
				if len(more) == 0 {
					break
				}
				items = append(items, more...)
				time.Sleep(lk21DelayMS * time.Millisecond)
			}
		}
		sections = append(sections, map[string]any{
			"name":  name,
			"type":  typ,
			"url":   url,
			"total": len(items),
			"items": toAnyList(items),
		})
	}
	return sections, nil
}

// parseDetail mirrors parseDetail() — the full legacy field set.
func parseDetail(html string, item map[string]any) map[string]any {
	d := map[string]any{}
	for k, v := range item {
		d[k] = v
	}
	if m := lk21WatchHistoryRe.FindStringSubmatch(html); m != nil {
		if j, err := DecodeObject(m[1]); err == nil {
			if v, ok := j["id"]; ok {
				d["id"] = v
			}
			if v, ok := j["title"]; ok {
				d["title"] = v
			}
			if v, ok := j["year"]; ok {
				d["year"] = v
			}
			if v, ok := j["runtime"]; ok {
				d["runtime"] = v
			}
			if v, ok := j["rating"]; ok {
				d["rating"] = v
			}
			if v, ok := j["poster"]; ok {
				d["poster"] = v
			}
		}
		// malformed payload — keep the scraped values
	}
	if m := lk21MainPlayerRe.FindStringSubmatch(html); m != nil {
		d["id"] = m[1]
		d["type"] = m[2]
	}
	if m := lk21InfoBlockRe.FindStringSubmatch(html); m != nil {
		if cur, ok := d["title"].(string); !ok || cur == "" {
			d["title"] = strings.TrimSpace(decodeEntities(stripTags(m[1])))
		}
		spans := lk21SpanRe.FindAllString(m[2], -1)
		info := []any{}
		if spans != nil {
			for _, x := range spans {
				info = append(info, strings.TrimSpace(stripSpanTags(x)))
			}
		}
		d["info"] = info
		tags := []any{}
		genres := []any{}
		countries := []any{}
		for _, t := range lk21TagItemRe.FindAllStringSubmatch(m[3], -1) {
			name := strings.TrimSpace(decodeEntities(stripTags(t[2])))
			tags = append(tags, map[string]any{"url": t[1], "name": name})
			if strings.HasPrefix(t[1], "/genre/") {
				genres = append(genres, name)
			}
			if strings.HasPrefix(t[1], "/country/") {
				countries = append(countries, name)
			}
		}
		d["tags"] = tags
		d["genres"] = genres
		d["countries"] = countries
	}
	if m := lk21SynopsisRe.FindStringSubmatch(html); m != nil {
		text := lk21BrRe.ReplaceAllString(m[1], "\n")
		d["synopsis"] = strings.TrimSpace(decodeEntities(stripTags(text)))
	} else {
		d["synopsis"] = nil
	}
	if m := lk21DetailHiddenRe.FindStringSubmatch(html); m != nil {
		detail := map[string]any{}
		for _, dm := range lk21DetailPRe.FindAllStringSubmatch(m[1], -1) {
			raw := strings.TrimSpace(stripTags(dm[1]))
			km := lk21SpanRe.FindStringSubmatch(dm[0])
			if km == nil {
				continue
			}
			key := strings.TrimSpace(strings.TrimSuffix(decodeEntities(stripSpanTags(km[1])), ":"))
			detail[key] = decodeEntities(raw)
		}
		d["details"] = detail
	}
	if m := lk21IframeRe.FindStringSubmatch(html); m != nil {
		d["player"] = m[1]
	} else {
		d["player"] = nil
	}
	if m := lk21PlayerListRe.FindStringSubmatch(html); m != nil {
		players := []any{}
		for _, p := range lk21PlayerItemRe.FindAllStringSubmatch(m[1], -1) {
			players = append(players, map[string]any{"server": p[2], "url": p[1]})
		}
		d["players"] = players
	}
	if m := lk21DownloadRe.FindStringSubmatch(html); m != nil {
		d["downloadUrl"] = m[1]
	} else {
		d["downloadUrl"] = nil
	}
	if m := lk21TrailerRe.FindStringSubmatch(html); m != nil {
		d["trailerUrl"] = m[1]
	} else {
		d["trailerUrl"] = nil
	}
	d["site"] = lk21Base
	return d
}

var lk21SpanTagRe = regexp.MustCompile(`</?span>`)

func stripSpanTags(s string) string { return lk21SpanTagRe.ReplaceAllString(s, "") }

func getDetail(slug string) (any, error) {
	if !lk21SlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug (a-z 0-9 - only)")
	}
	html, err := lk21Site.Fetch("/" + slug + "/")
	if err != nil {
		return nil, err
	}
	// a challenge/soft block must not be reported as an empty film
	if !strings.Contains(html, "watch-history-data") {
		return nil, errors.New("Respon tidak dikenali untuk " + slug)
	}
	if m := lk21OpenNowRe.FindStringSubmatch(html); m != nil {
		return map[string]any{"slug": slug, "status": "redirect", "redirectUrl": m[1]}, nil
	}
	return parseDetail(html, map[string]any{"slug": slug}), nil
}

func lk21Scraper() Scraper {
	return Scraper{
		Name:  "lk21",
		Title: "LK21 Scraper (tv12.lk21official.cc)",
		Commands: map[string]Command{
			"list": {
				Desc: "Seluruh daftar lengkap film terbaru",
				Run: func([]string, map[string]string) (any, error) {
					return getCompleteList()
				},
			},
			"sections": {
				Desc: "Semua bagian di halaman utama (terbaru, rekomendasi, dll)",
				Run: func([]string, map[string]string) (any, error) {
					return getSections()
				},
			},
			"detail": {
				Desc:  "Detail satu film",
				Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					slug := argAt(args, 0)
					if slug == "" {
						return nil, errors.New("Slug required (e.g. night-nurse-2026)")
					}
					return getDetail(strings.TrimSpace(slug))
				},
			},
			"list-detail": {
				Desc: "Daftar lengkap + detail tiap film (SLOW)",
				Run: func([]string, map[string]string) (any, error) {
					listAny, err := getCompleteList()
					if err != nil {
						return nil, err
					}
					list, _ := listAny.([]any)
					result := []any{}
					for _, it := range list {
						entry, _ := it.(map[string]any)
						slug, _ := entry["slug"].(string)
						detail, derr := getDetail(slug)
						if derr != nil {
							merged := map[string]any{}
							for k, v := range entry {
								merged[k] = v
							}
							merged["status"] = "error"
							merged["message"] = derr.Error()
							result = append(result, merged)
						} else {
							result = append(result, detail)
						}
						time.Sleep(lk21DelayMS * time.Millisecond)
					}
					return result, nil
				},
			},
		},
	}
}
