// jsonapi.go — guarded request path for the internal-JSON scrapers.
//
// The cached HTML transport (transport.go) is the right tool for pages, but the
// JSON APIs these three scrapers talk to need more than it exposes: the status
// code (Spotify decides on `res.ok`, YouTube Music throws `Request failed (N)`),
// the response headers (TikTok reads `Location` and `Set-Cookie`) and
// per-request headers (Spotify's `authorization`, YouTube's `x-youtube-client-*`).
//
// siteRequest provides exactly that; nothing else about the transport changes.
// The site's serial rate limiter, 15s timeout, 3MB body cap, bounded redirects
// and retry/backoff all still apply, and private/loopback/metadata hosts are
// rejected at every hop. Host pinning is explicit and total — `hosts` is the
// complete allowlist for the target *and every redirect hop*, so a hostile
// `Location` cannot leave the pinned set. Nothing here is ever cached: a cached
// nonce- or token-bearing response is a dead one.
package scrapers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// APIResp is one raw response from a guarded API request. (Named apart from
// transport.go's APIResult, which is the same idea for RequestSpec.)
type APIResp struct {
	Status int
	Header http.Header
	Body   []byte
	URL    string // URL of the final (redirected) response
}

// apiRetryError marks a request whose failure is worth retrying. It may carry
// the response that triggered it (a throttled 429/5xx is part of the contract).
type apiRetryError struct {
	msg        string
	res        *APIResp
	retryAfter int64 // ms
}

func (e *apiRetryError) Error() string { return e.msg }

var apiNetErrRe = regexp.MustCompile(`(?i)timeout|econn|enotfound|eai_again|socket|fetch failed|connection|reset|refused|deadline|unexpected eof`)

// apiCheckHost applies every per-hop guard to one URL: scheme, credentials,
// private/loopback/metadata hosts, and the caller's explicit host allowlist.
func apiCheckHost(u *url.URL, allow map[string]bool) error {
	if u == nil || u.Hostname() == "" {
		return errors.New("Invalid URL")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return errors.New("Blocked URL scheme")
	}
	if u.User != nil {
		return errors.New("Creds in URL blocked")
	}
	if IsBlockedHost(u.Hostname()) {
		return fmt.Errorf("Blocked host: %s", u.Hostname())
	}
	if !allow[strings.ToLower(u.Hostname())] {
		return fmt.Errorf("External host rejected: %s", u.Hostname())
	}
	return nil
}

// apiReadCapped drains a response through the size cap and the binary
// content-type guard. noCT skips only the latter (declared media downloads).
func apiReadCapped(res *http.Response, maxBytes int, noCT bool) ([]byte, error) {
	if res == nil {
		return nil, errors.New("nil response")
	}
	if cl := strings.TrimSpace(res.Header.Get("Content-Length")); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil && n > int64(maxBytes) {
			return nil, fmt.Errorf("Body too large (%s bytes)", cl)
		}
	}
	if !noCT {
		if ct := strings.ToLower(res.Header.Get("Content-Type")); ct != "" {
			if strings.Contains(ct, "image/") || strings.Contains(ct, "video/") || strings.Contains(ct, "octet-stream") {
				return nil, fmt.Errorf("Unexpected content-type: %s", res.Header.Get("Content-Type"))
			}
		}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBytes {
		return nil, errors.New("Body exceeds size cap")
	}
	return data, nil
}

// apiAttempt performs one logical request, following redirects manually and
// re-validating every hop against the allowlist.
func apiAttempt(s *Site, start, method string, body []byte, headers map[string]string, follow, noCT bool, allow map[string]bool) (*APIResp, error) {
	cur := start
	hops := 0
	for {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.timeoutMS)*time.Millisecond)
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, cur, rdr)
		if err != nil {
			cancel()
			return nil, errors.New("Invalid URL")
		}
		for k, v := range s.headers {
			req.Header.Set(k, v)
		}
		for k, v := range headers {
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
			low := strings.ToLower(err.Error())
			if errors.Is(err, context.DeadlineExceeded) || strings.Contains(low, "timeout") || strings.Contains(low, "deadline exceeded") {
				return nil, fmt.Errorf("Timeout %dms for %s", s.timeoutMS, cur)
			}
			return nil, &apiRetryError{msg: err.Error()}
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			hdr := res.Header.Clone()
			loc := res.Header.Get("Location")
			res.Body.Close()
			cancel()
			if !follow {
				// "manual" mode: hand the 3xx back with Location intact.
				return &APIResp{Status: res.StatusCode, Header: hdr, URL: cur}, nil
			}
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
				return nil, errors.New("Invalid URL")
			}
			if cerr := apiCheckHost(nu, allow); cerr != nil {
				return nil, cerr
			}
			cur = next
			continue
		}
		hdr := res.Header.Clone()
		status := res.StatusCode
		data, rerr := apiReadCapped(res, s.maxBytes, noCT)
		res.Body.Close()
		cancel()
		if rerr != nil {
			return nil, rerr
		}
		out := &APIResp{Status: status, Header: hdr, Body: data, URL: cur}
		if status == 429 || status >= 500 {
			return out, &apiRetryError{msg: fmt.Sprintf("HTTP %d for %s", status, cur), res: out, retryAfter: retryAfterMS(hdr)}
		}
		return out, nil
	}
}

func retryAfterMS(h http.Header) int64 {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
		return n * 1000
	}
	return 0
}

// siteRequest performs one request through the site's limiter, retrying 429/5xx
// and network failures with exponential backoff. The last response is returned
// even when every attempt was throttled, so callers can surface the status
// ("searchDesktop failed: 429") exactly as the TS reference does; a persistent
// transport failure is an error. Non-2xx is never cached — and no response on
// this path is cached at all.
func siteRequest(s *Site, rawURL, method string, body []byte, headers map[string]string, follow bool, hosts []string) (*APIResp, error) {
	return siteRequestOpts(s, rawURL, method, body, headers, follow, false, hosts)
}

// siteRequestMedia is siteRequest for a declared binary download: the
// image/video content-type guard is skipped, everything else is identical.
func siteRequestMedia(s *Site, rawURL string, headers map[string]string, hosts []string) (*APIResp, error) {
	return siteRequestOpts(s, rawURL, http.MethodGet, nil, headers, true, true, hosts)
}

func siteRequestOpts(s *Site, rawURL, method string, body []byte, headers map[string]string, follow, noCT bool, hosts []string) (*APIResp, error) {
	if method == "" {
		method = http.MethodGet
	}
	allow := make(map[string]bool, len(hosts))
	for _, h := range hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			allow[h] = true
		}
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, errors.New("Invalid URL")
	}
	if err := apiCheckHost(u, allow); err != nil {
		return nil, err
	}
	start := u.String()

	for attempt := 0; ; attempt++ {
		var res *APIResp
		var aerr error
		_, runErr := s.limiter.run(func() ([]byte, error) {
			res, aerr = apiAttempt(s, start, method, body, headers, follow, noCT, allow)
			if aerr != nil {
				return nil, aerr
			}
			return nil, nil
		})
		if runErr != nil && aerr == nil {
			aerr = runErr
		}
		if aerr == nil {
			return res, nil
		}
		retryable := false
		var ra int64
		var re *apiRetryError
		if errors.As(aerr, &re) {
			retryable = true
			ra = re.retryAfter
		} else if apiNetErrRe.MatchString(aerr.Error()) {
			retryable = true
		}
		if !retryable || attempt >= s.maxRetries {
			if res != nil {
				return res, nil // throttled response is the answer, not an error
			}
			return nil, aerr
		}
		back := ra
		if back == 0 {
			back = int64(600) << uint(attempt)
			if back > 8000 {
				back = 8000
			}
		}
		time.Sleep(time.Duration(back+rand.Int64N(300)) * time.Millisecond)
	}
}

// apiDecodeMap decodes a JSON object body, preserving numeric literals.
func apiDecodeMap(body []byte) (map[string]any, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("unexpected JSON payload (not an object)")
	}
	return m, nil
}

// === JSON path helpers ===
// mget walks a key path down decoded JSON; a missing link yields nil, mirroring
// the TS `at()` helper whose missing links are `undefined`.
func mget(o any, keys ...string) any {
	cur := o
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur, ok = m[k]
		if !ok {
			return nil
		}
	}
	return cur
}

// mgetOK is mget plus "the key exists" — TS distinguishes absent (undefined)
// from present-but-null, and the output shapes depend on that difference.
func mgetOK(o any, keys ...string) (any, bool) {
	cur := o
	for i, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur, ok = m[k]
		if !ok {
			return nil, false
		}
		if i == len(keys)-1 {
			return cur, true
		}
	}
	return nil, false
}

// mmap returns the object at `keys`, nil when absent or not an object.
func mmap(o any, keys ...string) map[string]any { return obj(mget(o, keys...)) }

// mlist returns the array at `keys`, nil when absent or not an array.
func mlist(o any, keys ...string) []any { return arr(mget(o, keys...)) }

// mstr returns the string at `keys`, "" when absent or not a string.
func mstr(o any, keys ...string) string { return jstr(mget(o, keys...)) }

// === JSON accessors ===

// jnum converts a decoded JSON number (json.Number) to an int64, 0 when absent.
func jnum(v any) int64 {
	switch t := v.(type) {
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return n
		}
		if f, err := t.Float64(); err == nil {
			return int64(f)
		}
	case float64:
		return int64(t)
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64); err == nil {
			return n
		}
	}
	return 0
}

// jsNum converts a decoded JSON value to what a JS `Number()` would hold, so the
// re-encoded payload matches `JSON.parse` → `JSON.stringify`. `UseNumber` keeps the
// source literal, which is what yt/tiktok need for their exact-digit ids, but it
// also preserves a trailing `.0`: Spotify sends `"average":5.0` and the TS reference
// (JSON.parse) turns that into `5`, so Go emitted `5.0` and `spotify show` diverged.
// Only apply this where the value is a quantity, never to identity fields.
func jsNum(v any) any {
	if n, ok := v.(json.Number); ok {
		if f, err := n.Float64(); err == nil {
			return f
		}
	}
	return v
}

// jstr returns the value as a string, "" when it is not one.
func jstr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// jbool returns JS truthiness for the values the scrapers actually test.
func jbool(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		return t.String() != "0"
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	default:
		return true
	}
}

// arr returns v as []any, nil when it is not an array.
func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// obj returns v as map[string]any, nil when it is not an object.
func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// firstTruthy mirrors JS `a || b || c`: the first non-empty/non-zero/non-nil.
func firstTruthy(vals ...any) any {
	for _, v := range vals {
		if jbool(v) {
			return v
		}
	}
	return nil
}

// strOrNil returns the string at `keys`, or nil when absent/not a string.
func strOrNil(o any, keys ...string) any {
	if v, ok := mgetOK(o, keys...); ok {
		if s, isStr := v.(string); isStr {
			return s
		}
	}
	return nil
}

// numOrNil returns the number at `keys`, or nil when absent/not a number.
func numOrNil(o any, keys ...string) any {
	if v, ok := mgetOK(o, keys...); ok {
		if _, isNum := v.(json.Number); isNum {
			return v
		}
	}
	return nil
}
