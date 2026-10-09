package scrapers

import (
	"net/http"
	"testing"
)

// newHeaderTestSite builds a Site with no network access needed: applyHeaders
// only reads config + the request, so header behaviour is testable hermetically.
func newHeaderTestSite() *Site {
	return NewSite(SiteConfig{
		Base:    "https://example.com",
		Headers: map[string]string{"user-agent": "test-ua", "accept": "*/*"},
	})
}

func reqFor(t *testing.T, method, url string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	return req
}

// A CDN can key its cache on the Origin request header, so an implicit Origin on
// a GET makes the Go port read a different (differently-aged) body than TS,
// which sends origin/referer only for POSTs. GETs must carry site headers only.
func TestApplyHeadersGetCarriesNoOriginOrReferer(t *testing.T) {
	s := newHeaderTestSite()
	req := reqFor(t, http.MethodGet, "https://example.com/loadmore-home/page/2")
	s.applyHeaders(req, nil)

	if got := req.Header.Get("origin"); got != "" {
		t.Errorf("GET must not send origin, got %q", got)
	}
	if got := req.Header.Get("referer"); got != "" {
		t.Errorf("GET must not send referer, got %q", got)
	}
	if got := req.Header.Get("user-agent"); got != "test-ua" {
		t.Errorf("site headers must still apply, user-agent = %q", got)
	}
	if got := req.Header.Get("accept"); got != "*/*" {
		t.Errorf("site headers must still apply, accept = %q", got)
	}
}

func TestApplyHeadersPostAddsOriginAndReferer(t *testing.T) {
	s := newHeaderTestSite()
	req := reqFor(t, http.MethodPost, "https://example.com/wp-admin/admin-ajax.php")
	s.applyHeaders(req, nil)

	if got := req.Header.Get("origin"); got != "https://example.com" {
		t.Errorf("POST origin = %q, want %q", got, "https://example.com")
	}
	if got := req.Header.Get("referer"); got != "https://example.com/" {
		t.Errorf("POST referer = %q, want %q", got, "https://example.com/")
	}
}

// Scrapers that genuinely need a referer on a GET pass it explicitly (tiktok,
// codeengo, yt, …); per-request headers must win over the site defaults.
func TestApplyHeadersPerRequestOverrideWinsOnGet(t *testing.T) {
	s := newHeaderTestSite()
	req := reqFor(t, http.MethodGet, "https://example.com/api")
	s.applyHeaders(req, map[string]string{"referer": "https://example.com/watch/1", "accept": "application/json"})

	if got := req.Header.Get("referer"); got != "https://example.com/watch/1" {
		t.Errorf("explicit referer on GET must be honoured, got %q", got)
	}
	if got := req.Header.Get("accept"); got != "application/json" {
		t.Errorf("per-request accept must override the site default, got %q", got)
	}
}
