// clean.go — the TS `clean()` helper shared by the HTML scrapers.
//
// Every ported site funnels its payload through this before encoding: nil and
// empty-array leaves are dropped, empty objects collapse to nil, so the JSON
// shape matches the TypeScript CLI byte for byte (it never emits
// `"field": null` where the TS version omits the key, nor `[]`).
package scrapers

import (
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// Clean recursively drops nil values, empty arrays and objects that end up
// empty. Arrays keep their order; non-empty scalars pass through untouched.
func Clean(v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case []any:
		out := make([]any, 0, len(t))
		for _, e := range t {
			c := Clean(e)
			if c == nil {
				continue
			}
			if arr, ok := c.([]any); ok && len(arr) == 0 {
				continue
			}
			out = append(out, c)
		}
		if len(out) == 0 {
			return nil
		}
		return out
	case []map[string]any:
		arr := make([]any, 0, len(t))
		for _, e := range t {
			arr = append(arr, any(e))
		}
		return Clean(arr)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			c := Clean(e)
			if c == nil {
				continue
			}
			if arr, ok := c.([]any); ok && len(arr) == 0 {
				continue
			}
			out[k] = c
		}
		if len(out) == 0 {
			return nil
		}
		return out
	default:
		return v
	}
}

// ScraperEnvelope wraps a payload the way every ported CLI does:
// `{creator, page, url, data}` with empty branches cleaned away.
func ScraperEnvelope(creator, page, url string, data map[string]any) map[string]any {
	out := Clean(map[string]any{"creator": creator, "page": page, "url": url, "data": data})
	if m, ok := out.(map[string]any); ok {
		return m
	}
	return map[string]any{"creator": creator, "page": page, "url": url}
}

// TxtSel is JS `$(el).text().trim()` for a goquery selection.
func TxtSel(sel *goquery.Selection) string {
	if sel == nil || sel.Length() == 0 {
		return ""
	}
	return strings.TrimSpace(sel.Text())
}

// CollapseWhitespace mirrors JS `.replace(/\s+/g,' ').trim()`.
func CollapseWhitespace(s string) string {
	return strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
}

// ParseIntJS mirrors JS `parseInt(s, 10)`: leading whitespace and an optional
// sign, then digits up to the first non-digit; ok=false when nothing parses
// (JS `NaN`). Needed because the sites carry half-episode links like
// "Episode 1004.5", which parseInt folds to 1004.
func ParseIntJS(s string) (int, bool) {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	neg := false
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		neg = s[i] == '-'
		i++
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(s[start:i])
	if err != nil {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
