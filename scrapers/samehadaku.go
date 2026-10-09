// samehadaku.go — Go port of samehadaku.ts (Samehadaku, v2.samehadaku.how).
//
// The site runs the WordPress "eastplay" theme behind a Cloudflare managed
// challenge, so plain HTTP clients get "Just a moment..." (HTTP 403) — the same
// situation as lk21. Parsers are therefore kept structurally identical to the
// reference and verified against captured real markup; with a challenge-solving
// session's cookie in SAMEHADAKU_COOKIE every command runs live.
//
// Endpoints
//
//	home     [page]           latest anime cards + latest-episode feed
//	search   <query>          /?s=<query>
//	list     [page]           /anime-terbaru/ paginated catalogue
//	detail   <slug|url>       info, genres, rating, episode list, batch links
//	episode  <slug|url>       mirrors (AJAX), downloads, navigation
//	batch    <slug|url>       batch download groups
//	mirrors  <slug|url> [n]   player_ajax mirror embeds only
package scrapers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// shBase is overridable so the parsers can be exercised against a local fixture
// host (the live site is challenge-gated for plain HTTP clients).
var shBase = strings.TrimRight(func() string {
	if b := os.Getenv("SAMEHADAKU_BASE"); b != "" {
		return b
	}
	return "https://v2.samehadaku.how"
}(), "/")

var shSite = NewSite(SiteConfig{
	Base:   shBase,
	RateMS: 450,
	Headers: map[string]string{
		"user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
	},
})

func init() {
	// A Cloudflare-session cookie is what makes this source usable from a plain
	// HTTP client; the cookie belongs to whatever host SAMEHADAKU_BASE points at.
	if c := os.Getenv("SAMEHADAKU_COOKIE"); c != "" {
		if u, err := url.Parse(shBase); err == nil {
			shSite.SetCookie(u.Host, c)
		}
	}
}

// shFetch GETs an origin-pinned page and trims the UTF-8 BOM.
func shFetch(rawURL string) (string, error) {
	res, err := shSite.Do(RequestSpec{Method: http.MethodGet, URL: rawURL, Follow: true})
	if err != nil {
		return "", err
	}
	if res.Status < 200 || res.Status >= 300 {
		return "", fmt.Errorf("HTTP %d for %s", res.Status, rawURL)
	}
	return strings.TrimPrefix(res.BodyString(), "\uFEFF"), nil
}

// shSlug mirrors slugOf(): the last non-empty path segment.
func shSlug(raw string) string {
	s := raw
	if i := strings.IndexAny(s, "?#"); i != -1 {
		s = s[:i]
	}
	s = strings.TrimRight(s, "/")
	parts := strings.Split(s, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return parts[i]
		}
	}
	return ""
}

// shAbs absolutises a site-relative href.
func shAbs(href string) string {
	if href == "" {
		return ""
	}
	if strings.HasPrefix(href, "http") {
		return href
	}
	if strings.HasPrefix(href, "/") {
		return shBase + href
	}
	return shBase + "/" + href
}

// shPageTitle strips the trailing site suffix from <title>.
var (
	shTitleSuffixRe = regexp.MustCompile(`(?i)\s*[–|-]\s*Samehadaku\s*$`)
	shReleasedRe    = regexp.MustCompile(`(?is).*Released on:\s*`)
	shViewsRe       = regexp.MustCompile(`(?is)\s*Views.*`)
	shPageOfRe      = regexp.MustCompile(`(?i)of\s+(\d+)`)
)

func shPageTitle(doc *goquery.Document) string {
	return Txt(shTitleSuffixRe.ReplaceAllString(doc.Find("title").First().Text(), ""), 200)
}

// shPostShowCard parses one `div.post-show li` card.
func shPostShowCard(sel *goquery.Selection) map[string]any {
	a := sel.Find("h2.entry-title a").First()
	href, ok := a.Attr("href")
	if !ok || href == "" {
		return nil
	}
	abs := shAbs(href)
	out := map[string]any{
		"title": Txt(a.Text(), 200),
		"slug":  shSlug(abs),
		"url":   abs,
	}
	if poster, ok := sel.Find("img").First().Attr("src"); ok && poster != "" {
		out["poster"] = poster
	} else {
		out["poster"] = nil
	}
	if ep := Txt(sel.Find(`author[itemprop="name"]`).First().Text(), 40); ep != "" {
		out["episode"] = ep
	}
	if by := Txt(sel.Find("span.author").First().Text(), 60); by != "" {
		out["postedBy"] = by
	}
	var released string
	sel.Find("span").EachWithBreak(func(_ int, s *goquery.Selection) bool {
		t := s.Text()
		if !strings.Contains(strings.ToLower(t), "released on") {
			return true
		}
		released = Txt(shReleasedRe.ReplaceAllString(t, ""), 60)
		return false
	})
	if released != "" {
		out["releasedOn"] = released
	}
	return out
}

// shAnimpostCard parses one search-result card. The site renamed the class
// `animpost` → `animepost`; shSearchCardSel accepts both.
func shAnimpostCard(sel *goquery.Selection) map[string]any {
	a := sel.Find(`a[href*="/anime/"]`).First()
	href, ok := a.Attr("href")
	if !ok || href == "" {
		return nil
	}
	abs := shAbs(href)
	title, _ := a.Attr("title")
	if title == "" {
		title = a.Text()
	}
	out := map[string]any{
		"title":  Txt(title, 200),
		"slug":   shSlug(abs),
		"url":    abs,
		"poster": nilOrStr(sel.Find("img.anmsa").First().AttrOr("src", "")),
		"type":   nilOrStr(Txt(sel.Find(".content-thumb .type").First().Text(), 30)),
		"score":  nilOrStr(Txt(Num(sel.Find(".content-thumb .score").First().Text()), 12)),
		"status": nilOrStr(Txt(sel.Find(".data .type").First().Text(), 30)),
	}
	var views string
	sel.Find(".metadata span").EachWithBreak(func(_ int, s *goquery.Selection) bool {
		t := s.Text()
		if !strings.Contains(strings.ToLower(t), "views") {
			return true
		}
		views = Txt(shViewsRe.ReplaceAllString(t, ""), 20)
		return false
	})
	if views != "" {
		out["views"] = views
	} else {
		out["views"] = nil
	}
	genres := []any{}
	sel.Find(".genres .mta a").Each(func(_ int, g *goquery.Selection) {
		if t := Txt(g.Text(), 40); t != "" {
			genres = append(genres, t)
		}
	})
	if len(genres) > 0 {
		out["genres"] = genres
	}
	return out
}

// nilOrStr is the reference's `x || null` for string fields.
func nilOrStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// === COMMANDS ===
// shAtoi is JS parseInt for the digits-only fields this site emits.
func shAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// shSearchCardSel matches a search-result card. The site renamed the class from
// `animpost` to `animepost` (live capture 2026-10-08: `article.animepost`), and
// the parser had been written against a fixture that still carried the old
// spelling — so `samehadaku search` silently returned zero results live while
// the fixture test stayed green. Both spellings are accepted now; the test uses
// this same constant so it cannot drift from the production selector again.
const shSearchCardSel = "article.animpost, article.animepost"

// shSearch mirrors search().
func shSearch(query string) (map[string]any, error) {
	q := Txt(query, 100)
	if n16(q) < 2 {
		return nil, errors.New("Query too short")
	}
	// encodeURIComponent semantics: spaces become %20, not "+".
	pageURL := shBase + "/?s=" + shEncode(q)
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	results := []any{}
	doc.Find(shSearchCardSel).Each(func(_ int, el *goquery.Selection) {
		if c := shAnimpostCard(el); c != nil {
			results = append(results, c)
		}
	})
	return map[string]any{"query": q, "url": pageURL, "count": len(results), "results": results}, nil
}

// shDoc fetches a page and parses it; transport failures propagate.
func shDoc(rawURL string) (*goquery.Document, error) {
	html, err := shFetch(rawURL)
	if err != nil {
		return nil, err
	}
	return SafeDoc(html), nil
}

// shHome mirrors home().
func shHome(page int) (map[string]any, error) {
	p := min(50, max(1, page))
	pageURL := shBase + "/"
	if p != 1 {
		pageURL = fmt.Sprintf("%s/page/%d/", shBase, p)
	}
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	cards := []any{}
	doc.Find("div.post-show li").Each(func(_ int, el *goquery.Selection) {
		if c := shPostShowCard(el); c != nil {
			cards = append(cards, c)
		}
	})
	// On this theme the "Latest Episode" rail is the same post-show card list, so
	// the feed is the subset of cards carrying an episode number.
	latest := []any{}
	for _, c := range cards {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		ep, _ := m["episode"].(string)
		if ep == "" {
			continue
		}
		latest = append(latest, map[string]any{
			"title": m["title"], "url": m["url"], "slug": m["slug"],
			"episode": ep, "releasedOn": m["releasedOn"],
		})
	}
	return map[string]any{
		"creator": "avicenna", "page": p, "url": pageURL,
		"count": len(cards), "cards": cards, "latestEpisode": latest,
	}, nil
}

// shList mirrors list().
func shList(page int) (map[string]any, error) {
	p := min(50, max(1, page))
	pageURL := shBase + "/anime-terbaru/"
	if p != 1 {
		pageURL = fmt.Sprintf("%s/anime-terbaru/page/%d/", shBase, p)
	}
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	items := []any{}
	doc.Find("div.post-show li").Each(func(_ int, el *goquery.Selection) {
		if c := shPostShowCard(el); c != nil {
			items = append(items, c)
		}
	})
	var total any
	if m := shPageOfRe.FindStringSubmatch(Txt(doc.Find(".pagination span").First().Text(), 40)); m != nil {
		total = shAtoi(m[1])
	}
	return map[string]any{
		"creator": "avicenna", "url": pageURL, "page": p,
		"totalPages": total, "count": len(items), "items": items,
	}, nil
}

// shDateRe matches the release-date span of a redesigned episode row ("28 September 2026").
var shDateRe = regexp.MustCompile(`^\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$`)

// shDetail mirrors detail().
func shDetail(rawSlug string) (map[string]any, error) {
	slug := shSlug(rawSlug)
	if slug == "" {
		return nil, errors.New("Slug required")
	}
	if !shSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug (a-z 0-9 - only)")
	}
	pageURL := fmt.Sprintf("%s/anime/%s/", shBase, slug)
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	return shDetailFromDoc(doc, slug, pageURL), nil
}

// shDetailFromDoc is the extraction half of shDetail, split out so a fixture
// (tools/fixtures/samehadaku/detail-live.html) can pin it with no network fetch.
func shDetailFromDoc(doc *goquery.Document, slug, pageURL string) map[string]any {
	info := doc.Find(".infoanime")
	title := Txt(info.Find("h2.entry-title, h1.entry-title").First().Text(), 200)
	// Redesigned (2026-10) markup: the live page dropped every `.infoanime` class,
	// so each field below falls back to the new anchor, and the `Txt` collapse
	// keeps the new synopsis byte-compatible with the reference's whitespace strip.
	if title == "" {
		title = Txt(doc.Find(`h1[itemprop="headline"]`).First().Text(), 200)
	}
	if title == "" {
		title = shPageTitle(doc)
	}
	rating := nilOrStr(Txt(info.Find(`[itemprop="ratingValue"]`).First().Text(), 12))
	if rating == nil {
		rating = nilOrStr(Txt(doc.Find("span.font-extrabold").First().Text(), 12))
	}
	sinopsis := Txt(doc.Find(".infoanime .desc, .infoanime .entry-content, .desc p").First().Text(), 1200)
	if sinopsis == "" {
		sinopsis = Txt(doc.Find(`h1[itemprop="headline"]`).Parent().Find("p.text-xs").First().Text(), 1200)
	}
	details := map[string]any{}
	info.Find(".spe span").Each(func(_ int, s *goquery.Selection) {
		raw := Txt(s.Text(), 200)
		if i := strings.Index(raw, ":"); i > 0 {
			details[Txt(raw[:i], 40)] = Txt(raw[i+1:], 200)
		}
	})
	// Redesigned markup splits each spec row into two spans: a label carrying
	// `w-28` and its `font-semibold` value. The `w-28` marker is what keeps this
	// from matching every other `font-medium` span on the page.
	if len(details) == 0 {
		doc.Find("span.w-28.font-medium").Each(func(_ int, s *goquery.Selection) {
			label := Txt(s.Text(), 40)
			val := Txt(s.Parent().Find("span.font-semibold").First().Text(), 200)
			if label != "" && val != "" {
				details[label] = val
			}
		})
	}
	genres := []any{}
	doc.Find(".genre-info a, .infoanime .genre-info a").Each(func(_ int, g *goquery.Selection) {
		if t := Txt(g.Text(), 40); t != "" {
			genres = append(genres, t)
		}
	})
	// Redesigned markup renders the genres as pills. Sibling "related anime" list
	// items also link `/genre/…`, so the `rel="tag"` ones are skipped rather than
	// relied on a `:not()` in the selector.
	if len(genres) == 0 {
		doc.Find(`a[href*="/genre/"]`).Each(func(_ int, g *goquery.Selection) {
			if rel, _ := g.Attr("rel"); rel == "tag" {
				return
			}
			if t := Txt(g.Text(), 40); t != "" {
				genres = append(genres, t)
			}
		})
	}
	episodes := []any{}
	doc.Find(".lstepsiode.listeps li").Each(func(_ int, el *goquery.Selection) {
		a := el.Find(".lchx a, a").First()
		href, ok := a.Attr("href")
		if !ok || href == "" {
			return
		}
		episodes = append(episodes, map[string]any{
			"episode": nilOrStr(Txt(el.Find(".eps a").First().Text(), 12)),
			"title":   Txt(a.Text(), 160),
			"url":     shAbs(href),
			"date":    nilOrStr(Txt(el.Find(".date").First().Text(), 40)),
		})
	})
	// Redesigned markup: one `div.flex.items-center.gap-3` per episode — the number
	// in a leading `div.shrink-0 a`, the titled link in `h4 a`, the release date in
	// the block's trailing span. Verified 100 rows on the live /anime/one-piece/.
	if len(episodes) == 0 {
		doc.Find("div.flex.items-center.gap-3").Each(func(_ int, el *goquery.Selection) {
			a := el.Find("h4 a").First()
			href, ok := a.Attr("href")
			if !ok || href == "" {
				return
			}
			date := ""
			el.Find("span").Each(func(_ int, sp *goquery.Selection) {
				if t := Txt(sp.Text(), 40); shDateRe.MatchString(t) {
					date = t
				}
			})
			episodes = append(episodes, map[string]any{
				"episode": nilOrStr(Txt(el.Find("div.shrink-0 a").First().Text(), 12)),
				"title":   Txt(a.Text(), 160),
				"url":     shAbs(href),
				"date":    nilOrStr(date),
			})
		})
	}
	batches := []any{}
	doc.Find(".listbatch a").Each(func(_ int, a *goquery.Selection) {
		if href, ok := a.Attr("href"); ok && href != "" {
			batches = append(batches, map[string]any{"title": Txt(a.Text(), 160), "url": shAbs(href)})
		}
	})
	if len(batches) == 0 {
		doc.Find(`a[href*="/batch/"]`).Each(func(_ int, a *goquery.Selection) {
			if href, ok := a.Attr("href"); ok && href != "" {
				batches = append(batches, map[string]any{"title": Txt(a.Text(), 160), "url": shAbs(href)})
			}
		})
	}
	posterSrc := info.Find("img.anmsa, .thumb img").First().AttrOr("src", "")
	if posterSrc == "" {
		posterSrc = doc.Find(`div[class*=aspect-] img`).First().AttrOr("src", "")
	}
	out := map[string]any{
		"creator": "avicenna", "url": pageURL, "slug": slug, "title": title,
		"poster":   nilOrStr(posterSrc),
		"rating":   rating,
		"genres":   genres,
		"details":  details,
		"episodes": episodes, "episodeCount": len(episodes),
	}
	if sinopsis != "" {
		out["sinopsis"] = sinopsis
	}
	if len(batches) > 0 {
		out["batches"] = batches
	}
	return out
}

// shPlayerOptions reads the `.east_player_option` mirror list off a page.
// includeType matches the reference: `mirrors` emits data-type, `episode` does not.
func shPlayerOptions(doc *goquery.Document, includeType bool) []any {
	options := []any{}
	doc.Find("#server .east_player_option, .east_player_option").Each(func(_ int, el *goquery.Selection) {
		o := map[string]any{
			"nume": shAtoi(el.AttrOr("data-nume", "0")),
			"name": Txt(el.Find("span").First().Text(), 60),
			"post": nilOrStr(el.AttrOr("data-post", "")),
		}
		if includeType {
			o["type"] = nilOrStr(el.AttrOr("data-type", ""))
		}
		options = append(options, o)
	})
	return options
}

// shMirrors mirrors mirrors().
func shMirrors(rawSlug string, nume int) (map[string]any, error) {
	slug := shSlug(rawSlug)
	if slug == "" {
		return nil, errors.New("Slug required")
	}
	doc, err := shDoc(fmt.Sprintf("%s/%s/", shBase, slug))
	if err != nil {
		return nil, err
	}
	options := shPlayerOptions(doc, true)
	if len(options) == 0 {
		return nil, errors.New("No player options on this page")
	}
	post, _ := options[0].(map[string]any)["post"].(string)
	if post == "" {
		return nil, errors.New("No player options on this page")
	}
	if nume < 1 {
		nume = 1
	}
	body := fmt.Sprintf("action=player_ajax&post=%s&nume=%d&type=schtml", url.QueryEscape(post), nume)
	raw, err := shSite.PostForm("/wp-admin/admin-ajax.php", body, "")
	if err != nil {
		return nil, err
	}
	var server any
	for _, o := range options {
		if m, ok := o.(map[string]any); ok && m["nume"] == nume {
			server = m["name"]
			break
		}
	}
	return map[string]any{
		"slug": slug, "post": post, "nume": nume, "server": server,
		"options": options, "embed": strings.TrimSpace(raw),
	}, nil
}

// shDownloadGroups reads `<div id="downloadb"><p><b>label</b></p><ul><li><strong>quality</strong><span><a>…`
func shDownloadGroups(doc *goquery.Document) []any {
	groups := []any{}
	doc.Find("#downloadb").Each(func(_ int, block *goquery.Selection) {
		label := Txt(block.ChildrenFiltered("p, h4, h3").First().Text(), 80)
		entries := []any{}
		var current map[string]any
		block.Find("ul li").Each(func(_ int, li *goquery.Selection) {
			quality := Txt(li.Find("strong").First().Text(), 24)
			if current == nil || current["quality"] != quality {
				current = map[string]any{"quality": quality, "servers": []any{}}
				entries = append(entries, current)
			}
			li.Find("a").Each(func(_ int, a *goquery.Selection) {
				if href, ok := a.Attr("href"); ok && href != "" {
					current["servers"] = append(current["servers"].([]any),
						map[string]any{"name": Txt(a.Text(), 40), "url": href})
				}
			})
		})
		if len(entries) > 0 {
			groups = append(groups, map[string]any{"label": label, "entries": entries})
		}
	})
	return groups
}

// shEpisode mirrors episode().
func shEpisode(rawSlug string) (map[string]any, error) {
	slug := shSlug(rawSlug)
	if slug == "" {
		return nil, errors.New("Slug required")
	}
	pageURL := fmt.Sprintf("%s/%s/", shBase, slug)
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	players := shPlayerOptions(doc, false)
	downloads := shDownloadGroups(doc)

	// .naveps = [prev] [All Episode] [next]; `nonex` marks a missing neighbour.
	navNodes := doc.Find(".naveps .nvs")
	prevHref, _ := navNodes.First().Find("a").Attr("href")
	lastA := navNodes.Last().Find("a")
	nextHref, _ := lastA.Attr("href")
	hasNext := lastA.Length() > 0 && !lastA.HasClass("nonex") && nextHref != "" && nextHref != "#"

	title := Txt(doc.Find("h1.entry-title").First().Text(), 200)
	if title == "" {
		title = shPageTitle(doc)
	}
	var anime any
	doc.Find(".naveps a").EachWithBreak(func(_ int, a *goquery.Selection) bool {
		href, _ := a.Attr("href")
		if !strings.Contains(href, "/anime/") {
			return true
		}
		label := Txt(a.Text(), 160)
		// The back-link reads "All Episode"; only a real title is worth reporting.
		var title any
		if !strings.EqualFold(label, "all episode") && label != "" {
			title = label
		}
		anime = map[string]any{"title": title, "slug": shSlug(shAbs(href)), "url": shAbs(href)}
		return false
	})
	var prev, next any
	if prevHref != "" {
		prev = map[string]any{"slug": shSlug(prevHref), "url": shAbs(prevHref)}
	}
	if hasNext {
		next = map[string]any{"slug": shSlug(nextHref), "url": shAbs(nextHref)}
	}
	embed, _ := doc.Find(`#player_embed iframe, #player iframe, iframe[src*="blogger"], iframe[src*="youtube"]`).First().Attr("src")

	return map[string]any{
		"creator": "avicenna", "url": pageURL, "slug": slug, "title": title,
		"anime": anime, "players": players, "downloads": downloads,
		"prev": prev, "next": next, "embed": nilOrStr(embed),
	}, nil
}

// shBatch mirrors batch().
func shBatch(rawSlug string) (map[string]any, error) {
	slug := shSlug(rawSlug)
	if slug == "" {
		return nil, errors.New("Slug required")
	}
	pageURL := fmt.Sprintf("%s/batch/%s/", shBase, slug)
	doc, err := shDoc(pageURL)
	if err != nil {
		return nil, err
	}
	return shBatchFromDoc(doc, slug, pageURL), nil
}

// shBatchFromDoc is the extraction half of shBatch, split out for fixture tests.
func shBatchFromDoc(doc *goquery.Document, slug, pageURL string) map[string]any {
	groups := shDownloadGroups(doc)
	title := Txt(doc.Find("h1.entry-title").First().Text(), 200)
	if title == "" {
		title = shPageTitle(doc)
	}
	// The live batch page still carries the PRE-redesign markup: the poster is an
	// `img.anmsa` inside `.infoanime .thumb`. `.thumb-batch`/`.content-batch` are
	// the historical selectors and only still match older captures, so without the
	// fallback the live poster came back null while groups parsed fine.
	poster := doc.Find(".thumb-batch img, .content-batch img").First().AttrOr("src", "")
	if poster == "" {
		poster = doc.Find(".infoanime .thumb img, img.anmsa").First().AttrOr("src", "")
	}
	return map[string]any{
		"creator": "avicenna", "url": pageURL, "slug": slug, "title": title,
		"poster": nilOrStr(poster),
		"count":  len(groups), "groups": groups,
	}
}

var shSlugRe = regexp.MustCompile(`(?i)^[a-z0-9-]+$`)

// The site's own mobile-client API (`/wp-json/apk/*`): search returns the numeric
// post ids that `/apk/episode?id=` consumes, so the pair is the cheapest path
// from a title to a mirror list — no HTML, no nonce, no player_ajax.
func shApkSearch(query string) (map[string]any, error) {
	q := Txt(query, 100)
	if n16(q) < 2 {
		return nil, errors.New("Query too short")
	}
	raw, err := shSite.Fetch("/wp-json/apk/search?s=" + shEncode(q))
	if err != nil {
		return nil, err
	}
	var results []any
	out := map[string]any{"query": q}
	if json.Unmarshal([]byte(raw), &results) == nil {
		out["count"] = len(results)
		out["results"] = results
		return out, nil
	}
	var fault struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal([]byte(raw), &fault)
	out["count"] = 0
	out["results"] = []any{}
	if fault.Error != "" {
		out["note"] = fault.Error
	}
	return out, nil
}

// shApkEpisode returns one episode record from the mobile API.
func shApkEpisode(id string) (map[string]any, error) {
	clean := shDigitsOnly(id)
	if clean == "" {
		return nil, errors.New("Numeric post id required")
	}
	raw, err := shSite.Fetch("/wp-json/apk/episode?id=" + clean)
	if err != nil {
		return nil, err
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(raw), &rec); err != nil {
		return nil, err
	}
	return rec, nil
}

func shDigitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// shEncode is encodeURIComponent for query values.
func shEncode(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

var shScheduleDays = []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}

// shSchedule mirrors schedule(): the weekly schedule.
//
// The REST endpoint this used to read (`custom/v1/all-schedule`) has been removed
// from the site — it 404s, the whole `custom/v1` namespace is gone, and its `apk`
// namespace replacement (`/wp-json/apk/schedule`) returns every airing anime at
// once with no per-day field (`time` is free text: "02:00", "Fridays at 00:55
// (JST)", "02.00"), so it cannot be filtered by day. The surviving source is the
// `/jadwal/` page: it renders all seven days as
// `div.result-schedule[x-show="activeDay === '<day>'"]` panels of `div.animepost`
// cards, which is the same card markup the home/search parsers already read.
func shSchedule(day string) (map[string]any, error) {
	d := strings.ToLower(strings.TrimSpace(day))
	if !slices.Contains(shScheduleDays, d) {
		return nil, fmt.Errorf("Day must be one of: %s", strings.Join(shScheduleDays, ", "))
	}
	doc, err := shDoc(shBase + "/jadwal/")
	if err != nil {
		return nil, err
	}
	items := shScheduleFromDoc(doc, d)
	return map[string]any{"creator": "avicenna", "day": d, "count": len(items), "items": items}, nil
}

// shScheduleFromDoc is the extraction half of shSchedule, split out for fixture tests.
func shScheduleFromDoc(doc *goquery.Document, day string) []any {
	items := []any{}
	panel := doc.Find(fmt.Sprintf(`div.result-schedule[x-show="activeDay === '%s'"]`, day)).First()
	if panel.Length() == 0 {
		return items
	}
	panel.Find("div.animepost").Each(func(_ int, card *goquery.Selection) {
		item := shAnimpostCard(card)
		if item == nil {
			return
		}
		// The airing time is schedule-only; add it rather than duplicating the card parser.
		if t := Txt(card.Find("a.ltseps").First().Text(), 40); t != "" {
			item["time"] = t
		}
		items = append(items, item)
	})
	return items
}

// samehadakuScraper builds the CLI surface (identical to the TS reference).
func samehadakuScraper() Scraper {
	return Scraper{
		Name:  "samehadaku",
		Title: "Samehadaku Scraper (v2.samehadaku.how)",
		Commands: map[string]Command{
			"home": {
				Name: "home", Desc: "Latest anime cards + latest-episode feed", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shHome(shAtoi(argAt(args, 0)))
				},
			},
			"search": {
				Name: "search", Desc: "Search anime by title", Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shSearch(strings.Join(args, " "))
				},
			},
			"list": {
				Name: "list", Desc: "Paginated anime catalogue (/anime-terbaru/)", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shList(shAtoi(argAt(args, 0)))
				},
			},
			"detail": {
				Name: "detail", Desc: "Anime detail: info, genres, rating, episodes, batch links", Usage: "<slug|url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shDetail(argAt(args, 0))
				},
			},
			"episode": {
				Name: "episode", Desc: "Episode page: mirrors, downloads, navigation", Usage: "<slug|url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shEpisode(argAt(args, 0))
				},
			},
			"batch": {
				Name: "batch", Desc: "Batch download groups", Usage: "<slug|url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shBatch(argAt(args, 0))
				},
			},
			"apksearch": {
				Name: "apksearch", Desc: "Search the site's mobile API (returns numeric post ids)", Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shApkSearch(strings.Join(args, " "))
				},
			},
			"apk": {
				Name: "apk", Desc: "Episode record from the mobile API: players, prev, thumb", Usage: "<numeric id>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shApkEpisode(argAt(args, 0))
				},
			},
			"schedule": {
				Name: "schedule", Desc: "Weekly release schedule for one day", Usage: "<monday..sunday>",
				Run: func(args []string, _ map[string]string) (any, error) {
					return shSchedule(argAt(args, 0))
				},
			},
			"mirrors": {
				Name: "mirrors", Desc: "Resolve player mirrors via the player_ajax endpoint", Usage: "<slug|url> [nume]",
				Run: func(args []string, _ map[string]string) (any, error) {
					n := shAtoi(argAt(args, 1))
					if n == 0 {
						n = 1
					}
					return shMirrors(argAt(args, 0), n)
				},
			},
		},
	}
}

func init() { register(samehadakuScraper()) }
