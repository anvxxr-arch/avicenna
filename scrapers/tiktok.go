// tiktok.go — Go port of tiktok.ts (TikTok Scraper).
//
// Page HTML plus the embedded JSON payloads (#__UNIVERSAL_DATA_FOR_REHYDRATION__
// and #api-data), with the mobile UA and the cookie/webid session the reference
// sends.
//
// Host pinning: www.tiktok.com plus the short-link domains vm./vt.tiktok.com for
// the redirect hop they legitimately need. Downloads additionally reach TikTok's
// own CDN hosts, which are named explicitly and privately guarded.
package scrapers

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	tiktokBaseURL  = "https://www.tiktok.com"
	tiktokUAMobile = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

// tiktokHosts is the complete allowlist for page fetches, including the
// short-link domains that redirect onto www.tiktok.com.
var tiktokHosts = []string{"www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"}

// tiktokCDNHosts are TikTok's own media/CDN hosts, named explicitly. Nothing
// outside this list can be downloaded from.
var tiktokCDNHosts = []string{
	"v16-webapp.tiktokcdn.com",
	"v16-webapp-prime.tiktokcdn.com",
	"v16-webapp-prime.tiktokcdn-us.com",
	"v16-webapp.tiktokcdn-us.com",
	"v19-webapp-prime.tiktokcdn.com",
	"v19-default.tiktokcdn.com",
	"v19.tiktokcdn.com",
	"v16m-default.tiktokcdn.com",
	"v16m.tiktokcdn.com",
	"v9-default.tiktokcdn.com",
	"v9.tiktokcdn.com",
	"p16-sign-va.tiktokcdn.com",
	"p16-sign-sg.tiktokcdn.com",
	"p16-sign.tiktokcdn.com",
	"p16-common-sign.tiktokcdn.com",
	"p16-common-sign-va.tiktokcdn.com",
	"p16-common-sign.tiktokcdn-us.com",
}

// tiktokWebID is the tt_webid_v2/ttwid value the reference generates per process.
var tiktokWebID = "7" + strconv.FormatInt(1000000000000000+rand.Int64N(9000000000000000), 10)

var tiktokSite = NewSite(SiteConfig{
	Base:   tiktokBaseURL,
	RateMS: 700,
	Headers: map[string]string{
		"user-agent":      tiktokUAMobile,
		"accept-language": "id-ID,id;q=0.9,en;q=0.8",
		"accept":          "text/html,application/xhtml+xml,application/json",
		"referer":         tiktokBaseURL + "/",
		"cookie":          tiktokCookieHeader(),
	},
})

// tiktokCookieHeader is the static session cookie the reference sends on every
// request. The msToken padding is verbatim (107 'x'), never logged.
func tiktokCookieHeader() string {
	return "tt_webid_v2=" + tiktokWebID + "; ttwid=" + tiktokWebID + "; msToken=" + strings.Repeat("x", 107)
}

// ciMap is a case-insensitive view over a decoded JSON object. JSON keys differ
// in case between the embed payloads (webapp.user-detail vs WebappUserDetail),
// and the TS reference reads them with `as Record` + direct indexing, so the
// lookup has to be case-insensitive to keep parity.
type ciMap map[string]any

func (m ciMap) get(key string) any {
	if v, ok := m[key]; ok {
		return v
	}
	lk := strings.ToLower(key)
	for k, v := range m {
		if strings.ToLower(k) == lk {
			return v
		}
	}
	return nil
}

// ciObj wraps a value as a case-insensitive object, nil when it is not one.
func ciObj(v any) ciMap {
	if m, ok := v.(map[string]any); ok {
		return ciMap(m)
	}
	return nil
}

// tiktokGrabCookies renders the Set-Cookie headers of a response as one
// Cookie header value, deduplicated by the first `name=value` part.
func tiktokGrabCookies(h map[string][]string) string {
	parts := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, raw := range h["Set-Cookie"] {
		part := strings.TrimSpace(strings.SplitN(raw, ";", 2)[0])
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		parts = append(parts, part)
	}
	return strings.Join(parts, "; ")
}

// tiktokFetchPage GETs a page (following the short-link redirects) and returns
// the final response's cookies plus its HTML.
func tiktokFetchPage(rawURL string) (string, string, error) {
	res, err := siteRequest(tiktokSite, rawURL, "GET", nil, map[string]string{
		"user-agent":      tiktokUAMobile,
		"accept-language": "id-ID,id;q=0.9,en;q=0.8",
		"accept":          "text/html,application/xhtml+xml,application/json",
		"referer":         tiktokBaseURL + "/",
		"cookie":          tiktokCookieHeader(),
	}, true, tiktokHosts)
	if err != nil {
		return "", "", err
	}
	cookies := tiktokGrabCookies(map[string][]string(res.Header))
	if res.Status < 200 || res.Status >= 300 {
		return cookies, "", fmt.Errorf("HTTP %d for %s", res.Status, res.URL)
	}
	return cookies, string(res.Body), nil
}

var (
	tiktokAPIDataRe   = regexp.MustCompile(`(?is)<script[^>]*\bid=["']api-data["'][^>]*>(.*?)</script>`)
	tiktokUniversalRe = regexp.MustCompile(`(?is)<script[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>(.*?)</script>`)
)

func tiktokScriptObject(html string, re *regexp.Regexp) map[string]any {
	m := re.FindStringSubmatch(html)
	if m == nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(m[1]), &out); err != nil {
		return nil
	}
	return out
}

// tiktokParseAPIData reads the #api-data script payload.
func tiktokParseAPIData(html string) map[string]any {
	return tiktokScriptObject(html, tiktokAPIDataRe)
}

// tiktokParseUniversal reads the #__UNIVERSAL_DATA_FOR_REHYDRATION__ payload.
func tiktokParseUniversal(html string) map[string]any {
	return tiktokScriptObject(html, tiktokUniversalRe)
}

// tiktokCleanVideoURL swaps the watermarked /playwm/ segment for /play/.
func tiktokCleanVideoURL(url string) any {
	if url == "" {
		return nil
	}
	if strings.Contains(url, "/playwm/") {
		return strings.Replace(url, "/playwm/", "/play/", 1)
	}
	return url
}

// tiktokTakeAvatar reads the first URL out of {urlList:[...]} or a bare string.
func tiktokTakeAvatar(avatar any) any {
	if !jbool(avatar) {
		return nil
	}
	if s, ok := avatar.(string); ok {
		return s
	}
	a := obj(avatar)
	if list := arr(a["urlList"]); len(list) > 0 {
		if url, ok := list[0].(string); ok {
			return url
		}
	}
	return nil
}

// tiktokTakeURL mirrors takeUrl(): `[{url}]` takes the LAST element's url, a
// bare string is returned as-is.
func tiktokTakeURL(v any) any {
	if list, ok := v.([]any); ok {
		if len(list) == 0 {
			return nil
		}
		last := list[len(list)-1]
		if m, ok := last.(map[string]any); ok {
			if url, ok := m["url"].(string); ok {
				return url
			}
		}
		return nil
	}
	if s, ok := v.(string); ok {
		return s
	}
	return nil
}

// strOf renders any decoded JSON scalar the way JS `String(v)` would.
func strOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		return strconv.FormatBool(t)
	}
	return ""
}

// tiktokExtractVideo shapes one itemStruct (webapp.user-detail itemInfo form).
func tiktokExtractVideo(item ciMap) map[string]any {
	if item == nil {
		return nil
	}
	video := ciObj(item.get("video"))
	author := ciObj(item.get("author"))
	stats := ciObj(item.get("stats"))
	music := ciObj(item.get("music"))
	if video == nil {
		video = ciMap{}
	}
	if author == nil {
		author = ciMap{}
	}
	if stats == nil {
		stats = ciMap{}
	}
	if music == nil {
		music = ciMap{}
	}
	// playAddr/downloadAddr are `string` on most responses and `[{url}]` on
	// others; both (and null) are legal, so takeUrl narrows them.
	play := tiktokTakeURL(video.get("playAddr"))
	download := tiktokTakeURL(video.get("downloadAddr"))
	var cover any
	for _, c := range []any{video.get("cover"), video.get("dynamicCover"), video.get("originCover")} {
		if jbool(c) {
			cover = c
			break
		}
	}
	if s, ok := cover.(string); ok {
		cover = s
	} else if cover != nil {
		if list := arr(obj(cover)["urlList"]); len(list) > 0 {
			cover = list[0]
		} else {
			cover = nil
		}
	}
	var avatar any
	if a := tiktokTakeAvatar(author.get("avatarLarger")); jbool(a) {
		avatar = a
	} else if a := tiktokTakeAvatar(author.get("avatarThumb")); jbool(a) {
		avatar = a
	}
	return map[string]any{
		"id":            strOf(item.get("id")),
		"desc":          jstr(item.get("desc")),
		"createTime":    jnum(item.get("createTime")),
		"author":        jstr(author.get("uniqueId")),
		"nickname":      jstr(author.get("nickname")),
		"avatar":        avatar,
		"signature":     jstr(author.get("signature")),
		"verified":      jbool(author.get("verified")),
		"cover":         cover,
		"duration":      jnum(video.get("duration")),
		"playCount":     jnum(stats.get("playCount")),
		"likeCount":     jnum(stats.get("diggCount")),
		"commentCount":  jnum(stats.get("commentCount")),
		"shareCount":    jnum(stats.get("shareCount")),
		"collectCount":  jnum(stats.get("collectCount")),
		"music":         jstr(music.get("title")),
		"musicUrl":      jstr(music.get("playUrl")),
		"noWatermark":   firstTruthy(tiktokCleanVideoURL(jstr(play)), tiktokCleanVideoURL(jstr(download))),
		"withWatermark": firstTruthy(tiktokCleanVideoURL(jstr(download)), tiktokCleanVideoURL(jstr(play))),
	}
}

// tiktokVideoIDRe matches the canonical video URL shape.
var tiktokVideoIDRe = regexp.MustCompile(`/video/(\d{10,})`)

// tiktokVideoURLRe is the canonical shape a video page fetch must have:
// https://www.tiktok.com/video/<digits> (a query string is allowed —
// ?is_copy=1 is how share links arrive).
var tiktokVideoURLRe = regexp.MustCompile(`^https://www\.tiktok\.com/video/\d{10,}(\?[^#\s]*)?(#.*)?$`)

// tiktokShortLinkRe is the short-link shape a fetch may start from:
// https://vm.tiktok.com/<token> or https://vt.tiktok.com/<token>. The token is
// a single path segment (one trailing slash tolerated, as share links carry
// it) — internal slashes mean traversal/subpath and are out.
var tiktokShortLinkRe = regexp.MustCompile(`^https://(?:vm|vt)\.tiktok\.com/[A-Za-z0-9._-]+/?(\?[^#\s]*)?(#.*)?$`)

// tiktokValidateVideoURL pins a caller-supplied video URL to the two shapes the
// fetcher can actually handle — a canonical www.tiktok.com/video/<id> page or a
// vm./vt. short link. The TS reference (tiktok.ts getVideo) fetches the
// caller's URL as-is and relies only on the site's host pin; that pin is a
// registrable-domain rule, so e.g. www.tiktok.com.evil.com passes it. The
// allowlist in tiktokFetchPage (vm./vt. hosts) then rejects the fetch with a
// generic "External host rejected" — and a crafted Location on a short link
// could redirect the fetch to any host on that allowlist. Pinning the shape
// first makes the rejection happen before any request and makes it specific.
func tiktokValidateVideoURL(raw string) error {
	u := strings.TrimSpace(raw)
	if tiktokVideoURLRe.MatchString(u) || tiktokShortLinkRe.MatchString(u) {
		return nil
	}
	return fmt.Errorf("URL tidak valid: harus https://www.tiktok.com/video/<id> atau https://vm.tiktok.com/<link> (dapat %s)", u)
}

// tiktokExtractIDFromURL mirrors extractIdFromUrl().
func tiktokExtractIDFromURL(url string) any {
	m := tiktokVideoIDRe.FindStringSubmatch(url)
	if m == nil {
		return nil
	}
	return m[1]
}

// tiktokResolveShortLink follows a vm./vt. link one hop, validating the target.
func tiktokResolveShortLink(url string) string {
	if !tiktokShortLinkRe.MatchString(url) {
		return url
	}
	// vm./vt. hosts redirect onto www.tiktok.com — validate the hop explicitly
	// (the same allowlist is re-checked inside siteRequest).
	res, err := siteRequest(tiktokSite, url, "GET", nil, map[string]string{
		"user-agent": tiktokUAMobile,
		"accept":     "*/*",
	}, false, tiktokHosts)
	if err != nil || res == nil {
		return url
	}
	loc := res.Header.Get("Location")
	if loc == "" || !IsValidURL(loc) {
		return url
	}
	return loc
}

// tiktokSortedKeys gives Object.values a deterministic order (JSON object order
// is not preserved by encoding/json, and the reference takes the first match).
func tiktokSortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// tiktokFindItemStruct depth-first search for itemInfo.itemStruct.
func tiktokFindItemStruct(v any, depth int) ciMap {
	if depth > 4 || !jbool(v) {
		return nil
	}
	m := obj(v)
	if m == nil {
		return nil
	}
	if ii := obj(m["itemInfo"]); ii != nil {
		if is := obj(ii["itemStruct"]); is != nil {
			return ciMap(is)
		}
	}
	if vd := obj(m["videoDetail"]); vd != nil {
		if ii := obj(vd["itemInfo"]); ii != nil {
			if is := obj(ii["itemStruct"]); is != nil {
				return ciMap(is)
			}
		}
	}
	for _, k := range tiktokSortedKeys(m) {
		if found := tiktokFindItemStruct(m[k], depth+1); found != nil {
			return found
		}
	}
	return nil
}

// tiktokGetVideo returns the video payload (or an error payload).
func tiktokGetVideo(url string) (map[string]any, error) {
	if err := tiktokValidateVideoURL(url); err != nil {
		return nil, err
	}
	fullURL := tiktokResolveShortLink(url)
	videoID := tiktokExtractIDFromURL(fullURL)
	cookies, html, err := tiktokFetchPage(fullURL)
	if err != nil {
		return nil, err
	}
	item := tiktokFindItemStruct(tiktokParseAPIData(html), 0)
	if item == nil {
		item = tiktokFindItemStruct(tiktokParseUniversal(html), 0)
	}
	var info map[string]any
	if item != nil {
		info = tiktokExtractVideo(item)
	}
	if info == nil {
		return map[string]any{
			"error": "video tidak ditemukan (kemungkinan kena rate-limit)",
			"url":   fullURL,
		}, nil
	}
	if info["id"] == "" && videoID != nil {
		info["id"] = videoID
	}
	info["pageUrl"] = fullURL
	info["sessionCookies"] = cookies
	return info, nil
}

var tiktokUsernameRe = regexp.MustCompile(`^[a-zA-Z0-9._]{1,30}$`)
var tiktokQueryTailRe = regexp.MustCompile(`[?#].*$`)

// tiktokGetUser returns a profile payload.
func tiktokGetUser(username string) (map[string]any, error) {
	clean := strings.TrimSpace(tiktokQueryTailRe.ReplaceAllString(strings.TrimPrefix(strings.TrimSpace(username), "@"), ""))
	if !tiktokUsernameRe.MatchString(clean) {
		return nil, errors.New("Invalid username")
	}
	_, html, err := tiktokFetchPage(tiktokBaseURL + "/@" + clean)
	if err != nil {
		return nil, err
	}
	// The user payload rides two different scopes depending on which bot-filter
	// band the request lands in.
	var userData ciMap
	if uni := tiktokParseUniversal(html); uni != nil {
		if scope := obj(uni["__DEFAULT_SCOPE__"]); scope != nil {
			for _, k := range tiktokSortedKeys(scope) {
				v := obj(scope[k])
				if ui := obj(v["userInfo"]); ui != nil && obj(ui["user"]) != nil {
					userData = ciMap(ui)
					break
				}
			}
		}
	}
	if userData == nil {
		if api := tiktokParseAPIData(html); api != nil {
			if ud := obj(api["userDetail"]); ud != nil {
				if ui := obj(ud["userInfo"]); ui != nil {
					userData = ciMap(ui)
				}
			}
		}
	}
	if userData == nil {
		return map[string]any{"error": "profil tidak ditemukan", "username": clean}, nil
	}
	user := ciObj(userData.get("user"))
	stats := ciObj(userData.get("stats"))
	if user == nil {
		user = ciMap{}
	}
	if stats == nil {
		stats = ciMap{}
	}
	totalLikes := firstTruthy(stats.get("heartCount"), stats.get("heart"), user.get("heartCount"), 0)
	var avatar any
	if a := tiktokTakeAvatar(user.get("avatarLarger")); jbool(a) {
		avatar = a
	} else if a := tiktokTakeAvatar(user.get("avatarThumb")); jbool(a) {
		avatar = a
	}
	usernameOut := firstTruthy(jstr(user.get("uniqueId")), clean)
	videos := jnum(stats.get("videoCount"))
	if videos == 0 {
		videos = jnum(user.get("videoCount"))
	}
	return map[string]any{
		"username":    usernameOut,
		"nickname":    jstr(user.get("nickname")),
		"avatar":      avatar,
		"bio":         jstr(user.get("signature")),
		"verified":    jbool(user.get("verified")),
		"private":     jbool(user.get("privateAccount")),
		"followers":   jnum(stats.get("followerCount")),
		"following":   jnum(stats.get("followingCount")),
		"hearts":      jnum(totalLikes),
		"likesCount":  jnum(totalLikes),
		"videosCount": videos,
		"secUid":      jstr(user.get("secUid")),
	}, nil
}

// tiktokDownloadVideo fetches the no-watermark MP4 to disk and reports it.
func tiktokDownloadVideo(url, nama string) (map[string]any, error) {
	info, err := tiktokGetVideo(url)
	if err != nil {
		return nil, err
	}
	noWM := jstr(info["noWatermark"])
	if noWM == "" {
		return nil, errors.New("gagal ambil link video")
	}
	if !IsValidURL(noWM) {
		return nil, errors.New("video URL blocked by guards")
	}
	file := nama
	if file == "" {
		if id := jstr(info["id"]); id != "" {
			file = id + ".mp4"
		} else {
			file = "video.mp4"
		}
	}
	dir := filepath.Dir(file)
	if dir != "." && dir != "" {
		if _, serr := os.Stat(dir); serr != nil {
			if merr := os.MkdirAll(dir, 0o755); merr != nil {
				return nil, merr
			}
		}
	}
	// CDN download: explicitly allowlisted TikTok hosts only, redirects stay
	// inside that allowlist, media content-type is expected.
	res, derr := siteRequestMedia(tiktokSite, noWM, map[string]string{
		"user-agent": tiktokUAMobile,
		"referer":    firstTruthy(jstr(info["pageUrl"]), tiktokBaseURL+"/").(string),
		"cookie":     jstr(info["sessionCookies"]),
		"accept":     "video/mp4,*/*",
	}, tiktokCDNHosts)
	if derr != nil {
		return nil, derr
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("download HTTP %d", res.Status)
	}
	if werr := os.WriteFile(file, res.Body, 0o644); werr != nil {
		return nil, werr
	}
	return map[string]any{"status": "ok", "file": file, "id": jstr(info["id"]), "desc": jstr(info["desc"])}, nil
}

// tiktokScraper builds the CLI surface.
func tiktokScraper() Scraper {
	return Scraper{
		Name:  "tiktok",
		Title: "TikTok Scraper",
		Commands: map[string]Command{
			"video": {
				Name: "video", Desc: "Info video (stats, no-watermark URL)", Usage: "<url>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Video URL required")
					}
					return tiktokGetVideo(args[0])
				},
			},
			"user": {
				Name: "user", Desc: "Profil user (stats)", Usage: "<username>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Username required")
					}
					return tiktokGetUser(args[0])
				},
			},
			"download": {
				Name: "download", Desc: "Download video no-watermark", Usage: "<url> [nama.mp4]",
				// writes the video file to a caller-named local path: CLI only.
				LocalOnly: true,
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Video URL required")
					}
					nama := ""
					if len(args) > 1 {
						nama = args[1]
					}
					res, err := tiktokDownloadVideo(args[0], nama)
					if err != nil {
						return nil, err
					}
					return map[string]any{"status": "ok", "file": res["file"]}, nil
				},
			},
		},
	}
}

// init registers the scraper with the package registry (scrapers.All/Find).
func init() { register(tiktokScraper()) }
