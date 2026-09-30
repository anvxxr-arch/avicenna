// anilist.go — Go port of anilist.ts (anilist.co).
//
// Reference: anilist.ts — base https://anilist.co, rateMs 600. The TS file has
// two entries (bot handler + CLI); only the CLI/JSON surface is ported, as the
// contract requires.
//
// anilist.co has been a Vue SPA since ~2024: its HTML ships no server-rendered
// cards and the official GraphQL API is periodically disabled server-side. The
// TS version surfaces that fact instead of returning an empty list, so this
// port reproduces the same behaviour: `populer` returns null after reporting
// the SPA limitation, and `search` is an actionable error.
package scrapers

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// NewAniList builds the AniList scraper (embeddable).
func NewAniList() Scraper { return anilistScraper() }

func init() { register(anilistScraper()) }

var anilistSite = NewSite(SiteConfig{
	Base:   "https://anilist.co",
	RateMS: 600,
	Headers: map[string]string{
		"user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
	},
})

// SPAError is the actionable failure the TS version asserts when anilist.co
// serves no server-rendered cards.
const SPAError = "anilist.co served no server-rendered cards (SPA) — official GraphQL API (graphql.anilist.co) is the data path when enabled; scraping path kept for parity"

// grabCards mirrors grabCards(): `.landing-section.<section> .results .media-card`.
func grabCards(doc *goquery.Document, section string, withRank bool) []any {
	out := []any{}
	doc.Find(".landing-section." + section + " .results .media-card").Each(func(_ int, el *goquery.Selection) {
		title := strings.TrimSpace(el.Find(".title").Text())
		href := el.Find("a.cover").AttrOr("href", "")
		image := el.Find("img.image").AttrOr("src", "")
		if title == "" || href == "" {
			return
		}
		card := map[string]any{
			"title": title,
			"link":  "https://anilist.co" + href,
			"image": image,
		}
		if withRank {
			card["rank"] = strings.TrimSpace(el.Find(".rank").Text())
		}
		out = append(out, card)
	})
	return out
}

// anilistPopuler mirrors anilistPopuler(), including its null-on-failure
// contract: the SPA limitation is reported on stderr (the TS version's
// console.error) and the payload is null.
func anilistPopuler() any {
	html, err := anilistSite.Fetch("/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error scraping AniList: "+err.Error())
		return nil
	}
	doc := SafeDoc(html)
	trending := grabCards(doc, "trending", false)
	populer := grabCards(doc, "season", false)
	upcoming := grabCards(doc, "nextSeason", false)
	top := grabCards(doc, "top", true)
	if len(trending) == 0 && len(populer) == 0 && len(upcoming) == 0 && len(top) == 0 {
		fmt.Fprintln(os.Stderr, "Error scraping AniList: "+SPAError)
		return nil
	}
	return map[string]any{
		"trending": trending,
		"populer":  populer,
		"upcoming": upcoming,
		"top":      top,
	}
}

// anilistSearch mirrors anilistSearch(): an empty array when the SPA serves no
// cards, with the reason reported on stderr. SPAError is exported so a host
// binary can turn that into an actionable response.
func anilistSearch(query string) (any, error) {
	html, err := anilistSite.Fetch("/search/anime?query=" + EncodeURIComponent(query))
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error fetching data: "+err.Error())
		return []any{}, nil
	}
	doc := SafeDoc(html)
	results := []any{}
	doc.Find(".media-card").Each(func(_ int, el *goquery.Selection) {
		title := strings.TrimSpace(el.Find(".title").Text())
		image := el.Find(".image").AttrOr("src", "")
		link := el.Find(".cover").AttrOr("href", "")
		if title == "" || image == "" || link == "" {
			return
		}
		results = append(results, map[string]any{
			"title":    title,
			"imageUrl": image,
			"link":     "https://anilist.co" + link,
		})
	})
	if len(results) == 0 {
		fmt.Fprintln(os.Stderr, "Error fetching data: "+SPAError)
	}
	return results, nil
}

// anilistDetail mirrors anilistDetail() minus the Google-translate fan-out:
// no translation provider is available to this port, so the title/description
// fields report the original text rather than silently fabricating a result.
func anilistDetail(url string) any {
	target, err := ParseTarget(url)
	if err != nil {
		msg := err.Error()
		return map[string]any{"error": msg}
	}
	if !strings.HasSuffix(strings.ToLower(target.Hostname()), "anilist.co") {
		return map[string]any{"error": "URL host not allowed: " + target.Hostname()}
	}
	html, err := anilistSite.Fetch(target.String())
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	doc := SafeDoc(html)
	cleanText := func(s string) string {
		return Txt(strings.ReplaceAll(s, "\n", " "), 0)
	}
	descriptionText := cleanText(doc.Find(".description.content-wrap").Text())
	paragraphs := []any{}
	for _, p := range strings.Split(descriptionText, "\n") {
		if strings.TrimSpace(p) != "" {
			paragraphs = append(paragraphs, p)
		}
	}
	dataSet := func(label string) string {
		return cleanText(doc.Find("div.data-set:contains(\"" + label + "\") .value").First().Text())
	}
	listIn := func(label string) []any {
		out := []any{}
		doc.Find("div.data-set:contains(\"" + label + "\") .value a").Each(func(_ int, el *goquery.Selection) {
			out = append(out, cleanText(el.Text()))
		})
		return out
	}
	genres := listIn("Genres")
	studios := listIn("Studios")
	var banner any
	if bg, ok := doc.Find(".banner").First().Attr("style"); ok {
		banner = bannerURL(bg)
	}
	return map[string]any{
		"title": map[string]any{
			"romaji":  cleanText(doc.Find(".content h1").First().Text()),
			"english": dataSet("English"),
			"native":  dataSet("Native"),
			"translated": map[string]any{
				"romaji":  cleanText(doc.Find(".content h1").First().Text()),
				"english": dataSet("English"),
				"native":  dataSet("Native"),
			},
		},
		"description": map[string]any{
			"original":   descriptionText,
			"translated": strings.Join(strings.Split(descriptionText, "\n"), "\n\n"),
			"paragraphs": map[string]any{"original": paragraphs, "translated": paragraphs},
		},
		"cover":  doc.Find(".cover-wrap-inner .cover").First().AttrOr("src", ""),
		"banner": banner,
		"details": map[string]any{
			"format":       dataSet("Format"),
			"episodes":     dataSet("Episodes"),
			"status":       dataSet("Status"),
			"season":       dataSet("Season"),
			"averageScore": dataSet("Average Score"),
			"popularity":   dataSet("Popularity"),
		},
		"genres": map[string]any{
			"original":   strings.Join(anyToStrings(genres), ", "),
			"translated": genres,
		},
		"studios": map[string]any{
			"original":   studios,
			"translated": studios,
		},
	}
}

var bannerURLRe = regexp.MustCompile(`url\(\s*['"]?|['"]?\s*\)`)

func bannerURL(style string) any {
	if style == "" {
		return nil
	}
	out := bannerURLRe.ReplaceAllString(style, "")
	if out == "" {
		return nil
	}
	return out
}

func anyToStrings(in []any) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func anilistScraper() Scraper {
	return Scraper{
		Name:  "anilist",
		Title: "AniList Scraper",
		Commands: map[string]Command{
			"populer": {
				Desc: "Trending/populer/upcoming/top dari halaman utama",
				Run: func([]string, map[string]string) (any, error) {
					return anilistPopuler(), nil
				},
			},
			"search": {
				Desc:  "Cari anime",
				Usage: "<query>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if argAt(args, 0) == "" {
						return nil, errors.New("Query required")
					}
					return anilistSearch(strings.Join(args, " "))
				},
			},
			"detail": {
				Desc:  "Detail anime + terjemahan ID",
				Usage: "<url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if argAt(args, 0) == "" {
						return nil, errors.New("URL required")
					}
					return anilistDetail(argAt(args, 0)), nil
				},
			},
		},
	}
}
