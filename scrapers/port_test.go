// port_test.go — deterministic coverage for the JS-compatibility and parsing
// logic of the ported scrapers. Network paths are exercised live; these tests
// pin the parts that must not drift: JSON.parse/JSON.stringify semantics,
// encodeURIComponent, Node's lenient base64 decode and the lk21 regex parsers.
package scrapers

import (
	"strings"
	"testing"
)

func TestTolerantJSONMatchesJSONParse(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", `{"a":1,"b":[1,2],"c":{"d":"x"}}`, `{"a":1,"b":[1,2],"c":{"d":"x"}}`},
		{"trailing comma", `{"a":1,}`, `{"a":1}`},
		{"trailing comma array", `[1,2,]`, `[1,2]`},
		{"line comment", `{"a":1, // note
"b":2}`, `{"a":1,"b":2}`},
		{"block comment", `{"a":/* x */1}`, `{"a":1}`},
		{"NaN", `{"n":NaN}`, `{"n":null}`},
		{"Infinity", `{"n":Infinity}`, `{"n":null}`},
		{"neg Infinity", `[-Infinity]`, `[null]`},
		{"big int", `{"id":12345678901234567890}`, `{"id":12345678901234567000}`},
		{"float", `{"n":1.5}`, `{"n":1.5}`},
		{"exp", `{"n":2.5e-7}`, `{"n":2.5e-7}`},
		{"neg exp", `{"n":1e-7}`, `{"n":1e-7}`},
		{"huge", `[1e21]`, `[1e+21]`},
	}
	for _, c := range cases {
		v, err := TolerantJSON(c.in)
		if err != nil {
			t.Fatalf("%s: TolerantJSON error: %v", c.name, err)
		}
		got, err := JSONStringify(v)
		if err != nil {
			t.Fatalf("%s: JSONStringify error: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestTolerantJSONKeepsNumbersAndShapes(t *testing.T) {
	v, err := TolerantJSON(`{"status":true,"result":{"totalSongs":20,"songs":[{"duration":"7.00"}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	obj, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("expected object, got %T", v)
	}
	result, _ := obj["result"].(map[string]any)
	if result == nil {
		t.Fatal("missing result object")
	}
	if _, isString := result["totalSongs"].(string); isString {
		t.Error("totalSongs must stay numeric (json.Number), not string")
	}
}

func TestJSONStringifyEscaping(t *testing.T) {
	got, err := JSONStringify(map[string]any{"q": "a\"b\\c\nd\u0001", "s": "<tag> & 'x'"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"q":"a\"b\\c\nd\u0001","s":"<tag> & 'x'"}`
	if got != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestEncodeURIComponentMatchesJS(t *testing.T) {
	cases := map[string]string{
		"a b":          "a%20b",
		"a+b":          "a%2Bb",
		"a/b?c=d":      "a%2Fb%3Fc%3Dd",
		"a&b":          "a%26b",
		"abc-_.!~*'()": "abc-_.!~*'()",
		"é":            "%C3%A9",
		"#":            "%23",
		"a\\b":         "a%5Cb",
	}
	for in, want := range cases {
		if got := EncodeURIComponent(in); got != want {
			t.Errorf("EncodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeDataImage(t *testing.T) {
	// Node's Buffer.from(..., 'base64') ignores non-alphabet characters.
	got, err := decodeDataImage("data:image/png;base64,aGVsbG8=")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
	padded, err := decodeDataImage("aGVsbG8") // unpadded, Node tolerates it
	if err != nil {
		t.Fatal(err)
	}
	if string(padded) != "hello" {
		t.Errorf("unpadded: got %q, want %q", padded, "hello")
	}
	if _, err := decodeDataImage("!!!!"); err != nil {
		t.Errorf("all-invalid base64 should decode to empty, got error %v", err)
	}
}

func TestLK21DecodeEntities(t *testing.T) {
	got := decodeEntities(`a&quot;b&#039;c&#39;d&amp;e&lt;f&gt;g&nbsp;h`)
	if got != `a"b'c'd&e<f>g h` {
		t.Errorf("got %q", got)
	}
}

// lk21ItemFixture is a trimmed copy of one real `parseItem` block.
const lk21ItemFixture = `<article class="item">
  <a href="/uprising-2026" title="The Uprising"><div class="poster"><img data-src="https://poster.assetsy.de/film-uprising-2026-lk21.jpg" src="data:image/gif;base64,x"></div></a>
  <div class="rating"><span itemprop="ratingValue">6.3</span><span itemprop="ratingCount" content="3131"></span></div>
  <h3 class="poster-title"><a href="/uprising-2026">The Uprising &amp; Friends</a></h3>
  <div class="genre">Action, Drama, History, War</div>
  <span class="year">2026</span>
  <span class="label">HD</span>
  <span class="duration" itemprop="duration" content="PT3M3S">03:03</span>
</article>`

func TestParseItem(t *testing.T) {
	item := parseItem(lk21ItemFixture)
	if item["slug"] != "uprising-2026" {
		t.Errorf("slug = %v", item["slug"])
	}
	if item["title"] != "The Uprising & Friends" {
		t.Errorf("title = %v", item["title"])
	}
	if item["rating"] != "6.3" || item["ratingCount"] != "3131" {
		t.Errorf("rating = %v / %v", item["rating"], item["ratingCount"])
	}
	if item["year"] != "2026" || item["duration"] != "03:03" || item["quality"] != "HD" {
		t.Errorf("year/duration/quality = %v / %v / %v", item["year"], item["duration"], item["quality"])
	}
	if item["poster"] != "https://poster.assetsy.de/film-uprising-2026-lk21.jpg" {
		t.Errorf("poster = %v (data-src must win over src)", item["poster"])
	}
	genres, _ := item["genres"].([]any)
	if len(genres) != 4 || genres[0] != "Action" {
		t.Errorf("genres = %v", genres)
	}
	if item["isSeries"] != false {
		t.Errorf("isSeries = %v", item["isSeries"])
	}
	if item["url"] != lk21Base+"/uprising-2026" {
		t.Errorf("url = %v", item["url"])
	}
	if item["episodes"] != nil {
		t.Errorf("episodes = %v, want nil", item["episodes"])
	}
}

const lk21DetailFixture = `<div class="main-player" data-post_id="34744" data-related_type="movie"></div>
<script id="watch-history-data" type="application/json">{"id":34744,"title":"The Uprising","rating":"6.3","poster":"https://p/x.jpg","slug":"uprising-2026","year":2026,"runtime":"03:03"}</script>
<h1>The Uprising (2026)</h1><div class="info-tag"><span>17+</span><span>WEBDL</span><span>1080p</span></div><div class="tag-list"><span class="tag"><a href="/genre/action">Action</a></span><span class="tag"><a href="/country/uk">United Kingdom</a></span></div>
<div class="synopsis collapsed">Line one<br>Line two</div>
<div class="detail hidden"><p><span>Subtitle: </span><a href="/t/x">workkeerr</a></p><p><span>Negara: </span>UK</p></div>
<iframe id="main-player" src="https://videonode.de/iframe3/p2p/ABC?v=1"></iframe>
<div id="player-list"><li><a href="https://videonode.de/iframe3/p2p/ABC" class="active" data-url="https://videonode.de/iframe3/p2p/ABC" data-server="p2p">P2P</a></li></ul>
<a href="https://dadadidi.de/uprising-2026/" title="Download The Uprising (2026)">D</a>
<a href="https://www.youtube.com/watch?v=lyhCxZN4Ro8" class="yt-lightbox">T</a>`

func TestParseDetail(t *testing.T) {
	d := parseDetail(lk21DetailFixture, map[string]any{"slug": "uprising-2026"})
	if d["id"] != "34744" || d["type"] != "movie" {
		t.Errorf("id/type = %v / %v (main-player must win over the JSON block)", d["id"], d["type"])
	}
	if d["title"] != "The Uprising" {
		t.Errorf("title = %v (the watch-history payload wins)", d["title"])
	}
	if d["year"] != jsonNumber(2026) {
		t.Errorf("year = %#v (must stay numeric)", d["year"])
	}
	info, _ := d["info"].([]any)
	if len(info) != 3 || info[0] != "17+" {
		t.Errorf("info = %v", info)
	}
	genres, _ := d["genres"].([]any)
	countries, _ := d["countries"].([]any)
	if len(genres) != 1 || genres[0] != "Action" {
		t.Errorf("genres = %v", genres)
	}
	if len(countries) != 1 || countries[0] != "United Kingdom" {
		t.Errorf("countries = %v", countries)
	}
	if d["synopsis"] != "Line one\nLine two" {
		t.Errorf("synopsis = %q", d["synopsis"])
	}
	details, _ := d["details"].(map[string]any)
	if details["Subtitle:"] != "workkeerr" || details["Negara:"] != "UK" {
		t.Errorf("details = %v", details)
	}
	if d["player"] != "https://videonode.de/iframe3/p2p/ABC?v=1" {
		t.Errorf("player = %v", d["player"])
	}
	players, _ := d["players"].([]any)
	if len(players) != 1 {
		t.Fatalf("players = %v", players)
	}
	first, _ := players[0].(map[string]any)
	if first["server"] != "p2p" || first["url"] != "https://videonode.de/iframe3/p2p/ABC" {
		t.Errorf("players[0] = %v", first)
	}
	if d["downloadUrl"] != "https://dadadidi.de/uprising-2026/" {
		t.Errorf("downloadUrl = %v", d["downloadUrl"])
	}
	if d["trailerUrl"] != "https://www.youtube.com/watch?v=lyhCxZN4Ro8" {
		t.Errorf("trailerUrl = %v", d["trailerUrl"])
	}
	if d["site"] != lk21Base || d["slug"] != "uprising-2026" {
		t.Errorf("site/slug = %v / %v", d["site"], d["slug"])
	}
}

func TestLK21SlugGuard(t *testing.T) {
	if _, err := getDetail("../etc"); err == nil || err.Error() != "Invalid slug (a-z 0-9 - only)" {
		t.Errorf("traversal slug must be rejected with the TS message, got %v", err)
	}
}

func TestRegistryCoversPortedScrapers(t *testing.T) {
	// All 14 ported scrapers: every command of the TS reference must exist, so a
	// dropped command is a test failure rather than a silent regression.
	want := map[string][]string{
		"anilist":        {"detail", "populer", "search"},
		"animeindo":      {"batch", "detail", "episode", "genre", "genrelist", "home", "jadwal", "movies", "search", "supported", "watch"},
		"codeengo":       {"generate", "styles", "test"},
		"drowify":        {"album", "artist", "audio", "lyrics", "search", "suggest"},
		"freeconvert":    {"compress"},
		"lk21":           {"detail", "list", "list-detail", "sections"},
		"otakudesu":      {"batch", "complete", "detail", "episode", "genre", "genrelist", "home", "jadwal", "ongoing", "search", "watch"},
		"sakana":         {"chat", "conversations", "delete", "models"},
		"spotify":        {"album", "artist", "episode", "home", "playlist", "search", "show", "track"},
		"tiktok":         {"download", "user", "video"},
		"viewpagesource": {"token", "view"},
		"whitehouse":     {"administration", "briefings", "detail", "executive-orders", "fact-sheets", "gallery", "home", "memoranda", "news", "nominations", "presidential-actions", "proclamations", "releases", "remarks", "research", "search", "videos"},
		"yt":             {"download", "info", "related", "search"},
		"ytmusic":        {"download", "info", "lyrics", "related", "search"},
	}
	for name, cmds := range want {
		s, ok := Find(name)
		if !ok {
			t.Errorf("scraper %q missing from All()", name)
			continue
		}
		for _, c := range cmds {
			if _, ok := s.Commands[c]; !ok {
				t.Errorf("%s: command %q missing", name, c)
			}
		}
		if got := len(s.Commands); got != len(cmds) {
			t.Errorf("%s: %d commands, want %d (update this matrix when the CLI surface changes)", name, got, len(cmds))
		}
	}
}

func TestAnilistSPAErrorIsActionable(t *testing.T) {
	if !strings.Contains(SPAError, "GraphQL") || !strings.Contains(SPAError, "SPA") {
		t.Errorf("SPAError must stay actionable: %q", SPAError)
	}
}

// TestLocalOnlyCommandsAreNotRoutable pins the HTTP surface: a command that
// touches the filesystem must be flagged LocalOnly, because api_go.go skips
// flagged commands when it builds routes (a query string must never name a
// server-side path).
func TestLocalOnlyCommandsAreNotRoutable(t *testing.T) {
	want := map[string][]string{
		"codeengo":       {"generate", "test"},
		"freeconvert":    {"compress"},
		"tiktok":         {"download"},
		"viewpagesource": {"view"},
	}
	for name, cmds := range want {
		s, ok := Find(name)
		if !ok {
			t.Fatalf("scraper %q missing", name)
		}
		for _, c := range cmds {
			if !s.Commands[c].LocalOnly {
				t.Errorf("%s %s must be LocalOnly (it writes or reads local files)", name, c)
			}
		}
	}
}
