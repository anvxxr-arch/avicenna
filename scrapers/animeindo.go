// animeindo.go — Go port of animeindo.ts (anime-indo.lol HTML scraper).
//
// Reference: animeindo.ts — base https://anime-indo.lol, rateMs 500, cheerio
// selectors. Payload shapes (including the nested pagination/items/server
// objects) match the TS CLI output key for key; the third-party embed proxy
// hosts (play.<x>) are fetched through the explicit external-host path.
package scrapers

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const (
	aiBase = "https://anime-indo.lol"
	aiUA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

var aiSite = NewSite(SiteConfig{
	Base:   aiBase,
	RateMS: 500,
	Headers: map[string]string{
		"user-agent":      aiUA,
		"accept-language": "id-ID,id;q=0.9,en;q=0.8",
	},
})

// === TRANSPORT ===

// aiFetchHTML GETs an origin-pinned page, following same-host redirects
// (legacy /search.php?q= 302s to /search/<slug>/) and trimming the UTF-8 BOM
// some pages prepend. Uncached, matching `site.request(url, {follow:true})`.
func aiFetchHTML(rawURL string) (string, error) {
	res, err := aiSite.Do(RequestSpec{Method: "GET", URL: rawURL, Follow: true})
	if err != nil {
		return "", err
	}
	if res.Status < 200 || res.Status >= 300 {
		return "", fmt.Errorf("HTTP %d untuk %s", res.Status, rawURL)
	}
	return strings.TrimPrefix(res.BodyString(), "\uFEFF"), nil
}

// aiFetchPublic GETs a third-party embed/proxy page. The host is explicit (the
// URL's own origin); private/loopback targets stay rejected.
func aiFetchPublic(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", errors.New("Invalid URL")
	}
	txt, res, err := aiSite.ExternalText(rawURL, nil, "", []string{u.Hostname()})
	if err != nil {
		return "", err
	}
	if res.Status != 200 {
		return "", fmt.Errorf("HTTP %d untuk %s", res.Status, rawURL)
	}
	return strings.TrimPrefix(txt, "\uFEFF"), nil
}

// === HELPERS ===

var (
	aiEntityRe = strings.NewReplacer(
		"&quot;", `"`,
		"&#39;", "'",
		"&#039;", "'",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&nbsp;", " ",
	)
	aiSlugRe     = regexp.MustCompile(`^[a-z0-9-]+$`)
	aiGenreSlug  = regexp.MustCompile(`/genres/([^/]+)/?`)
	aiGVURLRe    = regexp.MustCompile(`https?://[^"'\s]*googlevideo\.com/videoplayback[^"'\s]*`)
	aiDigitsOnly = regexp.MustCompile(`^\d+$`)
)

func aiDecodeEntities(s string) string { return aiEntityRe.Replace(s) }

func aiBuild(page, u string, data map[string]any) map[string]any {
	return ScraperEnvelope("rynaqrtz", page, u, data)
}

func aiArg(args []string, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	return args[i]
}

func aiAttr(sel *goquery.Selection, name string) string {
	if sel == nil || sel.Length() == 0 {
		return ""
	}
	v, _ := sel.Attr(name)
	return v
}

// aiAbs mirrors `x.startsWith('http') ? x : BASE_URL + x`.
func aiAbs(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "http") {
		return raw
	}
	return aiBase + raw
}

func aiInt(s string) (int, bool) { return ParseIntJS(s) }

// === PARSERS ===

func aiPagination(doc *goquery.Document) map[string]any {
	result := map[string]any{"current": 1, "next": nil, "hasNext": false, "total": nil}
	type pageLink struct{ text, href string }
	var links []pageLink
	doc.Find(".pag a, .pag span, .pagination a, .pagination span").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		if href == "" {
			return
		}
		links = append(links, pageLink{text: strings.TrimSpace(el.Text()), href: href})
	})
	total := 0
	haveTotal := false
	for _, l := range links {
		if aiDigitsOnly.MatchString(l.text) {
			if n, err := strconv.Atoi(l.text); err == nil && (!haveTotal || n > total) {
				total, haveTotal = n, true
			}
		}
	}
	if haveTotal {
		result["total"] = total
	}
	cur := doc.Find(".pag .cur, .pagination .current").First()
	if cur.Length() > 0 {
		if t := strings.TrimSpace(cur.Text()); aiDigitsOnly.MatchString(t) {
			if n, err := strconv.Atoi(t); err == nil {
				result["current"] = n
			}
		}
	}
	curN, _ := result["current"].(int)
	if haveTotal && curN < total {
		result["hasNext"] = true
		for _, l := range links {
			if l.text == "»" || strings.Contains(strings.ToLower(l.text), "next") {
				result["next"] = aiAbs(l.href)
				break
			}
		}
	}
	return result
}

func aiCardHome(el *goquery.Selection) map[string]any {
	link := aiAttr(el.Parent().Filter("a").First(), "href")
	if link == "" {
		link = aiAttr(el.Find("a").First(), "href")
	}
	title := TxtSel(el.Find("p").First())
	image := aiAttr(el.Find("img").First(), "data-original")
	if image == "" {
		image = aiAttr(el.Find("img").First(), "src")
	}
	episode := TxtSel(el.Find(".eps").First())
	if link == "" {
		link = aiAttr(el.Find("a").First(), "href")
	}
	if link == "" || title == "" {
		return nil
	}
	return map[string]any{
		"title":   title,
		"url":     aiAbs(link),
		"image":   aiNullable(aiAbs(image)),
		"episode": aiNullable(episode),
	}
}

func aiNullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func aiCardTable(el *goquery.Selection) map[string]any {
	thumb := aiAttr(el.Find(".vithumb img").First(), "src")
	if thumb == "" {
		thumb = aiAttr(el.Find(".vithumb img").First(), "data-original")
	}
	titleSel := el.Find(".videsc a").First()
	title := TxtSel(titleSel)
	link := aiAttr(titleSel, "href")
	var labels []any
	el.Find(".label").Each(func(_ int, l *goquery.Selection) {
		labels = append(labels, strings.TrimSpace(l.Text()))
	})
	description := strings.TrimSpace(el.Find(".des").Text())
	if title == "" || link == "" {
		return nil
	}
	strs := make([]string, 0, len(labels))
	for _, l := range labels {
		strs = append(strs, l.(string))
	}
	typ := "tv"
	switch {
	case contains(strs, "Movie"):
		typ = "movie"
	case contains(strs, "LA"):
		typ = "liveaction"
	case contains(strs, "Special"):
		typ = "special"
	case contains(strs, "OVA"):
		typ = "ova"
	}
	var duration, year, status any
	for _, l := range strs {
		if duration == nil && (strings.Contains(l, "hr") || strings.Contains(l, "min")) {
			duration = l
		}
		if year == nil && aiYearRe.MatchString(l) {
			year = l
		}
		if status == nil && (l == "Completed" || l == "Currently Airing" || l == "Unknown") {
			status = l
		}
	}
	var thumbOut any
	if thumb != "" {
		thumbOut = aiAbs(thumb)
	}
	labelsOut := make([]any, len(strs))
	for i, s := range strs {
		labelsOut[i] = s
	}
	return map[string]any{
		"title":       title,
		"url":         aiAbs(link),
		"thumbnail":   thumbOut,
		"labels":      labelsOut,
		"description": description,
		"type":        typ,
		"duration":    duration,
		"year":        year,
		"status":      status,
	}
}

var aiYearRe = regexp.MustCompile(`^\d{4}$`)

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func aiEpisodeList(doc *goquery.Document) []map[string]any {
	out := []map[string]any{}
	doc.Find(".ep a").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		text := strings.TrimSpace(el.Text())
		n, ok := aiInt(text)
		if href == "" || !ok {
			return
		}
		out = append(out, map[string]any{
			"number": n,
			"title":  fmt.Sprintf("Episode %d", n),
			"url":    aiAbs(href),
		})
	})
	return out
}

func aiGenreList(doc *goquery.Document) []map[string]any {
	out := []map[string]any{}
	doc.Find(".list-genre a").Each(func(_ int, el *goquery.Selection) {
		name := strings.TrimSpace(el.Text())
		href, _ := el.Attr("href")
		if name == "" || href == "" {
			return
		}
		out = append(out, map[string]any{
			"name": name,
			"slug": aiGenreSlug.ReplaceAllString(href, "$1"),
			"url":  aiAbs(href),
		})
	})
	return out
}

func aiVideoURLs(doc *goquery.Document) map[string]any {
	servers := []any{}
	downloads := []any{}
	var iframe any
	if src, ok := doc.Find("#tontonin").Attr("src"); ok && src != "" {
		iframe = aiAbs(src)
	}
	doc.Find(".server").Each(func(_ int, el *goquery.Selection) {
		name := strings.TrimSpace(el.Text())
		v, ok := el.Attr("data-video")
		if !ok || v == "" {
			return
		}
		servers = append(servers, map[string]any{"name": name, "url": aiAbs(v)})
	})
	doc.Find(".navi a").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		text := strings.TrimSpace(el.Text())
		if href == "" {
			return
		}
		if strings.Contains(text, "Download") || strings.Contains(text, "Unduh") || strings.Contains(text, "GDrive") {
			downloads = append(downloads, map[string]any{"text": text, "url": aiAbs(href)})
		}
	})
	return map[string]any{"iframe": iframe, "servers": servers, "downloads": downloads}
}

// aiFetchDirectVideo walks the embed chain (proxy → iframe → video source) up
// to 5 hops and returns the first direct media URL (googlevideo etc).
func aiFetchDirectVideo(proxyURL string, depth int) any {
	if depth > 5 {
		return nil
	}
	html, err := aiFetchPublic(proxyURL)
	if err != nil {
		return nil
	}
	doc := SafeDoc(html)
	if src, ok := doc.Find("iframe").First().Attr("src"); ok && src != "" {
		if strings.Contains(src, "googlevideo.com") {
			return src
		}
		return aiFetchDirectVideo(src, depth+1)
	}
	videoSrc, ok := doc.Find("video source").First().Attr("src")
	if !ok || videoSrc == "" {
		videoSrc, _ = doc.Find("video").First().Attr("src")
	}
	if videoSrc != "" {
		return videoSrc
	}
	embed, ok := doc.Find(".embed-responsive iframe").First().Attr("src")
	if !ok || embed == "" {
		embed, _ = doc.Find("#player iframe").First().Attr("src")
	}
	if embed == "" {
		embed, _ = doc.Find(".player iframe").First().Attr("src")
	}
	if embed != "" {
		if strings.Contains(embed, "googlevideo.com") {
			return embed
		}
		return aiFetchDirectVideo(embed, depth+1)
	}
	if m := aiGVURLRe.FindString(html); m != "" {
		return m
	}
	return nil
}

// === COMMANDS ===

func aiHome(page int) (map[string]any, error) {
	u := aiBase + "/"
	if page != 1 {
		u = fmt.Sprintf("%s/page/%d/", aiBase, page)
	}
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".list-anime").Each(func(_ int, el *goquery.Selection) {
		if card := aiCardHome(el); card != nil {
			items = append(items, card)
		}
	})
	return aiBuild("home", u, map[string]any{"pagination": aiPagination(doc), "items": items}), nil
}

func aiGenreListCommand() (map[string]any, error) {
	u := aiBase + "/list-genre/"
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	genres := []any{}
	for _, g := range aiGenreList(doc) {
		genres = append(genres, g)
	}
	return aiBuild("genreList", u, map[string]any{"genres": genres}), nil
}

func aiGenre(slug string, page int) (map[string]any, error) {
	s := strings.ToLower(strings.TrimSpace(slug))
	if !aiSlugRe.MatchString(s) {
		return nil, errors.New("Invalid genre slug")
	}
	u := fmt.Sprintf("%s/genres/%s/", aiBase, s)
	if page != 1 {
		u = fmt.Sprintf("%s/genres/%s/page/%d/", aiBase, s, page)
	}
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".otable").Each(func(_ int, el *goquery.Selection) {
		if card := aiCardTable(el); card != nil {
			items = append(items, card)
		}
	})
	return aiBuild("genre", u, map[string]any{"slug": s, "pagination": aiPagination(doc), "items": items}), nil
}

func aiMovies(page int) (map[string]any, error) {
	u := aiBase + "/movie/"
	if page != 1 {
		u = fmt.Sprintf("%s/movie/page/%d/", aiBase, page)
	}
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".otable").Each(func(_ int, el *goquery.Selection) {
		if card := aiCardTable(el); card != nil {
			items = append(items, card)
		}
	})
	return aiBuild("movies", u, map[string]any{"pagination": aiPagination(doc), "items": items}), nil
}

func aiJadwal() (map[string]any, error) {
	u := aiBase + "/jadwal/"
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".anime-list li").Each(func(_ int, el *goquery.Selection) {
		if t := strings.TrimSpace(el.Text()); t != "" {
			items = append(items, t)
		}
	})
	return aiBuild("jadwal", u, map[string]any{"items": items}), nil
}

func aiSearch(query string) (map[string]any, error) {
	u := aiBase + "/search.php?q=" + EncodeURIComponent(query)
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".otable").Each(func(_ int, el *goquery.Selection) {
		if card := aiCardTable(el); card != nil {
			items = append(items, card)
		}
	})
	if len(items) == 0 {
		doc.Find(".list-anime").Each(func(_ int, el *goquery.Selection) {
			if card := aiCardHome(el); card != nil {
				items = append(items, card)
			}
		})
	}
	return aiBuild("search", u, map[string]any{"query": query, "items": items}), nil
}

func aiDetail(slug string) (map[string]any, error) {
	if !aiSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug")
	}
	u := fmt.Sprintf("%s/anime/%s/", aiBase, slug)
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	detail := doc.Find(".detail")
	title := TxtSel(doc.Find("h1.title").First())
	if title == "" {
		title = TxtSel(doc.Find("title").First())
	}
	var image any
	if src := aiAttr(detail.Find("img").First(), "src"); src != "" {
		image = aiAbs(src)
	}
	var description any
	if d := strings.TrimSpace(detail.Find("p").Text()); d != "" {
		description = d
	}
	genres := []any{}
	detail.Find("li a").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		genres = append(genres, map[string]any{
			"name": strings.TrimSpace(el.Text()),
			"url":  aiAbs(href),
		})
	})
	episodes := []any{}
	for _, e := range aiEpisodeList(doc) {
		episodes = append(episodes, e)
	}
	return aiBuild("detail", u, map[string]any{
		"title":       title,
		"image":       image,
		"description": description,
		"genres":      genres,
		"episodes":    episodes,
	}), nil
}

func aiEpisode(slug string) (map[string]any, error) {
	if !aiSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid episode slug")
	}
	u := fmt.Sprintf("%s/%s/", aiBase, slug)
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := TxtSel(doc.Find("h1.title").First())
	if title == "" {
		title = TxtSel(doc.Find("title").First())
	}
	video := aiVideoURLs(doc)
	var direct any
	if iframe, ok := video["iframe"].(string); ok && strings.Contains(iframe, "btube3.php") {
		direct = aiFetchDirectVideo(iframe, 0)
	}
	return aiBuild("episode", u, map[string]any{
		"title":       title,
		"iframe":      video["iframe"],
		"directVideo": direct,
		"servers":     video["servers"],
		"downloads":   video["downloads"],
	}), nil
}

func aiBatch(slug string) (map[string]any, error) {
	if !aiSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug")
	}
	u := fmt.Sprintf("%s/anime/%s/", aiBase, slug)
	html, err := aiFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := TxtSel(doc.Find("h1.title").First())
	if title == "" {
		title = TxtSel(doc.Find("title").First())
	}
	episodes := aiEpisodeList(doc)
	batchData := []any{}
	for i, ep := range episodes {
		if i >= 10 {
			break
		}
		num := ep["number"]
		epTitle := ep["title"]
		epURL, _ := ep["url"].(string)
		epHTML, ferr := aiFetchHTML(epURL)
		if ferr != nil {
			batchData = append(batchData, map[string]any{
				"episode": num, "title": epTitle, "error": ferr.Error(),
			})
			continue
		}
		epDoc := SafeDoc(epHTML)
		video := aiVideoURLs(epDoc)
		var direct any
		if iframe, ok := video["iframe"].(string); ok && strings.Contains(iframe, "btube3.php") {
			direct = aiFetchDirectVideo(iframe, 0)
		}
		batchData = append(batchData, map[string]any{
			"episode":     num,
			"title":       epTitle,
			"iframe":      video["iframe"],
			"directVideo": direct,
			"servers":     video["servers"],
			"downloads":   video["downloads"],
		})
	}
	return aiBuild("batch", u, map[string]any{"title": title, "episodes": batchData}), nil
}

func aiSupportedPages() map[string]any {
	return aiBuild("supportedPages", aiBase, map[string]any{
		"home": true, "genreList": true, "genre": true, "movies": true, "jadwal": true,
		"search": true, "detail": true, "episode": true, "watch": true, "batch": true,
	})
}

// NewAnimeIndo builds the AnimeIndo scraper (exposed so a host binary can embed it).
func NewAnimeIndo() Scraper { return animeIndoScraper() }

func init() { register(animeIndoScraper()) }

func animeIndoScraper() Scraper {
	return Scraper{
		Name:  "animeindo",
		Title: "AnimeIndo Scraper (anime-indo.lol)",
		Commands: map[string]Command{
			"home": {Name: "home", Desc: "Homepage (paginated)", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					n, _ := ParseIntJS(aiArg(args, 0))
					if n == 0 {
						n = 1
					}
					return aiHome(n)
				}},
			"genrelist": {Name: "genrelist", Desc: "Daftar genre",
				Run: func(_ []string, _ map[string]string) (any, error) { return aiGenreListCommand() }},
			"genre": {Name: "genre", Desc: "Anime per genre", Usage: "<slug> [page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Genre slug required")
					}
					n, _ := ParseIntJS(aiArg(args, 1))
					if n == 0 {
						n = 1
					}
					return aiGenre(aiArg(args, 0), n)
				}},
			"movies": {Name: "movies", Desc: "Daftar movie", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					n, _ := ParseIntJS(aiArg(args, 0))
					if n == 0 {
						n = 1
					}
					return aiMovies(n)
				}},
			"jadwal": {Name: "jadwal", Desc: "Jadwal mingguan",
				Run: func(_ []string, _ map[string]string) (any, error) { return aiJadwal() }},
			"search": {Name: "search", Desc: "Cari anime", Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Query required")
					}
					return aiSearch(strings.Join(args, " "))
				}},
			"detail": {Name: "detail", Desc: "Detail anime + episode list", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Anime slug required")
					}
					return aiDetail(aiArg(args, 0))
				}},
			"episode": {Name: "episode", Desc: "Episode + streams + downloads", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Episode slug required")
					}
					return aiEpisode(aiArg(args, 0))
				}},
			"batch": {Name: "batch", Desc: "Batch download page (10 eps)", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Anime slug required")
					}
					return aiBatch(aiArg(args, 0))
				}},
			"watch": {Name: "watch", Desc: "Episode streams + downloads (alias of episode)", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if aiArg(args, 0) == "" {
						return nil, errors.New("Episode slug required")
					}
					return aiEpisode(aiArg(args, 0))
				}},
			"supported": {Name: "supported", Desc: "List supported pages/features",
				Run: func(_ []string, _ map[string]string) (any, error) { return aiSupportedPages(), nil }},
		},
	}
}
