// nontonanime_test.go — offline coverage for the primary origin's parsers and
// guards, using inline HTML fixtures. No network: every function here is pure
// (string/document in, values out), which is why these paths were never covered
// before — the live parity suite only exercises them end to end.
package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestCleanSlugRejectsTraversalAndJunk(t *testing.T) {
	for _, s := range []string{"", "   ", "../etc", "..%2f..", "a/b", "A B", "slug?x=1", "slug#f", "日本語"} {
		if got, err := cleanSlug(s); err == nil {
			t.Errorf("cleanSlug(%q) = %q, want an error", s, got)
		}
	}
	ok := map[string]string{
		"Family-Control":      "family-control",
		"eleceed-chapter-420": "eleceed-chapter-420",
		" family-control ":    "family-control",
		"9":                   "9",
	}
	for in, want := range ok {
		got, err := cleanSlug(in)
		if err != nil || got != want {
			t.Errorf("cleanSlug(%q) = %q, %v; want %q, nil", in, got, err, want)
		}
	}
}

func TestCleanQueryCollapsesWhitespace(t *testing.T) {
	for _, s := range []string{"", " ", "a"} {
		if got, err := cleanQuery(s); err == nil {
			t.Errorf("cleanQuery(%q) = %q, want an error", s, got)
		}
	}
	got, err := cleanQuery("  one   piece  ")
	if err != nil || got != "one piece" {
		t.Errorf(`cleanQuery("  one   piece  ") = %q, %v; want "one piece", nil`, got, err)
	}
}

func TestClampPageBounds(t *testing.T) {
	for in, want := range map[int]int{0: 1, -3: 1, 1: 1, 7: 7, 50: 50, 99: 50, 1000: 50} {
		if got := clampPage(in); got != want {
			t.Errorf("clampPage(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestExtractEmbedURLPreferenceOrder(t *testing.T) {
	cases := []struct{ name, html, want string }{
		{"iframe src", `<html><iframe src="https://e/1.mp4"></iframe></html>`, "https://e/1.mp4"},
		{"iframe data-src", `<html><iframe data-src="https://e/2.mp4"></iframe></html>`, "https://e/2.mp4"},
		{"video source", `<html><video><source src="https://e/3.mp4"></video></html>`, "https://e/3.mp4"},
		{"video src", `<html><video src="https://e/4.mp4"></video></html>`, "https://e/4.mp4"},
		{"raw url fallback", `no player here, try https://e/5.mp4 instead`, "https://e/5.mp4"},
		{"nothing", `<html><p>no player</p></html>`, ""},
	}
	for _, c := range cases {
		if got := extractEmbedURL(c.html); got != c.want {
			t.Errorf("%s: extractEmbedURL() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParseArticleGridExtractsAndDropsIncomplete(t *testing.T) {
	html := `<html><body>
<article class="animeseries"><a href="/series/one-piece/">
  <div class="title"><span data-title-default="One Piece"></span></div>
  <div class="episodes"> Episode 1100 </div>
  <img data-src="/img/op.jpg" src="/img/fallback.jpg">
</a></article>
<article class="animeseries"><a href="/series/no-title/"><div class="title"><span></span></div></a></article>
<article class="animeseries"><a href=""><div class="title"><span>No href</span></div></a></article>
</body></html>`

	eps := parseArticleGrid(safeDoc(html))
	if len(eps) != 1 {
		t.Fatalf("got %d episodes, want 1 (only the complete row survives): %+v", len(eps), eps)
	}
	e := eps[0]
	if e.Title != "One Piece" {
		t.Errorf("title = %q, want One Piece", e.Title)
	}
	if e.Ep != "1100" {
		t.Errorf("episode = %q, want 1100", e.Ep)
	}
	if e.URL != "/series/one-piece/" {
		t.Errorf("url = %q, want /series/one-piece/", e.URL)
	}
	if e.Thumbnail != "/img/op.jpg" {
		t.Errorf("thumbnail = %q, want /img/op.jpg (data-src beats src)", e.Thumbnail)
	}
}

// The optional-field contract: a card that has no rating/type/season/synopsis or
// genres must OMIT those keys, not emit empty strings — that is the behaviour the
// `coarse` contract mode exists to tolerate, so it is pinned here.
func TestParseAsCardsKeepsOptionalFieldsOptional(t *testing.T) {
	html := `<html><body>
<a class="as-anime-card" href="/anime/bleach/">
  <img data-src="/img/bleach.jpg">
  <div class="as-anime-title" data-title-default="Bleach"></div>
  <div class="as-rating"> 8.24 </div>
  <div class="as-type">★ TV</div>
  <div class="as-season">📅 Fall 2024</div>
  <div class="as-synopsis"> A shinigami story </div>
  <div class="as-genres"><span>Action</span><span>Shounen</span></div>
</a>
<a class="as-anime-card" href="/anime/plain/">
  <div class="as-anime-title" data-title-default="Plain"></div>
</a>
<div class="as-anime-card"><div class="as-anime-title" data-title-default="No href"></div></div>
</body></html>`

	cards := parseAsCards(safeDoc(html), "")
	if len(cards) != 2 {
		t.Fatalf("got %d cards, want 2 (a card without a url must be dropped): %+v", len(cards), cards)
	}
	first := cards[0]
	if first.Title != "Bleach" || first.URL != "/anime/bleach/" || first.Thumbnail != "/img/bleach.jpg" {
		t.Errorf("required fields wrong: %+v", first)
	}
	if first.Rating == nil || *first.Rating != "8.24" {
		t.Errorf("rating = %v, want 8.24", first.Rating)
	}
	if first.Type == nil || *first.Type != "TV" {
		t.Errorf("type = %v, want TV (leading symbol stripped)", first.Type)
	}
	if first.Season == nil || !strings.Contains(*first.Season, "Fall 2024") {
		t.Errorf("season = %v, want it to contain Fall 2024", first.Season)
	}
	if len(first.Genres) != 2 {
		t.Errorf("genres = %v, want 2 entries", first.Genres)
	}

	second := cards[1]
	if second.Rating != nil || second.Type != nil || second.Season != nil || second.Synopsis != nil || second.Genres != nil {
		t.Errorf("optional fields must stay omitted for a bare card: %+v", second)
	}
}

// extractPageVar has two input paths: an inline <script> and a data: URL script.
// This exercises the base64 + balanced-brace slice path used by the stream routes.
func TestExtractPageVarDecodesBase64AndInlineScripts(t *testing.T) {
	js := `var playerConfig={"url":"https://e/x.m3u8","n":7};`
	encoded := base64.StdEncoding.EncodeToString([]byte(js))
	fromData := `<html><head><script src="data:text/javascript;base64,` + encoded + `"></script></head><body></body></html>`

	got := extractPageVar(fromData, "playerConfig")
	if got == nil {
		t.Fatal("extractPageVar returned nil for a data: URL script")
	}
	if got["url"] != "https://e/x.m3u8" {
		t.Errorf("url = %v, want https://e/x.m3u8", got["url"])
	}
	if n, ok := got["n"].(float64); !ok || n != 7 {
		t.Errorf("n = %v (%T), want 7", got["n"], got["n"])
	}

	inline := `<html><body><script>var otherVar={"a":1};</script></body></html>`
	got2 := extractPageVar(inline, "otherVar")
	if got2 == nil || got2["a"] != float64(1) {
		t.Errorf("inline script var not extracted: %v", got2)
	}

	if got3 := extractPageVar(`<html><body><script>var x=1;</script></body></html>`, "absentVar"); got3 != nil {
		t.Errorf("extractPageVar for an absent var = %v, want nil", got3)
	}
}
