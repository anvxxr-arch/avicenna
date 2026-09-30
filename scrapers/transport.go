// transport.go — hardened shared transport for every scraper in this package.
//
// It is a faithful Go port of core/fetch.ts (createSite + isBlockedHost +
// core/parse.ts helpers). Each scraper builds its OWN *Site, so the per-host
// serial rate limiter, LRU response cache, in-flight dedupe and SSRF guards are
// isolated per site. Nothing here imports package main: the same patterns are
// re-established locally (see nontonanime.go's fetch_page for the original).
//
// Guarantees, identical per request:
//   - the request may not leave its site host (redirects are re-validated hop by hop);
//   - off-site targets go through ParseTarget + an explicit per-scraper allowlist;
//   - private/loopback/link-local hosts are rejected;
//   - per-host serial rate limit with jitter (default 350ms + 0-120ms);
//   - default 15s timeout, 3MB body cap, max 5 redirects;
//   - retry with backoff on 429/5xx and network errors, Cloudflare challenges reported.
package scrapers

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Transport defaults (mirror SiteConfig defaults in core/fetch.ts).
const (
	DefaultTimeoutMS     = 15000
	DefaultMaxBytes      = 3000000
	DefaultMaxRedirects  = 5
	DefaultMaxRetries    = 3
	DefaultRateMS        = 350
	DefaultCacheTTLMS    = 5 * 60 * 1000
	DefaultCacheMax      = 100
	maxPostBodyBytes     = 8192
	maxURLBytes          = 2048
	maxDocBytes          = 2000000
	jitterMS             = 120
	cloudflareBodyMarker = `attention required|just a moment|cf-challenge|captcha|you have been blocked`
)

// === SSRF / URL GUARDS ===

var (
	blockedHostRe = regexp.MustCompile(`(?i)^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)`)
	// IPv6 literals that must never be fetched: loopback/unspecified,
	// IPv4-mapped, unique-local, link-local.
	blockedV6Re = regexp.MustCompile(`(?i)^(::1?$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)`)
	ctrlRe      = regexp.MustCompile("[\x00-\x1f\x7f\\\\]")
	wafRe       = regexp.MustCompile(`(?i)` + cloudflareBodyMarker)
	netErrRe    = regexp.MustCompile(`(?i)timeout|econn|enotfound|eai_again|socket|fetch failed|connection|reset|refused`)
)

// IsBlockedHost reports whether a hostname is private, loopback, link-local or
// otherwise never fetchable. Mirrors isBlockedHost() in core/fetch.ts.
func IsBlockedHost(host string) bool {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	return blockedHostRe.MatchString(h) || blockedV6Re.MatchString(h) || h == "localhost"
}

// Sentinel errors for ParseTarget, so callers can map them onto their own
// (TS-faithful) wording.
var (
	ErrInvalidURL    = errors.New("Invalid URL")
	ErrBlockedScheme = errors.New("Blocked URL scheme")
	ErrCredsInURL    = errors.New("Creds in URL blocked")
	ErrBlockedHost   = errors.New("Blocked host")
)

// ParseTarget validates an arbitrary (possibly off-site) http(s) target URL.
// Shared by every scraper that takes a user-supplied URL, including the
// explicit third-party allowlists, so the private-host rejection is uniform.
func ParseTarget(raw string) (*url.URL, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, ErrInvalidURL
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" {
		return nil, ErrInvalidURL
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, ErrBlockedScheme
	}
	if u.User != nil {
		return nil, ErrCredsInURL
	}
	if IsBlockedHost(u.Hostname()) {
		return nil, fmt.Errorf("%w: %s", ErrBlockedHost, u.Hostname())
	}
	return u, nil
}

// ResolveURL resolves a redirect Location against the current URL, re-applying
// every guard. Mirrors resolveUrl() in core/fetch.ts.
func ResolveURL(raw, base string) (string, error) {
	b, err := url.Parse(base)
	if err != nil {
		return "", ErrInvalidURL
	}
	ref, err := url.Parse(raw)
	if err != nil {
		return "", ErrInvalidURL
	}
	u := b.ResolveReference(ref)
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("Bad redirect scheme")
	}
	if u.User != nil {
		return "", ErrCredsInURL
	}
	if IsBlockedHost(u.Hostname()) {
		return "", errors.New("Blocked redirect host")
	}
	u.User = nil
	s := u.String()
	if len(s) > maxURLBytes {
		return "", errors.New("URL too long")
	}
	return s, nil
}

// IsValidURL mirrors core/fetch.ts isValidUrl().
func IsValidURL(raw string) bool {
	if raw == "" || len(raw) > maxURLBytes {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return false
	}
	if u.User != nil {
		return false
	}
	return !IsBlockedHost(u.Hostname())
}

// === RATE LIMITER (serial chain + jitter) ===

type rateLimiter struct {
	mu    sync.Mutex
	tail  chan struct{}
	last  int64
	delay int64
}

func newRateLimiter(delayMS int64) *rateLimiter {
	ch := make(chan struct{}, 1)
	ch <- struct{}{}
	return &rateLimiter{tail: ch, delay: delayMS}
}

func (r *rateLimiter) run(fn func() ([]byte, error)) ([]byte, error) {
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
		time.Sleep(time.Duration(wait+rand.Int64N(jitterMS)) * time.Millisecond)
	}
	out, err := fn()
	r.mu.Lock()
	r.last = time.Now().UnixMilli()
	r.mu.Unlock()
	prev <- struct{}{}
	return out, err
}

// === SITE ===

// SiteConfig configures one scraper host.
type SiteConfig struct {
	Base         string
	Headers      map[string]string
	RateMS       int
	TimeoutMS    int
	MaxBytes     int
	MaxRedirects int
	MaxRetries   int
	CacheTTLMS   int
	CacheMax     int
}

type cacheEntry struct {
	t int64
	v string
}

type inflightCall struct {
	done chan struct{}
	v    string
	e    error
}

// Site is a host-pinned, rate-limited, cached HTTP client.
type Site struct {
	base    string
	host    string
	headers map[string]string

	limiter      *rateLimiter
	timeoutMS    int
	maxBytes     int
	maxRedirects int
	maxRetries   int
	cacheTTL     int
	cacheMax     int

	mu       sync.Mutex
	cache    map[string]cacheEntry
	order    []string
	inflight map[string]*inflightCall

	extMu    sync.Mutex
	external map[string]*Site
}

var sharedTransport = &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	ForceAttemptHTTP2:     true,
	MaxIdleConns:          32,
	MaxIdleConnsPerHost:   8,
	IdleConnTimeout:       60 * time.Second,
	TLSHandshakeTimeout:   10 * time.Second,
	ExpectContinueTimeout: 1 * time.Second,
}

// NewSite builds the site client. Base must be an absolute http(s) URL; it
// panics otherwise, since all call sites are package constants.
func NewSite(cfg SiteConfig) *Site {
	base := strings.TrimRight(cfg.Base, "/")
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" {
		panic("scrapers: invalid Site base " + cfg.Base)
	}
	intOr := func(v, d int) int {
		if v > 0 {
			return v
		}
		return d
	}
	s := &Site{
		base:         base,
		host:         strings.ToLower(u.Hostname()),
		headers:      cfg.Headers,
		limiter:      newRateLimiter(int64(intOr(cfg.RateMS, DefaultRateMS))),
		timeoutMS:    intOr(cfg.TimeoutMS, DefaultTimeoutMS),
		maxBytes:     intOr(cfg.MaxBytes, DefaultMaxBytes),
		maxRedirects: intOr(cfg.MaxRedirects, DefaultMaxRedirects),
		maxRetries:   intOr(cfg.MaxRetries, DefaultMaxRetries),
		cacheTTL:     intOr(cfg.CacheTTLMS, DefaultCacheTTLMS),
		cacheMax:     intOr(cfg.CacheMax, DefaultCacheMax),
		cache:        map[string]cacheEntry{},
		inflight:     map[string]*inflightCall{},
		external:     map[string]*Site{},
	}
	return s
}

// Base returns the pinned origin (no trailing slash).
func (s *Site) Base() string { return s.base }

// Host returns the pinned hostname (lower-case).
func (s *Site) Host() string { return s.host }

// === URL pinning ===

func (s *Site) assertSiteURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("Invalid URL")
	}
	if (u.Scheme != "https" && u.Scheme != "http") || strings.ToLower(u.Hostname()) != s.host {
		return "", fmt.Errorf("URL host not allowed: %s", u.Hostname())
	}
	if IsBlockedHost(u.Hostname()) {
		return "", errors.New("Blocked host")
	}
	return u.String(), nil
}

func (s *Site) sanitizeURL(path string) (string, error) {
	if path == "" {
		return "", errors.New("Empty URL")
	}
	clean := strings.TrimSpace(path)
	if len(clean) > maxURLBytes {
		clean = clean[:maxURLBytes]
	}
	if ctrlRe.MatchString(clean) {
		return "", errors.New("Illegal chars in URL")
	}
	l := strings.ToLower(clean)
	if strings.HasPrefix(l, "javascript:") || strings.HasPrefix(l, "data:") || strings.HasPrefix(l, "vbscript:") {
		return "", errors.New("Blocked URL scheme")
	}
	doc, err := url.Parse(s.base + "/")
	if err != nil {
		return "", ErrInvalidURL
	}
	ref, err := url.Parse(clean)
	if err != nil {
		return "", ErrInvalidURL
	}
	u := doc.ResolveReference(ref)
	if strings.ToLower(u.Hostname()) != s.host {
		return "", fmt.Errorf("External host rejected: %s", u.Hostname())
	}
	u.User = nil
	u.Fragment = ""
	return u.String(), nil
}

// resolveRequest pins either an absolute URL or a site-relative path.
func (s *Site) resolveRequest(pathOrURL string) (string, error) {
	if strings.HasPrefix(pathOrURL, "/") {
		return s.sanitizeURL(pathOrURL)
	}
	return s.assertSiteURL(pathOrURL)
}

// === CACHE (LRU + in-flight dedupe) ===

func (s *Site) cacheGet(k string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cache[k]
	if !ok {
		return "", false
	}
	if time.Now().UnixMilli()-e.t > int64(s.cacheTTL) {
		delete(s.cache, k)
		s.dropOrderLocked(k)
		return "", false
	}
	s.dropOrderLocked(k)
	s.order = append(s.order, k)
	return e.v, true
}

func (s *Site) dropOrderLocked(k string) {
	for i, key := range s.order {
		if key == k {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
}

func (s *Site) cacheSet(k, v string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.cache[k]; ok {
		s.dropOrderLocked(k)
	}
	s.cache[k] = cacheEntry{t: time.Now().UnixMilli(), v: v}
	s.order = append(s.order, k)
	for len(s.order) > s.cacheMax {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.cache, oldest)
	}
}

// === HTTP CORE ===

type retryableError struct {
	msg        string
	retryable  bool
	retryAfter int64 // ms
}

func (e *retryableError) Error() string { return e.msg }

func readCappedBytes(res *http.Response, maxBytes int) ([]byte, error) {
	if cl := res.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(cl), 10, 64); err == nil && n > int64(maxBytes) {
			return nil, fmt.Errorf("Body too large (%s bytes)", cl)
		}
	}
	if ct := res.Header.Get("Content-Type"); ct != "" {
		l := strings.ToLower(ct)
		if strings.Contains(l, "image/") || strings.Contains(l, "video/") || strings.Contains(l, "octet-stream") {
			return nil, fmt.Errorf("Unexpected content-type: %s", ct)
		}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, fmt.Errorf("Body exceeds cap")
	}
	// Manual gzip fallback: the shared transport usually negotiates gzip
	// itself; harmless if the body is plain.
	if strings.Contains(res.Header.Get("Content-Encoding"), "gzip") {
		if zr, err := gzip.NewReader(bytes.NewReader(data)); err == nil {
			if dec, err := io.ReadAll(io.LimitReader(zr, int64(maxBytes)+1)); err == nil {
				zr.Close()
				data = dec
			} else {
				zr.Close()
			}
		}
	}
	return data, nil
}

func readCapped(res *http.Response, maxBytes int) (string, error) {
	b, err := readCappedBytes(res, maxBytes)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

type requestSpec struct {
	method  string
	url     string
	body    []byte
	headers map[string]string
}

// doFetch performs the request with manual redirect handling. Mirrors
// doFetch() in core/fetch.ts.
func (s *Site) doFetch(spec requestSpec) ([]byte, error) {
	cur := spec.url
	hops := 0
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.timeoutMS)*time.Millisecond)
		var rdr io.Reader
		if spec.body != nil {
			rdr = bytes.NewReader(spec.body)
		}
		req, err := http.NewRequestWithContext(ctx, spec.method, cur, rdr)
		if err != nil {
			cancel()
			return nil, ErrInvalidURL
		}
		for k, v := range s.headers {
			req.Header.Set(k, v)
		}
		for k, v := range spec.headers {
			req.Header.Set(k, v)
		}
		client := &http.Client{
			Transport: sharedTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		res, err := client.Do(req)
		if err != nil {
			cancel()
			msg := err.Error()
			low := strings.ToLower(msg)
			if errors.Is(err, context.DeadlineExceeded) || strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded") {
				return nil, fmt.Errorf("Timeout %dms for %s", s.timeoutMS, cur)
			}
			return nil, &retryableError{msg: msg}
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			res.Body.Close()
			cancel()
			if loc == "" {
				return nil, fmt.Errorf("Redirect %d without location", res.StatusCode)
			}
			hops++
			if hops > s.maxRedirects {
				return nil, errors.New("Too many redirects")
			}
			next, rerr := ResolveURL(loc, cur)
			if rerr != nil {
				return nil, rerr
			}
			cur = next
			continue
		}
		// 429/403/401/5xx may be a Cloudflare interstitial — inspect the body
		// BEFORE deciding to retry, so a challenge is reported, not retried.
		if res.StatusCode == 429 || res.StatusCode == 403 || res.StatusCode == 401 || res.StatusCode >= 500 {
			peek, _ := readCapped(res, s.maxBytes)
			res.Body.Close()
			cancel()
			if wafRe.MatchString(peek) {
				return nil, fmt.Errorf("WAF blocked (Cloudflare) for %s — filter params trip bot protection; retry with fewer filters", cur)
			}
			if res.StatusCode == 429 || res.StatusCode >= 500 {
				var ra int64
				if v := res.Header.Get("Retry-After"); v != "" {
					if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
						ra = int64(n) * 1000
					}
				}
				return nil, &retryableError{msg: fmt.Sprintf("HTTP %d for %s", res.StatusCode, cur), retryable: true, retryAfter: ra}
			}
			return nil, fmt.Errorf("HTTP %d for %s", res.StatusCode, cur)
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			res.Body.Close()
			cancel()
			return nil, fmt.Errorf("HTTP %d for %s", res.StatusCode, cur)
		}
		body, rerr := readCappedBytes(res, s.maxBytes)
		res.Body.Close()
		cancel()
		if rerr != nil {
			return nil, rerr
		}
		return body, nil
	}
}

func (s *Site) withRetry(fn func() ([]byte, error)) ([]byte, error) {
	var last error = errors.New("failed")
	for i := 0; i <= s.maxRetries; i++ {
		v, err := fn()
		if err == nil {
			return v, nil
		}
		last = err
		retryable := false
		var backoff int64
		var re *retryableError
		if errors.As(err, &re) {
			retryable = re.retryable
			backoff = re.retryAfter
		} else if netErrRe.MatchString(err.Error()) {
			retryable = true
		}
		if !retryable || i == s.maxRetries {
			return nil, last
		}
		if backoff == 0 {
			backoff = int64(600) << uint(i)
			if backoff > 8000 {
				backoff = 8000
			}
		}
		time.Sleep(time.Duration(backoff+rand.Int64N(300)) * time.Millisecond)
	}
	return nil, last
}

// Fetch GETs a site-pinned path/URL with cache + in-flight dedupe + retry.
func (s *Site) Fetch(pathOrURL string) (string, error) {
	b, err := s.fetchBytes(pathOrURL)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *Site) fetchBytes(pathOrURL string) ([]byte, error) {
	target, err := s.resolveRequest(pathOrURL)
	if err != nil {
		return nil, err
	}
	if hit, ok := s.cacheGet(target); ok {
		return []byte(hit), nil
	}
	s.mu.Lock()
	if c, ok := s.inflight[target]; ok {
		s.mu.Unlock()
		<-c.done
		if hit, ok := s.cacheGet(target); ok {
			return []byte(hit), nil
		}
		if c.e != nil {
			return nil, c.e
		}
		return []byte(c.v), nil
	}
	call := &inflightCall{done: make(chan struct{})}
	s.inflight[target] = call
	s.mu.Unlock()

	v, e := s.limiter.run(func() ([]byte, error) {
		return s.withRetry(func() ([]byte, error) {
			return s.doFetch(requestSpec{method: "GET", url: target})
		})
	})
	if e == nil {
		s.cacheSet(target, string(v))
	}
	call.v, call.e = string(v), e
	s.mu.Lock()
	delete(s.inflight, target)
	s.mu.Unlock()
	close(call.done)
	if e != nil {
		return nil, e
	}
	return v, nil
}

// FetchRaw GETs a site-pinned path/URL without touching the response cache —
// for internal/JSON APIs whose content is expected to change between calls.
// Mirrors request() in core/fetch.ts.
func (s *Site) FetchRaw(pathOrURL string) ([]byte, error) {
	target, err := s.resolveRequest(pathOrURL)
	if err != nil {
		return nil, err
	}
	return s.limiter.run(func() ([]byte, error) {
		return s.doFetch(requestSpec{method: "GET", url: target})
	})
}

func (s *Site) post(path, body, refererPath string, contentType string) (string, error) {
	target, err := s.resolveRequest(path)
	if err != nil {
		return "", err
	}
	if len(body) > maxPostBodyBytes {
		return "", errors.New("POST body too large")
	}
	ref := s.base + "/"
	if refererPath != "" {
		ref, err = s.resolveRequest(refererPath)
		if err != nil {
			return "", err
		}
	}
	headers := map[string]string{
		"accept":           "*/*",
		"origin":           s.base,
		"referer":          ref,
		"x-requested-with": "XMLHttpRequest",
		"content-type":     contentType,
	}
	b, err := s.limiter.run(func() ([]byte, error) {
		return s.withRetry(func() ([]byte, error) {
			return s.doFetch(requestSpec{method: "POST", url: target, body: []byte(body), headers: headers})
		})
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// PostJSON POSTs an application/json body to a site-pinned path. `{...}`/`[...]`
// bodies get the JSON content-type automatically, mirroring postAjax().
func (s *Site) PostJSON(path, body, refererPath string) (string, error) {
	return s.post(path, body, refererPath, "application/json")
}

// PostForm POSTs an application/x-www-form-urlencoded body.
func (s *Site) PostForm(path, body, refererPath string) (string, error) {
	return s.post(path, body, refererPath, "application/x-www-form-urlencoded; charset=UTF-8")
}

// === EXTERNAL (explicit allowlist) ===

// ExternalResult is a raw response from an explicitly allowlisted third-party host.
type ExternalResult struct {
	Status      int
	Body        []byte
	ContentType string
	URL         string // final URL after redirects
}

// External performs a guarded request against a PUBLIC third-party host
// (CDN/embed/upload endpoint). `allowHosts` is mandatory and explicit — a host
// outside the list is rejected, private/loopback targets are rejected as well,
// and redirects must stay inside the same allowlist. Mirrors requestExternal()
// in core/fetch.ts, with the origin list made explicit per scraper.
func (s *Site) External(rawURL string, body []byte, contentType string, extraHosts []string) (ExternalResult, error) {
	var zero ExternalResult
	u, err := ParseTarget(rawURL)
	if err != nil {
		return zero, err
	}
	allowed := map[string]bool{}
	for _, h := range extraHosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			allowed[h] = true
		}
	}
	host := strings.ToLower(u.Hostname())
	if !allowed[host] {
		return zero, fmt.Errorf("External host rejected: %s", u.Hostname())
	}
	origin := u.Scheme + "://" + u.Host
	child := s.externalSite(origin)
	originHost := strings.ToLower(u.Hostname())

	headers := map[string]string{}
	if contentType != "" {
		headers["content-type"] = contentType
	}
	method := "GET"
	if body != nil {
		method = "POST"
	}
	cur := u.String()
	hops := 0
	var raw []byte
	var status int
	var finalCT string
	for {
		res, err := child.oneShot(requestSpec{method: method, url: cur, body: body, headers: headers})
		if err != nil {
			return zero, err
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			next, rerr := ResolveURL(loc, cur)
			res.Body.Close()
			if rerr != nil {
				return zero, rerr
			}
			nu, perr := url.Parse(next)
			if perr != nil {
				return zero, ErrInvalidURL
			}
			nh := strings.ToLower(nu.Hostname())
			if nu.Scheme != u.Scheme || !allowed[nh] || nh != originHost {
				return zero, fmt.Errorf("Redirect host not allowed: %s", nu.Hostname())
			}
			hops++
			if hops > s.maxRedirects {
				return zero, errors.New("Too many redirects")
			}
			cur = next
			continue
		}
		data, rerr := readCappedBytes(res, s.maxBytes)
		finalCT = res.Header.Get("Content-Type")
		status = res.StatusCode
		res.Body.Close()
		if rerr != nil {
			return zero, rerr
		}
		raw = data
		break
	}
	return ExternalResult{Status: status, Body: raw, ContentType: finalCT, URL: cur}, nil
}

// oneShot performs exactly one request (no cache, no in-flight dedupe, no
// retry) through the site limiter — the semantics of request() in core/fetch.ts.
// Non-2xx is returned to the caller instead of raised, since these are
// third-party documents whose error pages carry meaning.
func (s *Site) oneShot(spec requestSpec) (*http.Response, error) {
	var out *http.Response
	var outErr error
	_, err := s.limiter.run(func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.timeoutMS)*time.Millisecond)
		defer cancel()
		var rdr io.Reader
		if spec.body != nil {
			rdr = bytes.NewReader(spec.body)
		}
		req, err := http.NewRequestWithContext(ctx, spec.method, spec.url, rdr)
		if err != nil {
			outErr = ErrInvalidURL
			return nil, outErr
		}
		for k, v := range s.headers {
			req.Header.Set(k, v)
		}
		for k, v := range spec.headers {
			req.Header.Set(k, v)
		}
		client := &http.Client{
			Transport: sharedTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		res, err := client.Do(req)
		if err != nil {
			low := strings.ToLower(err.Error())
			if errors.Is(err, context.DeadlineExceeded) || strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded") {
				outErr = fmt.Errorf("Timeout %dms for %s", s.timeoutMS, spec.url)
			} else {
				outErr = err
			}
			return nil, outErr
		}
		out = res
		return nil, nil
	})
	if err != nil && outErr == nil {
		outErr = err
	}
	if outErr != nil {
		return nil, outErr
	}
	return out, nil
}

// externalSite returns (and memoizes) a child Site pinned to an explicit public
// origin, sharing this site's rate, timeout, cap and header settings.
func (s *Site) externalSite(origin string) *Site {
	s.extMu.Lock()
	defer s.extMu.Unlock()
	if child, ok := s.external[origin]; ok {
		return child
	}
	child := NewSite(SiteConfig{
		Base:         origin,
		Headers:      s.headers,
		RateMS:       int(s.limiter.delay),
		TimeoutMS:    s.timeoutMS,
		MaxBytes:     s.maxBytes,
		MaxRedirects: s.maxRedirects,
		MaxRetries:   s.maxRetries,
		CacheTTLMS:   s.cacheTTL,
		CacheMax:     s.cacheMax,
	})
	s.external[origin] = child
	return child
}

// ExternalText is External with a UTF-8 string body (nil body = GET).
func (s *Site) ExternalText(rawURL string, body []byte, contentType string, extraHosts []string) (string, ExternalResult, error) {
	res, err := s.External(rawURL, body, contentType, extraHosts)
	if err != nil {
		return "", res, err
	}
	return string(res.Body), res, nil
}

// === JSON / URL HELPERS (JS semantics) ===

// EncodeURIComponent mirrors JS encodeURIComponent.
func EncodeURIComponent(s string) string {
	var sb strings.Builder
	for i := range len(s) {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			sb.WriteByte(c)
		default:
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// JSONStringify mirrors JSON.stringify: no whitespace, no HTML escaping,
// numbers emitted with ECMAScript Number→string semantics.
func JSONStringify(v any) (string, error) {
	var sb strings.Builder
	if err := writeJSON(&sb, v); err != nil {
		return "", err
	}
	return sb.String(), nil
}

func writeJSON(sb *strings.Builder, v any) error {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case string:
		writeJSONString(sb, t)
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case json.Number:
		sb.WriteString(jsonNumberString(t))
	case float64:
		sb.WriteString(numberString(t))
	case float32:
		sb.WriteString(numberString(float64(t)))
	case int:
		sb.WriteString(strconv.Itoa(t))
	case int64:
		sb.WriteString(strconv.FormatInt(t, 10))
	case []any:
		sb.WriteByte('[')
		for i, el := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeJSON(sb, el); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case map[string]any:
		sb.WriteByte('{')
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeJSONString(sb, k)
			sb.WriteByte(':')
			if err := writeJSON(sb, t[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		sb.Write(b)
	}
	return nil
}

func jsonNumberString(n json.Number) string {
	if _, err := strconv.ParseInt(n.String(), 10, 64); err == nil {
		return n.String()
	}
	if f, err := n.Float64(); err == nil {
		return numberString(f)
	}
	return n.String()
}

// numberString renders a float64 the way ECMAScript does for the common range
// (integers stay integers, no exponent below 1e21).
func numberString(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null" // JSON.stringify(NaN|Infinity) === 'null'
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'e', -1, 64)
}

func writeJSONString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// === PARSE HELPERS (core/parse.ts) ===

// SafeDoc mirrors safeCheerio(): 2MB source cap.
func SafeDoc(html string) *goquery.Document {
	src := html
	if len(src) > maxDocBytes {
		src = src[:maxDocBytes]
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(src))
	if err != nil {
		doc, _ = goquery.NewDocumentFromReader(strings.NewReader("<html></html>"))
	}
	return doc
}

var wsRe = regexp.MustCompile(`\s+`)
var nonNumRe = regexp.MustCompile(`[^0-9.]`)

// n16 counts UTF-16 code units (JS string semantics), never splitting a rune.
func n16(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// Trunc16 truncates to `max` UTF-16 code units, never splitting a rune.
func Trunc16(s string, max int) string {
	if n16(s) <= max {
		return s
	}
	n := 0
	for i, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
		if n > max {
			return s[:i]
		}
	}
	return s
}

// Txt mirrors txt(): whitespace-collapse, trim, cap to `max` UTF-16 code units.
func Txt(s string, max int) string {
	if s == "" {
		return ""
	}
	t := strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	if max <= 0 {
		return t
	}
	return Trunc16(t, max)
}

// Num mirrors num(): keep digits and dots only.
func Num(s string) string {
	if s == "" {
		return ""
	}
	return strings.TrimSpace(nonNumRe.ReplaceAllString(s, ""))
}

// === JSON ===

// DecodeAny decodes JSON preserving the original numeric literals (json.Number),
// so integers round-trip exactly as JSON.parse → JSON.stringify does in TS.
func DecodeAny(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// DecodeObject decodes a JSON object preserving numeric literals.
func DecodeObject(text string) (map[string]any, error) {
	v, err := DecodeAny(text)
	if err != nil {
		return nil, err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("unexpected JSON payload (not an object)")
	}
	return obj, nil
}

// GetStr reads a string field from a decoded JSON object.
func GetStr(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
