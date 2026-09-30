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

// ytvAndroidVRKey mirrors `process.env.YT_ANDROID_VR_KEY || ”`.
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

// str is `typeof v === 'string' ? v : ”`.
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

// === PAYLOAD BUILDERS ===
// ytvParseSearchItem mirrors parseSearchItem: one search element → one row, a
// list of rows (shelf of shorts), or nil for renderers the reference ignores.
func ytvParseSearchItem(item *ytvNode) []any {
	if v := item.get("videoWithContextRenderer"); v.isObj() {
		return []any{map[string]any{
			"type":      "video",
			"id":        v.get("videoId").any(),
			"title":     ytvText(v.get("headline").get("runs")),
			"channel":   ytvText(v.get("shortBylineText").get("runs")),
			"views":     ytvText(v.get("shortViewCountText").get("runs")),
			"thumbnail": ytvThumb(v.get("thumbnail").get("thumbnails")),
		}}
	}
	if v := item.get("compactRadioRenderer"); v.isObj() {
		return []any{map[string]any{
			"type":       "mix",
			"id":         v.get("playlistId").any(),
			"title":      ytvText(v.get("title").get("runs")),
			"videoCount": ytvText(v.get("videoCountText").get("runs")),
			"thumbnail":  ytvThumb(v.get("thumbnail").get("thumbnails")),
		}}
	}
	if v := item.get("compactPlaylistRenderer"); v.isObj() {
		return []any{map[string]any{
			"type":       "playlist",
			"id":         v.get("playlistId").any(),
			"title":      ytvText(v.get("title").get("runs")),
			"channel":    ytvText(v.get("shortBylineText").get("runs")),
			"videoCount": ytvText(v.get("videoCountText").get("runs")),
			"thumbnail":  ytvThumb(v.get("thumbnail").get("thumbnails")),
		}}
	}
	if v := item.get("compactChannelRenderer"); v.isObj() {
		return []any{map[string]any{
			"type":        "channel",
			"id":          v.get("channelId").any(),
			"title":       ytvText(v.get("title").get("runs")),
			"subscribers": ytvText(v.get("subscriberCountText").get("runs")),
			"videoCount":  ytvText(v.get("videoCountText").get("runs")),
			"thumbnail":   ytvThumb(v.get("thumbnail").get("thumbnails")),
		}}
	}
	if g := item.get("gridShelfViewModel"); g.isObj() {
		rows := []any{}
		for _, s := range ytvFind(g, "shortsLockupViewModel", nil) {
			rows = append(rows, ytvParseShort(s))
		}
		return rows
	}
	return nil
}

// ytvParseShort mirrors parseShort.
func ytvParseShort(s *ytvNode) map[string]any {
	reel := s.get("onTap").get("innertubeCommand").get("reelWatchEndpoint")
	title := any(nil)
	if acc := s.get("accessibilityText"); acc.str() != "" {
		if parts := strings.Split(acc.str(), ", "); len(parts) > 0 {
			title = parts[0]
		}
	}
	return map[string]any{
		"type":      "short",
		"id":        reel.get("videoId").any(),
		"title":     title,
		"thumbnail": ytvThumb(s.get("thumbnail").get("sources")),
	}
}

// ytvCollectItems mirrors collectItems: walk every itemSectionRenderer, in
// document order, and flatten the parsed rows.
func ytvCollectItems(json *ytvNode) []any {
	items := []any{}
	for _, sec := range ytvFind(json, "itemSectionRenderer", nil) {
		for _, item := range sec.get("contents").nodes() {
			for _, parsed := range ytvParseSearchItem(item) {
				items = append(items, parsed)
			}
		}
	}
	return items
}

// ytvThumbOf is thumbnail(x.thumbnails) for a node that carries `thumbnails`.
func ytvThumbOf(v *ytvNode) any { return ytvThumb(v.get("thumbnails")) }

// ytvViewModelText mirrors viewModelText: string | runs | simpleText | content
// | dynamicTextViewModel.text, else nil.
func ytvViewModelText(v *ytvNode) any {
	if v == nil || !v.truthy() {
		return nil
	}
	if s := v.str(); s != "" {
		return s
	}
	if v.isObj() {
		if runs := v.get("runs"); runs.isArr() {
			return ytvText(runs)
		}
		if st := v.get("simpleText"); st.truthy() {
			return st.str()
		}
		if c := v.get("content"); c.str() != "" {
			return c.str()
		}
		if dtv := v.get("dynamicTextViewModel").get("text"); dtv.truthy() {
			return ytvViewModelText(dtv)
		}
	}
	return nil
}

// ytvMetaRows is findAll(x,'metadataParts') flattened by one level and mapped
// through viewModelText, dropping nulls — the reference's `parts.map(...).filter(Boolean)`.
func ytvMetaRows(root *ytvNode) []string {
	out := []string{}
	for _, group := range ytvFind(root, "metadataParts", nil) {
		if !group.isArr() {
			continue
		}
		for _, part := range group.nodes() {
			if txt := ytvViewModelText(part.get("text")); txt != nil {
				if s, ok := txt.(string); ok {
					out = append(out, s)
				}
			}
		}
	}
	return out
}

// ytvParseLockup mirrors parseLockup (playlist grids, channel tabs).
func ytvParseLockup(v *ytvNode) map[string]any {
	md := v.get("metadata").get("lockupMetadataViewModel")
	title := md.get("title").get("content").any()
	img := v.get("contentImage").get("thumbnailViewModel").get("image")
	var badge any
	for _, o := range img.get("overlays").nodes() {
		for _, b := range o.get("thumbnailBottomOverlayViewModel").get("badges").nodes() {
			if t := b.get("thumbnailBadgeViewModel").get("text"); t.truthy() {
				badge = t.any()
				break
			}
		}
		if badge != nil {
			break
		}
	}
	stats := ytvMetaRows(md)
	pick := func(i int) any {
		if i < len(stats) {
			return stats[i]
		}
		return nil
	}
	return map[string]any{
		"type":      "video",
		"id":        v.get("contentId").any(),
		"title":     title,
		"channel":   pick(0),
		"length":    badge,
		"views":     pick(1),
		"published": pick(2),
		"thumbnail": ytvThumb(img.get("sources")),
	}
}

// ytvParsePanelVideo mirrors parsePanelVideo (mix playlist rows).
func ytvParsePanelVideo(v *ytvNode) map[string]any {
	selected := v.get("selected").any()
	if selected == nil {
		selected = false
	}
	return map[string]any{
		"type":      "video",
		"id":        v.get("videoId").any(),
		"title":     ytvRunsText(v.get("title")),
		"channel":   ytvRunsText(v.get("longBylineText")),
		"length":    ytvRunsText(v.get("lengthText")),
		"selected":  selected,
		"thumbnail": ytvThumbOf(v.get("thumbnail")),
	}
}

// ytvDetectType mirrors detectType.
func ytvDetectType(id string) string {
	switch {
	case id == "":
		return "unknown"
	case regexp.MustCompile(`^UC[\w-]{22}$`).MatchString(id):
		return "channel"
	case strings.HasPrefix(id, "RDAM"):
		return "mix"
	case strings.HasPrefix(id, "PL"), strings.HasPrefix(id, "UU"),
		strings.HasPrefix(id, "FL"), strings.HasPrefix(id, "OLAK5uy_"):
		return "playlist"
	default:
		if regexp.MustCompile(`^[\w-]{11}$`).MatchString(id) {
			return "video"
		}
		return "unknown"
	}
}

// === COMMAND IMPLEMENTATIONS ===
// ytvSearch mirrors search().
func ytvSearch(query string, page int) (map[string]any, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	if page < 1 {
		page = 1
	}
	json, err := ytvYoutubei("search", map[string]any{
		"context": map[string]any{"client": ytvMweb(cfg)},
		"query":   query,
	})
	if err != nil {
		return nil, err
	}
	for i := 1; i < page; i++ {
		commands := ytvFind(json, "continuationCommand", nil)
		if len(commands) == 0 {
			break
		}
		token := commands[len(commands)-1].get("token").str()
		if token == "" {
			break
		}
		if json, err = ytvYoutubei("search", map[string]any{
			"context":      map[string]any{"client": ytvMweb(cfg)},
			"continuation": token,
		}); err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"query":            query,
		"page":             page,
		"results":          ytvCollectItems(json),
		"estimatedResults": json.get("estimatedResults").any(),
		"hasMore":          len(ytvFind(json, "continuationCommand", nil)) > 0,
	}, nil
}

// ytvInfo mirrors info(): auto-detect the id kind and dispatch.
func ytvInfo(id string) (any, error) {
	switch ytvDetectType(id) {
	case "channel":
		return ytvInfoChannel(id)
	case "playlist":
		return ytvInfoPlaylist(id)
	case "mix":
		return ytvInfoMix(id)
	case "video":
		return ytvInfoVideo(id)
	default:
		return nil, fmt.Errorf("Cannot determine content type for id: %s", id)
	}
}

// ytvInfoVideo mirrors infoVideo().
func ytvInfoVideo(videoID string) (map[string]any, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	json, err := ytvYoutubei("player", map[string]any{
		"context":        map[string]any{"client": ytvMweb(cfg)},
		"videoId":        videoID,
		"contentCheckOk": true,
		"racyCheckOk":    true,
	})
	if err != nil {
		return nil, err
	}
	return ytvVideoPayload(json), nil
}

// ytvVideoPayload is the shared infoVideo shape.
func ytvVideoPayload(json *ytvNode) map[string]any {
	vd := json.get("videoDetails")
	mf := json.get("microformat").get("playerMicroformatRenderer")
	keywords := []any{}
	if k := vd.get("keywords"); k.isArr() {
		keywords = k.any().([]any)
	}
	isLive := vd.get("isLiveContent").any()
	if isLive == nil {
		isLive = false
	}
	return map[string]any{
		"type":            "video",
		"id":              vd.get("videoId").any(),
		"title":           vd.get("title").any(),
		"description":     vd.get("shortDescription").any(),
		"author":          vd.get("author").any(),
		"channelId":       vd.get("channelId").any(),
		"durationSeconds": int(ytvNum(vd.get("lengthSeconds"))),
		"viewCount":       vd.get("viewCount").any(),
		"keywords":        keywords,
		"isLive":          isLive,
		"isFamilySafe":    mf.get("isFamilySafe").any(),
		"category":        mf.get("category").any(),
		"publishDate":     mf.get("publishDate").any(),
		"uploadDate":      mf.get("uploadDate").any(),
		"thumbnail":       ytvThumbOf(vd.get("thumbnail")),
		"playability":     json.get("playabilityStatus").get("status").any(),
	}
}

// ytvInfoPlaylist mirrors infoPlaylist().
func ytvInfoPlaylist(id string) (map[string]any, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	json, err := ytvYoutubei("browse", map[string]any{
		"context":  map[string]any{"client": ytvMweb(cfg)},
		"browseId": "VL" + id,
	})
	if err != nil {
		return nil, err
	}
	head := json.get("header").get("pageHeaderRenderer")
	phvm := head.get("content").get("pageHeaderViewModel")
	if !phvm.isObj() {
		phvm = head
	}
	parts := ytvMetaRows(phvm)
	findIn := func(parts []string, re *regexp.Regexp) any {
		for _, p := range parts {
			if re.MatchString(p) {
				return p
			}
		}
		return nil
	}
	avatarStack := ytvFindOne(phvm, "avatarStackViewModel")
	ownerEndpoint := ytvFindOne(avatarStack, "browseEndpoint")
	ownerAvatar := ytvFindOne(avatarStack, "avatarViewModel")
	videos := []any{}
	for _, l := range ytvFind(json, "lockupViewModel", nil) {
		videos = append(videos, ytvParseLockup(l))
	}
	var channel any
	if t := ytvViewModelText(avatarStack.get("text")); t != nil {
		channel = t
	} else if len(parts) > 0 {
		channel = parts[0]
	}
	var title any
	if t := ytvViewModelText(phvm.get("title")); t != nil {
		title = t
	} else if pt := head.get("pageTitle"); pt.truthy() {
		title = pt.any()
	}
	return map[string]any{
		"type":        "playlist",
		"id":          id,
		"title":       title,
		"description": ytvViewModelText(phvm.get("description")),
		"videoCount":  findIn(parts, regexp.MustCompile(`\d+\s*videos?`)),
		"views":       findIn(parts, regexp.MustCompile(`\d[\d,]*\s*views?`)),
		"channel":     channel,
		"channelId":   ownerEndpoint.get("browseId").any(),
		"avatar":      ytvThumb(ownerAvatar.get("image").get("sources")),
		"thumbnail":   ytvThumb(ytvFindOne(phvm, "thumbnailViewModel").get("image").get("sources")),
		"videos":      videos,
	}, nil
}

// ytvInfoMix mirrors infoMix().
func ytvInfoMix(id string) (map[string]any, error) {
	seed := ""
	if strings.HasPrefix(id, "RDAMPL") {
		pl, err := ytvInfoPlaylist(id[6:])
		if err != nil {
			return nil, err
		}
		if videos, ok := pl["videos"].([]any); ok && len(videos) > 0 {
			if row, ok := videos[0].(map[string]any); ok {
				if s, ok := row["id"].(string); ok {
					seed = s
				}
			}
		}
	} else if len(id) > 7 {
		seed = id[7:]
	}
	if seed == "" {
		return nil, errors.New("Unable to resolve seed video for mix.")
	}
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	json, err := ytvYoutubei("next", map[string]any{
		"context":    map[string]any{"client": ytvMweb(cfg)},
		"videoId":    seed,
		"playlistId": id,
	})
	if err != nil {
		return nil, err
	}
	pls := json.get("contents").get("singleColumnWatchNextResults").get("playlist").get("playlist")
	videos := []any{}
	for _, c := range pls.get("contents").nodes() {
		if row := c.get("playlistPanelVideoRenderer"); row.isObj() {
			videos = append(videos, ytvParsePanelVideo(row))
		}
	}
	title := any("Mix")
	if t := pls.get("title"); t.truthy() {
		title = t.any()
	}
	return map[string]any{"type": "mix", "id": id, "title": title, "videos": videos}, nil
}

// ytvInfoChannel mirrors infoChannel().
func ytvInfoChannel(id string) (map[string]any, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	json, err := ytvYoutubei("browse", map[string]any{
		"context":  map[string]any{"client": ytvMweb(cfg)},
		"browseId": id,
	})
	if err != nil {
		return nil, err
	}
	meta := ytvFindOne(json, "channelMetadataRenderer")
	header := ytvFindOne(json, "pageHeaderViewModel")
	if !header.isObj() {
		header = ytvFindOne(json, "pageHeaderRenderer")
	}
	rows := ytvMetaRows(header)
	var title any
	if t := ytvViewModelText(header.get("title")); t != nil {
		title = t
	} else if pt := header.get("pageTitle"); pt.truthy() {
		if s := ytvText(pt); s != "" {
			title = s
		}
	} else if t := ytvViewModelText(meta.get("title")); t != nil {
		title = t
	}
	var handle any
	for _, r := range rows {
		if strings.HasPrefix(r, "@") {
			handle = r
			break
		}
	}
	img := header.get("image").get("thumbnailViewModel").get("image")
	var description any
	if d := ytvViewModelText(header.get("description")); d != nil {
		description = d
	} else if d := ytvViewModelText(meta.get("description")); d != nil {
		description = d
	}
	var keywords any
	if k := meta.get("keywords").str(); k != "" {
		keywords = splitKeywords(k)
	}
	var url any
	if v := meta.get("vanityChannelUrl").any(); v != nil {
		url = v
	} else if owners := meta.get("ownerUrls").nodes(); len(owners) > 0 {
		url = owners[0].any()
	}
	avatar := ytvThumbOf(meta.get("avatar"))
	if avatar == nil {
		avatar = ytvThumb(img.get("sources"))
	}
	out := map[string]any{
		"type":        "channel",
		"id":          id,
		"title":       title,
		"description": description,
		"avatar":      avatar,
		"handle":      handle,
		"stats":       toAnySlice(rows),
		"url":         url,
	}
	if fs := meta.get("isFamilySafe").any(); fs != nil {
		out["isFamilySafe"] = fs
	} else {
		out["isFamilySafe"] = nil
	}
	out["keywords"] = keywords
	out["country"] = meta.get("country").any()
	return out, nil
}
func splitKeywords(s string) []any {
	parts := regexp.MustCompile(`,\s*`).Split(s, -1)
	out := make([]any, 0, len(parts))
	for _, p := range parts {
		out = append(out, p)
	}
	return out
}
func toAnySlice(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}

// ytvRelated mirrors related().
func ytvRelated(videoID string) (map[string]any, error) {
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	json, err := ytvYoutubei("next", map[string]any{
		"context": map[string]any{"client": ytvMweb(cfg)},
		"videoId": videoID,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"videoId": videoID, "results": ytvCollectItems(json)}, nil
}

// ytvDownload mirrors download(); stream URLs are volatile, so the payload is
// returned as-is (the CLI contract, not a cacheable shape).
func ytvDownload(videoID string) (map[string]any, error) {
	if ytvAndroidVRKey == "" {
		return nil, errors.New(ytvErrNoKey)
	}
	cfg, err := ytvBootstrap()
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"context": map[string]any{"client": map[string]any{
			"clientName":        "ANDROID_VR",
			"clientVersion":     ytvAndroidVRVersion,
			"androidSdkVersion": ytvAndroidVRSDK,
			"hl":                "en",
			"gl":                cfg.gl,
		}},
		"videoId":        videoID,
		"contentCheckOk": true,
		"racyCheckOk":    true,
	}
	res, err := siteRequest(ytvSite, ytvAPI+"/player?key="+ytvAndroidVRKey, http.MethodPost, ytvMustJSON(payload), map[string]string{
		"content-type":      "application/json",
		"user-agent":        ytvUA,
		"origin":            ytvBase,
		"x-goog-visitor-id": cfg.visitorData,
	}, false, ytvHosts)
	if err != nil {
		return nil, err
	}
	json, derr := ytvParse(res.Body)
	if derr != nil {
		return nil, derr
	}
	if e := json.get("error"); e.truthy() {
		if msg := e.get("message").str(); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, errors.New("youtubei error")
	}
	if !json.get("streamingData").truthy() {
		ps := json.get("playabilityStatus")
		reason := ps.get("reason").str()
		if reason == "" {
			reason = ps.get("status").str()
		}
		if reason == "" {
			reason = "Streaming unavailable."
		}
		return nil, errors.New(reason)
	}
	vd := json.get("videoDetails")
	sd := json.get("streamingData")
	formats := []any{}
	for _, group := range []*ytvNode{sd.get("formats"), sd.get("adaptiveFormats")} {
		for _, f := range group.nodes() {
			if !f.get("url").truthy() {
				continue
			}
			mime := f.get("mimeType").str()
			codec := strings.SplitN(mime, ";", 2)[0]
			quality := ""
			if w := ytvNum(f.get("width")); w != 0 {
				quality = fmt.Sprintf("%dx%d", int(w), int(ytvNum(f.get("height"))))
			} else if aq := f.get("audioQuality").str(); aq != "" {
				quality = aq
			}
			label := codec
			if quality != "" {
				label += " " + quality
			}
			container := strings.SplitN(mime, "/", 2)[0]
			formats = append(formats, map[string]any{
				"itag":         f.get("itag").any(),
				"container":    container,
				"codecs":       anyOrNil(mime),
				"label":        label,
				"bitrate":      f.get("bitrate").any(),
				"width":        f.get("width").any(),
				"height":       f.get("height").any(),
				"audioQuality": f.get("audioQuality").any(),
				"url":          f.get("url").any(),
			})
		}
	}
	title := any(nil)
	if t := vd.get("title"); t.truthy() {
		title = t.any()
	}
	author := any(nil)
	if a := vd.get("author"); a.truthy() {
		author = a.any()
	}
	return map[string]any{
		"id":               vd.get("videoId").any(),
		"title":            title,
		"author":           author,
		"durationSeconds":  int(ytvNum(vd.get("lengthSeconds"))),
		"expiresInSeconds": sd.get("expiresInSeconds").any(),
		"formats":          formats,
	}, nil
}
func anyOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ytvMustJSON marshals a payload; the caller builds plain maps only.
func ytvMustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// === CLI SURFACE ===
func ytScraper() Scraper {
	return Scraper{
		Name:  "yt",
		Title: "m.youtube.com Scraper (youtubei)",
		Commands: map[string]Command{
			"search": {
				Name: "search", Desc: "Search videos", Usage: "<query> [page]",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Query required")
					}
					return ytvSearch(strings.Join(args, " "), 1)
				},
			},
			"info": {
				Name: "info", Desc: "Details (video/playlist/channel/mix — auto-detected)", Usage: "<id>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Id required")
					}
					return ytvInfo(args[0])
				},
			},
			"related": {
				Name: "related", Desc: "Related videos", Usage: "<videoId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("videoId required")
					}
					return ytvRelated(args[0])
				},
			},
			"download": {
				Name: "download", Desc: "Stream formats (needs YT_ANDROID_VR_KEY)", Usage: "<videoId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("videoId required")
					}
					return ytvDownload(args[0])
				},
			},
		},
	}
}
func init() { register(ytScraper()) }
