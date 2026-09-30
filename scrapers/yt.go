// yt.go — Go port of yt.ts (m.youtube.com Scraper (youtubei)).
//
// The inner API: an HTML bootstrap on m.youtube.com/ supplies the inner key, the
// client version, the visitor data and the country; every payload then POSTs to
// /youtubei/v1/{search,next,player,browse} with the MWEB client context. All
// requests go through siteRequest — guarded, host-pinned to m.youtube.com and
// deliberately NON-caching, since the inner key and the continuation tokens are
// per-response. The bootstrap page itself is fetched through the site's cache,
// exactly as the reference's fetchPage does.
//
// The reference walks responses with findAll(obj, key): depth-first, JSON
// document order, EVERY occurrence — the result arrays (search results, related
// items, playlist rows) depend on that order, and so do the "first match" picks
// (§infoPlaylist's avatar stack, §parseLockup's badges). Go maps cannot express
// document order (iteration is randomised), so responses are parsed into
// ytvNode, an ordered tree whose nil-safe accessors stand in for the reference's
// `?.` chains.
//
// `download` needs YT_ANDROID_VR_KEY; without it the command fails with the
// reference's message verbatim (yt.ts:400).
package scrapers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	ytvBase = "https://m.youtube.com"
	ytvAPI  = ytvBase + "/youtubei/v1"
	ytvUA   = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
	// The ANDROID_VR client the reference uses for the `download` stream formats.
	ytvAndroidVRVersion = "1.58.24"
	ytvAndroidVRSDK     = 30
	// ytvErrNoKey is the reference's message verbatim (yt.ts:400).
	ytvErrNoKey = "ANDROID_VR key not set — provide YT_ANDROID_VR_KEY env (legacy source had it redacted)"
)

// ytvHosts is the complete allowlist: the page, the inner API and every hop.
var ytvHosts = []string{"m.youtube.com"}

// ytvAndroidVRKey mirrors `process.env.YT_ANDROID_VR_KEY || ''`.
var ytvAndroidVRKey = os.Getenv("YT_ANDROID_VR_KEY")

var ytvSite = NewSite(SiteConfig{
	Base:    ytvBase,
	RateMS:  400,
	Headers: map[string]string{"user-agent": ytvUA, "accept-language": "en-US,en;q=0.9"},
})

// === BOOTSTRAP (inner-API config) ===

type ytvCfg struct {
	key         string
	version     string
	visitorData string
	gl          string
}

var (
	ytvInnerKeyRe = regexp.MustCompile(`INNERTUBE_API_KEY":"([^"]+)"`)
	ytvVersionRe  = regexp.MustCompile(`INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"`)
	ytvVisitorRe  = regexp.MustCompile(`visitorData":"([^"]+)"`)
	ytvGLRe       = regexp.MustCompile(`"GL":"([^"]+)"`)
)

var (
	ytvConfigMu  sync.Mutex
	ytvConfigVal *ytvCfg
)

// ytvBootstrap fetches (once) and caches the inner-API config. The mutex keeps
// the concurrent HTTP API from bootstrapping twice at the same time.
func ytvBootstrap() (*ytvCfg, error) {
	ytvConfigMu.Lock()
	defer ytvConfigMu.Unlock()
	if ytvConfigVal != nil {
		return ytvConfigVal, nil
	}
	html, err := ytvSite.Fetch(ytvBase + "/")
	if err != nil {
		return nil, err
	}
	grab := func(re *regexp.Regexp) (string, error) {
		m := re.FindStringSubmatch(html)
		if m == nil {
			pat := re.String()
			if len(pat) > 40 {
				pat = pat[:40]
			}
			return "", fmt.Errorf("bootstrap: pattern not found (%s...) — YouTube page format changed?", pat)
		}
		return m[1], nil
	}
	key, err := grab(ytvInnerKeyRe)
	if err != nil {
		return nil, err
	}
	version, err := grab(ytvVersionRe)
	if err != nil {
		return nil, err
	}
	visitor, err := grab(ytvVisitorRe)
	if err != nil {
		return nil, err
	}
	gl := "US"
	if m := ytvGLRe.FindStringSubmatch(html); m != nil {
		gl = m[1]
	}
	ytvConfigVal = &ytvCfg{key: key, version: version, visitorData: visitor, gl: gl}
	return ytvConfigVal, nil
}

// ytvMweb is the MWEB client context (`mweb()` in the reference).
func ytvMweb(cfg *ytvCfg) map[string]any {
	return map[string]any{
		"clientName":    "MWEB",
		"clientVersion": cfg.version,
		"visitorData":   cfg.visitorData,
		"hl":            "en",
		"gl":            cfg.gl,
	}
}

// === ORDERED JSON NODE ===
//
// ytvNode is one JSON value with its object members kept in document order. It
// exists only so ytvFind (the reference's findAll) can visit keys in the order
// the response spells them; every accessor is nil-receiver safe, which is how
// the reference's optional chaining is expressed here: `a?.b?.c` becomes
// `a.get("b").get("c")`.

type ytvNode struct {
	scalar  any                 // string | json.Number | bool | nil
	keys    []string            // object members in JSON document order
	members map[string]*ytvNode // non-nil for objects (possibly empty)
	items   []*ytvNode          // non-nil for arrays (possibly empty)
}

// ytvParse decodes raw JSON into an ordered tree. Numeric literals stay
// json.Number so they re-encode exactly as JSON.parse → JSON.stringify does.
func ytvParse(raw []byte) (*ytvNode, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	return ytvParseValue(dec)
}

func ytvParseValue(dec *json.Decoder) (*ytvNode, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); ok {
		switch d {
		case '{':
			return ytvParseObject(dec)
		case '[':
			return ytvParseArray(dec)
		}
		return nil, errors.New("unexpected JSON delimiter")
	}
	return &ytvNode{scalar: tok}, nil
}

func ytvParseObject(dec *json.Decoder) (*ytvNode, error) {
	n := &ytvNode{members: map[string]*ytvNode{}}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if d, ok := tok.(json.Delim); ok {
			if d == '}' {
				return n, nil
			}
			return nil, errors.New("unexpected JSON delimiter in object")
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errors.New("unexpected JSON object key")
		}
		val, err := ytvParseValue(dec)
		if err != nil {
			return nil, err
		}
		if _, seen := n.members[key]; !seen {
			n.keys = append(n.keys, key)
		}
		n.members[key] = val
	}
}

func ytvParseArray(dec *json.Decoder) (*ytvNode, error) {
	n := &ytvNode{items: []*ytvNode{}}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case ']':
				return n, nil
			case '{':
				v, err := ytvParseObject(dec)
				if err != nil {
					return nil, err
				}
				n.items = append(n.items, v)
				continue
			case '[':
				v, err := ytvParseArray(dec)
				if err != nil {
					return nil, err
				}
				n.items = append(n.items, v)
				continue
			}
			return nil, errors.New("unexpected JSON delimiter in array")
		}
		n.items = append(n.items, &ytvNode{scalar: tok})
	}
}

// isObj / isArr are exact type tests: an object is truthy even when empty.
func (n *ytvNode) isObj() bool { return n != nil && n.members != nil }
func (n *ytvNode) isArr() bool { return n != nil && n.items != nil }

// get returns the member under `key`, nil when n is not an object or the key is
// absent (TS `x?.key`).
func (n *ytvNode) get(key string) *ytvNode {
	if !n.isObj() {
		return nil
	}
	return n.members[key]
}

// raw returns the node itself, so `x || y` chains read like the reference.
func (n *ytvNode) raw() *ytvNode { return n }

// nodes returns the array elements, nil when n is not an array.
func (n *ytvNode) nodes() []*ytvNode {
	if !n.isArr() {
		return nil
	}
	return n.items
}

// truthy reports JS truthiness: objects and arrays are always truthy, while the
// empty string, 0, false and null are not.
func (n *ytvNode) truthy() bool {
	if n == nil {
		return false
	}
	if n.members != nil || n.items != nil {
		return true
	}
	switch t := n.scalar.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f, err := t.Float64()
		return err != nil || f != 0
	}
	return true
}

// str is `typeof v === 'string' ? v : ''`.
func (n *ytvNode) str() string {
	if n == nil {
		return ""
	}
	s, _ := n.scalar.(string)
	return s
}

// any converts the node back to plain decoded JSON (map[string]any / []any /
// string / json.Number / bool / nil) for the payload builder and Clean.
func (n *ytvNode) any() any {
	if n == nil {
		return nil
	}
	if n.members != nil {
		m := make(map[string]any, len(n.members))
		for _, k := range n.keys {
			m[k] = n.members[k].any()
		}
		return m
	}
	if n.items != nil {
		out := make([]any, 0, len(n.items))
		for _, it := range n.items {
			out = append(out, it.any())
		}
		return out
	}
	return n.scalar
}

// ytvFind mirrors findAll(obj, key): re-entrant depth-first search that collects
// EVERY value stored under `key`, in JSON document order. Arrays are walked in
// order, object members in document order.
func ytvFind(n *ytvNode, key string, out []*ytvNode) []*ytvNode {
	if n == nil {
		return out
	}
	if n.items != nil {
		for _, it := range n.items {
			out = ytvFind(it, key, out)
		}
		return out
	}
	if n.members == nil {
		return out
	}
	for _, k := range n.keys {
		v := n.members[k]
		if k == key {
			out = append(out, v)
			continue
		}
		out = ytvFind(v, key, out)
	}
	return out
}

// ytvFindOne is the reference's `findAll(...)[0] || {}` idiom: the first match
// as an object, an empty object when there is none.
func ytvFindOne(n *ytvNode, key string) *ytvNode {
	found := ytvFind(n, key, nil)
	if len(found) == 0 {
		return &ytvNode{}
	}
	return found[0]
}

// ytvText is `text(runs)`: the run texts joined, then trimmed.
func ytvText(runs *ytvNode) string {
	var b strings.Builder
	for _, r := range runs.nodes() {
		b.WriteString(r.get("text").str())
	}
	return strings.TrimSpace(b.String())
}

// ytvRunsText is `text(x.runs)` for an x that may be missing entirely.
func ytvRunsText(x *ytvNode) string { return ytvText(x.get("runs")) }

var ytvVideoURLRe = regexp.MustCompile(`/vi/([^/]+)/`)

// ytvThumb picks the widest thumbnail URL (`thumbnail()`), nil when the list is
// empty. Ties keep the document order, which stable sorting and a strict `>`
// comparison reproduce.
func ytvThumb(thumbs *ytvNode) any {
	items := thumbs.nodes()
	if len(items) == 0 {
		return nil
	}
	best := items[0]
	bestW := ytvNum(best.get("width"))
	for _, t := range items[1:] {
		if w := ytvNum(t.get("width")); w > bestW {
			best, bestW = t, w
		}
	}
	return best.get("url").str()
}

// ytvNum is `Number(v)`: numbers decode as json.Number, strings parse like JS
// (JSON never produces a numeric string here, but the fallback costs nothing).
func ytvNum(n *ytvNode) float64 {
	if n == nil {
		return 0
	}
	switch t := n.scalar.(type) {
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0
		}
		return f
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0
		}
		return f
	}
	return 0
}

// ytvYoutubei posts one youtubei body and returns the ordered response tree.
func ytvYoutubei(endpoint string, payload map[string]any) (*ytvNode, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	res, err := siteRequest(ytvSite, ytvAPI+"/"+endpoint+"?key="+cfg.key, http.MethodPost, body, map[string]string{
		"content-type": "application/json",
		"user-agent":   ytvUA,
		"origin":       ytvBase,
	}, false, ytvHosts)
	if err != nil {
		return nil, err
	}
	doc, derr := ytvParse(res.Body)
	if derr != nil {
		return nil, derr
	}
	if e := doc.get("error"); e.truthy() {
		if msg := e.get("message").str(); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, errors.New("youtubei error")
	}
	return doc, nil
}
