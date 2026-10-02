// mangareader.go — shared Go port of the Themesia "mangareader" WordPress theme
// served by mangasusuku.com, kanzenin.info and 02.ngomik.cc. One parser core,
// three thin registrations (mangasusuku.go, kanzenin.go, ngomik.go).
//
// Uniform markup across the three skins:
//   - cards: .bsx (cover .limit img, title .tt, latest chapter .epxs, score
//     .numscore, type badge span.type.<T>, span.colored / span.hotx flags);
//   - series: h1.entry-title, .thumb img cover, info rows in table.infotable
//     (mangasusuku, kanzenin) or .tsinfo .imptdt (ngomik), genres via
//     a[rel=tag] under .seriestugenre/.mgen, synopsis [itemprop=description],
//     chapters .eplister li[data-num] (.chapternum/.chapterdate);
//   - chapter: the page's `ts_reader.run({...})` JSON carries image sources,
//     prevUrl and nextUrl;
//   - lists: .pagination (span.page-numbers.current, numeric slots, a.next).
//
// Per-site differences are configuration only: the series URL prefix
// (/komik/ vs /manga/) and the optional A-Z list (/az-list/ vs /a-z-list/;
// ngomik has none).
package scrapers

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const mrUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

var (
	mrSlugRe   = regexp.MustCompile(`^[a-z0-9-]+$`)
	mrGenreRe  = regexp.MustCompile(`/genres/([^/]+)/`)
	mrDigitsRe = regexp.MustCompile(`^\d+$`)
	mrAZRe     = regexp.MustCompile(`^(\.|0-9|[A-Za-z])$`)
)

// mangaReaderSite is one mangareader-skin site: config plus its own transport.
type mangaReaderSite struct {
	name       string
	title      string
	base       string
	seriesPath string // "/komik/" (mangasusuku) or "/manga/" (kanzenin, ngomik)
	azPath     string // "/az-list/", "/a-z-list/" or "" when the skin has no A-Z list
	site       *Site
}

func newMangaReaderSite(name, title, base, seriesPath, azPath string) *mangaReaderSite {
	return &mangaReaderSite{
		name:       name,
		title:      title,
		base:       base,
		seriesPath: seriesPath,
		azPath:     azPath,
		site: NewSite(SiteConfig{Base: base, RateMS: 500, Headers: map[string]string{
			"user-agent":      mrUA,
			"accept-language": "id-ID,id;q=0.9,en;q=0.8",
		}}),
	}
}

// fetchHTML GETs an origin-pinned page, following same-host redirects and
// trimming the UTF-8 BOM WordPress sometimes prepends. Uncached, matching
// `site.request(url, {follow: true})` in the TS reference.
func (m *mangaReaderSite) fetchHTML(rawURL string) (string, error) {
	res, err := m.site.Do(RequestSpec{Method: "GET", URL: rawURL, Follow: true})
	if err != nil {
		return "", err
	}
	if res.Status < 200 || res.Status >= 300 {
		return "", fmt.Errorf("HTTP %d untuk %s", res.Status, rawURL)
	}
	return strings.TrimPrefix(res.BodyString(), "\uFEFF"), nil
}

func (m *mangaReaderSite) build(page, u string, data map[string]any) map[string]any {
	return ScraperEnvelope("avicenna", page, u, data)
}

// === SMALL HELPERS ===

func mrAttr(sel *goquery.Selection, name string) string {
	if sel == nil || sel.Length() == 0 {
		return ""
	}
	v, _ := sel.Attr(name)
	return v
}

// mrAbs mirrors `x.startsWith('http') ? x : BASE_URL + x`.
func mrAbs(base, raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "http") {
		return raw
	}
	return base + raw
}

// mrImg picks the real image URL. ngomik runs PageSpeed, which replaces src
// with a /pagespeed_static/ placeholder and keeps the original in
// data-pagespeed-lazy-src, so attribute order matters.
func mrImg(sel *goquery.Selection) string {
	if sel == nil || sel.Length() == 0 {
		return ""
	}
	for _, attr := range []string{"data-pagespeed-lazy-src", "data-src", "data-original", "src"} {
		v := strings.TrimSpace(mrAttr(sel, attr))
		if v == "" || strings.HasPrefix(v, "data:") || strings.HasPrefix(v, "javascript:") || strings.Contains(v, "pagespeed_static") {
			continue
		}
		return v
	}
	return ""
}

// mrTypeBadge reads span.type.<T> (e.g. `<span class="type Manhwa">` → "Manhwa").
func mrTypeBadge(sel *goquery.Selection) string {
	out := ""
	sel.Find("span.type").EachWithBreak(func(_ int, span *goquery.Selection) bool {
		for _, c := range strings.Fields(mrAttr(span, "class")) {
			if c != "type" {
				out = c
				return false
			}
		}
		return true
	})
	return out
}

func mrArg(args []string, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	return args[i]
}

func mrPage(args []string, i int) int {
	n, err := strconv.Atoi(mrArg(args, i))
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// === PARSERS ===

// parseCard reads one .bsx card (home/search/genre grids).
func (m *mangaReaderSite) parseCard(sel *goquery.Selection) map[string]any {
	a := sel.Find("a").First()
	href := mrAttr(a, "href")
	title := Txt(sel.Find(".tt").First().Text(), 200)
	if title == "" {
		title = Txt(mrAttr(a, "title"), 200)
	}
	if href == "" || title == "" {
		return nil
	}
	card := map[string]any{"title": title, "url": mrAbs(m.base, href)}
	if img := mrImg(sel.Find("img").First()); img != "" {
		card["image"] = mrAbs(m.base, img)
	}
	if t := mrTypeBadge(sel); t != "" {
		card["type"] = t
	}
	if sel.Find("span.colored").Length() > 0 {
		card["colored"] = true
	}
	if sel.Find("span.hotx").Length() > 0 {
		card["hot"] = true
	}
	if latest := Txt(sel.Find(".epxs").First().Text(), 60); latest != "" {
		card["latest"] = latest
	}
	if score := Txt(sel.Find(".numscore").First().Text(), 10); score != "" {
		card["score"] = score
	}
	return card
}

func (m *mangaReaderSite) cards(sel *goquery.Selection) []any {
	items := []any{}
	sel.Each(func(_ int, s *goquery.Selection) {
		if card := m.parseCard(s); card != nil {
			items = append(items, card)
		}
	})
	return items
}

// mrPagination reads a .pagination block: .page-numbers.current, the highest
// numeric slot and the a.next link.
func mrPagination(base string, pag *goquery.Selection) map[string]any {
	out := map[string]any{"current": 1, "hasNext": false}
	if pag == nil || pag.Length() == 0 {
		return out
	}
	current := 1
	if n, err := strconv.Atoi(Num(Txt(pag.Find(".page-numbers.current").First().Text(), 8))); err == nil && n > 0 {
		current = n
	}
	total := 0
	pag.Find(".page-numbers").Each(func(_ int, s *goquery.Selection) {
		t := Txt(s.Text(), 8)
		if !mrDigitsRe.MatchString(t) {
			return
		}
		if n, err := strconv.Atoi(t); err == nil && n > total {
			total = n
		}
	})
	next := mrAbs(base, mrAttr(pag.Find("a.next").First(), "href"))
	out["current"] = current
	if total > 0 {
		out["total"] = total
	}
	if next != "" {
		out["next"] = next
		out["hasNext"] = true
	} else if total > 0 && current < total {
		out["hasNext"] = true
	}
	return out
}

// mrInfo merges the two info-row skins into one lower-cased label→value map:
// table.infotable (mangasusuku, kanzenin) and .tsinfo .imptdt (ngomik).
func mrInfo(doc *goquery.Document) map[string]string {
	info := map[string]string{}
	doc.Find("table.infotable tr").Each(func(_ int, tr *goquery.Selection) {
		k := strings.ToLower(Txt(tr.Find("td").First().Text(), 40))
		v := Txt(tr.Find("td").Eq(1).Text(), 200)
		if k != "" && v != "" && v != "?" {
			info[k] = v
		}
	})
	doc.Find(".tsinfo .imptdt").Each(func(_ int, d *goquery.Selection) {
		val := d.Find("i").First()
		if val.Length() == 0 {
			val = d.Find("a").First()
		}
		if val.Length() == 0 {
			val = d.Find("span").First()
		}
		v := Txt(val.Text(), 200)
		k := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(Txt(d.Text(), 300), v)))
		if k != "" && v != "" && v != "?" {
			info[k] = v
		}
	})
	return info
}

// mrTime reads a machine timestamp: time[itemprop=<prop>][datetime] (older
// skins) or meta[itemprop=<prop>][content] (ngomik).
func mrTime(doc *goquery.Document, prop string) string {
	if dt := mrAttr(doc.Find(`time[itemprop="`+prop+`"]`).First(), "datetime"); dt != "" {
		return dt
	}
	return mrAttr(doc.Find(`meta[itemprop="`+prop+`"]`).First(), "content")
}

// mrTsReader extracts and decodes the `ts_reader.run({...})` payload from a
// chapter page: image sources, prevUrl, nextUrl and mode. A brace scan (string
// aware, so `}` inside string literals cannot end the object early) beats a
// regex here because the payload nests objects.
func mrTsReader(html string) (map[string]any, bool) {
	marker := "ts_reader.run("
	i := strings.Index(html, marker)
	if i < 0 {
		return nil, false
	}
	rest := html[i+len(marker):]
	j := strings.IndexByte(rest, '{')
	if j < 0 {
		return nil, false
	}
	start := i + len(marker) + j
	depth, inStr, esc := 0, false, false
	for k := start; k < len(html); k++ {
		c := html[k]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				payload, err := DecodeObject(html[start : k+1])
				if err != nil {
					return nil, false
				}
				return payload, true
			}
		}
	}
	return nil, false
}

// === COMMANDS ===

func (m *mangaReaderSite) home(page int) (any, error) {
	u := m.base + "/"
	if page > 1 {
		u = m.base + "/page/" + itoa(page) + "/"
	}
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	sections := []any{}
	doc.Find(".bixbox").Each(func(_ int, box *goquery.Selection) {
		title := Txt(box.Find(".releases h2, .releases h1").First().Text(), 80)
		items := m.cards(box.Find(".listupd .bsx"))
		if title == "" || len(items) == 0 {
			return
		}
		sections = append(sections, map[string]any{"title": title, "items": items})
	})
	return m.build("home", u, map[string]any{
		"sections":   sections,
		"pagination": mrPagination(m.base, doc.Find(".pagination").First()),
	}), nil
}

func (m *mangaReaderSite) search(query string) (any, error) {
	if query == "" {
		return nil, errors.New("Query required")
	}
	u := m.base + "/?s=" + EncodeURIComponent(query)
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	return m.build("search", u, map[string]any{
		"query":      query,
		"items":      m.cards(doc.Find(".postbody .listupd .bsx")),
		"pagination": mrPagination(m.base, doc.Find(".pagination").First()),
	}), nil
}

// genreList reads the genre index page (ngomik's .taxindex); the older skins
// have no index page, so their homepage menu links fill the gap.
func (m *mangaReaderSite) genreList() (any, error) {
	u := m.base + "/genres/"
	genres := []any{}
	seen := map[string]bool{}
	if html, err := m.fetchHTML(u); err == nil {
		SafeDoc(html).Find(".taxindex li a").Each(func(_ int, a *goquery.Selection) {
			name := Txt(a.Find("span").First().Text(), 60)
			if name == "" {
				name = Txt(a.Text(), 60)
			}
			href := mrAttr(a, "href")
			loc := mrGenreRe.FindStringSubmatch(href)
			if name == "" || loc == nil || seen[loc[1]] {
				return
			}
			seen[loc[1]] = true
			g := map[string]any{"name": name, "slug": loc[1], "url": mrAbs(m.base, href)}
			if n, err := strconv.Atoi(Num(Txt(a.Find("i").First().Text(), 8))); err == nil && n > 0 {
				g["count"] = n
			}
			genres = append(genres, g)
		})
	}
	if len(genres) == 0 {
		html, err := m.fetchHTML(m.base + "/")
		if err != nil {
			return nil, err
		}
		SafeDoc(html).Find(`a[href*="/genres/"]`).Each(func(_ int, a *goquery.Selection) {
			name := Txt(a.Text(), 60)
			href := mrAttr(a, "href")
			loc := mrGenreRe.FindStringSubmatch(href)
			if name == "" || loc == nil || seen[loc[1]] {
				return
			}
			seen[loc[1]] = true
			genres = append(genres, map[string]any{"name": name, "slug": loc[1], "url": mrAbs(m.base, href)})
		})
	}
	return m.build("genreList", u, map[string]any{"genres": genres}), nil
}

func (m *mangaReaderSite) genre(slug string, page int) (any, error) {
	if !mrSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug (a-z 0-9 - only)")
	}
	u := m.base + "/genres/" + slug + "/"
	if page > 1 {
		u += "page/" + itoa(page) + "/"
	}
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	return m.build("genre", u, map[string]any{
		"genre":      slug,
		"items":      m.cards(doc.Find(".postbody .listupd .bsx")),
		"pagination": mrPagination(m.base, doc.Find(".pagination").First()),
	}), nil
}

// azList reads the A-Z directory: the letter tabs (.lista a) plus one letter's
// series links.
func (m *mangaReaderSite) azList(letter string) (any, error) {
	if !mrAZRe.MatchString(letter) {
		return nil, errors.New("Invalid letter (A-Z, 0-9 or . only)")
	}
	u := m.base + m.azPath + "?show=" + EncodeURIComponent(letter)
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	letters := []any{}
	doc.Find(".lista a").Each(func(_ int, a *goquery.Selection) {
		label := Txt(a.Text(), 4)
		href := mrAttr(a, "href")
		show := ""
		if q := strings.Index(href, "show="); q >= 0 {
			show = href[q+len("show="):]
		}
		if label == "" || show == "" {
			return
		}
		letters = append(letters, map[string]any{"label": label, "show": show})
	})
	items := []any{}
	seen := map[string]bool{}
	doc.Find(".postbody a").Each(func(_ int, a *goquery.Selection) {
		href := mrAttr(a, "href")
		title := Txt(a.Text(), 200)
		if title == "" || !strings.Contains(href, m.seriesPath) {
			return
		}
		url := mrAbs(m.base, href)
		if seen[url] {
			return
		}
		seen[url] = true
		items = append(items, map[string]any{"title": title, "url": url})
	})
	return m.build("azList", u, map[string]any{
		"letter":  letter,
		"letters": letters,
		"items":   items,
	}), nil
}

func (m *mangaReaderSite) detail(slug string) (any, error) {
	if !mrSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug (a-z 0-9 - only)")
	}
	u := m.base + m.seriesPath + slug + "/"
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	if canonical := mrAttr(doc.Find(`link[rel="canonical"]`).First(), "href"); canonical != "" {
		u = canonical
	}
	title := Txt(doc.Find("h1.entry-title").First().Text(), 200)
	if title == "" {
		title = Txt(doc.Find("h1").First().Text(), 200)
	}
	data := map[string]any{"title": title, "slug": slug}
	alts := []string{}
	for _, part := range strings.Split(Txt(doc.Find(".seriestualt").First().Text(), 500), ",") {
		if p := strings.TrimSpace(part); p != "" {
			alts = append(alts, p)
		}
	}
	if len(alts) > 0 {
		data["altTitles"] = alts
	}
	if img := mrImg(doc.Find(".thumb img").First()); img != "" {
		data["cover"] = mrAbs(m.base, img)
	}
	info := mrInfo(doc)
	for _, key := range []string{"status", "type", "released", "author", "artist", "serialization"} {
		if v := info[key]; v != "" {
			data[key] = v
		}
	}
	if v := info["posted by"]; v != "" {
		data["postedBy"] = v
	}
	if v := mrTime(doc, "datePublished"); v != "" {
		data["postedOn"] = v
	} else if v := info["posted on"]; v != "" {
		data["postedOn"] = v
	}
	if v := mrTime(doc, "dateModified"); v != "" {
		data["updatedOn"] = v
	} else if v := info["updated on"]; v != "" {
		data["updatedOn"] = v
	}
	if v := info["views"]; mrDigitsRe.MatchString(v) {
		if n, err := strconv.Atoi(v); err == nil {
			data["views"] = n
		}
	}
	if n, err := strconv.Atoi(Num(Txt(doc.Find(".bmc").First().Text(), 40))); err == nil && n > 0 {
		data["followers"] = n
	}
	score := mrAttr(doc.Find(`[itemprop="ratingValue"]`).First(), "content")
	if score == "" {
		score = Txt(doc.Find(".rating .numscore, .numscore, .rating .num").First().Text(), 10)
	}
	if score != "" {
		data["score"] = score
	}
	genres := []any{}
	seen := map[string]bool{}
	doc.Find(`.seriestugenre a[rel="tag"], .mgen a[rel="tag"]`).Each(func(_ int, a *goquery.Selection) {
		name := Txt(a.Text(), 40)
		href := mrAttr(a, "href")
		loc := mrGenreRe.FindStringSubmatch(href)
		if name == "" || loc == nil || seen[loc[1]] {
			return
		}
		seen[loc[1]] = true
		genres = append(genres, map[string]any{"name": name, "slug": loc[1], "url": mrAbs(m.base, href)})
	})
	if len(genres) > 0 {
		data["genres"] = genres
	}
	if syn := Txt(doc.Find(`[itemprop="description"]`).First().Text(), 5000); syn != "" {
		data["synopsis"] = syn
	}
	doc.Find(".lastend .inepcx").Each(func(_ int, box *goquery.Selection) {
		label := strings.ToLower(Txt(box.Find("span").First().Text(), 20))
		title := Txt(box.Find(".epcur").First().Text(), 80)
		if title == "" {
			return
		}
		entry := map[string]any{"title": title}
		if href := mrAttr(box.Find("a").First(), "href"); href != "" && !strings.HasPrefix(href, "#") {
			entry["url"] = mrAbs(m.base, href)
		}
		switch {
		case strings.HasPrefix(label, "first"):
			data["firstChapter"] = entry
		case strings.HasPrefix(label, "latest"):
			data["latestChapter"] = entry
		}
	})
	chapters := []any{}
	doc.Find(".eplister li").Each(func(_ int, li *goquery.Selection) {
		a := li.Find(".eph-num a").First()
		if a.Length() == 0 {
			a = li.Find("a").First()
		}
		href := mrAttr(a, "href")
		title := Txt(li.Find(".chapternum").First().Text(), 80)
		if title == "" {
			title = Txt(a.Text(), 80)
		}
		if href == "" || title == "" {
			return
		}
		ch := map[string]any{"title": title, "url": mrAbs(m.base, href)}
		if n, err := strconv.Atoi(Num(mrAttr(li, "data-num"))); err == nil && n > 0 {
			ch["number"] = n
		}
		if date := Txt(li.Find(".chapterdate").First().Text(), 40); date != "" {
			ch["date"] = date
		}
		chapters = append(chapters, ch)
	})
	if len(chapters) > 0 {
		data["chapters"] = chapters
	}
	return m.build("detail", u, data), nil
}

func (m *mangaReaderSite) chapter(slug string) (any, error) {
	if !mrSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug (a-z 0-9 - only)")
	}
	u := m.base + "/" + slug + "/"
	html, err := m.fetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := Txt(doc.Find("h1.entry-title").First().Text(), 200)
	if title == "" {
		title = Txt(doc.Find(".headpost h1").First().Text(), 200)
	}
	data := map[string]any{"title": title, "slug": slug}
	if a := doc.Find(".allc a").First(); a.Length() > 0 {
		data["series"] = map[string]any{"title": Txt(a.Text(), 200), "url": mrAbs(m.base, mrAttr(a, "href"))}
	}
	var images []any
	servers := []any{}
	if payload, ok := mrTsReader(html); ok {
		if arr, ok := payload["sources"].([]any); ok {
			for _, raw := range arr {
				src, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				imgs := []any{}
				if list, ok := src["images"].([]any); ok {
					for _, im := range list {
						if s, ok := im.(string); ok && s != "" {
							imgs = append(imgs, s)
						}
					}
				}
				if len(imgs) == 0 {
					continue
				}
				servers = append(servers, map[string]any{"name": GetStr(src, "source"), "images": imgs})
				if images == nil {
					images = imgs
				}
			}
		}
		if prev := GetStr(payload, "prevUrl"); prev != "" {
			data["prevUrl"] = mrAbs(m.base, prev)
		}
		if next := GetStr(payload, "nextUrl"); next != "" {
			data["nextUrl"] = mrAbs(m.base, next)
		}
		if mode := GetStr(payload, "mode"); mode != "" {
			data["mode"] = mode
		}
	}
	if images == nil {
		doc.Find("#readerarea img").Each(func(_ int, img *goquery.Selection) {
			if src := mrImg(img); src != "" {
				images = append(images, mrAbs(m.base, src))
			}
		})
	}
	if len(images) > 0 {
		data["images"] = images
	}
	if len(servers) > 0 {
		data["servers"] = servers
	}
	return m.build("chapter", u, data), nil
}

func (m *mangaReaderSite) supported() map[string]any {
	return m.build("supportedPages", m.base+"/", map[string]any{
		"home": true, "search": true, "genreList": true, "genre": true,
		"azList": m.azPath != "", "detail": true, "chapter": true,
	})
}

// scraper bundles the command surface; azlist exists only on skins that serve
// an A-Z directory.
func (m *mangaReaderSite) scraper() Scraper {
	cmds := map[string]Command{
		"home": {Name: "home", Desc: "Section homepage (rilisan terbaru, populer, …)", Usage: "[page]",
			Run: func(args []string, _ map[string]string) (any, error) { return m.home(mrPage(args, 0)) }},
		"search": {Name: "search", Desc: "Cari komik", Usage: "<query>",
			Run: func(args []string, _ map[string]string) (any, error) {
				if strings.Join(args, "") == "" {
					return nil, errors.New("Query required")
				}
				return m.search(strings.Join(args, " "))
			}},
		"genrelist": {Name: "genrelist", Desc: "Daftar genre", Run: func(_ []string, _ map[string]string) (any, error) {
			return m.genreList()
		}},
		"genre": {Name: "genre", Desc: "Komik per genre", Usage: "<slug> [page]",
			Run: func(args []string, _ map[string]string) (any, error) {
				if mrArg(args, 0) == "" {
					return nil, errors.New("Genre slug required")
				}
				return m.genre(mrArg(args, 0), mrPage(args, 1))
			}},
		"detail": {Name: "detail", Desc: "Detail komik + daftar chapter", Usage: "<slug>",
			Run: func(args []string, _ map[string]string) (any, error) {
				if mrArg(args, 0) == "" {
					return nil, errors.New("Series slug required")
				}
				return m.detail(mrArg(args, 0))
			}},
		"chapter": {Name: "chapter", Desc: "Chapter + daftar gambar", Usage: "<slug>",
			Run: func(args []string, _ map[string]string) (any, error) {
				if mrArg(args, 0) == "" {
					return nil, errors.New("Chapter slug required")
				}
				return m.chapter(mrArg(args, 0))
			}},
		"supported": {Name: "supported", Desc: "List supported pages/features", Run: func(_ []string, _ map[string]string) (any, error) {
			return m.supported(), nil
		}},
	}
	if m.azPath != "" {
		cmds["azlist"] = Command{Name: "azlist", Desc: "A-Z list (per huruf)", Usage: "<letter>",
			Run: func(args []string, _ map[string]string) (any, error) {
				if mrArg(args, 0) == "" {
					return nil, errors.New("Letter required (A-Z, 0-9 or .)")
				}
				return m.azList(mrArg(args, 0))
			}}
	}
	return Scraper{Name: m.name, Title: m.title, Commands: cmds}
}
