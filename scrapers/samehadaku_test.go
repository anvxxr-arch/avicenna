// samehadaku_test.go — offline parser coverage for the Samehadaku port.
//
// The live site sits behind a Cloudflare managed challenge, so plain HTTP
// clients cannot reach it. These tests run the port's parsers over
// tools/fixtures/samehadaku/*.html — real captures of the pages (trimmed to the
// blocks each parser reads) — and pin the fields a live run would produce.
package scrapers

import (
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
	doc.Find("article.animpost").Each(func(_ int, el *goquery.Selection) {
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
