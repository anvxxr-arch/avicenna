// api_handlers_test.go — the route-level argument guards and the query-param
// helpers, pinned offline.
//
// Every handler that takes a user value rejects it *before* the scraper runs, so
// each row below proves two things at once without touching the network: the
// route is reachable, and the guard refuses the bad input instead of forwarding
// it upstream. The messages are part of the response contract (the TS client and
// the docs quote them), so they are asserted verbatim — the values in this table
// were captured from a live server, not guessed.
//
// The host-guard rows also cross the root/scrapers boundary: a foreign or loopback
// URL must come back 400 bad_request ("URL host not allowed"), never a 502 from a
// fetch attempt.
package main

import (
	"math"
	"net/http"
	"strings"
	"testing"
)

func TestArgumentGuardsRejectBeforeFetching(t *testing.T) {
	cases := []struct {
		name   string
		target string
		msg    string
	}{
		{"search empty", apiRootPath + "/search", "Query required (?q=)"},
		{"search blank", apiRootPath + "/search?q=", "Query required (?q=)"},

		{"anime no url", apiRootPath + "/anime", "Anime URL required (?url=)"},
		{"episode no url", apiRootPath + "/episode", "Episode URL required (?url=)"},
		{"stream no url", apiRootPath + "/stream", "Episode URL required (?url=)"},
		{"resolve no url", apiRootPath + "/resolve", "Episode URL required (?url=)"},
		{"servers no url", apiRootPath + "/servers", "Episode URL required (?url=)"},
		{"nav no url", apiRootPath + "/nav", "Episode URL required (?url=)"},
		{"meta no url", apiRootPath + "/meta", "Episode URL required (?url=)"},

		{"genre empty", apiRootPath + "/genre", "Genre slug required (?slug=)"},
		{"genre traversal", apiRootPath + "/genre?slug=../../etc", "Invalid slug (a-z 0-9 - only)"},
		{"genre absolute path", apiRootPath + "/genre?slug=/etc/passwd", "Invalid slug (a-z 0-9 - only)"},

		{"season missing", apiRootPath + "/season", "Season required (?season=winter&year=2024)"},
		{"season no year", apiRootPath + "/season?season=winter", "Year required (?season=winter&year=2024)"},
		{"season bad name", apiRootPath + "/season?season=wat&year=2024", "Season must be spring/summer/fall/winter"},
		{"season bad year", apiRootPath + "/season?season=winter&year=wat", "Year required (e.g. season winter 2024)"},

		{"anime foreign host", apiRootPath + "/anime?url=https://evil.com/x", "URL host not allowed: evil.com"},
		{"servers foreign host", apiRootPath + "/servers?url=https://evil.com/x", "URL host not allowed: evil.com"},
		{"resolve foreign host", apiRootPath + "/resolve?url=https://evil.com/x", "URL host not allowed: evil.com"},
		{"stream foreign host", apiRootPath + "/stream?url=https://evil.com/x", "URL host not allowed: evil.com"},
		{"anime loopback host", apiRootPath + "/anime?url=http://127.0.0.1:8893/x", "URL host not allowed: 127.0.0.1"},
		{"anime metadata host", apiRootPath + "/anime?url=http://169.254.169.254/latest/", "URL host not allowed: 169.254.169.254"},
		{"anime obfuscated loopback", apiRootPath + "/anime?url=http://2130706433/x", "URL host not allowed: 2130706433"},
	}
	s := testServer(false, false, "")
	for _, c := range cases {
		rec := call(s, http.MethodGet, c.target, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: %s = %d (%s), want 400", c.name, c.target, rec.Code, strings.TrimSpace(rec.Body.String()))
			continue
		}
		body := decode(t, rec)
		assertEnvelope(t, body)
		if code := errorCode(t, body); code != "bad_request" {
			t.Errorf("%s: error.code = %q, want bad_request", c.name, code)
		}
		e, _ := body["error"].(map[string]any)
		if got, _ := e["message"].(string); got != c.msg {
			t.Errorf("%s: message = %q, want %q", c.name, got, c.msg)
		}
	}
}

// TestGuardsRejectEverythingThatIsNotAValue pins the empty/whitespace boundary:
// a param that is present but blank must be treated as missing by every guard,
// or "?url= " would reach the scraper.
func TestGuardsRejectEverythingThatIsNotAValue(t *testing.T) {
	s := testServer(false, false, "")
	for _, target := range []string{
		apiRootPath + "/anime?url=",
		apiRootPath + "/anime?url=+",
		apiRootPath + "/episode?url=",
		apiRootPath + "/genre?slug=",
		apiRootPath + "/season?season=&year=",
		apiRootPath + "/season?season=winter&year=",
	} {
		rec := call(s, http.MethodGet, target, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", target, rec.Code)
		}
	}
}

// TestQueryParamHelpersReproduceTheReference covers the coercions that decide
// what the API actually asks the scraper for. They are small, pure and load-
// bearing: page/server clamping and the JS-faithful integer parsing are what keep
// a hostile ?page= from reaching the upstream request builder.
func TestQueryParamHelpersReproduceTheReference(t *testing.T) {
	pages := []struct {
		in   string
		want int
	}{
		{"", 1}, {"abc", 1}, {"0", 1}, {"-5", 1}, {"1", 1}, {"3", 3},
		{"50", 50}, {"51", 50}, {"999", 50},
		// parseInt has no radix here, so `0x10` is 16 in the reference too.
		{"0x10", 16},
		{"3abc", 3}, // parseInt stops at the first non-digit
		// A digit run too long for an int saturates instead of falling back to 1:
		// parseInt returns 1e20, clampPage pins it to 50. Falling back to 1 asked
		// the upstream for page 1 where the reference asks for page 50.
		{"99999999999999999999", 50},
		{"-99999999999999999999", 1},
		{"0xffffffffffffffffff", 50},
	}
	for _, c := range pages {
		if got := apiPage(c.in); got != c.want {
			t.Errorf("apiPage(%q) = %d, want %d", c.in, got, c.want)
		}
	}

	servers := []struct {
		in   string
		want int
	}{
		{"", 1}, {"abc", 1}, {"0", 1}, {"-3", 1}, {"1", 1},
		{"20", 20}, {"21", 20}, {"999", 20},
		{"99999999999999999999", 20},
		{"-99999999999999999999", 1},
	}
	for _, c := range servers {
		if got := apiServerNum(c.in); got != c.want {
			t.Errorf("apiServerNum(%q) = %d, want %d", c.in, got, c.want)
		}
	}

	ints := []struct {
		in   string
		want int
		ok   bool
	}{
		{"", 0, false}, {"abc", 0, false}, {"12", 12, true},
		{" 7 ", 7, true}, {"+7", 7, true}, {"-7", -7, true},
		{"3abc", 3, true}, {"0x10", 16, true}, {"0X1f", 31, true},
		{"-0x10", -16, true}, {"0x", 0, false}, {"-", 0, false},
		// Overflow saturates (parseInt loses precision rather than failing).
		{"99999999999999999999", math.MaxInt, true},
		{"-99999999999999999999", math.MinInt, true},
		{"0xffffffffffffffffff", math.MaxInt, true},
	}
	for _, c := range ints {
		got, ok := jsParseInt(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("jsParseInt(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}

	nums := []struct {
		in   string
		want int
		ok   bool
	}{
		{"", 0, true}, // Number("") is 0, and it is finite
		{"   ", 0, true},
		{"abc", 0, false},
		{"12", 12, true}, {"12.9", 12, true}, {"-12.9", -12, true},
		{"0x10", 16, true}, {"1e2", 100, true},
	}
	for _, c := range nums {
		got, ok := jsNumberToInt(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("jsNumberToInt(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}

	// trunc16 slices by rune, not by byte: a byte slice would cut a multi-byte
	// character in half and produce mojibake in the upstream query.
	if got := trunc16("abcdef", 3); got != "abc" {
		t.Errorf(`trunc16("abcdef", 3) = %q, want "abc"`, got)
	}
	if got := trunc16("ab", 3); got != "ab" {
		t.Errorf(`trunc16("ab", 3) = %q, want "ab" (short input passes through)`, got)
	}
	if got := trunc16("日本語です", 2); got != "日本" {
		t.Errorf(`trunc16("日本語です", 2) = %q, want "日本" (rune slicing)`, got)
	}

	if got := clampInt(5, 1, 10); got != 5 {
		t.Errorf("clampInt(5,1,10) = %d, want 5", got)
	}
	if got := clampInt(0, 1, 10); got != 1 {
		t.Errorf("clampInt(0,1,10) = %d, want 1", got)
	}
	if got := clampInt(11, 1, 10); got != 10 {
		t.Errorf("clampInt(11,1,10) = %d, want 10", got)
	}

	if got := atoi(" 42 "); got != 42 {
		t.Errorf(`atoi(" 42 ") = %d, want 42`, got)
	}
	if got := atoi("wat"); got != 0 {
		t.Errorf(`atoi("wat") = %d, want 0`, got)
	}

	for _, b := range []byte{'0', '9', 'a', 'f', 'A', 'F'} {
		if !isHexDigit(b) {
			t.Errorf("isHexDigit(%q) = false, want true", b)
		}
	}
	for _, b := range []byte{'g', 'G', '/', ':', 'z', ' '} {
		if isHexDigit(b) {
			t.Errorf("isHexDigit(%q) = true, want false", b)
		}
	}

	q := map[string][]string{"q": {"first"}, "empty": {}}
	if got := first(q, "q"); got != "first" {
		t.Errorf(`first(q,"q") = %q, want "first"`, got)
	}
	if got := first(q, "empty"); got != "" {
		t.Errorf(`first(q,"empty") = %q, want ""`, got)
	}
	if got := first(q, "missing"); got != "" {
		t.Errorf(`first(q,"missing") = %q, want ""`, got)
	}
}

// TestHostilePageValueBecomesTheClampedUpstreamPath closes the whole chain in one
// place: a caller's ?page= value, through the JS-faithful coercion, to the path
// the scraper actually requests. A live check cannot prove this — this origin
// answers / and /page/N/ with identical payloads — so the URL is pinned here.
func TestHostilePageValueBecomesTheClampedUpstreamPath(t *testing.T) {
	const base = "https://origin.test"
	cases := []struct {
		raw  string
		want string
	}{
		{"1", base + "/"},
		{"", base + "/"}, // apiPage falls back to 1
		{"abc", base + "/"},
		{"2", base + "/page/2/"},
		{"50", base + "/page/50/"},
		{"51", base + "/page/50/"},                   // clamped
		{"999", base + "/page/50/"},                  // clamped
		{"99999999999999999999", base + "/page/50/"}, // saturates, then clamps to 50
		{"-99999999999999999999", base + "/"},        // saturates negative, clamps to 1
		{"0", base + "/"},
	}
	for _, c := range cases {
		got := pagePath(base, apiPage(c.raw))
		if got != c.want {
			t.Errorf("pagePath(apiPage(%q)) = %q, want %q", c.raw, got, c.want)
		}
	}
	// pagePath itself keeps the bare index for exactly page 1.
	if got := pagePath(base, 1); got != base+"/" {
		t.Errorf("pagePath(base,1) = %q, want %q", got, base+"/")
	}
}
