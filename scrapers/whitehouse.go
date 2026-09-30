// whitehouse.go — Go port of whitehouse.ts (whitehouse.gov HTML scraper).
//
// Reference: whitehouse.ts — base https://www.whitehouse.gov, rateMs 600,
// mobile Chrome UA, WordPress block-theme selectors. Two contracts are legacy
// and kept verbatim:
//
//	pagination: {current, total, pages:[{number,url,current}], next}
//	filters:    [{label,url,active}]
//
// All listing pages are plain 200 HTML (no redirects), so the cached GET path
// is enough.
package scrapers

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const (
	whBase = "https://www.whitehouse.gov"
	whUA   = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
)

var whSite = NewSite(SiteConfig{
	Base:   whBase,
	RateMS: 600,
	Headers: map[string]string{
		"user-agent": whUA,
	},
})

// whSections maps a command name to its section path (order as in the TS map).
var whSections = []struct{ name, path string }{
	{"news", "/news/"},
	{"releases", "/releases/"},
	{"briefings", "/briefings-statements/"},
	{"presidential-actions", "/presidential-actions/"},
	{"executive-orders", "/presidential-actions/executive-orders/"},
	{"memoranda", "/presidential-actions/presidential-memoranda/"},
	{"proclamations", "/presidential-actions/proclamations/"},
	{"nominations", "/presidential-actions/nominations-appointments/"},
	{"fact-sheets", "/fact-sheets/"},
	{"remarks", "/remarks/"},
	{"research", "/research/"},
	{"gallery", "/gallery/"},
	{"videos", "/videos/"},
}

func whSectionPath(name string) (string, bool) {
	for _, s := range whSections {
		if s.name == name {
			return s.path, true
		}
	}
	return "", false
}

func whFetchHTML(u string) (string, error) { return whSite.Fetch(u) }

func whPageURL(sectionPath string, page int) string {
	if page > 1 {
		return whBase + sectionPath + "page/" + strconv.Itoa(page) + "/"
	}
	return whBase + sectionPath
}

func whTopperTitle(doc *goquery.Document) string {
	return TxtSel(doc.Find("h1.wp-block-whitehouse-topper__headline").First())
}

// whAbs mirrors `new URL(url, base).href` with a raw fallback.
func whAbs(raw, base string) string {
	if raw == "" {
		return ""
	}
	ref, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	b, err := url.Parse(base)
	if err != nil {
		return raw
	}
	return b.ResolveReference(ref).String()
}

// whPagination keeps the legacy contract:
// {current, total, pages:[{number,url,current}], next}.
func whPagination(doc *goquery.Document, baseURL string) map[string]any {
	pages := []any{}
	total := 0
	doc.Find("nav.wp-block-query-pagination .page-numbers").Each(func(_ int, el *goquery.Selection) {
		n, err := strconv.Atoi(strings.TrimSpace(el.Text()))
		if err != nil {
			return
		}
		if n > total {
			total = n
		}
		var u any
		if el.Is("a") {
			href, _ := el.Attr("href")
			u = whAbs(href, baseURL)
		}
		pages = append(pages, map[string]any{
			"number":  n,
			"url":     u,
			"current": el.HasClass("current"),
		})
	})
	current := 1
	for _, p := range pages {
		if m, ok := p.(map[string]any); ok {
			if cur, _ := m["current"].(bool); cur {
				if n, ok := m["number"].(int); ok {
					current = n
				}
				break
			}
		}
	}
	var next any
	if href, ok := doc.Find("nav.wp-block-query-pagination a.wp-block-query-pagination-next").First().Attr("href"); ok && href != "" {
		next = whAbs(href, baseURL)
	}
	return map[string]any{"current": current, "total": total, "pages": pages, "next": next}
}

// whFilters keeps the legacy `{label,url,active}` contract.
func whFilters(doc *goquery.Document, baseURL string) []any {
	filters := []any{}
	doc.Find(".wp-block-whitehouse-topper-navigation__parent-item, .wp-block-whitehouse-topper-navigation__child-item").Each(func(_ int, el *goquery.Selection) {
		a := el.Find("a").First()
		if a.Length() == 0 {
			return
		}
		href, _ := a.Attr("href")
		filters = append(filters, map[string]any{
			"label":  TxtSel(a),
			"url":    whAbs(href, baseURL),
			"active": a.HasClass("is-current"),
		})
	})
	return filters
}

// whPost is one listing/search entry (fields exactly as the TS interface).
type whPost struct {
	Title      string   `json:"title"`
	URL        any      `json:"url"`
	Categories []string `json:"categories"`
	Date       any      `json:"date"`
	DateISO    any      `json:"dateISO"`
	Thumbnail  any      `json:"thumbnail"`
	PostID     any      `json:"postId"`
}

func whParsePost(el *goquery.Selection) whPost {
	var p whPost
	titleSel := el.Find("h2.wp-block-post-title").First()
	a := titleSel.Find("a").First()
	cover := el.Find("a.wp-block-cover__action").First()
	href, _ := a.Attr("href")
	if href == "" {
		href, _ = cover.Attr("href")
	}
	p.URL = nil
	if href != "" {
		p.URL = whAbs(href, whBase)
	}
	p.Categories = []string{}
	el.Find(".wp-block-post-terms a").Each(func(_ int, c *goquery.Selection) {
		p.Categories = append(p.Categories, TxtSel(c))
	})
	timeSel := el.Find(".wp-block-post-date time").First()
	p.Date = nil
	if d := TxtSel(timeSel); d != "" {
		p.Date = d
	}
	p.DateISO = nil
	if iso, ok := timeSel.Attr("datetime"); ok && iso != "" {
		p.DateISO = iso
	}
	p.Thumbnail = nil
	if src, ok := el.Find("img.wp-post-image").First().Attr("src"); ok && src != "" {
		p.Thumbnail = src
	} else if src, ok := el.Find("img").First().Attr("src"); ok && src != "" {
		p.Thumbnail = src
	}
	p.PostID = nil
	if m := whPostClassRe.FindStringSubmatch(el.AttrOr("class", "")); len(m) > 1 {
		if n, err := strconv.Atoi(m[1]); err == nil {
			p.PostID = n
		}
	}
	p.Title = TxtSel(a)
	if p.Title == "" {
		p.Title = TxtSel(titleSel)
	}
	return p
}

var whPostClassRe = regexp.MustCompile(`post-(\d+)`)

func whParseListing(html, u string) map[string]any {
	doc := SafeDoc(html)
	posts := []any{}
	doc.Find("li.wp-block-post").Each(func(_ int, el *goquery.Selection) {
		if p := whParsePost(el); p.Title != "" {
			posts = append(posts, p)
		}
	})
	return map[string]any{
		"title":      odNil(whTopperTitle(doc)),
		"url":        u,
		"count":      len(posts),
		"posts":      posts,
		"filters":    whFilters(doc, u),
		"pagination": whPagination(doc, u),
	}
}

func whParseVideos(html, u string) map[string]any {
	doc := SafeDoc(html)
	posts := []any{}
	doc.Find("div.wp-block-whitehouse-past-event").Each(func(_ int, el *goquery.Selection) {
		a := el.Find("a").First()
		href, _ := a.Attr("href")
		img := el.Find("img").First()
		src, _ := img.Attr("src")
		timeSel := el.Find("time").First()
		posts = append(posts, map[string]any{
			"title":     TxtSel(el.Find(".wp-block-whitehouse-past-event__title a")),
			"url":       whAbs(href, whBase),
			"thumbnail": odNil(src),
			"duration":  odNil(TxtSel(el.Find(".wp-block-whitehouse-past-event__duration"))),
			"date":      odNil(TxtSel(timeSel)),
			"dateISO":   odAttrOrNil(timeSel, "datetime"),
		})
	})
	return map[string]any{
		"title":      odNil(whTopperTitle(doc)),
		"url":        u,
		"count":      len(posts),
		"posts":      posts,
		"pagination": whPagination(doc, u),
	}
}

func whParseSearch(html, u string) map[string]any {
	doc := SafeDoc(html)
	posts := []any{}
	doc.Find("li.wp-block-post").Each(func(_ int, el *goquery.Selection) {
		if p := whParsePost(el); p.Title != "" {
			posts = append(posts, p)
		}
	})
	typeFilters := []any{}
	doc.Find("fieldset.wp-block-search__filters label").Each(func(_ int, el *goquery.Selection) {
		input := el.Find("input")
		val, _ := input.Attr("value")
		typeFilters = append(typeFilters, map[string]any{
			"label":   TxtSel(el),
			"type":    odNil(val),
			"checked": input.Is(":checked"),
		})
	})
	q, _ := doc.Find(`input[name="s"]`).First().Attr("value")
	return map[string]any{
		"query":       odNil(q),
		"url":         u,
		"count":       len(posts),
		"posts":       posts,
		"typeFilters": typeFilters,
		"pagination":  whPagination(doc, u),
	}
}

func odAttrOrNil(sel *goquery.Selection, name string) any {
	if sel == nil || sel.Length() == 0 {
		return nil
	}
	v, ok := sel.Attr(name)
	if !ok || v == "" {
		return nil
	}
	return v
}

func whParseDetail(html, u string) map[string]any {
	doc := SafeDoc(html)
	topper := doc.Find(".wp-block-whitehouse-topper").First()
	title := TxtSel(topper.Find(".wp-block-whitehouse-topper__headline").First())
	if title == "" {
		title = TxtSel(doc.Find("h1").First())
	}
	eyebrow := topper.Find(".wp-block-whitehouse-topper__eyebrow a").First()
	byline := topper.Find(".wp-block-whitehouse-byline-subcategory").First()
	subLink := byline.Find("a").First()
	dateSel := topper.Find(".wp-block-post-date time").First()
	eoNumber := TxtSel(doc.Find("p.wp-block-whitehouse-topper__eo-number").First())
	entry := doc.Find("div.entry-content").First()
	entry.Find(".wp-block-whitehouse-topper").Remove()
	images := []any{}
	entry.Find("img").Each(func(_ int, img *goquery.Selection) {
		if src, ok := img.Attr("src"); ok && src != "" {
			images = append(images, src)
		}
	})
	bodyText := CollapseWhitespace(entry.Text())
	var schema map[string]any
	if ld := TxtSel(doc.Find("script.yoast-schema-graph").First()); ld != "" {
		if decoded, err := DecodeAny(ld); err == nil {
			if m, ok := decoded.(map[string]any); ok {
				graph, _ := m["@graph"].([]any)
				for _, node := range graph {
					n, ok := node.(map[string]any)
					if !ok {
						continue
					}
					switch n["@type"] {
					case "Article":
						schema = n
					case "WebPage":
						if schema == nil {
							schema = n
						}
					}
				}
			}
		}
	}
	var featured any
	var sections, published, modified, wordCount any
	if schema != nil {
		sections = whNilIfEmpty(schema["articleSection"])
		published = whNilIfEmpty(schema["datePublished"])
		modified = whNilIfEmpty(schema["dateModified"])
		wordCount = whNilIfEmpty(schema["wordCount"])
		featured = whNilIfEmpty(schema["thumbnailUrl"])
	}
	if featured == nil && len(images) > 0 {
		featured = images[0]
	}
	var categoryURL any
	if href, ok := eyebrow.Attr("href"); ok && href != "" {
		categoryURL = whAbs(href, u)
	}
	subcategory := ""
	if subLink.Length() > 0 {
		subcategory = TxtSel(subLink)
	} else {
		subcategory = TxtSel(byline)
	}
	bodyHTML, _ := entry.Html()
	return map[string]any{
		"url":           u,
		"title":         title,
		"category":      odNil(TxtSel(eyebrow)),
		"categoryUrl":   categoryURL,
		"subcategory":   odNil(subcategory),
		"byline":        odNil(TxtSel(byline)),
		"date":          odNil(TxtSel(dateSel)),
		"dateISO":       odAttrOrNil(dateSel, "datetime"),
		"eoNumber":      odNil(eoNumber),
		"sections":      sections,
		"published":     published,
		"modified":      modified,
		"wordCount":     wordCount,
		"featuredImage": featured,
		"images":        images,
		"bodyText":      bodyText,
		"bodyHtml":      odNil(bodyHTML),
	}
}

func whNilIfEmpty(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		if t == "" {
			return nil
		}
		return t
	case []any:
		if len(t) == 0 {
			return nil
		}
	}
	return v
}

func whParseHome(html string) map[string]any {
	doc := SafeDoc(html)
	topper := doc.Find(".wp-block-whitehouse-topper").First()
	hero, ok := topper.Find(".wp-block-whitehouse-topper__media video").Attr("src")
	if !ok || hero == "" {
		hero, _ = topper.Find(".wp-block-whitehouse-topper__media video source").Attr("src")
	}
	videos := []any{}
	doc.Find(".wp-block-whitehouse-video-accordion-item").Each(func(_ int, el *goquery.Selection) {
		a := el.Find(".wp-block-whitehouse-video-accordion-item__link").First()
		href, _ := a.Attr("href")
		v, _ := el.Find("video").First().Attr("src")
		var urlOut any
		if href != "" {
			urlOut = whAbs(href, whBase)
		}
		videos = append(videos, map[string]any{
			"title": TxtSel(el.Find(".wp-block-whitehouse-video-accordion-item__title")),
			"url":   urlOut,
			"video": odNil(v),
		})
	})
	paragraphs := []any{}
	doc.Find(".site-content .entry-content p, .site-content main p").Each(func(_ int, el *goquery.Selection) {
		if t := CollapseWhitespace(el.Text()); t != "" {
			paragraphs = append(paragraphs, t)
		}
	})
	headings := []any{}
	doc.Find("main h2, main h3, main h4").Each(func(_ int, el *goquery.Selection) {
		if t := CollapseWhitespace(el.Text()); t != "" {
			headings = append(headings, t)
		}
	})
	return map[string]any{
		"headline":       odNil(TxtSel(topper.Find(".wp-block-whitehouse-topper__headline"))),
		"deck":           odNil(CollapseWhitespace(topper.Find(".wp-block-whitehouse-topper__deck").Text())),
		"heroVideo":      odNil(hero),
		"videoAccordion": videos,
		"headings":       headings,
		"paragraphs":     paragraphs,
		"url":            whBase + "/",
	}
}

func whParseAdministration(html string) map[string]any {
	doc := SafeDoc(html)
	profiles := []any{}
	doc.Find(".entry-content .wp-block-columns").Each(func(_ int, group *goquery.Selection) {
		cols := group.ChildrenFiltered(".wp-block-column")
		if cols.Length() < 2 {
			return
		}
		img, _ := cols.First().Find("img").Attr("src")
		text := cols.Last()
		h := text.Find("h2.wp-block-heading").First()
		link := h.Find("a").First()
		name := TxtSel(link)
		if name == "" {
			name = TxtSel(h)
		}
		if name == "" {
			return
		}
		var bio string
		if g2 := h.Closest(".wp-block-group"); g2.Length() > 0 {
			bio = CollapseWhitespace(g2.Parent().ChildrenFiltered("p").First().Text())
		} else {
			bio = CollapseWhitespace(text.ChildrenFiltered("p").Eq(1).Text())
		}
		var url any
		if href, ok := link.Attr("href"); ok && href != "" {
			url = whAbs(href, whBase)
		}
		profiles = append(profiles, map[string]any{
			"name":  name,
			"role":  odNil(TxtSel(text.Find("p.has-small-caps-font-size").First())),
			"url":   url,
			"image": odNil(img),
			"bio":   bio,
		})
	})
	return map[string]any{
		"title":    odNil(whTopperTitle(doc)),
		"count":    len(profiles),
		"profiles": profiles,
	}
}

// === COMMANDS ===

func whHome() (any, error) {
	html, err := whFetchHTML(whBase + "/")
	if err != nil {
		return nil, err
	}
	return whParseHome(html), nil
}

func whSearch(keyword string, page int) (any, error) {
	u := whBase + "/?s=" + EncodeURIComponent(keyword)
	if page > 1 {
		u += "&paged=" + strconv.Itoa(page)
	}
	html, err := whFetchHTML(u)
	if err != nil {
		return nil, err
	}
	return whParseSearch(html, u), nil
}

func whDetail(raw string) (any, error) {
	u := whAbs(raw, whBase)
	html, err := whFetchHTML(u)
	if err != nil {
		return nil, err
	}
	return whParseDetail(html, u), nil
}

func whAdministration() (any, error) {
	u := whBase + "/administration/"
	html, err := whFetchHTML(u)
	if err != nil {
		return nil, err
	}
	return whParseAdministration(html), nil
}

func whSection(name string, page int) (any, error) {
	path, ok := whSectionPath(name)
	if !ok {
		return nil, fmt.Errorf("unknown section: %s", name)
	}
	u := whPageURL(path, page)
	html, err := whFetchHTML(u)
	if err != nil {
		return nil, err
	}
	if name == "videos" {
		return whParseVideos(html, u), nil
	}
	return whParseListing(html, u), nil
}

// NewWhiteHouse builds the WhiteHouse scraper (exposed so a host binary can embed it).
func NewWhiteHouse() Scraper { return whiteHouseScraper() }

func init() { register(whiteHouseScraper()) }

func whiteHouseScraper() Scraper {
	cmds := map[string]Command{
		"home": {Name: "home", Desc: "Homepage hero + content",
			Run: func(_ []string, _ map[string]string) (any, error) { return whHome() }},
		"search": {Name: "search", Desc: "Site search", Usage: "<keyword> [page]",
			Run: func(args []string, _ map[string]string) (any, error) {
				if odArg(args, 0) == "" {
					return nil, errWHKeyword()
				}
				page, _ := ParseIntJS(odArg(args, 1))
				return whSearch(odArg(args, 0), page)
			}},
		"detail": {Name: "detail", Desc: "Article detail", Usage: "<URL>",
			Run: func(args []string, _ map[string]string) (any, error) {
				if odArg(args, 0) == "" {
					return nil, errWHURL()
				}
				return whDetail(odArg(args, 0))
			}},
		"administration": {Name: "administration", Desc: "Administration profiles",
			Run: func(_ []string, _ map[string]string) (any, error) { return whAdministration() }},
	}
	for _, sec := range whSections {
		name := sec.name
		desc := "Listing: " + name
		if name == "videos" {
			desc = "Video gallery"
		}
		cmds[name] = Command{Name: name, Desc: desc, Usage: "[page]",
			Run: func(args []string, _ map[string]string) (any, error) {
				page, _ := ParseIntJS(odArg(args, 0))
				return whSection(name, page)
			}}
	}
	return Scraper{Name: "whitehouse", Title: "WhiteHouse.gov Scraper", Commands: cmds}
}

func errWHKeyword() error { return errSimple("Parameter keyword wajib") }
func errWHURL() error     { return errSimple("Parameter URL wajib") }

type errSimple string

func (e errSimple) Error() string { return string(e) }
