// api_go_test.go — offline coverage for the HTTP surface: envelope, METHOD and
// guard rejections, the index route advertisement, the admin purge contract and
// the OpenAPI gate. Every case here is served without touching the network, so
// the suite is deterministic (the live scrapers are covered by tools/parity.ts).
//
// These tests exist because the root package had 0% coverage, which is how the
// index advertising `"routes": null` (IndexData.Routes never filled) survived.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
)

func testServer(cors, spec bool, token string) *apiServer {
	return &apiServer{cors: cors, spec: spec, adminToken: token}
}

// call runs one request through the real handler chain and returns the recorder.
func call(s *apiServer, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// decode unmarshals a response body, failing the test when it is not JSON.
func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON (%v): %s", err, rec.Body.String())
	}
	return body
}

// assertEnvelope checks the two things every response must carry.
func assertEnvelope(t *testing.T, body map[string]any) {
	t.Helper()
	if body["api"] != apiName {
		t.Errorf("api = %v, want %q", body["api"], apiName)
	}
	if body["version"] != apiVersion {
		t.Errorf("version = %v, want %q", body["version"], apiVersion)
	}
}

func errorCode(t *testing.T, body map[string]any) string {
	t.Helper()
	e, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error object in %v", body)
	}
	code, _ := e["code"].(string)
	return code
}

func TestIndexAdvertisesEveryRoute(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodGet, apiRootPath, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decode(t, rec)
	assertEnvelope(t, body)
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("no data object: %v", body)
	}
	if data["name"] != apiName {
		t.Errorf("name = %v, want %q", data["name"], apiName)
	}

	raw, ok := data["routes"].([]any)
	if !ok {
		t.Fatalf("routes is %T, want an array — IndexData.Routes is not being filled", data["routes"])
	}
	if len(raw) == 0 {
		t.Fatal("routes is empty — IndexData.Routes is not being filled")
	}

	listed := make(map[string]bool, len(raw))
	prev := ""
	for _, v := range raw {
		p, _ := v.(string)
		listed[p] = true
		if p <= prev {
			t.Errorf("routes not sorted: %q after %q", p, prev)
		}
		prev = p
	}

	// every real route is advertised, except the index itself
	for p := range apiRouteIdx {
		if p == apiRootPath {
			continue
		}
		if !listed[p] {
			t.Errorf("route %s is served but not advertised by the index", p)
		}
	}
	if listed[apiRootPath] {
		t.Error("the index should not advertise itself")
	}
	if !listed[apiOpenAPIPath] {
		t.Errorf("%s is missing from the index", apiOpenAPIPath)
	}
}

func TestHealthIsNeverCached(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodGet, apiRootPath+"/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	body := decode(t, rec)
	assertEnvelope(t, body)
	data, _ := body["data"].(map[string]any)
	if data["ok"] != true {
		t.Errorf("ok = %v, want true", data["ok"])
	}
}

func TestUnknownRouteAnswersEnvelope404(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodGet, "/api/v1/definitely-not-a-route", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	body := decode(t, rec)
	assertEnvelope(t, body)
	if code := errorCode(t, body); code != "not_found" {
		t.Errorf("error.code = %q, want not_found", code)
	}
}

func TestGetRouteRejectsOtherMethods(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodPost, apiRootPath+"/home", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if code := errorCode(t, decode(t, rec)); code != "bad_request" {
		t.Errorf("error.code = %q, want bad_request", code)
	}
}

// A traversal slug must be refused by the guard, before any upstream request —
// no network is available in this test, so a fetch would fail differently.
func TestTraversalSlugIsRejectedOffline(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodGet, apiRootPath+"/genre?slug=../../etc", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, decode(t, rec)); code != "bad_request" {
		t.Errorf("error.code = %q, want bad_request", code)
	}
}

func TestCorsHeaderIsOptIn(t *testing.T) {
	if got := call(testServer(false, false, ""), http.MethodGet, apiRootPath, nil).Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("CORS header present without -cors: %q", got)
	}
	if got := call(testServer(true, false, ""), http.MethodGet, apiRootPath, nil).Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want * with -cors", got)
	}
}

func TestAdminPurgeContract(t *testing.T) {
	// no token configured: the route must not exist at all
	hidden := testServer(false, false, "")
	if rec := call(hidden, http.MethodPost, apiPurgePath, nil); rec.Code != http.StatusNotFound {
		t.Errorf("unconfigured purge status = %d, want 404", rec.Code)
	}

	s := testServer(false, false, "s3cret")
	if rec := call(s, http.MethodPost, apiPurgePath, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("purge without credentials = %d, want 401", rec.Code)
	}
	if rec := call(s, http.MethodPost, apiPurgePath, map[string]string{"Authorization": "Bearer wrong"}); rec.Code != http.StatusUnauthorized {
		t.Errorf("purge with a bad token = %d, want 401", rec.Code)
	}
	if rec := call(s, http.MethodGet, apiPurgePath, nil); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET purge = %d, want 405 (POST only)", rec.Code)
	}

	// Seed the primary origin cache so the report cannot be a hardcoded 0: the
	// route must evict real entries and say how many.
	cacheSet("https://example.test/warm", "<html>warm</html>")
	if _, ok := cacheGet("https://example.test/warm"); !ok {
		t.Fatal("cacheSet did not take effect — the purge assertion would be vacuous")
	}

	rec := call(s, http.MethodPost, apiPurgePath, map[string]string{"Authorization": "Bearer s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("authorized purge = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	assertEnvelope(t, body)
	data, _ := body["data"].(map[string]any)
	purged, ok := data["purged"].(float64)
	if !ok {
		t.Fatalf("purged is %T, want a number", data["purged"])
	}
	if purged < 1 {
		t.Errorf("purged = %v, want >= 1 after seeding the origin cache", purged)
	}
	if _, ok := cacheGet("https://example.test/warm"); ok {
		t.Error("purge reported evictions but the origin cache is still populated")
	}
	if n := purgePageCache(); n != 0 {
		t.Errorf("purgePageCache() = %d after a purge, want 0", n)
	}
}

// A leaked token must not turn the purge route into an origin DoS: after
// purgeLimit evictions in one window the client gets 429 + Retry-After, and the
// limiter is per-client so a second IP is unaffected.
func TestAdminPurgeIsRateLimitedPerClient(t *testing.T) {
	s := testServer(false, false, "s3cret")
	auth := map[string]string{"Authorization": "Bearer s3cret"}

	for i := 0; i < purgeLimit; i++ {
		if rec := call(s, http.MethodPost, apiPurgePath, auth); rec.Code != http.StatusOK {
			t.Fatalf("purge #%d = %d, want 200", i+1, rec.Code)
		}
	}

	rec := call(s, http.MethodPost, apiPurgePath, auth)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("purge #%d = %d, want 429", purgeLimit+1, rec.Code)
	}
	if ra := rec.Header().Get("Retry-After"); ra == "" {
		t.Error("429 without a Retry-After header")
	}
	if code := errorCode(t, decode(t, rec)); code != "rate_limited" {
		t.Errorf("error.code = %q, want rate_limited", code)
	}

	// a different client is not limited by the first client's window
	other := call(s, http.MethodPost, apiPurgePath, map[string]string{
		"Authorization": "Bearer s3cret",
		"X-Forwarded-For": "203.0.113.9",
	})
	if other.Code != http.StatusOK {
		t.Errorf("second client purge = %d, want 200 (limit is per-client)", other.Code)
	}
}

func TestClientIPResolution(t *testing.T) {
	cases := []struct {
		name string
		req  func() *http.Request
		want string
	}{
		{"direct peer", func() *http.Request { return httptest.NewRequest(http.MethodPost, "/x", nil) }, "192.0.2.1"},
		{"xff single hop", func() *http.Request {
			r := httptest.NewRequest(http.MethodPost, "/x", nil)
			r.Header.Set("X-Forwarded-For", "198.51.100.7")
			return r
		}, "198.51.100.7"},
		{"xff first hop wins", func() *http.Request {
			r := httptest.NewRequest(http.MethodPost, "/x", nil)
			r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.1")
			return r
		}, "198.51.100.7"},
	}
	for _, c := range cases {
		req := c.req()
		req.RemoteAddr = "192.0.2.1:51234"
		if got := clientIP(req); got != c.want {
			t.Errorf("%s: clientIP = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestPurgePageCacheDropsEveryEntry(t *testing.T) {
	cacheSet("https://example.test/one", "1")
	cacheSet("https://example.test/two", "2")
	if n := purgePageCache(); n < 2 {
		t.Fatalf("purgePageCache() = %d, want >= 2", n)
	}
	if len(cacheOrd) != 0 {
		t.Errorf("purgePageCache left %d keys in the eviction order", len(cacheOrd))
	}
	if _, ok := cacheGet("https://example.test/one"); ok {
		t.Error("purgePageCache left an entry behind")
	}
	if n := purgePageCache(); n != 0 {
		t.Errorf("second purgePageCache() = %d, want 0", n)
	}
}

func TestOpenAPIIsGatedBySpec(t *testing.T) {
	if rec := call(testServer(false, false, ""), http.MethodGet, apiOpenAPIPath, nil); rec.Code != http.StatusNotFound {
		t.Errorf("openapi without -spec = %d, want 404", rec.Code)
	}
	rec := call(testServer(false, true, ""), http.MethodGet, apiOpenAPIPath, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("openapi with -spec = %d, want 200", rec.Code)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("openapi is not JSON: %v", err)
	}
	paths, _ := doc["paths"].(map[string]any)
	if len(paths) < 100 {
		t.Errorf("openapi documents %d paths, want >= 100", len(paths))
	}
	schemas, _ := doc["components"].(map[string]any)
	inner, _ := schemas["schemas"].(map[string]any)
	for _, want := range []string{"Envelope", "ErrorEnvelope", "IndexData", "PurgeData"} {
		if _, ok := inner[want]; !ok {
			t.Errorf("openapi is missing the %s schema", want)
		}
	}
}

// IndexData declares `routes` required, so the live index must not answer null —
// the exact defect this file was added for.
func TestIndexDataRoutesIsNeverNull(t *testing.T) {
	rec := call(testServer(false, false, ""), http.MethodGet, apiRootPath, nil)
	if strings.Contains(rec.Body.String(), `"routes":null`) {
		t.Fatal(`the index answered "routes":null although IndexData declares it required`)
	}
}

func TestCacheControlReflectsTTL(t *testing.T) {
	if got := cacheControlValue(ttlNone); got != "no-store" {
		t.Errorf("ttlNone -> %q, want no-store", got)
	}
	want := "public, max-age=300, s-maxage=600, stale-while-revalidate=1200"
	if got := cacheControlValue(ttlShort); got != want {
		t.Errorf("ttlShort -> %q, want %q", got, want)
	}
	if got := cacheControlValue(ttlLong); strings.Contains(got, "no-store") {
		t.Errorf("ttlLong -> %q, want a cacheable directive", got)
	}
}

func TestParseNumCoercions(t *testing.T) {
	if got := parseNumOr0(""); got != 0 {
		t.Errorf(`parseNumOr0("") = %v, want 0 (mirrors parseFloat(x) || 0)`, got)
	}
	if got := parseNumOr0("7.43"); got != 7.43 {
		t.Errorf(`parseNumOr0("7.43") = %v, want 7.43`, got)
	}
	if got := parseNumOr0("not-a-number"); got != 0 {
		t.Errorf(`parseNumOr0("not-a-number") = %v, want 0`, got)
	}
	// parseNum must NOT coerce: it reports "no value" as NaN on purpose, which is
	// exactly why it must never be used as a sort comparator.
	if v := parseNum(""); v == v {
		t.Errorf(`parseNum("") = %v, want NaN`, v)
	}
}

// The regression behind the `top` parity failure: a card with no score ranked in
// the middle instead of last, because a NaN operand made the comparator
// non-transitive and sort.SliceStable silently returned a partly-sorted slice.
func TestTopRankingPutsMissingScoreLast(t *testing.T) {
	less := topScoreLess
	if !less(TopAnime{Score: "8.42"}, TopAnime{Score: ""}) {
		t.Error("a scored card must rank ahead of a score-less one")
	}
	if less(TopAnime{Score: ""}, TopAnime{Score: "8.42"}) {
		t.Error("a score-less card must not outrank a scored one")
	}
	if less(TopAnime{Score: ""}, TopAnime{Score: ""}) {
		t.Error("equal (missing) scores must compare false — a comparator is not <=")
	}

	in := []TopAnime{
		{Title: "Black Clover 2nd Season", Score: "8.83"},
		{Title: "Tokyo Revengers: Santen Sensou-hen", Score: "7.76"},
		{Title: "Tensei shitara Ken deshita II", Score: "7.54"},
		{Title: "Kikansha no Mahou wa Tokubetsu desu 2nd Season", Score: ""},
		{Title: "Koori no Jouheki 2nd Season", Score: "8.42"},
		{Title: "Ao no Hako Season 2", Score: "8.2"},
	}
	sort.SliceStable(in, func(i, j int) bool { return less(in[i], in[j]) })
	want := []string{
		"Black Clover 2nd Season",
		"Koori no Jouheki 2nd Season",
		"Ao no Hako Season 2",
		"Tokyo Revengers: Santen Sensou-hen",
		"Tensei shitara Ken deshita II",
		"Kikansha no Mahou wa Tokubetsu desu 2nd Season",
	}
	for i := range want {
		if in[i].Title != want[i] {
			t.Fatalf("rank %d = %q, want %q (full order %v)", i, in[i].Title, want[i], titlesOf(in))
		}
	}
}

func titlesOf(a []TopAnime) []string {
	out := make([]string, len(a))
	for i := range a {
		out[i] = a[i].Title
	}
	return out
}
