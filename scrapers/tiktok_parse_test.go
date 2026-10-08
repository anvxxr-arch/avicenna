package scrapers

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// These tests pin the tiktok payload shapers — the layer that turns a decoded
// JSON blob into the API's response shape. They are hermetic: no Site, no
// network, no registry side effects. The live parity row (`tiktok-user`)
// covers the fetch path; these cover the fifty ways a real payload can vary.

// --- case-insensitive access ---------------------------------------------

func TestCiMapGetIsCaseInsensitive(t *testing.T) {
	m := ciMap{"ItemInfo": map[string]any{"x": 1}, "id": "42"}
	if v := m.get("iteminfo"); v == nil {
		t.Error("ciMap.get must find a differently-cased key")
	}
	if v := m.get("ID"); v != "42" {
		t.Errorf(`ciMap.get("ID") = %v, want "42"`, v)
	}
	if v := m.get("missing"); v != nil {
		t.Errorf(`ciMap.get("missing") = %v, want nil`, v)
	}
}

func TestCiObjRejectsNonObjects(t *testing.T) {
	if ciObj("jstr") != nil {
		t.Error("ciObj(string) must be nil")
	}
	if ciObj(nil) != nil {
		t.Error("ciObj(nil) must be nil")
	}
	if ciObj([]any{1}) != nil {
		t.Error("ciObj(array) must be nil")
	}
	if ciObj(map[string]any{"a": 1}) == nil {
		t.Error("ciObj(object) must not be nil")
	}
}

// --- cookies --------------------------------------------------------------

func TestTiktokGrabCookiesDedupesByNameValuePart(t *testing.T) {
	got := tiktokGrabCookies(http.Header{
		"Set-Cookie": []string{
			"ttwid=abc; Path=/; Domain=.tiktok.com",
			"ttwid=abc; SameSite=None", // same name=value -> dropped
			"msToken=xyz; HttpOnly",
			"   ",
			"tt_webid_v2=700; Path=/",
		},
	})
	want := "ttwid=abc; msToken=xyz; tt_webid_v2=700"
	if got != want {
		t.Errorf("tiktokGrabCookies = %q, want %q", got, want)
	}
}

func TestTiktokGrabCookiesEmptyIsEmpty(t *testing.T) {
	if got := tiktokGrabCookies(http.Header{}); got != "" {
		t.Errorf("tiktokGrabCookies(empty) = %q, want \"\"", got)
	}
}

// --- script payload extraction --------------------------------------------

const tiktokAPIDataHTML = `<html><body>
<script id="api-data" type="application/json">{"itemInfo":{"itemStruct":{"id":"7301234567890123456"}}}</script>
</body></html>`

const tiktokUniversalHTML = `<html><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"uniqueId":"tiktok"}}}}}</script>
</body></html>`

func TestTiktokScriptObjectReadsBothPayloads(t *testing.T) {
	api := tiktokParseAPIData(tiktokAPIDataHTML)
	if api == nil {
		t.Fatal("tiktokParseAPIData must read the #api-data script")
	}
	if _, ok := api["itemInfo"]; !ok {
		t.Error("api-data payload lost its itemInfo key")
	}
	uni := tiktokParseUniversal(tiktokUniversalHTML)
	if uni == nil {
		t.Fatal("tiktokParseUniversal must read the rehydration script")
	}
	if _, ok := uni["__DEFAULT_SCOPE__"]; !ok {
		t.Error("universal payload lost __DEFAULT_SCOPE__")
	}
}

func TestTiktokScriptObjectDegradesToNil(t *testing.T) {
	cases := map[string]string{
		"empty html":      ``,
		"no script":       `<html><body>nothing</body></html>`,
		"truncated json":  `<script id="api-data">{"a":</script>`,
		"json not object": `<script id="api-data">[1,2,3]</script>`,
		"other script id": `<script id="something">{"a":1}</script>`,
	}
	for name, html := range cases {
		if got := tiktokParseAPIData(html); got != nil {
			t.Errorf("tiktokParseAPIData(%s) = %v, want nil", name, got)
		}
	}
}

// --- URL shaping ----------------------------------------------------------

func TestTiktokCleanVideoURLSwapsTheWatermarkSegment(t *testing.T) {
	cases := []struct {
		in   string
		want any
	}{
		{"", nil},
		{"https://cdn.tiktok.com/video/playwm/a.mp4", "https://cdn.tiktok.com/video/play/a.mp4"},
		{"https://cdn.tiktok.com/video/play/a.mp4", "https://cdn.tiktok.com/video/play/a.mp4"},
		// only the first /playwm/ is swapped (mirrors String.replace with a string arg)
		{"https://x/playwm/playwm/a.mp4", "https://x/play/playwm/a.mp4"},
	}
	for _, c := range cases {
		if got := tiktokCleanVideoURL(c.in); got != c.want {
			t.Errorf("tiktokCleanVideoURL(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestTiktokTakeAvatarPrefersUrlListHeadThenBareString(t *testing.T) {
	if got := tiktokTakeAvatar(map[string]any{"urlList": []any{"first", "second"}}); got != "first" {
		t.Errorf("urlList -> %v, want first", got)
	}
	if got := tiktokTakeAvatar("https://cdn/a.jpg"); got != "https://cdn/a.jpg" {
		t.Errorf("bare string -> %v", got)
	}
	for _, bad := range []any{nil, "", 0, map[string]any{}, map[string]any{"urlList": []any{}}, []any{"x"}} {
		if got := tiktokTakeAvatar(bad); got != nil {
			t.Errorf("tiktokTakeAvatar(%#v) = %v, want nil", bad, got)
		}
	}
}

func TestTiktokTakeURLTakesTheLastElement(t *testing.T) {
	// takeUrl() in the TS reference takes the LAST element, not the first —
	// a payload with several mirrors relies on that.
	got := tiktokTakeURL([]any{
		map[string]any{"url": "https://cdn/1.mp4"},
		map[string]any{"url": "https://cdn/2.mp4"},
		map[string]any{"url": "https://cdn/3.mp4"},
	})
	if got != "https://cdn/3.mp4" {
		t.Errorf("tiktokTakeURL(last) = %v, want the last element", got)
	}
	if got := tiktokTakeURL("https://cdn/plain.mp4"); got != "https://cdn/plain.mp4" {
		t.Errorf("bare string -> %v", got)
	}
	for _, bad := range []any{nil, []any{}, []any{map[string]any{"nourl": 1}}, []any{"notmap"}, 42, map[string]any{}} {
		if got := tiktokTakeURL(bad); got != nil {
			t.Errorf("tiktokTakeURL(%#v) = %v, want nil", bad, got)
		}
	}
}

func TestStrOfMirrorsJSStringCoercion(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, ""},
		{"already", "already"},
		{json.Number("7301234567890123456"), "7301234567890123456"},
		{float64(12.5), "12.5"},
		// digits below 1e21 render identically to JS String(); at/above 1e21 Go's
		// 'f' format keeps digits where JS switches to "1e+21". Unreachable for a
		// tiktok id (19 digits) but pinned here so the boundary is documented.
		{float64(1e20), "100000000000000000000"},
		{int64(7), "7"},
		{true, "true"},
		{false, "false"},
		{map[string]any{}, ""}, // objects coerce to "" here, not "[object Object]"
	}
	for _, c := range cases {
		if got := strOf(c.in); got != c.want {
			t.Errorf("strOf(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A big integer id must survive as digits (JS keeps it as a Number and
// String() renders the same digits), which needs UseNumber on decode.
func TestStrOfKeepsLargeIDDigits(t *testing.T) {
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(`{"id":7301234567890123456}`))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	if got := strOf(m["id"]); got != "7301234567890123456" {
		t.Errorf("strOf(large id) = %q, want the exact digits", got)
	}
}

// --- item lookup ----------------------------------------------------------

func TestTiktokFindItemStructPrefersItemInfoAlongThePath(t *testing.T) {
	inner := map[string]any{
		"itemInfo":   map[string]any{"itemStruct": map[string]any{"id": "found"}},
		"otherKey":   "x",
		"anotherKey": map[string]any{"nested": map[string]any{"deep": 1}},
	}
	root := map[string]any{"zzz": map[string]any{"aaa": inner}}
	got := tiktokFindItemStruct(root, 0)
	if got == nil || got.get("id") != "found" {
		t.Errorf("tiktokFindItemStruct = %v, want the nested itemStruct", got)
	}
}

func TestTiktokFindItemStructReadsVideoDetailShape(t *testing.T) {
	root := map[string]any{
		"videoDetail": map[string]any{
			"itemInfo": map[string]any{"itemStruct": map[string]any{"id": "via-video-detail"}},
		},
	}
	got := tiktokFindItemStruct(root, 0)
	if got == nil || got.get("id") != "via-video-detail" {
		t.Errorf("tiktokFindItemStruct(videoDetail) = %v", got)
	}
}

func TestTiktokFindItemStructGivesUpWhenAbsent(t *testing.T) {
	for _, v := range []any{nil, "", 0, map[string]any{}, []any{1, 2}, map[string]any{"a": "b"}} {
		if got := tiktokFindItemStruct(v, 0); got != nil {
			t.Errorf("tiktokFindItemStruct(%#v) = %v, want nil", v, got)
		}
	}
}

// The depth bound is 4: a payload nested five levels deep is not searched.
func TestTiktokFindItemStructHonoursTheDepthBound(t *testing.T) {
	// level 5 (root counts as depth 0 -> 4 nested wrappers is the limit)
	nest := func(n int, leaf any) any {
		v := leaf
		for i := 0; i < n; i++ {
			v = map[string]any{"w": v}
		}
		return v
	}
	leaf := map[string]any{"itemInfo": map[string]any{"itemStruct": map[string]any{"id": "deep"}}}

	if got := tiktokFindItemStruct(nest(4, leaf), 0); got == nil {
		t.Error("a payload four wrappers deep must still be found")
	}
	if got := tiktokFindItemStruct(nest(12, leaf), 0); got != nil {
		t.Errorf("a payload twelve wrappers deep must not be searched, got %v", got)
	}
}

// --- deterministic key order ----------------------------------------------

func TestTiktokSortedKeysIsDeterministic(t *testing.T) {
	// Object.values order is not preserved by encoding/json; the reference
	// takes the first match, so the iteration order must be pinned.
	m := map[string]any{"b": 1, "a": 2, "c": 3}
	first := tiktokSortedKeys(m)
	for i := 0; i < 20; i++ {
		if got := tiktokSortedKeys(m); len(got) != len(first) {
			t.Fatalf("tiktokSortedKeys length changed between calls")
		} else {
			for j := range got {
				if got[j] != first[j] {
					t.Fatalf("tiktokSortedKeys order changed: %v vs %v", got, first)
				}
			}
		}
	}
	if first[0] != "a" || first[1] != "b" || first[2] != "c" {
		t.Errorf("tiktokSortedKeys = %v, want sorted a,b,c", first)
	}
}

// --- the video shape mapper ----------------------------------------------

func TestTiktokExtractVideoShapesARealPayload(t *testing.T) {
	item := ciMap{
		"id":         "7301234567890123456",
		"desc":       "caption here",
		"createTime": json.Number("1700000000"),
		"author": map[string]any{
			"uniqueId":     "someone",
			"nickname":     "Some One",
			"signature":    "bio",
			"verified":     true,
			"avatarLarger": map[string]any{"urlList": []any{"https://cdn/avatar-lg.jpg"}},
		},
		"video": map[string]any{
			"duration":     json.Number("15000"),
			"cover":        map[string]any{"urlList": []any{"https://cdn/cover.jpg"}},
			"playAddr":     "https://cdn/video/playwm/a.mp4",
			"downloadAddr": []any{map[string]any{"url": "https://cdn/video/playwm/dl.mp4"}},
		},
		"stats": map[string]any{
			"playCount": json.Number("1000000"),
			"diggCount": json.Number("50000"),
		},
		"music": map[string]any{"title": "song", "playUrl": "https://cdn/music.mp3"},
	}

	got := tiktokExtractVideo(item)
	if got == nil {
		t.Fatal("tiktokExtractVideo returned nil for a full payload")
	}
	checks := map[string]any{
		"id":            "7301234567890123456",
		"desc":          "caption here",
		"author":        "someone",
		"nickname":      "Some One",
		"signature":     "bio",
		"verified":      true,
		"avatar":        "https://cdn/avatar-lg.jpg",
		"cover":         "https://cdn/cover.jpg",
		"music":         "song",
		"musicUrl":      "https://cdn/music.mp3",
		"noWatermark":   "https://cdn/video/play/a.mp4",
		"withWatermark": "https://cdn/video/play/dl.mp4",
	}
	for k, want := range checks {
		if got[k] != want {
			t.Errorf("tiktokExtractVideo[%q] = %v, want %v", k, got[k], want)
		}
	}
}

func TestTiktokExtractVideoSurvivesEmptyAndOddPayloads(t *testing.T) {
	if got := tiktokExtractVideo(nil); got != nil {
		t.Errorf("tiktokExtractVideo(nil) = %v, want nil", got)
	}
	// every sub-object missing: must still emit the full key set, values zeroed
	got := tiktokExtractVideo(ciMap{"id": "1"})
	if got == nil {
		t.Fatal("an item with only an id must still shape")
	}
	wantKeys := []string{
		"id", "desc", "createTime", "author", "nickname", "avatar", "signature",
		"verified", "cover", "duration", "playCount", "likeCount", "commentCount",
		"shareCount", "collectCount", "music", "musicUrl", "noWatermark", "withWatermark",
	}
	for _, k := range wantKeys {
		if _, ok := got[k]; !ok {
			t.Errorf("tiktokExtractVideo is missing key %q for a sparse payload", k)
		}
	}
	if got["id"] != "1" {
		t.Errorf("id = %v, want 1", got["id"])
	}
	// cover as a bare string is kept as-is
	if c := tiktokExtractVideo(ciMap{"video": map[string]any{"cover": "https://cdn/c.jpg"}}); c["cover"] != "https://cdn/c.jpg" {
		t.Errorf("bare-string cover = %v", c["cover"])
	}
	// cover as an unrecognised shape becomes nil rather than a raw object
	if c := tiktokExtractVideo(ciMap{"video": map[string]any{"cover": map[string]any{"nope": 1}}}); c["cover"] != nil {
		t.Errorf("unknown cover shape = %v, want nil", c["cover"])
	}
}

// --- username normalisation (guard only; the fetch is covered live) -------

func TestTiktokGetUserNormalisesThenGuards(t *testing.T) {
	// Every one of these must be refused before any request. The guard runs on
	// the normalised value (a leading @ is stripped), so only values that stay
	// invalid are listed — a junk tail such as "user?x=1" is stripped and then
	// legitimately fetched, which is why it is not here (this table stays
	// offline; the fetch path is covered by the live parity row).
	for _, bad := range []string{
		"", " ", "@", "../../etc", "bad username!", "a/b",
		"toolongusername_toolongusername_toolong",
		"@bad name",
	} {
		if _, err := tiktokGetUser(bad); err == nil {
			t.Errorf("tiktokGetUser(%q) must be rejected before any fetch", bad)
		}
	}
}
