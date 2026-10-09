// samehadaku_test.go — offline parser coverage for the Samehadaku port.
//
// The live site sits behind a Cloudflare managed challenge, so plain HTTP
// clients cannot reach it. These tests run the port's parsers over
// tools/fixtures/samehadaku/*.html — real captures of the pages (trimmed to the
// blocks each parser reads) — and pin the fields a live run would produce.
package scrapers

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

const shFixtureDir = "../tools/fixtures/samehadaku"

func shFixture(t *testing.T, name string) *goquery.Document {
	t.Helper()
	raw, err := os.ReadFile(shFixtureDir + "/" + name)
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return SafeDoc(string(raw))
}

func TestSamehadakuHomeCards(t *testing.T) {
	doc := shFixture(t, "home.html")
	cards := []map[string]any{}
	doc.Find("div.post-show li").Each(func(_ int, el *goquery.Selection) {
		if c := shPostShowCard(el); c != nil {
			cards = append(cards, c)
		}
	})
	if len(cards) != 16 {
		t.Fatalf("cards = %d, want 16", len(cards))
	}
	first := cards[0]
	if first["title"] != "Sora wa Akai Kawa no Hotori" {
		t.Errorf("title = %v", first["title"])
	}
	if first["slug"] != "sora-wa-akai-kawa-no-hotori" {
		t.Errorf("slug must be the path tail, got %v", first["slug"])
	}
	if first["episode"] != "13" {
		t.Errorf("episode = %v", first["episode"])
	}
	if first["releasedOn"] != "56 minutes yang lalu" {
		t.Errorf("releasedOn = %v", first["releasedOn"])
	}
	if !strings.HasPrefix(first["url"].(string), "https://v2.samehadaku.how/anime/") {
		t.Errorf("url = %v", first["url"])
	}
}

func TestSamehadakuSearchCards(t *testing.T) {
	doc := shFixture(t, "search.html")
	results := []map[string]any{}
	doc.Find(shSearchCardSel).Each(func(_ int, el *goquery.Selection) {
		if c := shAnimpostCard(el); c != nil {
			results = append(results, c)
		}
	})
	if len(results) != 8 {
		t.Fatalf("results = %d, want 8", len(results))
	}
	first := results[0]
	if first["title"] != "One Piece: Heroines" || first["slug"] != "one-piece-heroines" {
		t.Errorf("title/slug = %v / %v", first["title"], first["slug"])
	}
	if first["type"] != "Special" {
		t.Errorf("type = %v", first["type"])
	}
	if first["score"] != "7.58" {
		t.Errorf("score = %v", first["score"])
	}
	if first["status"] != "Completed" {
		t.Errorf("status = %v", first["status"])
	}
	genres, _ := first["genres"].([]any)
	if len(genres) != 4 || genres[0] != "Adventure" {
		t.Errorf("genres = %v", genres)
	}
	if first["views"] != "3378" {
		t.Errorf("views = %v", first["views"])
	}
}

// Live capture (2026-10-08) of `/?s=one piece`: the site now emits
// `article.animepost` (no extra "i") and most cards link to episodes/batches.
// The card parser intentionally keeps only `/anime/` series links, so a page of
// 20 articles yields exactly one card — the same rule the TS reference applies.
// Before the class fix this fixture produced zero cards, which is precisely the
// silent empty result the live command was returning.
func TestSamehadakuSearchCardsLiveMarkup(t *testing.T) {
	doc := shFixture(t, "search-live.html")
	results := []map[string]any{}
	doc.Find(shSearchCardSel).Each(func(_ int, el *goquery.Selection) {
		if c := shAnimpostCard(el); c != nil {
			results = append(results, c)
		}
	})
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1 (only /anime/ series links count)", len(results))
	}
	first := results[0]
	if first["title"] != "One Piece: Heroines" || first["slug"] != "one-piece-heroines" {
		t.Errorf("title/slug = %v / %v", first["title"], first["slug"])
	}
	if first["score"] != "7.58" {
		t.Errorf("score = %v", first["score"])
	}
	if first["status"] != "Completed" {
		t.Errorf("status = %v", first["status"])
	}
	if genres, _ := first["genres"].([]any); len(genres) != 4 {
		t.Errorf("genres = %v", genres)
	}
	// Episode and batch links must be skipped, not merely parsed badly.
	for _, c := range results {
		if url, _ := c["url"].(string); !strings.Contains(url, "/anime/") {
			t.Errorf("card kept a non-anime url: %v", url)
		}
	}
}

func TestSamehadakuDetailInfo(t *testing.T) {
	doc := shFixture(t, "detail.html")
	info := doc.Find(".infoanime")
	if got := Txt(info.Find(`[itemprop="ratingValue"]`).First().Text(), 12); got != "8.72" {
		t.Errorf("rating = %q, want 8.72", got)
	}
	genres := []string{}
	doc.Find(".genre-info a").Each(func(_ int, g *goquery.Selection) {
		genres = append(genres, Txt(g.Text(), 40))
	})
	if len(genres) < 7 || genres[0] != "Action" {
		t.Errorf("genres = %v", genres)
	}
	eps := 0
	doc.Find(".lstepsiode.listeps li").Each(func(_ int, el *goquery.Selection) {
		if href, ok := el.Find(".lchx a, a").First().Attr("href"); ok && href != "" {
			eps++
		}
	})
	if eps == 0 {
		t.Fatal("episode list is empty")
	}
	batch := doc.Find(".listbatch a").First()
	if href, ok := batch.Attr("href"); !ok || !strings.Contains(href, "/batch/") {
		t.Errorf("batch link = %q", href)
	}
}

func TestSamehadakuEpisodeMirrorsAndDownloads(t *testing.T) {
	doc := shFixture(t, "episode.html")
	players := shPlayerOptions(doc, false)
	if len(players) != 6 {
		t.Fatalf("players = %d, want 6", len(players))
	}
	first := players[0].(map[string]any)
	if first["nume"] != 1 || first["name"] != "Blogspot" || first["post"] != "54232" {
		t.Errorf("first player = %v", first)
	}
	if _, hasType := first["type"]; hasType {
		t.Error("episode players must not carry data-type (reference omits it)")
	}
	if typed := shPlayerOptions(doc, true); typed[0].(map[string]any)["type"] != "schtml" {
		t.Error("mirrors players must carry data-type")
	}

	groups := shDownloadGroups(doc)
	if len(groups) != 3 {
		t.Fatalf("download groups = %d, want 3 (MKV/MP4/x265)", len(groups))
	}
	labels := []string{}
	for _, g := range groups {
		labels = append(labels, g.(map[string]any)["label"].(string))
	}
	if labels[0] != "MKV" || labels[1] != "MP4" || !strings.HasPrefix(labels[2], "x265") {
		t.Errorf("labels = %v", labels)
	}
	g := groups[0].(map[string]any)
	if g["label"] != "MKV" {
		t.Errorf("label = %v", g["label"])
	}
	entries := g["entries"].([]any)
	quality := entries[0].(map[string]any)["quality"]
	if quality != "360p" {
		t.Errorf("first quality = %v", quality)
	}
	servers := entries[0].(map[string]any)["servers"].([]any)
	if len(servers) < 3 {
		t.Errorf("servers = %d, want ≥3", len(servers))
	}
}

func TestSamehadakuEpisodeNavigation(t *testing.T) {
	doc := shFixture(t, "episode-head.html")
	nav := doc.Find(".naveps .nvs")
	if nav.Length() != 3 {
		t.Fatalf("naveps children = %d, want 3", nav.Length())
	}
	if got := nav.First().Find("a").AttrOr("href", ""); shSlug(got) != "one-piece-episode-1179" {
		t.Errorf("prev = %q", got)
	}
	all := nav.Eq(1).Find("a").AttrOr("href", "")
	if shSlug(all) != "one-piece" {
		t.Errorf("anime link = %q", all)
	}
	// The next neighbour is a disabled placeholder (class `nonex`) and must not
	// be reported as a real next episode.
	last := nav.Last().Find("a")
	if !last.HasClass("nonex") {
		t.Error("expected the next slot to be a `nonex` placeholder")
	}
	if got := doc.Find("h1.entry-title").First().Text(); Txt(got, 200) != "One Piece Episode 1180 Sub Indo" {
		t.Errorf("title = %q", got)
	}
}

func TestSamehadakuBatchGroups(t *testing.T) {
	doc := shFixture(t, "batch.html")
	groups := shDownloadGroups(doc)
	if len(groups) == 0 {
		t.Fatal("no batch groups parsed")
	}
	first := groups[0].(map[string]any)
	if !strings.Contains(first["label"].(string), "One Piece Episode 1-25") {
		t.Errorf("label = %v", first["label"])
	}
	entries := first["entries"].([]any)
	if q := entries[0].(map[string]any)["quality"]; q != "360p" {
		t.Errorf("quality = %v", q)
	}
}

func TestSamehadakuSlugGuard(t *testing.T) {
	cases := map[string]string{
		"https://v2.samehadaku.how/anime/one-piece/":         "one-piece",
		"https://v2.samehadaku.how/one-piece-episode-1180/":  "one-piece-episode-1180",
		"/batch/one-piece-batch/":                            "one-piece-batch",
		"one-piece":                                          "one-piece",
		"https://v2.samehadaku.how/anime/one-piece/?x=1#top": "one-piece",
	}
	for in, want := range cases {
		if got := shSlug(in); got != want {
			t.Errorf("shSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

// The mobile API (`/wp-json/apk/*`) is JSON, so these fixtures are the raw
// responses — the pair search→episode is what turns a title into mirror embeds.
func TestSamehadakuApkFixtures(t *testing.T) {
	search, err := os.ReadFile(shFixtureDir + "/apk-search.json")
	if err != nil {
		t.Fatalf("apk search fixture: %v", err)
	}
	var results []map[string]any
	if err := json.Unmarshal(search, &results); err != nil {
		t.Fatalf("apk search fixture is not a JSON array: %v", err)
	}
	if len(results) != 8 {
		t.Fatalf("results = %d, want 8", len(results))
	}
	first := results[0]
	if first["title"] != "One Piece: Heroines" {
		t.Errorf("title = %v", first["title"])
	}
	// the id embedded in `url` is the handle for the episode call
	if id := shSlug(fmt.Sprint(first["url"])); id == "" || shDigitsOnly(fmt.Sprint(first["url"])) == "" {
		t.Errorf("url must carry the numeric id, got %v", first["url"])
	}

	ep, err := os.ReadFile(shFixtureDir + "/apk-episode.json")
	if err != nil {
		t.Fatalf("apk episode fixture: %v", err)
	}
	var rec map[string]any
	if err := json.Unmarshal(ep, &rec); err != nil {
		t.Fatalf("apk episode fixture is not a JSON object: %v", err)
	}
	if rec["episode"] != "1180" || rec["title"] != "One Piece Episode 1180" {
		t.Errorf("episode/title = %v / %v", rec["episode"], rec["title"])
	}
	players, ok := rec["player"].([]any)
	if !ok || len(players) == 0 {
		t.Fatalf("player = %v", rec["player"])
	}
	if name := players[0].(map[string]any)["title"]; name != "Blogspot " {
		t.Errorf("first player = %v", name)
	}
	if prev, _ := rec["prev"].(string); !strings.Contains(prev, "id=52740") {
		t.Errorf("prev = %q", prev)
	}
}

// Live capture (2026-10-08) of /anime/one-piece/ after the site moved to a
// Tailwind layout. Every old anchor is gone (`.infoanime`, `.whites.lsteps`,
// `.listbatch`, `#downloadb`, `[itemprop="ratingValue"]`, `img.anmsa`), so
// shDetail used to answer a hollow `{details:{}, episodes:[]}` at rc=0 while the
// TS reference raised WAF-blocked. This pins the redesigned-markup fallbacks.
func TestSamehadakuDetailLiveMarkup(t *testing.T) {
	doc := shFixture(t, "detail-live.html")
	out := shDetailFromDoc(doc, "one-piece", "https://v2.samehadaku.how/anime/one-piece/")

	if out["title"] != "One Piece Sub Indo" {
		t.Errorf("title = %v", out["title"])
	}
	if out["rating"] != "8.72" {
		t.Errorf("rating = %v", out["rating"])
	}
	if out["poster"] != "https://v2.samehadaku.how/wp-content/uploads/2020/04/E5RxYkWX0AAwdGH.png.jpg" {
		t.Errorf("poster = %v", out["poster"])
	}
	if s, _ := out["sinopsis"].(string); !strings.HasPrefix(s, "Nonton Streaming anime One Piece Sub Indo") {
		t.Errorf("sinopsis = %q", s)
	}
	genres, _ := out["genres"].([]any)
	if len(genres) != 7 || genres[0] != "Action" || genres[6] != "Super Power" {
		t.Errorf("genres = %v", genres)
	}
	details, _ := out["details"].(map[string]any)
	if len(details) != 12 {
		t.Errorf("details count = %d (%v)", len(details), details)
	}
	if details["Studio"] != "Toei Animation" || details["Status"] != "Ongoing" || details["Type"] != "TV" {
		t.Errorf("details = %v", details)
	}
	if out["episodeCount"] != 3 {
		t.Fatalf("episodeCount = %v", out["episodeCount"])
	}
	eps, _ := out["episodes"].([]any)
	first, _ := eps[0].(map[string]any)
	if first["episode"] != "1180" || first["title"] != "One Piece Episode 1180" ||
		first["url"] != "https://v2.samehadaku.how/one-piece-episode-1180/" ||
		first["date"] != "28 September 2026" {
		t.Errorf("episodes[0] = %v", first)
	}
	batches, _ := out["batches"].([]any)
	if len(batches) != 1 {
		t.Fatalf("batches = %v", batches)
	}
	if b, _ := batches[0].(map[string]any); b["url"] != "https://v2.samehadaku.how/batch/one-piece-batch-part-2/" {
		t.Errorf("batches[0] = %v", batches[0])
	}
}
