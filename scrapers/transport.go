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
// otherwise never fetchable. Mirrors isBlockedHost() in core/fetch.ts, plus the
// numeric IPv4/IPv6 obfuscations a WHATWG URL parser normalises but Go's
// url.Parse keeps verbatim (decimal 2130706433, hex 0x7f000001, octal
// 0177.0.0.1, short form 127.1, and long-form IPv4-mapped IPv6).
func IsBlockedHost(host string) bool {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	if blockedHostRe.MatchString(h) || blockedV6Re.MatchString(h) || h == "localhost" {
		return true
	}
	return isPrivateIP(h)
}

func isPrivateIP(h string) bool {
	// Bare numeric IPv4 or IPv6 literal?
	ip := net.ParseIP(h)
	if ip == nil {
		if n, ok := parseNumericIPv4(h); ok {
			ip = net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
		} else {
			return false
		}
	}
	if ip4 := ip.To4(); ip4 != nil {
		return isPrivateV4(ip4)
	}
	// IPv6: unspecified, loopback, IPv4-mapped, unique-local, link-local.
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		return isPrivateV4(v4)
	}
	if ip[0]&0xfe == 0xfc { // fc00::/7 unique-local
		return true
	}
	return false
}

// isPrivateV4 covers the ranges blocked for SSRF: loopback, private, and
// link-local, plus 0.0.0.0.
func isPrivateV4(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsUnspecified() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		(ip[0] == 169 && ip[1] == 254)
}

// parseNumericIPv4 accepts the non-dotted forms a browser would normalise:
// a single 32-bit integer (decimal, 0x hex, leading-0 octal) or the short
// "a.b" / "a.b.c" forms where the last part carries the remaining bytes.
func parseNumericIPv4(h string) (uint64, bool) {
	if h == "" {
		return 0, false
	}
	if !strings.Contains(h, ".") {
		n, ok := parseUintForm(h, 32)
		return n, ok
	}
	parts := strings.Split(h, ".")
	if len(parts) > 4 {
		return 0, false
	}
	var vals []uint64
	for _, p := range parts {
		bits := uint(8)
		if len(vals) == len(parts)-1 { // last part absorbs the remaining bytes
			bits = 8 * uint(5-len(parts))
		}
		v, ok := parseUintForm(p, bits)
		if !ok {
			return 0, false
		}
		vals = append(vals, v)
	}
	var out uint64
	for i, v := range vals {
		if i == len(vals)-1 {
			out |= v
		} else {
			out |= v << (8 * uint(3-i))
		}
	}
	if out > 0xFFFFFFFF {
		return 0, false
	}
	return out, true
}

// parseUintForm parses a decimal, 0x-hex or leading-0 octal integer of at most
// the given width in bits.
func parseUintForm(s string, bits uint) (uint64, bool) {
	base := 10
	digits := s
	if len(s) > 2 && (s[0:2] == "0x" || s[0:2] == "0X") {
		base, digits = 16, s[2:]
	} else if len(s) > 1 && s[0] == '0' {
		base, digits = 8, s[1:]
	}
	if digits == "" {
		return 0, false
	}
	for i := 0; i < len(digits); i++ {
		c := digits[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f' && base == 16:
		case c >= 'A' && c <= 'F' && base == 16:
		default:
			return 0, false
		}
	}
	n, err := strconv.ParseUint(digits, base, int(bits))
	if err != nil {
		return 0, false
	}
	return n, true
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
	// ExtraHosts lists additional hosts a redirect may land on, in addition to
	// the pinned origin. Never inferred — a hostile Location cannot reach an
	// unlisted (e.g. private) host.
	ExtraHosts []string
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
	extraHosts   []string

	cookieMu sync.Mutex
	cookies  map[string]string

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
	var extra []string
	for _, h := range cfg.ExtraHosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			extra = append(extra, h)
		}
	}
	s := &Site{
		base:         base,
		host:         strings.ToLower(u.Hostname()),
		headers:      cfg.Headers,
		extraHosts:   extra,
		limiter:      newRateLimiter(int64(intOr(cfg.RateMS, DefaultRateMS))),
		timeoutMS:    intOr(cfg.TimeoutMS, DefaultTimeoutMS),
		maxBytes:     intOr(cfg.MaxBytes, DefaultMaxBytes),
		maxRedirects: intOr(cfg.MaxRedirects, DefaultMaxRedirects),
		maxRetries:   intOr(cfg.MaxRetries, DefaultMaxRetries),
		cacheTTL:     intOr(cfg.CacheTTLMS, DefaultCacheTTLMS),
		cacheMax:     intOr(cfg.CacheMax, DefaultCacheMax),
		cache:        map[string]cacheEntry{},
		inflight:     map[string]*inflightCall{},
		cookies:      map[string]string{},
		external:     map[string]*Site{},
	}
	registerSite(s)
	return s
}

// === SITE REGISTRY ===
//
// Every Site registers itself so the API's admin purge can reach the response
// cache of each scraper origin — and of every external child site an origin
// memoizes (children are created through NewSite, so they register too). The
// sites are package-level values, so their caches live for the whole process;
// without a registry there would be nothing for the purge route to clear.
var (
	siteRegistryMu sync.Mutex
	siteRegistry   []*Site
)

func registerSite(s *Site) {
	siteRegistryMu.Lock()
	siteRegistry = append(siteRegistry, s)
	siteRegistryMu.Unlock()
}

// Purge drops this site's cached responses and reports how many were dropped.
// In-flight calls are left alone on purpose: their waiters still receive their
// result, and clearing the map would only allow a duplicate fetch of the same
// URL — the opposite of what a dedupe table is for.
func (s *Site) Purge() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.cache)
	s.cache = map[string]cacheEntry{}
	s.order = nil
	return n
}

// PurgeAll purges every registered site and returns the total number of cached
// responses dropped. It takes each site's own lock, so it is safe to call while
// requests are being served.
func PurgeAll() int {
	siteRegistryMu.Lock()
	sites := append([]*Site(nil), siteRegistry...)
	siteRegistryMu.Unlock()
	total := 0
	for _, s := range sites {
		total += s.Purge()
	}
	return total
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
	return readCappedBytesOpt(res, maxBytes, false)
}

// readRawCapped is readCappedBytes without the content-type guard, for
// explicitly requested binary payloads (images, video).
func readRawCapped(res *http.Response, maxBytes int) ([]byte, error) {
	return readCappedBytesOpt(res, maxBytes, true)
}

func readCappedBytesOpt(res *http.Response, maxBytes int, skipContentType bool) ([]byte, error) {
	if cl := res.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(strings.TrimSpace(cl), 10, 64); err == nil && n > int64(maxBytes) {
			return nil, fmt.Errorf("Body too large (%s bytes)", cl)
		}
	}
	if !skipContentType {
		if ct := res.Header.Get("Content-Type"); ct != "" {
			l := strings.ToLower(ct)
			if strings.Contains(l, "image/") || strings.Contains(l, "video/") || strings.Contains(l, "octet-stream") {
				return nil, fmt.Errorf("Unexpected content-type: %s", ct)
			}
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
	// extraHosts widens the redirect allowlist beyond the pinned origin.
	extraHosts []string
	// raw skips the content-type guard for explicitly requested binary payloads.
	raw bool
}

// allowedRedirectHost reports whether a redirect hop may land on `host`.
func (s *Site) allowedRedirectHost(host string, extra []string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return false
	}
	if h == s.host {
		return true
	}
	for _, allow := range extra {
		if h == strings.ToLower(strings.TrimSpace(allow)) {
			return true
		}
	}
	for _, allow := range s.extraHosts {
		if h == allow {
			return true
		}
	}
	return false
}

// applyHeaders sets the site defaults, per-request overrides and the page
// origin/referer headers, plus the jar's cookie header for the target host.
// Secrets in the jar are never logged.
func (s *Site) applyHeaders(req *http.Request, extra map[string]string) {
	for k, v := range s.headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("origin", s.base)
	req.Header.Set("referer", s.base+"/")
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	if c := s.Cookie(req.URL.Hostname()); c != "" {
		req.Header.Set("cookie", c)
	}
}

// doFetch performs the request with manual redirect handling; every hop is
// re-validated against the pinned host (plus spec.extraHosts). Mirrors
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
		s.applyHeaders(req, spec.headers)
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
		s.storeCookies(req.URL.Hostname(), res.Header.Values("Set-Cookie"))
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
			nu, perr := url.Parse(next)
			if perr != nil {
				return nil, ErrInvalidURL
			}
			if !s.allowedRedirectHost(nu.Hostname(), spec.extraHosts) {
				return nil, fmt.Errorf("Redirect host not allowed: %s", nu.Hostname())
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

// RequestSpec is a fully explicit same-host request (arbitrary headers,
// uncached, optional bounded redirect following). Hosts, in addition to the
// pinned origin, must be named in ExtraHosts.
type RequestSpec struct {
	Method     string
	URL        string
	Body       []byte
	Headers    map[string]string
	Follow     bool
	ExtraHosts []string
	// NoContentTypeCheck skips the "unexpected content-type" guard for binary
	// payloads (images/video) that a scraper explicitly wants.
	NoContentTypeCheck bool
	// ManualRedirect returns a 3xx response untouched (Location intact).
	ManualRedirect bool
}

// APIResult is the raw outcome of a request: status, headers and (captured)
// body, including non-2xx responses whose error bodies are part of a site's
// contract.
type APIResult struct {
	Status      int
	Headers     http.Header
	Body        []byte
	ContentType string
	URL         string // final URL after redirects
}

// BodyString returns the captured body as a UTF-8 string.
func (r APIResult) BodyString() string { return string(r.Body) }

// Do performs one guarded request and returns the raw response instead of
// raising on non-2xx. It applies the site's limiter, timeout, redirect bound,
// per-hop host allowlist and size cap; it never caches and never retries the
// status (network errors and 429/5xx are retried like every other request).
func (s *Site) Do(spec RequestSpec) (APIResult, error) {
	var zero APIResult
	target, err := s.resolveRequest(spec.URL)
	if err != nil {
		return zero, err
	}
	if len(spec.Body) > maxPostBodyBytes {
		return zero, fmt.Errorf("POST body too large")
	}
	if spec.Method == "" {
		spec.Method = "GET"
	}
	for _, h := range spec.ExtraHosts {
		if IsBlockedHost(h) {
			return zero, fmt.Errorf("Blocked host: %s", h)
		}
	}
	var out APIResult
	_, err = s.limiter.run(func() ([]byte, error) {
		res, rerr := s.doRaw(requestSpec{
			method:     spec.Method,
			url:        target,
			body:       spec.Body,
			headers:    spec.Headers,
			extraHosts: spec.ExtraHosts,
			raw:        spec.NoContentTypeCheck,
		}, spec.ManualRedirect)
		if rerr != nil {
			return nil, rerr
		}
		out = *res
		return nil, nil
	})
	if err != nil {
		return zero, err
	}
	return out, nil
}

func (s *Site) doRaw(spec requestSpec, manual bool) (*APIResult, error) {
	return s.withRetryRaw(func() (*APIResult, error) { return s.doRawOnce(spec, manual) })
}

func (s *Site) withRetryRaw(fn func() (*APIResult, error)) (*APIResult, error) {
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

func (s *Site) doRawOnce(spec requestSpec, manual bool) (*APIResult, error) {
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
		s.applyHeaders(req, spec.headers)
		client := &http.Client{
			Transport: sharedTransport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		res, err := client.Do(req)
		if err != nil {
			cancel()
			low := strings.ToLower(err.Error())
			if errors.Is(err, context.DeadlineExceeded) || strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded") {
				return nil, fmt.Errorf("Timeout %dms for %s", s.timeoutMS, cur)
			}
			return nil, &retryableError{msg: err.Error()}
		}
		s.storeCookies(req.URL.Hostname(), res.Header.Values("Set-Cookie"))
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			if manual {
				data, _ := readCappedBytes(res, s.maxBytes)
				res.Body.Close()
				cancel()
				return &APIResult{Status: res.StatusCode, Headers: res.Header.Clone(), Body: data, ContentType: res.Header.Get("Content-Type"), URL: cur}, nil
			}
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
			nu, perr := url.Parse(next)
			if perr != nil {
				return nil, ErrInvalidURL
			}
			if !s.allowedRedirectHost(nu.Hostname(), spec.extraHosts) {
				return nil, fmt.Errorf("Redirect host not allowed: %s", nu.Hostname())
			}
			cur = next
			continue
		}
		if res.StatusCode == 429 || res.StatusCode >= 500 {
			peek, _ := readCapped(res, s.maxBytes)
			res.Body.Close()
			cancel()
			if wafRe.MatchString(peek) {
				return nil, fmt.Errorf("WAF blocked (Cloudflare) for %s — filter params trip bot protection; retry with fewer filters", cur)
			}
			var ra int64
			if v := res.Header.Get("Retry-After"); v != "" {
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
					ra = int64(n) * 1000
				}
			}
			return nil, &retryableError{msg: fmt.Sprintf("HTTP %d for %s", res.StatusCode, cur), retryable: true, retryAfter: ra}
		}
		var data []byte
		var rerr error
		if spec.raw {
			data, rerr = readRawCapped(res, s.maxBytes)
		} else {
			data, rerr = readCappedBytes(res, s.maxBytes)
		}
		status := res.StatusCode
		ct := res.Header.Get("Content-Type")
		hdr := res.Header.Clone()
		res.Body.Close()
		cancel()
		if rerr != nil {
			return nil, rerr
		}
		return &APIResult{Status: status, Headers: hdr, Body: data, ContentType: ct, URL: cur}, nil
	}
}

// withRetry runs fn with bounded backoff on 429/5xx and network errors.
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
		return s.withRetry(func() ([]byte, error) {
			return s.doFetch(requestSpec{method: "GET", url: target})
		})
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
	if _, err := ParseTarget(rawURL); err != nil {
		return zero, err
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return zero, ErrInvalidURL
	}
	allowed := map[string]bool{}
	for _, h := range extraHosts {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" {
			continue
		}
		if IsBlockedHost(h) {
			return zero, fmt.Errorf("Blocked host: %s", h)
		}
		allowed[h] = true
	}
	host := strings.ToLower(u.Hostname())
	if !allowed[host] {
		return zero, fmt.Errorf("External host rejected: %s", u.Hostname())
	}
	child := s.externalSite(u.Scheme + "://" + u.Host)
	headers := map[string]string{}
	if contentType != "" {
		headers["content-type"] = contentType
	}
	method := "GET"
	if body != nil {
		method = "POST"
	}
	res, err := child.Do(RequestSpec{
		Method:             method,
		URL:                u.String(),
		Body:               body,
		Headers:            headers,
		Follow:             true,
		ExtraHosts:         []string{host},
		NoContentTypeCheck: true,
	})
	if err != nil {
		return zero, err
	}
	return ExternalResult{Status: res.Status, Body: res.Body, ContentType: res.ContentType, URL: res.URL}, nil
}

// oneShot performs exactly one request (no cache, no in-flight dedupe, no
// retry) through the site limiter — the semantics of request() in core/fetch.ts.
// Non-2xx is returned to the caller instead of raised, since these are
// third-party documents whose error pages carry meaning. The body is fully
// buffered here so the per-request context can be cancelled on return; the
// returned response's Body is an in-memory reader (headers are untouched).
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
		s.applyHeaders(req, spec.headers)
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
		s.storeCookies(req.URL.Hostname(), res.Header.Values("Set-Cookie"))
		data, rerr := readRawCapped(res, s.maxBytes)
		res.Body.Close()
		if rerr != nil {
			outErr = rerr
			return nil, outErr
		}
		// Rebuild the response with the buffered body: 3xx responses are handed
		// back to the caller with headers (Location) intact.
		body := io.NopCloser(bytes.NewReader(data))
		out = &http.Response{
			Status:        res.Status,
			StatusCode:    res.StatusCode,
			Proto:         res.Proto,
			Header:        res.Header,
			Body:          body,
			ContentLength: int64(len(data)),
			Request:       res.Request,
		}
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

// === COOKIE JAR ===
//
// core/fetch.ts inherits the platform cookie behaviour: Set-Cookie from a
// response is sent back on the next request to that host. The two flows that
// depend on it (WordPress/Cloudflare nonce double-POSTs) are the reason this
// exists; cookies never leave the pinned host and are never logged.

// SetCookie seeds the jar for one host with an explicit Cookie header value.
func (s *Site) SetCookie(host, header string) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return
	}
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	if header == "" {
		delete(s.cookies, h)
		return
	}
	s.cookies[h] = header
}

// Cookie returns the Cookie header currently held for a host.
func (s *Site) Cookie(host string) string {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	return s.cookies[strings.ToLower(strings.TrimSpace(host))]
}

// Cookies returns every stored cookie header keyed by host.
func (s *Site) Cookies() map[string]string {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	out := make(map[string]string, len(s.cookies))
	for k, v := range s.cookies {
		out[k] = v
	}
	return out
}

// ClearCookies drops the whole jar.
func (s *Site) ClearCookies() {
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	s.cookies = map[string]string{}
}

// storeCookies merges Set-Cookie headers into the jar. Deletion (Max-Age<=0 or
// a past Expires) removes the pair.
func (s *Site) storeCookies(host string, values []string) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" || len(values) == 0 {
		return
	}
	s.cookieMu.Lock()
	defer s.cookieMu.Unlock()
	pairs := parseCookiePairs(s.cookies[h])
	changed := false
	for _, v := range values {
		first := v
		if i := strings.IndexByte(first, ';'); i >= 0 {
			first = first[:i]
		}
		eq := strings.IndexByte(first, '=')
		if eq <= 0 {
			continue
		}
		name := strings.TrimSpace(first[:eq])
		val := strings.TrimSpace(first[eq+1:])
		if name == "" || len(name) > 64 {
			continue
		}
		expired := false
		lower := strings.ToLower(v)
		if i := strings.Index(lower, "max-age="); i >= 0 {
			rest := lower[i+len("max-age="):]
			if j := strings.IndexAny(rest, ";"); j >= 0 {
				rest = rest[:j]
			}
			if n, err := strconv.Atoi(strings.TrimSpace(rest)); err == nil && n <= 0 {
				expired = true
			}
		}
		if expired || val == "" {
			delete(pairs, name)
			changed = true
			continue
		}
		if pairs[name] != val {
			pairs[name] = val
			changed = true
		}
	}
	if !changed {
		return
	}
	names := make([]string, 0, len(pairs))
	for n := range pairs {
		names = append(names, n)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, n := range names {
		parts = append(parts, n+"="+pairs[n])
	}
	if len(parts) == 0 {
		delete(s.cookies, h)
		return
	}
	s.cookies[h] = strings.Join(parts, "; ")
}

func parseCookiePairs(header string) map[string]string {
	out := map[string]string{}
	if header == "" {
		return out
	}
	for _, part := range strings.Split(header, ";") {
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		out[strings.TrimSpace(part[:eq])] = strings.TrimSpace(part[eq+1:])
	}
	return out
}

// FetchFollow GETs a site-pinned path/URL without caching, following redirects
// with every hop re-validated against the pinned host (the JS `follow: true`
// request option). Used by scrapers whose own site 301s to a canonical URL.
func (s *Site) FetchFollow(pathOrURL string) (string, error) {
	target, err := s.resolveRequest(pathOrURL)
	if err != nil {
		return "", err
	}
	b, err := s.oneShotBytes(requestSpec{method: "GET", url: target})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// oneShotBytes is oneShot + body read + host pinning for redirect hops.
func (s *Site) oneShotBytes(spec requestSpec) ([]byte, error) {
	cur := spec.url
	hops := 0
	for {
		res, err := s.oneShot(requestSpec{method: spec.method, url: cur, body: spec.body, headers: spec.headers})
		if err != nil {
			return nil, err
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			res.Body.Close()
			if loc == "" {
				return nil, fmt.Errorf("Redirect %d without location", res.StatusCode)
			}
			next, rerr := ResolveURL(loc, cur)
			if rerr != nil {
				return nil, rerr
			}
			nu, perr := url.Parse(next)
			if perr != nil {
				return nil, ErrInvalidURL
			}
			if strings.ToLower(nu.Hostname()) != s.host {
				return nil, fmt.Errorf("Redirect host not allowed: %s", nu.Hostname())
			}
			hops++
			if hops > s.maxRedirects {
				return nil, errors.New("Too many redirects")
			}
			cur = next
			continue
		}
		data, rerr := readCappedBytes(res, s.maxBytes)
		res.Body.Close()
		if rerr != nil {
			return nil, rerr
		}
		return data, nil
	}
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

// TolerantJSON decodes a JSON document the way JSON.parse + the platform-style
// leniency sites actually rely on behave: trailing commas, // and /* */
// comments, and the non-standard NaN/±Infinity literals (which
// JSON.stringify renders back as null). Numeric literals are preserved, so
// integers round-trip exactly.
func TolerantJSON(text string) (any, error) {
	p := &jsonParseScanner{src: text}
	if err := p.rewrite(); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(p.out.String()))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

type jsonParseScanner struct {
	src string
	pos int
	out strings.Builder
}

func (p *jsonParseScanner) errorf(format string, args ...any) error {
	return fmt.Errorf("in JSON at position %d: %s", p.pos, fmt.Sprintf(format, args...))
}

func (p *jsonParseScanner) skipComment() {
	if strings.HasPrefix(p.src[p.pos:], "//") {
		p.pos += 2
		for p.pos < len(p.src) && p.src[p.pos] != '\n' {
			p.pos++
		}
		return
	}
	end := strings.Index(p.src[p.pos+2:], "*/")
	if end < 0 {
		p.pos = len(p.src)
		return
	}
	p.pos += 2 + end + 2
}

func (p *jsonParseScanner) skipInsignificant() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			p.pos++
			continue
		}
		if c == '/' && p.pos+1 < len(p.src) && (p.src[p.pos+1] == '/' || p.src[p.pos+1] == '*') {
			p.skipComment()
			continue
		}
		return
	}
}

func (p *jsonParseScanner) copyString() {
	p.out.WriteByte('"')
	p.pos++
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '\\' && p.pos+1 < len(p.src) {
			p.out.WriteByte(c)
			p.out.WriteByte(p.src[p.pos+1])
			p.pos += 2
			continue
		}
		p.out.WriteByte(c)
		p.pos++
		if c == '"' {
			return
		}
	}
}

func (p *jsonParseScanner) copyNumber() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' || c == 'E' {
			p.out.WriteByte(c)
			p.pos++
			continue
		}
		return
	}
}

func (p *jsonParseScanner) readIdent() string {
	start := p.pos
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$' {
			p.pos++
			continue
		}
		return p.src[start:p.pos]
	}
	return p.src[start:p.pos]
}

func isIdentStart(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '$'
}

func (p *jsonParseScanner) rewrite() error {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			p.pos++
		case c == '/' && p.pos+1 < len(p.src) && (p.src[p.pos+1] == '/' || p.src[p.pos+1] == '*'):
			p.skipComment()
		case c == ',':
			p.pos++
			p.skipInsignificant()
			if p.pos < len(p.src) && (p.src[p.pos] == ']' || p.src[p.pos] == '}') {
				continue // trailing comma
			}
			p.out.WriteByte(',')
		case c == '"':
			p.copyString()
		case c == '-' || c == '+':
			next := byte(0)
			if p.pos+1 < len(p.src) {
				next = p.src[p.pos+1]
			}
			if next == 'I' || next == 'N' {
				p.pos++
				if word := p.readIdent(); word == "Infinity" || word == "NaN" {
					p.out.WriteString("null")
					continue
				}
				return p.errorf("unexpected token")
			}
			p.copyNumber() // numbers first: exponents contain letters
		case c >= '0' && c <= '9' || c == '.':
			p.copyNumber()
		case isIdentStart(c):
			switch word := p.readIdent(); word {
			case "true", "false", "null":
				p.out.WriteString(word)
			case "NaN", "Infinity", "undefined":
				p.out.WriteString("null")
			default:
				return p.errorf("unexpected token")
			}
		default:
			p.out.WriteByte(c)
			p.pos++
		}
	}
	return nil
}

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
	// ECMAScript writes exponents without zero padding: 1e-7, not 1e-07.
	return normalizeExponent(strconv.FormatFloat(f, 'e', -1, 64))
}

func normalizeExponent(s string) string {
	i := strings.IndexAny(s, "eE")
	if i < 0 {
		return s
	}
	mant, exp := s[:i], s[i+1:]
	sign := ""
	if len(exp) > 0 && (exp[0] == '+' || exp[0] == '-') {
		sign, exp = exp[:1], exp[1:]
	}
	exp = strings.TrimLeft(exp, "0")
	if exp == "" {
		exp = "0"
	}
	return mant + "e" + sign + exp
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

// itoa keeps pagination paths readable.
func itoa(n int) string { return strconv.Itoa(n) }

// === JSON ===

// DecodeAny decodes a JSON document, preserving the original numeric literals
// (json.Number), so integers round-trip exactly as JSON.parse → JSON.stringify
// does in TS. Parsing is as tolerant as JSON.parse plus the platform-era
// leniency the scraped sites emit: trailing commas, // and /* */ comments and
// the non-standard NaN/±Infinity literals.
func DecodeAny(text string) (any, error) {
	return TolerantJSON(text)
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

// jsonNumber builds a json.Number for tests and internal literals.
func jsonNumber[T int | int64](n T) json.Number {
	return json.Number(strconv.FormatInt(int64(n), 10))
}
