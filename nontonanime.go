package main

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// === CONFIG ===
var (
	BASE     = strings.TrimRight(envOr("ANIME_BASE", "https://s13.nontonanimeid.boats"), "/")
	baseHost = mustHost(BASE)
)

const (
	timeoutMS     = 15000
	maxBytes      = 3000000
	maxRedirects  = 5
	maxRetries    = 3
	minIntervalMS = 350
	cacheTTL      = 5 * 60 * 1000 // ms
	cacheMax      = 100
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func mustHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return strings.ToLower(u.Hostname())
}

var HEADERS = map[string]string{
	"user-agent":                "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
	"accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language":           "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
	"referer":                   BASE + "/",
	"dnt":                       "1",
	"sec-ch-ua":                 `"Chromium";v="131", "Not_A Brand";v="24"`,
	"sec-ch-ua-mobile":          "?1",
	"sec-ch-ua-platform":        `"Android"`,
	"sec-fetch-dest":            "document",
	"sec-fetch-mode":            "navigate",
	"sec-fetch-site":            "same-origin",
	"sec-fetch-user":            "?1",
	"upgrade-insecure-requests": "1",
	// NOTE: no accept-encoding — Go's transport negotiates + decodes gzip itself.
}

// === TYPES (JSON names identical to the TS version) ===
type Episode struct {
	Title     string `json:"title"`
	Ep        string `json:"episode"`
	URL       string `json:"url"`
	Thumbnail string `json:"thumbnail"`
}

type AnimeCard struct {
	Title     string   `json:"title"`
	URL       string   `json:"url"`
	Thumbnail string   `json:"thumbnail"`
	Rating    *string  `json:"rating,omitempty"`
	Type      *string  `json:"type,omitempty"`
	Season    *string  `json:"season,omitempty"`
	Score     *string  `json:"score,omitempty"`
	Synopsis  *string  `json:"synopsis,omitempty"`
	Genres    []string `json:"genres,omitempty"`
}

type StreamLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}
type DownloadBlock struct {
	Format string       `json:"format"`
	Links  []StreamLink `json:"links"`
}
type StreamEntry struct {
	Server   string `json:"server"`
	EmbedURL string `json:"embedUrl"`
	RawHTML  string `json:"rawHtml"`
}
type StreamResult struct {
	Title     string          `json:"title"`
	PostID    string          `json:"postId"`
	Streams   []StreamEntry   `json:"streams"`
	Downloads []DownloadBlock `json:"downloads"`
}

type Genre struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Total   int    `json:"total"`
	Ongoing int    `json:"ongoing"`
}

type EpRef struct {
	Title string `json:"title"`
	Date  string `json:"date"`
	URL   string `json:"url"`
}
type AnimeDetail struct {
	Title         string      `json:"title"`
	TitleEn       string      `json:"titleEn"`
	TitleJp       string      `json:"titleJp"`
	Score         string      `json:"score"`
	Type          string      `json:"type"`
	Synopsis      string      `json:"synopsis"`
	Genres        []string    `json:"genres"`
	Studios       string      `json:"studios"`
	Rating        string      `json:"rating"`
	Popularity    string      `json:"popularity"`
	Members       string      `json:"members"`
	Aired         string      `json:"aired"`
	Status        string      `json:"status"`
	TotalEpisodes string      `json:"totalEpisodes"`
	Duration      string      `json:"duration"`
	Season        string      `json:"season"`
	Poster        string      `json:"poster"`
	Trailer       string      `json:"trailer"`
	Episodes      []EpRef     `json:"episodes"`
	FirstEpisode  string      `json:"firstEpisode"`
	LastEpisode   string      `json:"lastEpisode"`
	Recommended   []AnimeCard `json:"recommended"`
}

type ScheduleSlot struct {
	Title   string   `json:"title"`
	URL     string   `json:"url"`
	Episode string   `json:"episode"`
	Time    *string  `json:"time,omitempty"`
	Rating  *string  `json:"rating,omitempty"`
	Members *string  `json:"members,omitempty"`
	Type    *string  `json:"type,omitempty"`
	Status  *string  `json:"status,omitempty"`
	Genres  []string `json:"genres,omitempty"`
}
type ScheduleEntry struct {
	Day      string         `json:"day"`
	DateText string         `json:"dateText"`
	Entries  []ScheduleSlot `json:"entries"`
}

type TopAnime struct {
	Title     string `json:"title"`
	URL       string `json:"url"`
	Thumbnail string `json:"thumbnail"`
	Score     string `json:"score"`
}
type SeasonResult struct {
	Title     string `json:"title"`
	URL       string `json:"url"`
	Thumbnail string `json:"thumbnail"`
	Score     string `json:"score"`
	Genre     string `json:"genre"`
}

type ServerTab struct {
	N      int    `json:"n"`
	Name   string `json:"name"`
	PostID string `json:"postId"`
	Active bool   `json:"active"`
}
type ServersResult struct {
	PostID       string      `json:"postId"`
	Servers      []ServerTab `json:"servers"`
	DefaultEmbed string      `json:"defaultEmbed"`
	Nonce        string      `json:"nonce"`
}
type EpisodeNav struct {
	Prev          string `json:"prev"`
	All           string `json:"all"`
	Next          string `json:"next"`
	EpisodeNumber string `json:"episodeNumber"`
}
type EpisodeMeta struct {
	EpisodeNumber string   `json:"episodeNumber"`
	SeriesTitle   string   `json:"seriesTitle"`
	SeriesURL     string   `json:"seriesUrl"`
	Poster        string   `json:"poster"`
	Genres        []string `json:"genres"`
}
type OngoingEntry struct {
	Title          string `json:"title"`
	URL            string `json:"url"`
	CurrentEpisode string `json:"currentEpisode"`
	TotalEpisode   string `json:"totalEpisode"`
	Score          string `json:"score"`
	Rarity         int    `json:"rarity"`
}
type HomeContent struct {
	LatestEpisodes []Episode              `json:"latestEpisodes"`
	Series         map[string][]AnimeCard `json:"series"`
}

// === SSRF / URL GUARDS ===
var blockedHostRe = regexp.MustCompile(`(?i)^(localhost|127\.|0\.0\.0\.0|\[::|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)`)

func isBlockedHost(host string) bool {
	h := strings.ToLower(strings.Trim(host, "[]"))
	return blockedHostRe.MatchString(h) || h == "localhost" || h == "::1"
}

func isValidURL(s string) bool {
	if s == "" || len(s) > 2048 {
		return false
	}
	base := s
	if strings.HasPrefix(s, "/") {
		base = BASE + s
	}
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return false
	}
	if u.User != nil {
		return false
	}
	if isBlockedHost(u.Hostname()) {
		return false
	}
	return true
}

func assertSiteURL(raw string) (string, error) {
	in := raw
	if strings.HasPrefix(raw, "/") {
		in = BASE + raw
	}
	u, err := url.Parse(in)
	if err != nil {
		return "", fmt.Errorf("Invalid URL")
	}
	if (u.Scheme != "https" && u.Scheme != "http") || strings.ToLower(u.Hostname()) != baseHost {
		return "", fmt.Errorf("URL host not allowed: %s", u.Hostname())
	}
	if isBlockedHost(u.Hostname()) {
		return "", fmt.Errorf("Blocked host")
	}
	return u.String(), nil
}

var ctrlRe = regexp.MustCompile("[\x00-\x1f\x7f\\\\]")

func sanitizeURL(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("Empty URL")
	}
	clean := strings.TrimSpace(path)
	if len(clean) > 2048 {
		clean = clean[:2048]
	}
	if ctrlRe.MatchString(clean) {
		return "", fmt.Errorf("Illegal chars in URL")
	}
	l := strings.ToLower(clean)
	if strings.HasPrefix(l, "javascript:") || strings.HasPrefix(l, "data:") || strings.HasPrefix(l, "vbscript:") {
		return "", fmt.Errorf("Blocked URL scheme")
	}
	u, err := url.Parse(BASE + "/")
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(clean)
	if err != nil {
		return "", err
	}
	u = u.ResolveReference(ref)
	if strings.ToLower(u.Hostname()) != baseHost {
		return "", fmt.Errorf("External host rejected: %s", u.Hostname())
	}
	u.User = nil
	u.Fragment = ""
	return u.String(), nil
}

func resolveURL(raw, base string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	ref, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	u := b.ResolveReference(ref)
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("Bad redirect scheme")
	}
	if u.User != nil {
		return "", fmt.Errorf("Creds in URL blocked")
	}
	if isBlockedHost(u.Hostname()) {
		return "", fmt.Errorf("Blocked redirect host")
	}
	u.User = nil
	s := u.String()
	if len(s) > 2048 {
		return "", fmt.Errorf("URL too long")
	}
	return s, nil
}

// === RATE LIMITER (serial chain + jitter) ===
type RateLimiter struct {
	mu    sync.Mutex
	tail  chan struct{}
	last  int64
	delay int64
}

func NewRateLimiter(delayMS int64) *RateLimiter {
	ch := make(chan struct{}, 1)
	ch <- struct{}{}
	return &RateLimiter{tail: ch, delay: delayMS}
}

func (r *RateLimiter) Run(fn func() (string, error)) (string, error) {
	prev := make(chan struct{}, 1)
	r.mu.Lock()
	old := r.tail
	r.tail = prev
	r.mu.Unlock()
	<-old
	now := time.Now().UnixMilli()
	r.mu.Lock()
	wait := r.delay - (now - r.last)
	r.mu.Unlock()
	if wait > 0 {
		time.Sleep(time.Duration(wait+rand.Int63n(120)) * time.Millisecond)
	}
	out, err := fn()
	r.mu.Lock()
	r.last = time.Now().UnixMilli()
	r.mu.Unlock()
	prev <- struct{}{}
	return out, err
}

var limiter = NewRateLimiter(minIntervalMS)

// === CACHE (LRU + in-flight dedupe) ===
type cacheEntry struct {
	t int64
	v string
}

var (
	cacheMu    sync.Mutex
	cache      = map[string]cacheEntry{}
	cacheOrd   = []string{}
	inflightMu sync.Mutex
	inflight   = map[string]*inflightCall{}
)

type inflightCall struct {
	done chan struct{}
	v    string
	e    error
}

func cacheGet(k string) (string, bool) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	e, ok := cache[k]
	if !ok {
		return "", false
	}
	if time.Now().UnixMilli()-e.t > cacheTTL {
		delete(cache, k)
		for i, key := range cacheOrd {
			if key == k {
				cacheOrd = append(cacheOrd[:i], cacheOrd[i+1:]...)
				break
			}
		}
		return "", false
	}
	// refresh LRU
	for i, key := range cacheOrd {
		if key == k {
			cacheOrd = append(cacheOrd[:i], cacheOrd[i+1:]...)
			break
		}
	}
	cacheOrd = append(cacheOrd, k)
	return e.v, true
}

func cacheSet(k, v string) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if _, ok := cache[k]; ok {
		for i, key := range cacheOrd {
			if key == k {
				cacheOrd = append(cacheOrd[:i], cacheOrd[i+1:]...)
				break
			}
		}
	}
	cache[k] = cacheEntry{t: time.Now().UnixMilli(), v: v}
	cacheOrd = append(cacheOrd, k)
	for len(cacheOrd) > cacheMax {
		oldest := cacheOrd[0]
		cacheOrd = cacheOrd[1:]
		delete(cache, oldest)
	}
}

// === CORE FETCH ===
var httpClient = &http.Client{
	Timeout: time.Duration(timeoutMS) * time.Millisecond,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

type retryableError struct {
	msg        string
	retryable  bool
	retryAfter int64 // ms
}

func (e *retryableError) Error() string { return e.msg }

func readCapped(res *http.Response) (string, error) {
	if cl := res.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(cl), 10, 64); err == nil && n > maxBytes {
			return "", fmt.Errorf("Body too large (%s bytes)", cl)
		}
	}
	if ct := res.Header.Get("Content-Type"); ct != "" {
		l := strings.ToLower(ct)
		if strings.Contains(l, "image/") || strings.Contains(l, "video/") || strings.Contains(l, "octet-stream") {
			return "", fmt.Errorf("Unexpected content-type: %s", ct)
		}
	}
	lr := io.LimitReader(res.Body, maxBytes+1)
	data, err := io.ReadAll(lr)
	if err != nil {
		return "", err
	}
	if len(data) > maxBytes {
		return "", fmt.Errorf("Body exceeds 3MB cap")
	}
	// manual gzip fallback (transport usually handles it; harmless if plain)
	if strings.Contains(res.Header.Get("Content-Encoding"), "gzip") {
		if zr, err := gzip.NewReader(bytes.NewReader(data)); err == nil {
			if dec, err := io.ReadAll(io.LimitReader(zr, maxBytes+1)); err == nil {
				zr.Close()
				data = dec
			} else {
				zr.Close()
			}
		}
	}
	return string(data), nil
}

var wafRe = regexp.MustCompile(`(?i)attention required|just a moment|cf-challenge|captcha|you have been blocked`)

func doFetch(rawURL string, postBody *string, extraHeaders map[string]string, redirects int) (string, error) {
	cur := rawURL
	for r := 0; r <= maxRedirects; r++ {
		var req *http.Request
		var err error
		if postBody != nil {
			req, err = http.NewRequest("POST", cur, strings.NewReader(*postBody))
		} else {
			req, err = http.NewRequest("GET", cur, nil)
		}
		if err != nil {
			return "", err
		}
		for k, v := range HEADERS {
			req.Header.Set(k, v)
		}
		for k, v := range extraHeaders {
			req.Header.Set(k, v)
		}
		res, err := httpClient.Do(req)
		if err != nil {
			msg := err.Error()
			if strings.Contains(strings.ToLower(msg), "timeout") || strings.Contains(strings.ToLower(msg), "deadline") {
				return "", fmt.Errorf("Timeout %dms for %s", timeoutMS, cur)
			}
			return "", &retryableError{msg: err.Error()}
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			res.Body.Close()
			if loc == "" {
				return "", fmt.Errorf("Redirect %d without location", res.StatusCode)
			}
			if redirects+r >= maxRedirects {
				return "", fmt.Errorf("Too many redirects")
			}
			cur, err = resolveURL(loc, cur)
			if err != nil {
				return "", err
			}
			continue
		}
		if res.StatusCode == 429 || (res.StatusCode >= 500 && res.StatusCode < 600) {
			var ra int64
			if v := res.Header.Get("Retry-After"); v != "" {
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
					ra = int64(n) * 1000
				}
			}
			res.Body.Close()
			return "", &retryableError{msg: fmt.Sprintf("HTTP %d for %s", res.StatusCode, cur), retryable: true, retryAfter: ra}
		}
		if res.StatusCode == 403 || res.StatusCode == 401 || res.StatusCode == 503 {
			body, _ := readCapped(res)
			res.Body.Close()
			if wafRe.MatchString(body) {
				return "", fmt.Errorf("WAF blocked (Cloudflare) for %s — filter params trip bot protection; retry with fewer filters", cur)
			}
			return "", fmt.Errorf("HTTP %d for %s", res.StatusCode, cur)
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			return "", fmt.Errorf("HTTP %d for %s", res.StatusCode, cur)
		}
		body, err := readCapped(res)
		res.Body.Close()
		if err != nil {
			return "", err
		}
		return body, nil
	}
	return "", fmt.Errorf("Too many redirects")
}

var netErrRe = regexp.MustCompile(`(?i)timeout|econn|enotfound|eai_again|socket|fetch failed|connection|reset|refused`)

func withRetry(fn func() (string, error)) (string, error) {
	var last error = fmt.Errorf("failed")
	for i := 0; i <= maxRetries; i++ {
		v, err := fn()
		if err == nil {
			return v, nil
		}
		last = err
		var re *retryableError
		retryable := false
		var backoff int64
		if e, ok := err.(*retryableError); ok {
			_ = e
			re = e
			retryable = re.retryable
			if re.retryAfter > 0 {
				backoff = re.retryAfter
			}
		} else if netErrRe.MatchString(err.Error()) {
			retryable = true
		}
		if !retryable || i == maxRetries {
			return "", last
		}
		if backoff == 0 {
			b := int64(600) << uint(i)
			if b > 8000 {
				b = 8000
			}
			backoff = b
		}
		time.Sleep(time.Duration(backoff+rand.Int63n(300)) * time.Millisecond)
	}
	return "", last
}

func fetchPage(rawURL string) (string, error) {
	var site string
	var err error
	if strings.HasPrefix(rawURL, "/") {
		site, err = sanitizeURL(rawURL)
	} else {
		site, err = assertSiteURL(rawURL)
	}
	if err != nil {
		return "", err
	}
	if hit, ok := cacheGet(site); ok {
		return hit, nil
	}
	inflightMu.Lock()
	if c, ok := inflight[site]; ok {
		inflightMu.Unlock()
		<-c.done
		if hit, ok := cacheGet(site); ok {
			return hit, nil
		}
		return c.v, c.e
	}
	call := &inflightCall{done: make(chan struct{})}
	inflight[site] = call
	inflightMu.Unlock()

	v, e := limiter.Run(func() (string, error) {
		return withRetry(func() (string, error) { return doFetch(site, nil, nil, 0) })
	})
	if e == nil {
		cacheSet(site, v)
	}
	call.v, call.e = v, e
	inflightMu.Lock()
	delete(inflight, site)
	inflightMu.Unlock()
	close(call.done)
	return v, e
}

func postAjax(rawURL, body, postURL string) (string, error) {
	var site string
	var err error
	if strings.HasPrefix(rawURL, "/") {
		site, err = sanitizeURL(rawURL)
	} else {
		site, err = assertSiteURL(rawURL)
	}
	if err != nil {
		return "", err
	}
	if len(body) > 8192 {
		return "", fmt.Errorf("POST body too large")
	}
	ref := BASE + "/"
	if postURL != "" {
		if strings.HasPrefix(postURL, "/") {
			ref, err = sanitizeURL(postURL)
		} else {
			ref, err = assertSiteURL(postURL)
		}
		if err != nil {
			return "", err
		}
	}
	extra := map[string]string{
		"accept":           "*/*",
		"origin":           BASE,
		"referer":          ref,
		"x-requested-with": "XMLHttpRequest",
		"content-type":     "application/x-www-form-urlencoded; charset=UTF-8",
	}
	return limiter.Run(func() (string, error) {
		return withRetry(func() (string, error) { return doFetch(site, &body, extra, 0) })
	})
}

// === PARSE HELPERS ===
func safeDoc(html string) *goquery.Document {
	src := html
	if len(src) > 2000000 {
		src = src[:2000000]
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(src))
	if err != nil {
		doc, _ = goquery.NewDocumentFromReader(strings.NewReader(""))
	}
	return doc
}

var wsRe = regexp.MustCompile(`\s+`)

func txt(s string, max int) string {
	t := strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	// JS .slice(max) semantics: count UTF-16 code units, never split a rune
	if len(t) > max {
		n16 := 0
		for i, ru := range t {
			if n16 >= max {
				t = t[:i]
				break
			}
			if ru > 0xFFFF {
				n16 += 2
			} else {
				n16++
			}
		}
	}
	return t
}

var nonNumRe = regexp.MustCompile(`[^0-9.]`)

func num(s string) string {
	return strings.TrimSpace(nonNumRe.ReplaceAllString(s, ""))
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func imgOf(sel *goquery.Selection) string {
	img := sel.Find("img").First()
	if v, ok := img.Attr("data-src"); ok && v != "" {
		return v
	}
	if v, ok := img.Attr("data-lazy-src"); ok && v != "" {
		return v
	}
	if v, ok := img.Attr("src"); ok {
		return v
	}
	return ""
}

func hrefOf(sel *goquery.Selection) string {
	if v, ok := sel.Find("a").First().Attr("href"); ok {
		return v
	}
	return ""
}

func firstText(doc *goquery.Document, sels []string, max int) string {
	for _, s := range sels {
		if t := txt(doc.Find(s).First().Text(), max); t != "" {
			return t
		}
	}
	return ""
}

var nonceRe = regexp.MustCompile(`^[a-f0-9]{6,20}$`)

func isNonce(s string) bool { return nonceRe.MatchString(s) }

// string-aware balanced-brace slice
func sliceBalanced(src string, start, limit int) string {
	depth, inStr, esc := 0, false, false
	end := start + limit
	if end > len(src) {
		end = len(src)
	}
	for p := start; p < end; p++ {
		ch := src[p]
		if inStr {
			if esc {
				esc = false
			} else if ch == '\\' {
				esc = true
			} else if ch == '"' {
				inStr = false
			}
		} else if ch == '"' {
			inStr = true
		} else if ch == '{' {
			depth++
		} else if ch == '}' {
			depth--
			if depth == 0 {
				return src[start : p+1]
			}
		}
	}
	return ""
}

var epURLRe = regexp.MustCompile(`(?i)(?:episode[-/](\d+))|(?:/(\d+)(?:/|\.html|$))`)
var postIDRe = regexp.MustCompile(`/(\d{4,})\.html`)

func extractEpisodeFromURL(u string) string {
	m := epURLRe.FindStringSubmatch(u)
	if m == nil {
		return ""
	}
	if m[1] != "" {
		return m[1]
	}
	return m[2]
}

func extractPostID(u string) string {
	if m := postIDRe.FindStringSubmatch(u); m != nil {
		return m[1]
	}
	return ""
}

// extractPageVar decodes data: base64 script extras (and inline fallbacks)
func extractPageVar(html string, varNames ...string) map[string]interface{} {
	doc := safeDoc(html)
	var scripts []string
	doc.Find(`script[src^="data:text/javascript;base64,"]`).Each(func(_ int, el *goquery.Selection) {
		if src, ok := el.Attr("src"); ok {
			const pfx = "data:text/javascript;base64,"
			if strings.HasPrefix(src, pfx) {
				scripts = append(scripts, src[len(pfx):])
			}
		}
	})
	doc.Find("script:not([src])").Each(func(_ int, el *goquery.Selection) {
		t, _ := el.Html()
		for _, v := range varNames {
			if strings.Contains(t, v) {
				scripts = append(scripts, base64.StdEncoding.EncodeToString([]byte(t)))
				break
			}
		}
	})
	for _, b64 := range scripts {
		js, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			continue
		}
		jsStr := string(js)
		hit := -1
		for _, v := range varNames {
			if i := strings.Index(jsStr, "var "+v+"="); i != -1 {
				hit = i
				break
			}
		}
		if hit == -1 {
			continue
		}
		start := strings.Index(jsStr[hit:], "{")
		if start == -1 {
			continue
		}
		start += hit
		slice := sliceBalanced(jsStr, start, 20000)
		if slice == "" {
			continue
		}
		var out map[string]interface{}
		if err := json.Unmarshal([]byte(slice), &out); err == nil {
			return out
		}
	}
	return nil
}

var iframeSrcRe = regexp.MustCompile(`(?i)<iframe[^>]+(?:src|data-src)=["']([^"']+)["']`)
var urlRe = regexp.MustCompile(`https?://[^\s"'\\<>]+`)

func extractEmbedURL(html string) string {
	doc := safeDoc(html)
	if v, ok := doc.Find("iframe").First().Attr("src"); ok && v != "" {
		return v
	}
	if v, ok := doc.Find("iframe").First().Attr("data-src"); ok && v != "" {
		return v
	}
	if v, ok := doc.Find("video source").First().Attr("src"); ok && v != "" {
		return v
	}
	if v, ok := doc.Find("video").First().Attr("src"); ok && v != "" {
		return v
	}
	if m := iframeSrcRe.FindStringSubmatch(html); m != nil {
		return m[1]
	}
	if m := urlRe.FindString(html); m != "" {
		return m
	}
	return ""
}

// generic card parser
func parseCards(doc *goquery.Document, sel string, pick func(*goquery.Selection) *AnimeCard) []AnimeCard {
	var out []AnimeCard
	doc.Find(sel).Each(func(_ int, el *goquery.Selection) {
		c := pick(el)
		if c != nil && c.Title != "" && c.URL != "" {
			out = append(out, *c)
		}
	})
	if out == nil {
		out = []AnimeCard{}
	}
	return out
}

// === SCRAPERS ===
func parseArticleGrid(doc *goquery.Document) []Episode {
	out := []Episode{}
	doc.Find("article.animeseries").Each(func(_ int, el *goquery.Selection) {
		u := hrefOf(el)
		if u == "" {
			return
		}
		title := txt(el.Find(".title span").AttrOr("data-title-default", ""), 200)
		if title == "" {
			title = txt(el.Find(".title").First().Text(), 200)
		}
		if title == "" {
			return
		}
		out = append(out, Episode{Title: title, Ep: num(el.Find(".episodes").Text()), URL: u, Thumbnail: imgOf(el)})
	})
	return out
}

func getLatestEpisodes(page int) ([]Episode, error) {
	page = clampPage(page)
	var u string
	if page == 1 {
		u = BASE + "/"
	} else {
		u = fmt.Sprintf("%s/page/%d/", BASE, page)
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	return parseArticleGrid(safeDoc(html)), nil
}

func getHomeContent(page int) (HomeContent, error) {
	page = clampPage(page)
	var u string
	if page == 1 {
		u = BASE + "/"
	} else {
		u = fmt.Sprintf("%s/page/%d/", BASE, page)
	}
	html, err := fetchPage(u)
	if err != nil {
		return HomeContent{}, err
	}
	doc := safeDoc(html)
	series := map[string][]AnimeCard{}
	var pop []AnimeCard
	doc.Find("a.popseries").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		if href == "" {
			return
		}
		img := el.Find("img").First()
		title := txt(img.AttrOr("alt", ""), 200)
		if title == "" {
			return
		}
		src, _ := img.Attr("src")
		pop = append(pop, AnimeCard{Title: title, URL: href, Thumbnail: src})
	})
	if len(pop) > 0 {
		series["Populer"] = pop
	}
	return HomeContent{LatestEpisodes: parseArticleGrid(doc), Series: series}, nil
}

func parseAsCards(doc *goquery.Document, sel string) []AnimeCard {
	if sel == "" {
		sel = ".as-anime-card"
	}
	return parseCards(doc, sel, func(el *goquery.Selection) *AnimeCard {
		var u string
		if el.Is("a") {
			u, _ = el.Attr("href")
		}
		if u == "" {
			u = hrefOf(el)
		}
		if u == "" {
			return nil
		}
		t := el.Find(".as-anime-title").First()
		title := txt(t.AttrOr("data-title-default", ""), 200)
		if title == "" {
			title = txt(t.Text(), 200)
		}
		if title == "" {
			return nil
		}
		var genres []string
		el.Find(".as-genres span, .jr-genre-pill").Each(func(_ int, g *goquery.Selection) {
			if x := txt(g.Text(), 40); x != "" {
				genres = append(genres, x)
			}
		})
		c := &AnimeCard{Title: title, URL: u, Thumbnail: imgOf(el)}
		c.Rating = strPtr(num(el.Find(".as-rating").First().Text()))
		c.Type = strPtr(txt(nonWordLeadRe.ReplaceAllString(el.Find(".as-type").First().Text(), ""), 20))
		c.Season = strPtr(txt(emojiCalRe.ReplaceAllString(el.Find(".as-season").First().Text(), ""), 30))
		c.Synopsis = strPtr(txt(el.Find(".as-synopsis").First().Text(), 300))
		if len(genres) > 0 {
			c.Genres = genres
		}
		return c
	})
}

var nonWordLeadRe = regexp.MustCompile(`^[^\w]+`)
var emojiCalRe = regexp.MustCompile("📅\\s*")

var advKeys = []string{"sort", "status", "type", "score_min", "score_max", "year_min", "year_max", "genre", "rating", "mode", "studio", "season", "s"}

func advancedSearch(opts map[string]string) ([]AnimeCard, error) {
	params := url.Values{}
	for _, k := range advKeys {
		if v, ok := opts[k]; ok && v != "" {
			if len(v) > 64 {
				v = v[:64]
			}
			params.Set(k, v)
		}
	}
	page := 1
	if p, ok := opts["page"]; ok {
		page = clampPage(atoi(p))
	}
	base := BASE + "/anime/"
	if page != 1 {
		base = fmt.Sprintf("%s/anime/page/%d/", BASE, page)
	}
	qs := params.Encode()
	fetchURL := base
	if qs != "" {
		fetchURL = base + "?" + qs
	}
	html, err := fetchPage(fetchURL)
	if err == nil {
		return parseAsCards(safeDoc(html), ""), nil
	}
	genre, hasGenre := opts["genre"]
	if !hasGenre || genre == "" || !wafErrRe.MatchString(err.Error()) {
		return nil, err
	}
	return genreFallback(opts)
}

var wafErrRe = regexp.MustCompile(`WAF blocked|HTTP (403|500)`)

func genreFallback(opts map[string]string) ([]AnimeCard, error) {
	slug, err := cleanSlug(opts["genre"])
	if err != nil {
		return nil, err
	}
	var out []AnimeCard
	for p := 1; p <= 3; p++ {
		var u string
		if p == 1 {
			u = fmt.Sprintf("%s/genres/%s/", BASE, slug)
		} else {
			u = fmt.Sprintf("%s/genres/%s/page/%d/", BASE, slug, p)
		}
		html, err := fetchPage(u)
		if err != nil {
			return nil, err
		}
		cards := parseAsCards(safeDoc(html), "")
		if len(cards) == 0 {
			break
		}
		out = append(out, cards...)
		if len(cards) < 20 {
			break
		}
	}
	min := parseNum(opts["score_min"])
	max := parseNum(opts["score_max"])
	typ := strings.ToLower(opts["type"])
	var res []AnimeCard
	for _, c := range out {
		r := parseNum(strVal(c.Rating))
		if !isNaN(min) && (isNaN(r) || r < min) {
			continue
		}
		if !isNaN(max) && (isNaN(r) || r > max) {
			continue
		}
		if typ != "" && strings.ToLower(strVal(c.Type)) != typ {
			continue
		}
		res = append(res, c)
	}
	if opts["sort"] == "series_skor" {
		sort.SliceStable(res, func(i, j int) bool {
			// TS semantics: parseFloat(x) || 0 — NaN coerces to 0
			return parseNumOr0(strVal(res[j].Rating)) < parseNumOr0(strVal(res[i].Rating))
		})
	} else if opts["sort"] == "series_title" {
		sort.SliceStable(res, func(i, j int) bool { return res[i].Title < res[j].Title })
	}
	if res == nil {
		res = []AnimeCard{}
	}
	return res, nil
}

func getList(page int) ([]AnimeCard, error) {
	page = clampPage(page)
	var u string
	if page == 1 {
		u = BASE + "/anime/"
	} else {
		u = fmt.Sprintf("%s/anime/page/%d/", BASE, page)
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	return parseAsCards(safeDoc(html), ""), nil
}

func searchAnime(query string) ([]AnimeCard, error) {
	q, err := cleanQuery(query)
	if err != nil {
		return nil, err
	}
	html, err := fetchPage(BASE + "/?s=" + url.QueryEscape(q))
	if err != nil {
		return nil, err
	}
	return parseAsCards(safeDoc(html), ""), nil
}

func getAnimeDetail(rawURL string) (*AnimeDetail, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return nil, err
	}
	html, err := fetchPage(site)
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	title := txt(doc.Find("h1.entry-title span[data-title-default]").First().AttrOr("data-title-default", ""), 300)
	if title == "" {
		h1 := txt(doc.Find("h1.entry-title").First().Text(), 300)
		h1 = nontonTrimRe.ReplaceAllString(h1, "")
		title = strings.TrimSpace(h1)
	}
	if title == "" {
		title = txt(doc.Find(`meta[property="og:title"]`).First().AttrOr("content", ""), 300)
	}
	if title == "" {
		return nil, nil
	}
	meta := map[string]string{}
	doc.Find("ul.details-list li").Each(func(_ int, el *goquery.Selection) {
		label := txt(strings.TrimSuffix(el.Find(".detail-label").First().Text(), ":"), 40)
		label = txt(label, 40)
		if label == "" {
			return
		}
		clone := el.Clone()
		clone.Find(".detail-label").Remove()
		value := txt(clone.Text(), 300)
		if value == "" || value == "-" {
			return
		}
		if _, ok := meta[label]; !ok {
			meta[label] = value
		}
	})
	getMeta := func(label string) string {
		if v, ok := meta[label]; ok {
			return v
		}
		for k, v := range meta {
			if strings.Contains(strings.ToLower(k), strings.ToLower(label)) {
				return v
			}
		}
		return ""
	}
	var quick []string
	doc.Find(".anime-card__quick-info .info-item").Each(func(_ int, el *goquery.Selection) {
		quick = append(quick, txt(el.Text(), 60))
	})
	findQuick := func(re *regexp.Regexp) string {
		for _, q := range quick {
			if re.MatchString(q) {
				return q
			}
		}
		return ""
	}
	var genres []string
	doc.Find("a.genre-tag").Each(func(_ int, el *goquery.Selection) {
		if g := txt(el.Text(), 40); g != "" {
			genres = append(genres, g)
		}
	})
	var episodes []EpRef
	doc.Find(".episode-list-items a.episode-item").Each(func(_ int, el *goquery.Selection) {
		u, _ := el.Attr("href")
		if u == "" {
			u, _ = el.Attr("data-episode-url")
		}
		if u == "" {
			return
		}
		episodes = append(episodes, EpRef{
			Title: txt(el.Find(".ep-title").Text(), 200),
			Date:  txt(el.Find(".ep-date").Text(), 40),
			URL:   u,
		})
	})
	recs := parseAsCards(doc, ".related .as-anime-card")
	if genres == nil {
		genres = []string{}
	}
	if episodes == nil {
		episodes = []EpRef{}
	}
	d := &AnimeDetail{
		Title:    title,
		TitleEn:  getMeta("English"),
		TitleJp:  getMeta("Japanese"),
		Score:    txt(doc.Find(".anime-card__score .value").First().Text(), 10),
		Type:     txt(doc.Find(".anime-card__score .type").First().Text(), 20),
		Synopsis: txt(doc.Find(".synopsis-prose p").First().Text(), 2000),
		Genres:   genres,
		Studios:  getMeta("Studio"),
		Rating:   getMeta("Rating"),
		Members:  getMeta("Member"),
		Aired:    getMeta("Aired"),
		Status:   txt(doc.Find(".status-airing").First().Text(), 30),
		Duration: findQuick(minRe),
		Season:   txt(doc.Find(".info-item.season").First().Text(), 30),
		Poster:   doc.Find(".anime-card__sidebar img").First().AttrOr("src", ""),
		Trailer:  doc.Find("a.trailerbutton").First().AttrOr("href", ""),
		Episodes: episodes,
	}
	if d.TitleJp == "" {
		d.TitleJp = getMeta("Synonyms")
	}
	if v := getMeta("Popularity"); v != "" {
		d.Popularity = v
	} else {
		d.Popularity = getMeta("Popul")
	}
	if d.Synopsis == "" {
		d.Synopsis = txt(doc.Find(`meta[name="description"]`).First().AttrOr("content", ""), 2000)
	}
	if d.Poster == "" {
		d.Poster = doc.Find(`meta[property="og:image"]`).First().AttrOr("content", "")
	}
	d.TotalEpisodes = findQuick(episodeRe)
	first, _ := doc.Find(".meta-episode-item.first a").First().Attr("href")
	last, _ := doc.Find(".meta-episode-item.last a").First().Attr("href")
	if first == "" && len(episodes) > 0 {
		first = episodes[len(episodes)-1].URL
	}
	if last == "" && len(episodes) > 0 {
		last = episodes[0].URL
	}
	d.FirstEpisode, d.LastEpisode = first, last
	d.Recommended = recs
	return d, nil
}

var (
	nontonTrimRe = regexp.MustCompile(`(?i)^Nonton\s+|\s+Sub Indo$`)
	minRe        = regexp.MustCompile(`(?i)min`)
	episodeRe    = regexp.MustCompile(`(?i)episode`)
)

func getEpisodeInfo(rawURL string) (*StreamResult, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return nil, err
	}
	html, err := fetchPage(site)
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	title := firstText(doc, []string{"h1.entry-title", "h2.name"}, 300)
	if title == "" {
		title = txt(doc.Find(`meta[property="og:title"]`).First().AttrOr("content", ""), 300)
	}
	if title == "" {
		return nil, nil
	}
	var servers []ServerTab
	postID := extractPostID(rawURL)
	defEmbed := ""
	if res, err := getEpisodeServers(site); err == nil {
		servers = res.Servers
		if res.PostID != "" {
			postID = res.PostID
		}
		defEmbed = res.DefaultEmbed
	}
	var streams []StreamEntry
	if len(servers) > 0 {
		for _, s := range servers {
			e := ""
			if s.Active {
				e = defEmbed
			}
			streams = append(streams, StreamEntry{Server: s.Name, EmbedURL: e, RawHTML: "<span>S-" + s.Name + "</span>"})
		}
	} else {
		frame := doc.Find("#videoku iframe, .player_embed iframe").First()
		u := frame.AttrOr("data-src", "")
		if u == "" {
			u = frame.AttrOr("src", "")
		}
		if u != "" {
			streams = append(streams, StreamEntry{Server: "default", EmbedURL: u})
		}
	}
	if streams == nil {
		streams = []StreamEntry{}
	}
	var downloads []DownloadBlock
	collectDL := func(container *goquery.Selection, fmtFn func(*goquery.Selection) string) {
		container.Each(func(_ int, el *goquery.Selection) {
			format := fmtFn(el)
			var links []StreamLink
			el.Find("a").Each(func(_ int, a *goquery.Selection) {
				label := txt(a.Text(), 40)
				href, _ := a.Attr("href")
				if label != "" && href != "" && isValidURL(href) {
					links = append(links, StreamLink{Label: label, URL: href})
				}
			})
			if len(links) > 0 {
				downloads = append(downloads, DownloadBlock{Format: format, Links: links})
			}
		})
	}
	collectDL(doc.Find(".listlink"), func(el *goquery.Selection) string {
		if f := txt(el.Find("span").First().Text(), 30); f != "" {
			return f
		}
		return "Download"
	})
	if len(downloads) == 0 {
		collectDL(doc.Find("div dl.download > dd"), func(el *goquery.Selection) string {
			if f := txt(el.PrevFiltered("dt").Text(), 30); f != "" {
				return f
			}
			return "Download"
		})
	}
	if downloads == nil {
		downloads = []DownloadBlock{}
	}
	return &StreamResult{Title: title, PostID: postID, Streams: streams, Downloads: downloads}, nil
}

func getEpisodeServers(rawURL string) (ServersResult, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return ServersResult{}, err
	}
	html, err := fetchPage(site)
	if err != nil {
		return ServersResult{}, err
	}
	doc := safeDoc(html)
	var servers []ServerTab
	postID := ""
	doc.Find("li.serverplayer").Each(func(_ int, el *goquery.Selection) {
		name := txt(el.AttrOr("data-type", ""), 40)
		if name == "" {
			return
		}
		pid, _ := el.Attr("data-post")
		if pid != "" {
			postID = pid
		}
		n, _ := strconv.Atoi(el.AttrOr("data-nume", "0"))
		if n == 0 {
			n = len(servers) + 1
		}
		servers = append(servers, ServerTab{N: n, Name: name, PostID: pid, Active: el.HasClass("on")})
	})
	if len(servers) == 0 {
		return ServersResult{}, fmt.Errorf("No servers found (page layout changed?)")
	}
	sort.SliceStable(servers, func(i, j int) bool { return servers[i].N < servers[j].N })
	frame := doc.Find("#videoku iframe, .player_embed iframe").First()
	defEmbed := frame.AttrOr("data-src", "")
	if defEmbed == "" {
		defEmbed = frame.AttrOr("src", "")
	}
	nonce := ""
	if vars := extractPageVar(html, "kotakajax"); vars != nil {
		nonce, _ = vars["nonce"].(string)
	}
	return ServersResult{PostID: postID, Servers: servers, DefaultEmbed: defEmbed, Nonce: nonce}, nil
}

func pickServer(servers []ServerTab, sel string) (ServerTab, error) {
	if sel == "" {
		sel = "1"
	}
	if n, err := strconv.Atoi(sel); err == nil {
		if n < 1 {
			n = 1
		}
		if n > len(servers) {
			n = len(servers)
		}
		for _, s := range servers {
			if s.N == n {
				return s, nil
			}
		}
		return servers[n-1], nil
	}
	want := strings.ToLower(sel)
	for _, s := range servers {
		if strings.ToLower(s.Name) == want {
			return s, nil
		}
	}
	for _, s := range servers {
		if strings.Contains(strings.ToLower(s.Name), want) {
			return s, nil
		}
	}
	return ServerTab{}, fmt.Errorf("Unknown server %q (use servers command to list)", sel)
}

func resolveServer(rawURL, sel string) (string, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return "", err
	}
	res, err := getEpisodeServers(site)
	if err != nil {
		return "", err
	}
	tab, err := pickServer(res.Servers, sel)
	if err != nil {
		return "", err
	}
	if !isNonce(res.Nonce) {
		return "", fmt.Errorf("player_ajax nonce not found")
	}
	post := tab.PostID
	if post == "" {
		post = res.PostID
	}
	form := url.Values{
		"action":     {"player_ajax"},
		"post":       {post},
		"nume":       {strconv.Itoa(tab.N)},
		"serverName": {tab.Name},
		"nonce":      {res.Nonce},
	}
	resHTML, err := postAjax(BASE+"/wp-admin/admin-ajax.php", form.Encode(), site)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(resHTML) == "" || strings.TrimSpace(resHTML) == "0" {
		return "", fmt.Errorf("Server returned empty embed (expired nonce?)")
	}
	embed := extractEmbedURL(resHTML)
	if embed == "" || !isValidURL(embed) {
		return "", fmt.Errorf("No embed URL in server response")
	}
	return embed, nil
}

func getEpisodeStream(rawURL string, serverNumber int) (string, error) {
	if v, err := resolveServer(rawURL, strconv.Itoa(serverNumber)); err == nil {
		return v, nil
	}
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return "", err
	}
	html, err := fetchPage(site)
	if err != nil {
		return "", err
	}
	frame := safeDoc(html).Find("#videoku iframe, .player_embed iframe").First()
	u := frame.AttrOr("data-src", "")
	if u == "" {
		u = frame.AttrOr("src", "")
	}
	if u == "" {
		return "", fmt.Errorf("No stream found")
	}
	return u, nil
}

var epNumRe = regexp.MustCompile(`"episodeNumber"\s*:\s*"?(\d+)"?`)

func getEpisodeNav(rawURL string) (EpisodeNav, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return EpisodeNav{}, err
	}
	html, err := fetchPage(site)
	if err != nil {
		return EpisodeNav{}, err
	}
	doc := safeDoc(html)
	nav := EpisodeNav{EpisodeNumber: extractEpisodeFromURL(site)}
	doc.Find("#navigation-episode a").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		if href == "" {
			return
		}
		title, _ := el.Attr("title")
		t := strings.ToLower(el.Text() + " " + title)
		switch {
		case strings.Contains(t, "prev"):
			nav.Prev = href
		case strings.Contains(t, "next"):
			nav.Next = href
		case strings.Contains(href, "/anime/"):
			nav.All = href
		default:
			if nav.All == "" {
				nav.All = href
			}
		}
	})
	if m := epNumRe.FindStringSubmatch(html); m != nil {
		nav.EpisodeNumber = m[1]
	}
	return nav, nil
}

func getEpisodeMeta(rawURL string) (EpisodeMeta, error) {
	site, err := assertSiteURL(rawURL)
	if err != nil {
		return EpisodeMeta{}, err
	}
	html, err := fetchPage(site)
	if err != nil {
		return EpisodeMeta{}, err
	}
	trace := extractPageVar(html, "episodeToTrace", "episodeToTrack")
	str := func(m map[string]interface{}, k string) string {
		if m == nil {
			return ""
		}
		s, _ := m[k].(string)
		return s
	}
	meta := EpisodeMeta{}
	meta.EpisodeNumber = str(trace, "episodeNumber")
	if meta.EpisodeNumber == "" {
		if m := epNumRe.FindStringSubmatch(html); m != nil {
			meta.EpisodeNumber = m[1]
		} else {
			meta.EpisodeNumber = extractEpisodeFromURL(site)
		}
	}
	meta.SeriesTitle = str(trace, "seriesTitle")
	meta.SeriesURL = str(trace, "seriesUrl")
	meta.Poster = str(trace, "poster")
	if g, ok := trace["genres"].([]interface{}); ok {
		for _, x := range g {
			if s, ok := x.(string); ok {
				meta.Genres = append(meta.Genres, s)
			}
			if len(meta.Genres) >= 20 {
				break
			}
		}
	}
	if meta.SeriesTitle == "" || meta.SeriesURL == "" {
		seriesRe := regexp.MustCompile(`"partOfSeries"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"([^"]+)"`)
		if m := seriesRe.FindStringSubmatch(html); m != nil {
			if meta.SeriesTitle == "" {
				meta.SeriesTitle = m[1]
			}
			if meta.SeriesURL == "" {
				meta.SeriesURL = m[2]
			}
		}
	}
	if meta.Genres == nil {
		meta.Genres = []string{}
	}
	return meta, nil
}

func loadMoreHome(displayedIDs []int, offset int) ([]Episode, error) {
	home, err := fetchPage(BASE + "/")
	if err != nil {
		return nil, err
	}
	vars := extractPageVar(home, "misha_loadmore_params")
	nonce, _ := vars["nonce"].(string)
	if !isNonce(nonce) {
		return nil, fmt.Errorf("loadmore nonce not found")
	}
	if offset < 0 {
		offset = 0
	}
	if offset > 100000 {
		offset = 100000
	}
	form := url.Values{"action": {"loadmore"}, "nonce": {nonce}, "offset": {strconv.Itoa(offset)}}
	n := 0
	for _, id := range displayedIDs {
		if n >= 200 {
			break
		}
		form.Add("displayed_posts[]", strconv.Itoa(id))
		n++
	}
	resHTML, err := postAjax(BASE+"/wp-admin/admin-ajax.php", form.Encode(), BASE+"/")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(resHTML) == "" || strings.TrimSpace(resHTML) == "0" {
		return []Episode{}, nil
	}
	return parseArticleGrid(safeDoc(resHTML)), nil
}

var genreSorts = map[string]bool{"az": true, "popular": true, "ongoing": true}
var digitsRe = regexp.MustCompile(`[\d,]+`)

func getGenres(sort string) ([]Genre, error) {
	u := BASE + "/genres/"
	if sort != "" {
		s := strings.ToLower(strings.TrimSpace(sort))
		if !genreSorts[s] {
			return nil, fmt.Errorf("Sort must be az|popular|ongoing")
		}
		u += "?sort=" + s + "&mode=sort"
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	var out []Genre
	doc.Find("a.genre-grid-card").Each(func(_ int, el *goquery.Selection) {
		name := txt(el.Find(".genre-name").Text(), 60)
		href, _ := el.Attr("href")
		if name == "" || href == "" {
			return
		}
		total := 0
		if m := digitsRe.FindString(el.Find(".detail-item.count").Text()); m != "" {
			total, _ = strconv.Atoi(strings.ReplaceAll(m, ",", ""))
		}
		ongoing := 0
		if m := digitsRe.FindString(el.Find(".detail-item.ongoing").Text()); m != "" {
			ongoing, _ = strconv.Atoi(strings.ReplaceAll(m, ",", ""))
		}
		out = append(out, Genre{Name: name, URL: href, Total: total, Ongoing: ongoing})
	})
	if out == nil {
		out = []Genre{}
	}
	return out, nil
}

func getGenreAnime(slug string, page int) ([]AnimeCard, error) {
	s, err := cleanSlug(slug)
	if err != nil {
		return nil, err
	}
	page = clampPage(page)
	var u string
	if page == 1 {
		u = fmt.Sprintf("%s/genres/%s/", BASE, s)
	} else {
		u = fmt.Sprintf("%s/genres/%s/page/%d/", BASE, s, page)
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	return parseAsCards(safeDoc(html), ""), nil
}

var sortValRe = regexp.MustCompile(`^[a-z0-9_]+$`)

func getOngoingAnime(sortParam string) ([]OngoingEntry, error) {
	u := BASE + "/ongoing-list/"
	if sortParam != "" {
		if !sortValRe.MatchString(sortParam) {
			return nil, fmt.Errorf("Invalid sort value")
		}
		s := strings.ToLower(strings.TrimSpace(sortParam))
		if len(s) > 32 {
			s = s[:32]
		}
		u += "?sort=" + s + "&mode=sort"
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	rarityRe := regexp.MustCompile(`rarity-(\d)`)
	var out []OngoingEntry
	doc.Find("a.gacha-card").Each(func(_ int, el *goquery.Selection) {
		href, _ := el.Attr("href")
		if href == "" {
			return
		}
		title := txt(el.Find("h3.title").Text(), 200)
		if title == "" {
			return
		}
		rarity := 3
		if m := rarityRe.FindStringSubmatch(el.AttrOr("class", "")); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil {
				rarity = n
			}
		}
		out = append(out, OngoingEntry{
			Title: title, URL: href,
			CurrentEpisode: txt(el.Find(".current-ep").Text(), 20),
			TotalEpisode:   txt(el.Find(".total-ep").Text(), 20),
			Score:          strings.Trim(txt(el.Find(".skor-angka").Text(), 10), "()"),
			Rarity:         rarity,
		})
	})
	if out == nil {
		out = []OngoingEntry{}
	}
	return out, nil
}

func getPopularSeries() ([]SeasonResult, error) {
	html, err := fetchPage(BASE + "/popular-series/")
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	labels := map[string]string{}
	doc.Find(".tabs li").Each(func(_ int, li *goquery.Selection) {
		id, _ := li.Attr("data-tab")
		label := txt(li.Text(), 40)
		if id != "" && label != "" {
			labels[id] = label
		}
	})
	var out []SeasonResult
	doc.Find(".tab-content").Each(func(_ int, tab *goquery.Selection) {
		id, _ := tab.Attr("id")
		genre := labels[id]
		if genre == "" {
			genre = id
		}
		tab.Find(".animeseries").Each(func(_ int, el *goquery.Selection) {
			u := hrefOf(el)
			if u == "" {
				return
			}
			title := txt(el.Find(".title span").Text(), 200)
			if title == "" {
				return
			}
			out = append(out, SeasonResult{
				Title: title, URL: u, Thumbnail: imgOf(el),
				Score: num(el.Find(".kotakscore").Text()), Genre: genre,
			})
		})
	})
	if out == nil {
		out = []SeasonResult{}
	}
	return out, nil
}

func getSchedule() ([]ScheduleEntry, error) {
	html, err := fetchPage(BASE + "/jadwal-rilis/")
	if err != nil {
		return nil, err
	}
	doc := safeDoc(html)
	var out []ScheduleEntry
	doc.Find(".as-tab-content").Each(func(_ int, day *goquery.Selection) {
		dayName := txt(day.AttrOr("id", ""), 20)
		if dayName == "" {
			return
		}
		var entries []ScheduleSlot
		day.Find(".as-anime-card").Each(func(_ int, el *goquery.Selection) {
			link, _ := el.Attr("href")
			if link == "" || !el.Is("a") {
				link = hrefOf(el)
			}
			if link == "" {
				return
			}
			title := txt(el.Find(".as-anime-title").First().Text(), 200)
			if title == "" {
				return
			}
			var genres []string
			el.Find(".jr-genre-pill").Each(func(_ int, g *goquery.Selection) {
				if x := txt(g.Text(), 40); x != "" {
					genres = append(genres, x)
				}
			})
			slot := ScheduleSlot{
				Title: title, URL: link,
				Episode: txt(el.Find(".jr-ep-text").Text(), 30),
				Time:    strPtr(txt(el.Find(".time-text").Text(), 20)),
				Rating:  strPtr(num(el.Find(".rating-text").Text())),
				Members: strPtr(txt(el.Find(".members-text").Text(), 20)),
				Type:    strPtr(txt(el.Find(".jr-type-badge").Text(), 20)),
				Status:  strPtr(el.AttrOr("data-status", "")),
			}
			if len(genres) > 0 {
				slot.Genres = genres
			}
			entries = append(entries, slot)
		})
		if len(entries) > 0 {
			out = append(out, ScheduleEntry{Day: dayName, DateText: txt(day.AttrOr("data-date-text", ""), 40), Entries: entries})
		}
	})
	if out == nil {
		out = []ScheduleEntry{}
	}
	return out, nil
}

func getRecentEpisodes(page int) ([]Episode, error) { return getLatestEpisodes(page) }

func getTopAnime() ([]TopAnime, error) {
	all, err := getPopularSeries()
	if err != nil {
		return nil, err
	}
	seen := map[string]TopAnime{}
	var order []string
	for _, a := range all {
		if _, ok := seen[a.URL]; !ok {
			seen[a.URL] = TopAnime{Title: a.Title, URL: a.URL, Thumbnail: a.Thumbnail, Score: a.Score}
			order = append(order, a.URL)
		}
	}
	out := make([]TopAnime, 0, len(order))
	for _, k := range order {
		out = append(out, seen[k])
	}
	sort.SliceStable(out, func(i, j int) bool { return parseNum(out[i].Score) > parseNum(out[j].Score) })
	return out, nil
}

var seasons = map[string]bool{"spring": true, "summer": true, "fall": true, "autumn": true, "winter": true}

func getSeasonAnime(season string, year, page int) ([]SeasonResult, error) {
	s := strings.ToLower(strings.TrimSpace(season))
	if !seasons[s] {
		return nil, fmt.Errorf("Season must be spring/summer/fall/winter")
	}
	if year == 0 {
		return nil, fmt.Errorf("Year required (e.g. season winter 2024)")
	}
	if year < 1990 {
		year = 1990
	}
	if year > 2100 {
		year = 2100
	}
	page = clampPage(page)
	base := fmt.Sprintf("%s/premiereds/%s-%d/", BASE, s, year)
	u := base
	if page != 1 {
		u = fmt.Sprintf("%spage/%d/", base, page)
	}
	html, err := fetchPage(u)
	if err != nil {
		return nil, err
	}
	cards := parseAsCards(safeDoc(html), "")
	out := make([]SeasonResult, 0, len(cards))
	for _, c := range cards {
		out = append(out, SeasonResult{
			Title: c.Title, URL: c.URL, Thumbnail: c.Thumbnail,
			Score: strVal(c.Rating), Genre: strings.Join(c.Genres, ", "),
		})
	}
	return out, nil
}

// === INPUT SANITIZERS ===
func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func clampPage(p int) int { return clampInt(p, 1, 50) }

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

var slugRe = regexp.MustCompile(`^[a-z0-9-]+$`)

func cleanSlug(s string) (string, error) {
	if s == "" {
		return "", fmt.Errorf("Slug required")
	}
	c := strings.ToLower(strings.TrimSpace(s))
	if len(c) > 80 {
		c = c[:80]
	}
	if !slugRe.MatchString(c) {
		return "", fmt.Errorf("Invalid slug (a-z 0-9 - only)")
	}
	return c, nil
}

var multiWsRe = regexp.MustCompile(`\s+`)

func cleanQuery(q string) (string, error) {
	if q == "" {
		return "", fmt.Errorf("Query required")
	}
	c := strings.TrimSpace(multiWsRe.ReplaceAllString(q, " "))
	if len(c) > 100 {
		c = c[:100]
	}
	if len(c) < 2 {
		return "", fmt.Errorf("Query too short")
	}
	return c, nil
}

func parseNum(s string) float64 {
	if s == "" {
		return nan()
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return nan()
	}
	return f
}

// parseNumOr0 mirrors TS `parseFloat(x) || 0` — NaN/missing coerce to 0
func parseNumOr0(s string) float64 {
	f := parseNum(s)
	if isNaN(f) {
		return 0
	}
	return f
}

func nan() float64 {
	// quiet NaN without math import
	z := 0.0
	return z / z
}

func isNaN(f float64) bool { return f != f }

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// === CLI ===
func printUsage() {
	fmt.Print(`
NontonAnimeID Scraper - Go port
===============================
Usage:
  nontonanime-go home [page] / latest [page] / search <query> / advsearch [opts]
  nontonanime-go list [page] / anime <url> / episode <url> / stream <url> [n]
  nontonanime-go servers <url> / resolve <url> [n|name] / nav <url> / meta <url>
  nontonanime-go genres [az|popular|ongoing] / genre <slug> [page] / ongoing [sort]
  nontonanime-go popular / schedule / recent [page] / top / season <s> <y> [page]
  nontonanime-go more --offset=N [ids..]

Advanced Search Options:
  --sort=... --status=... --type=... --score_min=<n> --score_max=<n>
  --year_min=<n> --year_max=<n> --genre=<slug> --rating=... --mode=<q>
  --studio=<slug> --season=<slug> --s=<keyword> --page=<n>
`)
}

func needArg(v, msg string) (string, error) {
	if v == "" {
		return "", fmt.Errorf("%s", msg)
	}
	return v, nil
}

func pgArg(v string) int { return clampPage(atoi(v)) }

func emit(v interface{}) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

func main() {
	rand.Seed(time.Now().UnixNano())
	args := os.Args[1:]
	var pos []string
	flags := map[string]string{}
	for _, a := range args {
		if strings.HasPrefix(a, "--") {
			body := a[2:]
			if i := strings.Index(body, "="); i == -1 {
				flags[body] = ""
			} else {
				v := body[i+1:]
				if len(v) > 200 {
					v = v[:200]
				}
				flags[body[:i]] = v
			}
		} else {
			pos = append(pos, a)
		}
	}
	cmd := ""
	if len(pos) > 0 {
		cmd = pos[0]
	}
	if cmd == "" || cmd == "help" || cmd == "--help" {
		printUsage()
		return
	}
	get := func(i int) string {
		if i < len(pos) {
			return pos[i]
		}
		return ""
	}
	var (
		result interface{}
		err    error
	)
	switch cmd {
	case "home":
		result, err = getHomeContent(pgArg(get(1)))
	case "latest", "recent":
		result, err = getLatestEpisodes(pgArg(get(1)))
	case "search":
		result, err = searchAnime(get(1))
	case "advsearch":
		result, err = advancedSearch(flags)
	case "list":
		result, err = getList(pgArg(get(1)))
	case "anime":
		var u string
		if u, err = needArg(get(1), "Anime URL required"); err == nil {
			var d *AnimeDetail
			if d, err = getAnimeDetail(u); err == nil && d == nil {
				err = fmt.Errorf("Anime not found")
			} else {
				result = d
			}
		}
	case "episode":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			var d *StreamResult
			if d, err = getEpisodeInfo(u); err == nil && d == nil {
				err = fmt.Errorf("Episode not found")
			} else {
				result = d
			}
		}
	case "stream":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			n := atoi(get(2))
			if get(2) == "" {
				n = 1
			}
			if n < 1 {
				n = 1
			}
			if n > 20 {
				n = 20
			}
			result, err = getEpisodeStream(u, n)
		}
	case "servers":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			result, err = getEpisodeServers(u)
		}
	case "resolve":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			sel := get(2)
			if sel == "" {
				sel = "1"
			}
			result, err = resolveServer(u, sel)
		}
	case "nav":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			result, err = getEpisodeNav(u)
		}
	case "meta":
		var u string
		if u, err = needArg(get(1), "Episode URL required"); err == nil {
			result, err = getEpisodeMeta(u)
		}
	case "genres":
		result, err = getGenres(get(1))
	case "genre":
		var s string
		if s, err = needArg(get(1), "Genre slug required"); err == nil {
			result, err = getGenreAnime(s, pgArg(get(2)))
		}
	case "ongoing":
		result, err = getOngoingAnime(get(1))
	case "popular":
		result, err = getPopularSeries()
	case "schedule":
		result, err = getSchedule()
	case "top":
		result, err = getTopAnime()
	case "season":
		var s, y string
		if s, err = needArg(get(1), "Season required (spring/summer/fall/winter)"); err == nil {
			if y, err = needArg(get(2), "Year required (e.g. season winter 2024)"); err == nil {
				result, err = getSeasonAnime(s, atoi(y), pgArg(get(3)))
			}
		}
	case "more":
		var ids []int
		for _, p := range pos[1:] {
			if n, e := strconv.Atoi(p); e == nil {
				ids = append(ids, n)
			}
		}
		result, err = loadMoreHome(ids, atoi(flags["offset"]))
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "[ERROR] %s\n", err.Error())
		os.Exit(1)
	}
	emit(result)
}
