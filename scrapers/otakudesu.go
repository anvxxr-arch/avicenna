// otakudesu.go — Go port of otakudesu.ts (otakudesu.blog HTML scraper).
//
// Reference: otakudesu.ts — base https://otakudesu.blog, rateMs 500, cheerio
// selectors plus a DOUBLE-NONCE admin-ajax flow:
//
//	POST action=aa1208d27f29ca340c92c66d1926f13f              → {"data":"<nonce>"}
//	POST action=2a3505c93b0035d3f455df82bf976b84 id/i/q/nonce → {"data":"<base64 html>"}
//
// The second body is base64 HTML whose <iframe src> is the real stream URL.
// Both POSTs must carry `content-type: application/x-www-form-urlencoded;
// charset=UTF-8` or the site answers HTTP 400, and neither response may be
// cached (a cached nonce is a dead nonce) — they go through the uncached POST
// path. Note the nonce is single-use here: the TS version fetched it once and
// reused it across qualities, which the site now rejects, so this port fetches
// one nonce per stream request.
package scrapers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

const (
	odBase = "https://otakudesu.blog"
	odUA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	odNonceAction  = "aa1208d27f29ca340c92c66d1926f13f"
	odStreamAction = "2a3505c93b0035d3f455df82bf976b84"

	// WP AJAX error sentinels: without a nonce the site answers 400/-1, with a
	// stale one it answers 403 — both mean "fetch a fresh nonce and retry".
	odErrNonce    = "nonce rejected"
	odErrNonceNew = "nonce missing"
)

var odSite = NewSite(SiteConfig{
	Base:   odBase,
	RateMS: 500,
	Headers: map[string]string{
		"user-agent":      odUA,
		"accept-language": "id-ID,id;q=0.9,en;q=0.8",
	},
})

// === TRANSPORT ===

var odErrorPageRe = regexp.MustCompile(`(?i)kesalahan|class="error-404|Tidak ditemukan`)
var odRealContentRe = regexp.MustCompile(`mirrorstream|detpost|jdlrx`)

// odFetchHTML GETs an origin-pinned page (cached: these are plain 200 HTML) and
// names the site's own error/rate-limit page instead of returning it as data.
func odFetchHTML(rawURL string) (string, error) {
	body, err := odSite.Fetch(rawURL)
	if err != nil {
		return "", err
	}
	body = strings.TrimPrefix(body, "\uFEFF")
	if odErrorPageRe.MatchString(body) && !odRealContentRe.MatchString(body) {
		return "", errors.New("otakudesu mengembalikan halaman error (kemungkinan rate-limit/block) — coba lagi nanti")
	}
	return body, nil
}

// odPostAjax POSTs a form body to admin-ajax.php. Uncached, and it never
// rejects on a WP error status: the JSON error body is the signal.
func odPostAjax(payload map[string]string) (map[string]any, error) {
	var parts []string
	for _, k := range []string{"action", "id", "i", "q", "nonce"} {
		if v, ok := payload[k]; ok {
			parts = append(parts, k+"="+EncodeURIComponent(v))
		}
	}
	for k, v := range payload {
		switch k {
		case "action", "id", "i", "q", "nonce":
		default:
			parts = append(parts, k+"="+EncodeURIComponent(v))
		}
	}
	res, err := odSite.Do(RequestSpec{
		Method:             "POST",
		URL:                odBase + "/wp-admin/admin-ajax.php",
		Body:               []byte(strings.Join(parts, "&")),
		Headers:            map[string]string{"content-type": "application/x-www-form-urlencoded; charset=UTF-8"},
		NoContentTypeCheck: true,
	})
	// A network/timeout failure is fatal; a non-2xx status is not (the body is).
	if err != nil && res.Status == 0 {
		return nil, err
	}
	var out map[string]any
	if jsonErr := json.Unmarshal(res.Body, &out); jsonErr != nil {
		if res.Status == 400 || res.Status == 403 {
			return nil, errors.New(odErrNonce)
		}
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("admin-ajax: unexpected body (HTTP %d)", res.Status)
	}
	if v, ok := out["data"]; ok {
		if s, _ := v.(string); s != "" && (s == "-1" || s == "0") {
			return nil, errors.New(odErrNonce)
		}
	}
	return out, nil
}

// === HELPERS ===

var (
	odGenreSlugRe = regexp.MustCompile(`^[a-z0-9-]+$`)
	odGenreHrefRe = regexp.MustCompile(`/genres/([^/]+)/?`)
	odEpIDRe      = regexp.MustCompile(`/episode/([^/]+)/?$`)
	odPostIDRe    = regexp.MustCompile(`post-(\d+)`)
	odPostIDAnyRe = regexp.MustCompile(`(?i)post[_\s]*id[_\s]*[:=]\s*["']?(\d+)["']?`)
)

// odClean mirrors otakudesu.ts' own clean(): it drops `undefined` leaves and
// objects that end up empty, but PRESERVES empty arrays (`genres: []` is part
// of the search/detail item contract). animeindo.ts' clean() is the stricter
// one that also drops empty arrays — see Clean in clean.go.
func odClean(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		out := make([]any, 0, len(t))
		for _, e := range t {
			if c := odClean(e); c != nil {
				out = append(out, c)
			}
		}
		return out
	case []map[string]any:
		arr := make([]any, 0, len(t))
		for _, e := range t {
			arr = append(arr, any(e))
		}
		return odClean(arr)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			if c := odClean(e); c != nil {
				out[k] = c
			}
		}
		if len(out) == 0 {
			return nil
		}
		return out
	default:
		return v
	}
}

func odBuild(page, u string, data map[string]any) map[string]any {
	out := odClean(map[string]any{"creator": "rynaqrtz", "page": page, "url": u, "data": data})
	if m, ok := out.(map[string]any); ok {
		return m
	}
	return map[string]any{"creator": "rynaqrtz", "page": page, "url": u}
}

func odArg(args []string, i int) string {
	if i < 0 || i >= len(args) {
		return ""
	}
	return args[i]
}

func odAbs(raw string) string {
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(raw, "http") {
		return raw
	}
	return odBase + raw
}

// odPagination mirrors the TS shape exactly:
// {current, next, hasNext, total} in THAT key order.
func odPagination(doc *goquery.Document) map[string]any {
	type pageLink struct{ text, href string }
	var links []pageLink
	doc.Find(".pagination a, .pagination span, .page-numbers, .pagenavix a, .pagenavix span").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		if href == "" {
			return
		}
		links = append(links, pageLink{text: strings.TrimSpace(el.Text()), href: href})
	})
	total, haveTotal := 0, false
	for _, l := range links {
		if odDigitsOnly(l.text) {
			if n, err := strconv.Atoi(l.text); err == nil && (!haveTotal || n > total) {
				total, haveTotal = n, true
			}
		}
	}
	current := 1
	cur := doc.Find(".pagination .page-numbers.current, .pagenavix .page-numbers.current").First()
	if cur.Length() > 0 {
		if n, err := strconv.Atoi(strings.TrimSpace(cur.Text())); err == nil {
			current = n
		}
	}
	var next any
	hasNext := false
	if haveTotal && current < total {
		hasNext = true
		for _, l := range links {
			if l.text == "Next" || l.text == "»" || strings.Contains(strings.ToLower(l.text), "next") {
				next = odAbs(l.href)
				break
			}
		}
	}
	var totalOut any
	if haveTotal {
		totalOut = total
	}
	return map[string]any{"current": current, "next": next, "hasNext": hasNext, "total": totalOut}
}

func odDigitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func odCardDetpost(el *goquery.Selection) map[string]any {
	link, _ := el.Find(".thumb a").Attr("href")
	title := TxtSel(el.Find(".jdlflm"))
	poster, _ := el.Find(".thumbz img").Attr("src")
	episode := TxtSel(el.Find(".epz"))
	day := TxtSel(el.Find(".epztipe"))
	date := TxtSel(el.Find(".newnime"))
	if link == "" || title == "" {
		return nil
	}
	var posterOut, episodeOut, dayOut, dateOut any
	if poster != "" {
		posterOut = poster
	}
	if episode != "" {
		episodeOut = episode
	}
	if day != "" {
		dayOut = day
	}
	if date != "" {
		dateOut = date
	}
	return map[string]any{
		"title": title, "url": odAbs(link), "poster": posterOut,
		"episode": episodeOut, "day": dayOut, "date": dateOut,
	}
}

func odCardColAnime(el *goquery.Selection) map[string]any {
	titleSel := el.Find(".col-anime-title a")
	link, _ := titleSel.Attr("href")
	title := TxtSel(titleSel)
	studio := TxtSel(el.Find(".col-anime-studio"))
	eps := TxtSel(el.Find(".col-anime-eps"))
	rating := TxtSel(el.Find(".col-anime-rating"))
	genres := []any{}
	el.Find(".col-anime-genre a").Each(func(_ int, a *goquery.Selection) {
		genres = append(genres, a.Text())
	})
	poster, _ := el.Find(".col-anime-cover img").Attr("src")
	synopsis := TxtSel(el.Find(".col-synopsis p"))
	season := TxtSel(el.Find(".col-anime-date"))
	if link == "" || title == "" {
		return nil
	}
	return map[string]any{
		"title": title, "url": odAbs(link),
		"studio": odNil(studio), "episodes": odNil(eps), "rating": odNil(rating),
		"genres": genres, "poster": odNil(poster), "synopsis": odNil(synopsis), "season": odNil(season),
	}
}

func odNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func odGenreList(doc *goquery.Document) []any {
	out := []any{}
	doc.Find(".genres li a").Each(func(_ int, el *goquery.Selection) {
		name := TxtSel(el)
		link, _ := el.Attr("href")
		if name == "" || link == "" {
			return
		}
		out = append(out, map[string]any{
			"name": name,
			"slug": odGenreHrefRe.ReplaceAllString(link, "$1"),
			"url":  odAbs(link),
		})
	})
	return out
}

func odSchedule(doc *goquery.Document) map[string]any {
	schedule := map[string]any{}
	doc.Find(".kglist321").Each(func(_ int, el *goquery.Selection) {
		day := TxtSel(el.Find("h2"))
		items := []any{}
		el.Find("ul li a").Each(func(_ int, a *goquery.Selection) {
			href, _ := a.Attr("href")
			items = append(items, map[string]any{"title": TxtSel(a), "url": odAbs(href)})
		})
		if day != "" && len(items) > 0 {
			schedule[day] = items
		}
	})
	return schedule
}

func odEpisodeList(doc *goquery.Document) []any {
	out := []any{}
	doc.Find(".episodelist ul li").Each(func(_ int, el *goquery.Selection) {
		a := el.Find("a")
		title := TxtSel(a)
		href, _ := a.Attr("href")
		date := TxtSel(el.Find(".zeebr"))
		if href == "" || title == "" {
			return
		}
		m := odEpIDRe.FindStringSubmatch(href)
		var epID any
		if len(m) > 1 {
			epID = m[1]
		}
		out = append(out, map[string]any{
			"title": title, "episodeId": epID, "url": odAbs(href), "releaseDate": odNil(date),
		})
	})
	return out
}

// odExtractPostID mirrors extractPostId(): data-content base64 JSON ids,
// `id="post-NNN"` containers, then raw `post_id: NNN` mentions.
func odExtractPostID(doc *goquery.Document) any {
	ids := map[string]bool{}
	var order []string
	add := func(id string) {
		if id != "" && !ids[id] {
			ids[id] = true
			order = append(order, id)
		}
	}
	doc.Find("[data-content]").Each(func(_ int, el *goquery.Selection) {
		content, _ := el.Attr("data-content")
		if content == "" {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return
		}
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) != nil {
			return
		}
		if id, ok := parsed["id"]; ok {
			switch v := id.(type) {
			case float64:
				add(strconv.FormatInt(int64(v), 10))
			case string:
				add(v)
			}
		}
	})
	doc.Find(`[id^="post-"]`).Each(func(_ int, el *goquery.Selection) {
		id, _ := el.Attr("id")
		if m := odPostIDRe.FindStringSubmatch(id); len(m) > 1 {
			add(m[1])
		}
	})
	html, _ := doc.Html()
	for _, m := range odPostIDAnyRe.FindAllStringSubmatch(html, -1) {
		if len(m) > 1 {
			add(m[1])
		}
	}
	if len(order) == 0 {
		return nil
	}
	// The TS version returned the first collected id; keep that.
	if n, err := strconv.Atoi(order[0]); err == nil {
		return n
	}
	return order[0]
}

// === NONCE FLOW ===

// odGetNonce fetches a FRESH admin-ajax nonce (never cached).
func odGetNonce() (string, error) {
	res, err := odPostAjax(map[string]string{"action": odNonceAction})
	if err != nil {
		return "", err
	}
	if s, ok := res["data"].(string); ok && s != "" && s != "-1" {
		return s, nil
	}
	return "", errors.New(odErrNonceNew)
}

// odGetStreamURL resolves ONE stream entry: fresh nonce → base64 HTML → iframe src.
func odGetStreamURL(postID, index, quality string) (string, error) {
	nonce, err := odGetNonce()
	if err != nil {
		return "", err
	}
	res, err := odPostAjax(map[string]string{
		"action": odStreamAction, "id": postID, "i": index, "q": quality, "nonce": nonce,
	})
	if err != nil {
		return "", err
	}
	encoded, _ := res["data"].(string)
	if encoded == "" {
		return "", errors.New(odErrNonceNew)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	src, _ := SafeDoc(string(raw)).Find("iframe").Attr("src")
	if src == "" {
		return "", errors.New("no iframe in stream payload")
	}
	return src, nil
}

// odExtractStreams resolves every mirror into `{"<quality>_<label>": url}`.
func odExtractStreams(html string) map[string]any {
	doc := SafeDoc(html)
	postID := odExtractPostID(doc)
	if postID == nil {
		return map[string]any{}
	}
	postIDStr := fmt.Sprintf("%v", postID)
	type stream struct{ i, q string }
	streams := map[string]stream{}
	var order []string
	doc.Find(".mirrorstream ul").Each(func(_ int, ul *goquery.Selection) {
		ul.Find("a").Each(func(_ int, a *goquery.Selection) {
			dataContent, _ := a.Attr("data-content")
			if dataContent == "" {
				return
			}
			raw, err := base64.StdEncoding.DecodeString(dataContent)
			if err != nil {
				return
			}
			var decoded map[string]any
			if json.Unmarshal(raw, &decoded) != nil {
				return
			}
			idv, _ := decoded["id"]
			if fmt.Sprintf("%v", idv) != postIDStr {
				return
			}
			i := odJSONNum(decoded["i"])
			q := odJSONNum(decoded["q"])
			key := q + "_" + strings.TrimSpace(a.Text())
			if _, seen := streams[key]; !seen {
				order = append(order, key)
			}
			streams[key] = stream{i: i, q: q}
		})
	})
	result := map[string]any{}
	for _, key := range order {
		p := streams[key]
		url, err := odGetStreamURL(postIDStr, p.i, p.q)
		if err == nil && url != "" {
			result[key] = url
		}
	}
	return result
}

func odJSONNum(v any) string {
	switch t := v.(type) {
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case json.Number:
		return t.String()
	case string:
		return t
	}
	return ""
}

func odParseDownloads(doc *goquery.Document, fallbackGroup string) []any {
	downloads := []any{}
	doc.Find(".download ul").Each(func(_ int, ul *goquery.Selection) {
		group := TxtSel(ul.PrevFiltered("h4"))
		if group == "" {
			group = TxtSel(ul.PrevFiltered("strong"))
		}
		if group == "" {
			group = fallbackGroup
		}
		items := []any{}
		ul.Find("li").Each(func(_ int, li *goquery.Selection) {
			resolution := TxtSel(li.Find("strong"))
			size := TxtSel(li.Find("i"))
			links := []any{}
			li.Find("a").Each(func(_ int, a *goquery.Selection) {
				href, _ := a.Attr("href")
				links = append(links, map[string]any{"host": TxtSel(a), "url": odNil(href)})
			})
			if len(links) > 0 {
				items = append(items, map[string]any{
					"resolution": odNil(resolution), "size": odNil(size), "links": links,
				})
			}
		})
		if len(items) > 0 {
			downloads = append(downloads, map[string]any{"group": group, "items": items})
		}
	})
	return downloads
}

// === COMMANDS ===

func odHome() (map[string]any, error) {
	u := odBase + "/"
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".detpost").FilterFunction(func(_ int, el *goquery.Selection) bool {
		return strings.Contains(el.Find(".epz").Text(), "Episode")
	}).Each(func(_ int, el *goquery.Selection) {
		if card := odCardDetpost(el); card != nil {
			items = append(items, card)
		}
	})
	return odBuild("home", u, map[string]any{"items": items}), nil
}

func odOngoing(page int) (map[string]any, error) {
	u := fmt.Sprintf("%s/ongoing-anime/", odBase)
	if page != 1 {
		u = fmt.Sprintf("%s/ongoing-anime/page/%d/", odBase, page)
	}
	return odCardListing("ongoing", u)
}

func odComplete(page int) (map[string]any, error) {
	u := fmt.Sprintf("%s/complete-anime/", odBase)
	if page != 1 {
		u = fmt.Sprintf("%s/complete-anime/page/%d/", odBase, page)
	}
	return odCardListing("complete", u)
}

func odCardListing(page, u string) (map[string]any, error) {
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".detpost").Each(func(_ int, el *goquery.Selection) {
		if card := odCardDetpost(el); card != nil {
			items = append(items, card)
		}
	})
	return odBuild(page, u, map[string]any{"pagination": odPagination(doc), "items": items}), nil
}

func odGenreListCommand() (map[string]any, error) {
	u := odBase + "/genre-list/"
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	return odBuild("genreList", u, map[string]any{"genres": odGenreList(SafeDoc(html))}), nil
}

func odGenre(slug string, page int) (map[string]any, error) {
	if !odGenreSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid genre slug")
	}
	u := fmt.Sprintf("%s/genres/%s/", odBase, slug)
	if page != 1 {
		u = fmt.Sprintf("%s/genres/%s/page/%d/", odBase, slug, page)
	}
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".col-anime-con").Each(func(_ int, el *goquery.Selection) {
		if card := odCardColAnime(el); card != nil {
			items = append(items, card)
		}
	})
	return odBuild("genre", u, map[string]any{"slug": slug, "pagination": odPagination(doc), "items": items}), nil
}

func odJadwalRilis() (map[string]any, error) {
	u := odBase + "/jadwal-rilis/"
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	return odBuild("jadwalRilis", u, map[string]any{"schedule": odSchedule(SafeDoc(html))}), nil
}

func odSearch(query string) (map[string]any, error) {
	u := fmt.Sprintf("%s/?s=%s&post_type=anime", odBase, EncodeURIComponent(query))
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	items := []any{}
	doc.Find(".chivsrc li").Each(func(_ int, el *goquery.Selection) {
		h2 := el.Find("h2 a")
		link, _ := h2.Attr("href")
		title := TxtSel(h2)
		poster, _ := el.Find("img").Attr("src")
		// cheerio/jQuery child-index semantics, kept faithfully: the TS reference
		// selects `.set:first-child` / `.set:nth-child(2)`, which in this markup
		// (img, h2, then the .set divs) match nothing — genres stay [] and status
		// stays absent.
		genres := []any{}
		el.Find(".set").FilterFunction(func(_ int, s *goquery.Selection) bool {
			return s.PrevAll().Length() == 0
		}).Find("a").Each(func(_ int, a *goquery.Selection) {
			genres = append(genres, a.Text())
		})
		status := ""
		el.Find(".set").FilterFunction(func(_ int, s *goquery.Selection) bool {
			return s.PrevAll().Length() == 1
		}).Each(func(_ int, s *goquery.Selection) {
			status = strings.TrimSpace(strings.Replace(s.Text(), "Status :", "", 1))
		})
		ratingEl := el.Find(".set").FilterFunction(func(_ int, s *goquery.Selection) bool {
			return strings.Contains(s.Text(), "Rating")
		})
		var rating any
		if ratingEl.Length() > 0 {
			rating = strings.TrimSpace(strings.Replace(ratingEl.Text(), "Rating :", "", 1))
		}
		if link == "" || title == "" {
			return
		}
		items = append(items, map[string]any{
			"title": title, "url": odAbs(link), "poster": odNil(poster),
			"genres": genres, "status": odNil(status), "rating": rating,
		})
	})
	return odBuild("search", u, map[string]any{"query": query, "items": items}), nil
}

func odDetail(slug string) (map[string]any, error) {
	if !odGenreSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid slug")
	}
	u := fmt.Sprintf("%s/anime/%s/", odBase, slug)
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := TxtSel(doc.Find(".jdlrx h1"))
	if title == "" {
		title = TxtSel(doc.Find("title"))
	}
	poster, _ := doc.Find(".fotoanime img").Attr("src")
	sinopsis := TxtSel(doc.Find(".sinopc p"))
	info := map[string]any{}
	doc.Find(".infozin .infozingle p").Each(func(_ int, el *goquery.Selection) {
		text := TxtSel(el)
		if strings.Contains(text, "Genre") {
			var genreLinks []string
			el.Find("a").Each(func(_ int, a *goquery.Selection) {
				genreLinks = append(genreLinks, TxtSel(a))
			})
			if len(genreLinks) > 0 {
				info["genre"] = strings.Join(genreLinks, ", ")
			} else {
				info["genre"] = nil
			}
			return
		}
		parts := strings.Split(text, ":")
		if len(parts) >= 2 {
			key := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(parts[0]), " ", "_"))
			value := strings.TrimSpace(strings.Join(parts[1:], ":"))
			if key != "" {
				info[key] = value
			}
		}
	})
	recommendations := []any{}
	doc.Find(".isi-recommend-anime-series .isi-konten").Each(func(_ int, el *goquery.Selection) {
		link, _ := el.Find(".judul-anime a").Attr("href")
		recTitle := TxtSel(el.Find(".judul-anime a"))
		recPoster, _ := el.Find(".gambar-konten img").Attr("src")
		if link == "" || recTitle == "" {
			return
		}
		recommendations = append(recommendations, map[string]any{
			"title": recTitle, "url": odAbs(link), "poster": odNil(recPoster),
		})
	})
	episodes := odEpisodeList(doc)
	if episodes == nil {
		episodes = []any{}
	}
	return odBuild("detail", u, map[string]any{
		"title": title, "poster": odNil(poster), "sinopsis": odNil(sinopsis),
		"info": info, "episodes": episodes, "recommendations": recommendations,
	}), nil
}

func odEpisode(slug string) (map[string]any, error) {
	if !odGenreSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid episode slug")
	}
	u := fmt.Sprintf("%s/episode/%s/", odBase, slug)
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := TxtSel(doc.Find("h1.posttl"))
	if title == "" {
		title = TxtSel(doc.Find("title"))
	}
	streams := odExtractStreams(html)
	downloads := odParseDownloads(doc, "Download")
	flir := doc.Find(".prevnext .flir")
	nav := map[string]any{
		"prev": odNil(odAttrOf(flir.Find("a").First())),
		"all": odNil(odAttrOf(flir.Find("a").FilterFunction(func(_ int, a *goquery.Selection) bool {
			return strings.Contains(a.Text(), "See All")
		}))),
		"next": odNil(odAttrOf(flir.Find("a").Last())),
	}
	data := map[string]any{"title": title, "streams": streams, "downloads": downloads, "nav": nav}
	if other := odEpisodeList(doc); len(other) > 0 {
		data["otherEpisodes"] = other
	}
	return odBuild("episode", u, data), nil
}

func odAttrOf(sel *goquery.Selection) string {
	if sel == nil || sel.Length() == 0 {
		return ""
	}
	v, _ := sel.Attr("href")
	return v
}

func odWatch(slug string) (map[string]any, error) {
	out, err := odEpisode(slug)
	if err != nil {
		return nil, err
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		data = map[string]any{}
	}
	return odBuild("watch", fmt.Sprintf("%s/episode/%s/", odBase, slug), data), nil
}

func odBatch(slug string) (map[string]any, error) {
	if !odGenreSlugRe.MatchString(slug) {
		return nil, errors.New("Invalid batch slug")
	}
	u := fmt.Sprintf("%s/lengkap/%s/", odBase, slug)
	html, err := odFetchHTML(u)
	if err != nil {
		return nil, err
	}
	doc := SafeDoc(html)
	title := TxtSel(doc.Find(".jdlrx h1"))
	if title == "" {
		title = TxtSel(doc.Find("title"))
	}
	return odBuild("batch", u, map[string]any{"title": title, "downloads": odParseDownloads(doc, "Batch")}), nil
}

// NewOtakudesu builds the Otakudesu scraper (exposed so a host binary can embed it).
func NewOtakudesu() Scraper { return otakudesuScraper() }

func init() { register(otakudesuScraper()) }

func otakudesuScraper() Scraper {
	pageArg := func(args []string, i int) int {
		n, _ := ParseIntJS(odArg(args, i))
		if n == 0 {
			n = 1
		}
		return n
	}
	return Scraper{
		Name:  "otakudesu",
		Title: "Otakudesu Scraper (otakudesu.blog)",
		Commands: map[string]Command{
			"home": {Name: "home", Desc: "Episode terbaru",
				Run: func(_ []string, _ map[string]string) (any, error) { return odHome() }},
			"ongoing": {Name: "ongoing", Desc: "Anime ongoing", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) { return odOngoing(pageArg(args, 0)) }},
			"complete": {Name: "complete", Desc: "Anime completed", Usage: "[page]",
				Run: func(args []string, _ map[string]string) (any, error) { return odComplete(pageArg(args, 0)) }},
			"genrelist": {Name: "genrelist", Desc: "Daftar genre",
				Run: func(_ []string, _ map[string]string) (any, error) { return odGenreListCommand() }},
			"genre": {Name: "genre", Desc: "Anime per genre", Usage: "<slug> [page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Genre slug required")
					}
					return odGenre(odArg(args, 0), pageArg(args, 1))
				}},
			"jadwal": {Name: "jadwal", Desc: "Jadwal rilis mingguan",
				Run: func(_ []string, _ map[string]string) (any, error) { return odJadwalRilis() }},
			"search": {Name: "search", Desc: "Cari anime", Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Query required")
					}
					return odSearch(strings.Join(args, " "))
				}},
			"detail": {Name: "detail", Desc: "Detail anime + episode list", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Anime slug required")
					}
					return odDetail(odArg(args, 0))
				}},
			"episode": {Name: "episode", Desc: "Episode + resolved stream URLs", Usage: "<episode-slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Episode slug required")
					}
					return odEpisode(odArg(args, 0))
				}},
			"batch": {Name: "batch", Desc: "Batch download page", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Batch slug required")
					}
					return odBatch(odArg(args, 0))
				}},
			"watch": {Name: "watch", Desc: "Episode streams + downloads (legacy alias of episode)", Usage: "<slug>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if odArg(args, 0) == "" {
						return nil, errors.New("Episode slug required")
					}
					return odWatch(odArg(args, 0))
				}},
		},
	}
}
