// view_page_source.go — Go port of view-page-source.ts.
//
// Reference: view-page-source.ts — base https://www.view-page-source.com,
// rateMs 400. `token` fetches /api/token and validates the token format;
// `view` fetches a caller-supplied (off-site) URL through the site's API,
// writes the HTML locally and returns its metadata.
package scrapers

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// NewViewPageSource builds the View-Page-Source scraper (embeddable).
func NewViewPageSource() Scraper { return viewPageSourceScraper() }

func init() { register(viewPageSourceScraper()) }

var viewPageSourceSite = NewSite(SiteConfig{
	Base:   "https://www.view-page-source.com",
	RateMS: 400,
	Headers: map[string]string{
		"user-agent":      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
		"accept":          "application/json, text/plain, */*",
		"accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
	},
})

var tokenRe = regexp.MustCompile(`^[a-f0-9]{16,128}$`)

// getToken fetches and validates a fresh API token.
func getToken() (string, error) {
	raw, err := viewPageSourceSite.FetchRaw("/api/token")
	if err != nil {
		return "", err
	}
	parsed, err := DecodeObject(string(raw))
	if err != nil {
		return "", err
	}
	token := GetStr(parsed, "token")
	if token == "" || !tokenRe.MatchString(token) {
		return "", errors.New("Token API returned invalid token")
	}
	return token, nil
}

// fetchSource POSTs the target URL + token and returns the rendered source.
func fetchSource(target, token string) (map[string]any, error) {
	body, err := JSONStringify(map[string]any{"url": target, "token": token, "stylize": false})
	if err != nil {
		return nil, err
	}
	raw, err := viewPageSourceSite.PostJSON("/api/fetch", body, "")
	if err != nil {
		return nil, err
	}
	parsed, err := DecodeObject(raw)
	if err != nil {
		return nil, err
	}
	html, _ := parsed["html"].(string)
	if html == "" {
		return nil, errors.New("Fetch API returned no HTML")
	}
	out := map[string]any{"html": html, "metrics": nil, "serverInfo": nil, "pageInfo": nil}
	if v, ok := parsed["metrics"]; ok && v != nil {
		out["metrics"] = v
	}
	if v, ok := parsed["serverInfo"]; ok && v != nil {
		out["serverInfo"] = v
	}
	if v, ok := parsed["pageInfo"]; ok && v != nil {
		out["pageInfo"] = v
	}
	return out, nil
}

// buildMeta extracts the title, meta tags and links from rendered HTML.
func buildMeta(html, target string) map[string]any {
	doc := SafeDoc(html)
	var title any
	if t := Txt(doc.Find("title").First().Text(), 500); t != "" {
		title = t
	}
	meta := map[string]any{}
	doc.Find("meta[name], meta[property], meta[itemprop]").Each(func(_ int, sel *goquery.Selection) {
		key := ""
		if v, ok := sel.Attr("name"); ok && v != "" {
			key = v
		} else if v, ok := sel.Attr("property"); ok && v != "" {
			key = v
		} else if v, ok := sel.Attr("itemprop"); ok && v != "" {
			key = v
		}
		if key == "" {
			return
		}
		if content, ok := sel.Attr("content"); ok && content != "" {
			meta[key] = content
		}
	})
	seen := map[string]bool{}
	links := []any{}
	doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
		href, ok := sel.Attr("href")
		if !ok || href == "" || skipLinkRe.MatchString(href) || seen[href] {
			return
		}
		seen[href] = true
		links = append(links, href)
	})
	return map[string]any{"url": target, "title": title, "meta": meta, "links": links}
}

var skipLinkRe = regexp.MustCompile(`^(mailto:|javascript:|#)`)

// viewPageSource mirrors the TS command body.
func viewPageSource(target string) (any, error) {
	// target is intentionally off-site — validate scheme + block private hosts directly
	u, err := ParseTarget(target)
	if err != nil {
		switch {
		case errors.Is(err, ErrBlockedScheme):
			return nil, errors.New("Target must be http(s)")
		case errors.Is(err, ErrBlockedHost):
			return nil, errors.New("Private/loopback targets blocked")
		default:
			return nil, errors.New("Target must be a valid URL")
		}
	}
	target = u.String()
	token, err := getToken()
	if err != nil {
		return nil, err
	}
	result, err := fetchSource(target, token)
	if err != nil {
		return nil, err
	}
	html, _ := result["html"].(string)
	sum := md5.Sum([]byte(target))
	id := hex.EncodeToString(sum[:])[:8]
	file := fmt.Sprintf("source_%s.html", id)
	if err := os.WriteFile(file, []byte(html), 0o644); err != nil {
		return nil, err
	}
	return map[string]any{
		"id":         id,
		"saved":      file,
		"bytes":      len(html),
		"metrics":    result["metrics"],
		"serverInfo": result["serverInfo"],
		"pageInfo":   result["pageInfo"],
		"meta":       buildMeta(html, target),
	}, nil
}

func viewPageSourceScraper() Scraper {
	return Scraper{
		Name:  "viewpagesource",
		Title: "View-Page-Source Scraper",
		Commands: map[string]Command{
			"view": {
				// writes source_<hash>.html next to the process: CLI only.
				LocalOnly: true,
				Desc:      "Fetch rendered source of a URL, save + return meta",
				Usage:     "<url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					url := argAt(args, 0)
					if strings.TrimSpace(url) == "" {
						return nil, errors.New("Target URL required")
					}
					return viewPageSource(url)
				},
			},
			"token": {
				Desc: "Fetch a fresh API token",
				Run: func([]string, map[string]string) (any, error) {
					token, err := getToken()
					if err != nil {
						return nil, err
					}
					return map[string]any{"token": token}, nil
				},
			},
		},
	}
}
