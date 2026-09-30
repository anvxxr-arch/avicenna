// ytmusic.go — Go port of ytmusic.ts (YouTube Music Scraper).
//
// youtubei/v1 POSTs with the WEB_REMIX client context. The API key is optional:
// an empty key is accepted for WEB_REMIX (see the note in the TS reference).
//
// Host pinning: music.youtube.com only — the API, the page that carries the
// player script, and every redirect hop.
package scrapers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	ytmBase          = "https://music.youtube.com"
	ytmAPI           = ytmBase + "/youtubei/v1"
	ytmClientVersion = "1.20260804.16.00"
	ytmUserAgent     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)

// ytmHosts is the complete allowlist for every YouTube Music request.
var ytmHosts = []string{"music.youtube.com"}

// ytmFilters are the server-side search filter params (the filter is applied by
// the API, not by post-filtering the client-side result list).
var ytmFilters = map[string]string{
	"songs":     "EgWKAQIIAWoMEA4QChADEAQQCRAF",
	"videos":    "EgWKAQIQAWoMEA4QChADEAQQCRAF",
	"albums":    "EgWKAQIYAWoMEA4QChADEAQQCRAF",
	"artists":   "EgWKAQIgAWoMEA4QChADEAQQCRAF",
	"playlists": "Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo%3D",
}

var ytmTypeByLabel = map[string]string{
	"Song": "song", "Video": "video", "Album": "album", "EP": "album", "Single": "album",
	"Artist": "artist", "Playlist": "playlist", "Profile": "profile", "Podcast": "podcast", "Episode": "episode",
}

var ytmTypeByShelf = map[string]string{
	"Songs": "song", "Videos": "video", "Albums": "album", "Artists": "artist",
	"Community playlists": "playlist", "Featured playlists": "playlist",
	"Profiles": "profile", "Podcasts": "podcast", "Episodes": "episode",
}

// ytmAPIKey mirrors `process.env.YTM_API_KEY || ”`.
var ytmAPIKey = os.Getenv("YTM_API_KEY")

var ytmSite = NewSite(SiteConfig{
	Base:    ytmBase,
	RateMS:  400,
	Headers: map[string]string{"user-agent": ytmUserAgent},
})

// ytmPost posts one youtubei body and returns the decoded response object.
func ytmPost(endpoint string, body map[string]any) (map[string]any, error) {
	payload := map[string]any{
		"context": map[string]any{
			"client": map[string]any{
				"clientName": "WEB_REMIX", "clientVersion": ytmClientVersion,
				"hl": "en", "gl": "US", "userAgent": ytmUserAgent,
			},
		},
	}
	for k, v := range body {
		payload[k] = v
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	target := ytmAPI + "/" + endpoint + "?key=" + ytmAPIKey + "&prettyPrint=false"
	res, rerr := siteRequest(ytmSite, target, http.MethodPost, raw, map[string]string{
		"content-type":             "application/json",
		"user-agent":               ytmUserAgent,
		"x-youtube-client-name":    "67",
		"x-youtube-client-version": ytmClientVersion,
		"origin":                   ytmBase,
		"referer":                  ytmBase + "/",
	}, false, ytmHosts)
	if rerr != nil {
		return nil, rerr
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("Request failed (%d)", res.Status)
	}
	out, derr := apiDecodeMap(res.Body)
	if derr != nil {
		return nil, derr
	}
	return out, nil
}

// === JSON path helpers with TS `undefined` semantics ===

// ytRuns returns the `runs` array at `keys` (empty when absent).
func ytRuns(o any, keys ...string) []any {
	a := mlist(o, append(append([]string{}, keys...), "runs")...)
	if a == nil {
		return []any{}
	}
	return a
}

// ytText concatenates run texts (each missing `text` contributes "").
func ytText(runs []any) string {
	var b strings.Builder
	for _, r := range runs {
		b.WriteString(mstr(r, "text"))
	}
	return b.String()
}

// ytRunText is asRuns + runsToText in one step.
func ytRunText(o any, keys ...string) string { return ytText(ytRuns(o, keys...)) }

// ytThumbs mirrors getThumbnails(): the first of four shapes that is an array.
func ytThumbs(renderer any) []any {
	r := obj(renderer)
	var thumbs []any
	if t := mlist(r, "musicThumbnailRenderer", "thumbnail", "thumbnails"); t != nil {
		thumbs = t
	} else if t := mlist(r, "thumbnail", "thumbnails"); t != nil {
		thumbs = t
	} else if t := arr(mget(r, "thumbnails")); t != nil {
		thumbs = t
	}
	if thumbs == nil {
		return []any{}
	}
	out := []any{}
	for _, t := range thumbs {
		out = append(out, mget(t, "url"))
	}
	return out
}

// ytVideoID mirrors getVideoId().
func ytVideoID(item any) any {
	it := obj(item)
	flex := mlist(it, "flexColumns")
	var flex0 any
	if len(flex) > 0 {
		flex0 = flex[0]
	}
	runs := ytRuns(obj(mget(flex0, "musicResponsiveListItemFlexColumnRenderer")), "text")
	if len(runs) > 0 {
		if id := mstr(runs[0], "navigationEndpoint", "watchEndpoint", "videoId"); id != "" {
			return id
		}
	}
	for _, mi := range ytArrOrEmpty(it, "menu", "items") {
		if id := mstr(mi, "menuServiceItemRenderer", "serviceEndpoint", "queueAddEndpoint", "queueTarget", "videoId"); id != "" {
			return id
		}
	}
	return nilIfEmpty(mstr(it, "navigationEndpoint", "watchEndpoint", "videoId"))
}

// ytBrowseID mirrors getBrowseId().
func ytBrowseID(item any) any {
	it := obj(item)
	if id := mstr(it, "navigationEndpoint", "browseEndpoint", "browseId"); id != "" {
		return id
	}
	for _, mi := range ytArrOrEmpty(it, "menu", "items") {
		if id := mstr(mi, "menuServiceItemRenderer", "serviceEndpoint", "browseEndpoint", "browseId"); id != "" {
			return id
		}
	}
	return nil
}

// ytFlexColumn returns flexColumns[i].musicResponsiveListItemFlexColumnRenderer.
func ytFlexColumn(item any, i int) map[string]any {
	flex := mlist(item, "flexColumns")
	if i >= len(flex) {
		return nil
	}
	return obj(mget(flex[i], "musicResponsiveListItemFlexColumnRenderer"))
}

// ytFixedColumn returns fixedColumns[i].musicResponsiveListItemFixedColumnRenderer.
func ytFixedColumn(item any, i int) map[string]any {
	fixed := mlist(item, "fixedColumns")
	if i >= len(fixed) {
		return nil
	}
	return obj(mget(fixed[i], "musicResponsiveListItemFixedColumnRenderer"))
}

// ytArtists mirrors getArtists(): subtitle runs whose browseId starts with UC.
func ytArtists(item any) []any {
	runs := ytRuns(ytFlexColumn(item, 1), "text")
	out := []any{}
	for _, r := range runs {
		id := mstr(r, "navigationEndpoint", "browseEndpoint", "browseId")
		if strings.HasPrefix(id, "UC") {
			out = append(out, map[string]any{"name": mget(r, "text"), "id": id})
		}
	}
	return out
}

// ytAlbum mirrors getAlbum(): the first subtitle run browsing to an MPREb id.
func ytAlbum(item any) any {
	runs := ytRuns(ytFlexColumn(item, 1), "text")
	for _, r := range runs {
		id := mstr(r, "navigationEndpoint", "browseEndpoint", "browseId")
		if strings.HasPrefix(id, "MPREb") {
			return map[string]any{"name": mget(r, "text"), "id": id}
		}
	}
	return nil
}

var ytPlaysRe = regexp.MustCompile(`(?i)plays|views`)

// ytPlays mirrors getPlays().
func ytPlays(flex []any) any {
	var third any
	if len(flex) > 2 {
		third = flex[2]
	}
	t := ytText(ytRuns(obj(mget(third, "musicResponsiveListItemFlexColumnRenderer")), "text"))
	if ytPlaysRe.MatchString(t) {
		return t
	}
	return nil
}

// ytParseTrack shapes a track row.
func ytParseTrack(item any) map[string]any {
	if !jbool(item) {
		return nil
	}
	it := obj(item)
	flex := ytArrOrEmpty(it, "flexColumns")
	return map[string]any{
		"title":    ytText(ytRuns(ytFlexColumn(it, 0), "text")),
		"artists":  ytArtists(it),
		"album":    ytAlbum(it),
		"duration": ytText(ytRuns(ytFixedColumn(it, 0), "text")),
		"plays":    ytPlays(flex),
		"videoId":  ytVideoID(it),
	}
}

var ytDurationRe = regexp.MustCompile(`\d+:\d+$`)

// ytParseSearchItem shapes one search row; nil when the node is not a list item.
func ytParseSearchItem(item any, shelfType any) map[string]any {
	if !jbool(item) {
		return nil
	}
	it := obj(item)
	flex := ytArrOrEmpty(it, "flexColumns")
	title := ytText(ytRuns(ytFlexColumn(it, 0), "text"))
	subtitle := ytText(ytRuns(ytFlexColumn(it, 1), "text"))
	resultType := shelfType
	if !jbool(resultType) {
		resultType = nilIfEmptyMap(ytmTypeByLabel, strings.Split(subtitle, " • ")[0])
	}
	duration := any(ytText(ytRuns(ytFixedColumn(it, 0), "text")))
	if !jbool(duration) {
		if jstr(resultType) == "song" && ytDurationRe.MatchString(subtitle) {
			parts := strings.Split(subtitle, " • ")
			duration = parts[len(parts)-1]
		} else {
			duration = nil
		}
	}
	var videoID, browseID any
	if t := jstr(resultType); t == "song" || t == "video" {
		videoID = ytVideoID(it)
	}
	switch jstr(resultType) {
	case "album", "artist", "playlist":
		browseID = ytBrowseID(it)
	}
	artists := []any{}
	if jstr(resultType) == "song" {
		artists = ytArtists(it)
	}
	return map[string]any{
		"resultType": resultType,
		"title":      title,
		"subtitle":   subtitle,
		"videoId":    videoID,
		"browseId":   browseID,
		"artists":    artists,
		"plays":      ytPlays(flex),
		"duration":   duration,
		"thumbnails": ytThumbs(mget(it, "thumbnail")),
	}
}

// ytParseTopResult shapes the "Top result" card.
func ytParseTopResult(card any) map[string]any {
	c := obj(card)
	subtitle := ytText(ytRuns(c, "subtitle"))
	parts := strings.Split(subtitle, " • ")
	titleRuns := ytRuns(c, "title")
	var firstTitleRun any
	if len(titleRuns) > 0 {
		firstTitleRun = titleRuns[0]
	}
	onTap := firstObj(c["onTap"], mget(firstTitleRun, "navigationEndpoint"))
	songs := []any{}
	for _, x := range ytArrOrEmpty(c, "contents") {
		if p := ytParseSearchItem(mget(x, "musicResponsiveListItemRenderer"), nil); p != nil {
			songs = append(songs, p)
		}
	}
	return map[string]any{
		"category":   "Top result",
		"resultType": nilIfEmptyMap(ytmTypeByLabel, parts[0]),
		"title":      ytText(titleRuns),
		"subtitle":   subtitle,
		"videoId":    nilIfEmpty(mstr(onTap, "watchEndpoint", "videoId")),
		"browseId":   nilIfEmpty(mstr(onTap, "browseEndpoint", "browseId")),
		"thumbnails": ytThumbs(mget(c, "thumbnail")),
		"songs":      songs,
	}
}

// ytSearch posts a server-filtered search; `filter` is one of ytmFilters
// (checked here) or "".
func ytSearch(query, filter string) (map[string]any, error) {
	body := map[string]any{"query": query}
	if params, ok := ytmFilters[filter]; ok && filter != "" {
		body["params"] = params
	}
	js, err := ytmPost("search", body)
	if err != nil {
		return nil, err
	}
	tabs := ytArrOrEmpty(mget(js, "contents", "tabbedSearchResultsRenderer"), "tabs")
	var tab0 map[string]any
	if len(tabs) > 0 {
		tab0 = obj(mget(tabs[0], "tabRenderer"))
	}
	var sections []any
	if tab0 != nil {
		if content := obj(tab0["content"]); content != nil {
			sections = ytArrOrEmpty(content, "sectionListRenderer", "contents")
		}
	}
	if sections == nil {
		sections = []any{}
	}
	results := []any{}
	for _, section := range sections {
		if card := obj(mget(section, "musicCardShelfRenderer")); card != nil {
			results = append(results, ytParseTopResult(card))
			continue
		}
		shelf := obj(mget(section, "musicShelfRenderer"))
		var shelfType any
		if shelf != nil {
			shelfType = nilIfEmptyMap(ytmTypeByShelf, ytText(ytRuns(shelf, "title")))
		}
		items := mlist(shelf, "contents")
		if items == nil {
			items = mlist(section, "itemSectionRenderer", "contents")
		}
		if items == nil {
			items = []any{}
		}
		for _, item := range items {
			parsed := ytParseSearchItem(mget(item, "musicResponsiveListItemRenderer"), shelfType)
			if parsed == nil {
				continue
			}
			results = append(results, parsed)
		}
	}
	label := "all"
	if filter != "" {
		if _, ok := ytmFilters[filter]; ok {
			label = filter
		}
	}
	return map[string]any{"query": query, "filter": label, "count": len(results), "results": results}, nil
}

// ytInfo dispatches on the browseId prefix.
func ytInfo(browseID string) (map[string]any, error) {
	js, err := ytmPost("browse", map[string]any{"browseId": browseID})
	if err != nil {
		return nil, err
	}
	switch {
	case strings.HasPrefix(browseID, "MPREb"):
		return ytParseAlbum(js), nil
	case strings.HasPrefix(browseID, "UC"):
		return ytParseArtist(js, browseID), nil
	case strings.HasPrefix(browseID, "VL"), strings.HasPrefix(browseID, "PL"):
		return ytParsePlaylist(js), nil
	}
	return nil, fmt.Errorf("Unsupported browseId: %s", browseID)
}

// ytHeader mirrors getHeader().
func ytHeader(js any) map[string]any {
	two := obj(mget(js, "contents", "twoColumnBrowseResultsRenderer"))
	tabs := ytArrOrEmpty(two, "tabs")
	var tab0 any
	if len(tabs) > 0 {
		tab0 = tabs[0]
	}
	sections := ytArrOrEmpty(mget(tab0, "tabRenderer", "content"), "sectionListRenderer", "contents")
	for _, key := range []string{"musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer"} {
		for _, s := range sections {
			if h := obj(mget(s, key)); h != nil {
				return h
			}
		}
	}
	return nil
}

// ytSecondarySections mirrors getSecondarySections().
func ytSecondarySections(js any) []any {
	two := obj(mget(js, "contents", "twoColumnBrowseResultsRenderer"))
	return ytArrOrEmpty(two, "secondaryContents", "sectionListRenderer", "contents")
}

// ytShelfItems flattens track rows out of secondary sections.
func ytShelfItems(sections []any) []any {
	out := []any{}
	for _, s := range sections {
		if items := mlist(s, "musicShelfRenderer", "contents"); items != nil {
			out = append(out, items...)
			continue
		}
		if items := mlist(s, "musicPlaylistShelfRenderer", "contents"); items != nil {
			out = append(out, items...)
		}
	}
	return out
}

func ytParseAlbum(js any) map[string]any {
	header := ytHeader(js)
	subtitle := strings.Split(ytText(ytRuns(header, "subtitle")), " • ")
	tracks := []any{}
	for _, c := range ytShelfItems(ytSecondarySections(js)) {
		if t := ytParseTrack(mget(c, "musicResponsiveListItemRenderer")); t != nil {
			tracks = append(tracks, t)
		}
	}
	year := any(nil)
	if len(subtitle) > 1 {
		year = subtitle[1]
	}
	return map[string]any{
		"type":        "album",
		"title":       ytText(ytRuns(header, "title")),
		"artist":      ytText(ytRuns(header, "straplineTextOne")),
		"year":        year,
		"description": ytText(ytRuns(header, "description")),
		"thumbnails":  ytThumbs(mget(header, "thumbnail")),
		"trackCount":  len(tracks),
		"tracks":      tracks,
	}
}

func ytParsePlaylist(js any) map[string]any {
	header := ytHeader(js)
	tracks := []any{}
	for _, c := range ytShelfItems(ytSecondarySections(js)) {
		if t := ytParseTrack(mget(c, "musicResponsiveListItemRenderer")); t != nil {
			tracks = append(tracks, t)
		}
	}
	return map[string]any{
		"type":        "playlist",
		"title":       ytText(ytRuns(header, "title")),
		"description": ytText(ytRuns(header, "description")),
		"stats":       ytText(ytRuns(header, "secondSubtitle")),
		"thumbnails":  ytThumbs(mget(header, "thumbnail")),
		"trackCount":  len(tracks),
		"tracks":      tracks,
	}
}

func ytParseCarousel(carousel any) map[string]any {
	c := obj(carousel)
	title := ytText(ytRuns(mget(c, "header", "musicCarouselShelfBasicHeaderRenderer"), "title"))
	items := []any{}
	for _, x := range ytArrOrEmpty(c, "contents") {
		item := firstObj(mget(x, "musicTwoRowItemRenderer"), mget(x, "musicMultiRowListItemRenderer"))
		if item == nil {
			continue
		}
		items = append(items, map[string]any{
			"title":      ytText(ytRuns(item, "title")),
			"subtitle":   ytText(ytRuns(item, "subtitle")),
			"browseId":   nilIfEmpty(mstr(item, "navigationEndpoint", "browseEndpoint", "browseId")),
			"videoId":    nilIfEmpty(mstr(item, "navigationEndpoint", "watchEndpoint", "videoId")),
			"thumbnails": ytThumbs(mget(item, "thumbnailRenderer")),
		})
	}
	return map[string]any{"title": title, "items": items}
}

func ytParseArtist(js any, browseID string) map[string]any {
	// `singleColumnBrowseResultsRenderer.tabs` is an array; the first tab's
	// content carries the sections.
	tabs := ytArrOrEmpty(js, "contents", "singleColumnBrowseResultsRenderer", "tabs")
	var tab0 any
	if len(tabs) > 0 {
		tab0 = tabs[0]
	}
	sections := ytArrOrEmpty(mget(tab0, "tabRenderer", "content"), "sectionListRenderer", "contents")
	var songsShelf map[string]any
	for _, s := range sections {
		if sh := obj(mget(s, "musicShelfRenderer")); sh != nil {
			songsShelf = sh
			break
		}
	}
	songs := []any{}
	for _, c := range ytArrOrEmpty(songsShelf, "contents") {
		if t := ytParseTrack(mget(c, "musicResponsiveListItemRenderer")); t != nil {
			songs = append(songs, t)
		}
	}
	var descShelf map[string]any
	for _, s := range sections {
		if sh := obj(mget(s, "musicDescriptionShelfRenderer")); sh != nil {
			descShelf = sh
			break
		}
	}
	// The artist's own name is the one attached to a song that lists this UC id.
	var name any
	for _, s := range songs {
		for _, a := range ytArrOrEmpty(s, "artists") {
			if mstr(a, "id") == browseID {
				name = mget(a, "name")
				break
			}
		}
		if name != nil {
			break
		}
	}
	if !jbool(name) {
		if n := ytText(ytRuns(descShelf, "header")); n != "" {
			name = n
		} else {
			name = nil
		}
	}
	carousels := []any{}
	for _, s := range sections {
		if car := obj(mget(s, "musicCarouselShelfRenderer")); car != nil {
			carousels = append(carousels, ytParseCarousel(car))
		}
	}
	return map[string]any{
		"type":        "artist",
		"name":        name,
		"description": ytText(ytRuns(descShelf, "description")),
		"views":       nilIfEmpty(ytText(ytRuns(descShelf, "subheader"))),
		"songs":       songs,
		"sections":    carousels,
	}
}

// ytLyrics fetches (possibly synced) lyrics; depth>0 stops the fallback chain.
func ytLyrics(videoID string, depth int) (map[string]any, error) {
	js, err := ytmPost("next", map[string]any{"videoId": videoID, "isAudioOnly": true})
	if err != nil {
		return nil, err
	}
	watch := obj(mget(js, "contents", "singleColumnMusicWatchNextResultsRenderer", "tabbedRenderer"))
	tabs := ytArrOrEmpty(watch, "watchNextTabbedResultsRenderer", "tabs")
	var lyricsTab any
	for _, t := range tabs {
		cfg := mget(t, "tabRenderer", "endpoint", "browseEndpoint", "browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig")
		if mstr(cfg, "pageType") == "MUSIC_PAGE_TYPE_TRACK_LYRICS" {
			lyricsTab = t
			break
		}
	}
	lyricsBrowseID := mstr(lyricsTab, "tabRenderer", "endpoint", "browseEndpoint", "browseId")
	if lyricsBrowseID == "" {
		if depth > 0 {
			return map[string]any{"videoId": videoID, "lyrics": nil, "source": nil}, nil
		}
		return ytLyricsFallback(videoID)
	}
	lyricsJSON, lerr := ytmPost("browse", map[string]any{"browseId": lyricsBrowseID})
	if lerr != nil {
		return nil, lerr
	}
	contents := ytArrOrEmpty(lyricsJSON, "contents", "sectionListRenderer", "contents")
	var shelf map[string]any
	for _, s := range contents {
		if sh := obj(mget(s, "musicDescriptionShelfRenderer")); sh != nil {
			shelf = sh
			break
		}
	}
	if text := ytText(ytRuns(shelf, "description")); text != "" {
		return map[string]any{"videoId": videoID, "lyrics": text, "source": nilIfEmpty(ytText(ytRuns(shelf, "footer")))}, nil
	}
	if depth > 0 {
		return map[string]any{"videoId": videoID, "lyrics": nil, "source": nil}, nil
	}
	return ytLyricsFallback(videoID)
}

var ytParenTailRe = regexp.MustCompile(`\s*\([^)]*\)\s*$`)

// ytFindSongVideoID resolves an official "song" upload for a music video id.
func ytFindSongVideoID(videoID string) (string, error) {
	js, err := ytmPost("next", map[string]any{"videoId": videoID, "isAudioOnly": true})
	if err != nil {
		return "", err
	}
	watch := obj(mget(js, "contents", "singleColumnMusicWatchNextResultsRenderer", "tabbedRenderer"))
	tabs := ytArrOrEmpty(watch, "watchNextTabbedResultsRenderer", "tabs")
	var tab0 map[string]any
	if len(tabs) > 0 {
		tab0 = obj(mget(tabs[0], "tabRenderer"))
	}
	queue := obj(mget(tab0, "content", "musicQueueRenderer", "content", "playlistPanelRenderer"))
	contents := ytArrOrEmpty(queue, "contents")
	var track map[string]any
	for _, c := range contents {
		if pv := obj(mget(c, "playlistPanelVideoRenderer")); pv != nil && jbool(pv["selected"]) {
			track = pv
			break
		}
	}
	if track == nil {
		var c0 any
		if len(contents) > 0 {
			c0 = contents[0]
		}
		track = obj(mget(c0, "playlistPanelVideoRenderer"))
	}
	title := ytParenTailRe.ReplaceAllString(ytText(ytRuns(track, "title")), "")
	artistName := ytText(ytRuns(track, "shortBylineText"))
	query := strings.TrimSpace(title + " " + artistName)
	if query == "" {
		return "", nil
	}
	res, serr := ytSearch(query, "songs")
	if serr != nil {
		return "", serr
	}
	for _, r := range arr(res["results"]) {
		ro := obj(r)
		if jstr(ro["resultType"]) == "song" && jbool(ro["videoId"]) && jstr(ro["videoId"]) != videoID {
			return jstr(ro["videoId"]), nil
		}
	}
	return "", nil
}

// ytLyricsFallback retries lyrics against the official song upload.
func ytLyricsFallback(videoID string) (map[string]any, error) {
	songID, err := ytFindSongVideoID(videoID)
	if err != nil {
		return nil, err
	}
	if songID == "" {
		return map[string]any{"videoId": videoID, "lyrics": nil, "source": nil}, nil
	}
	resolved, rerr := ytLyrics(songID, 1)
	if rerr != nil {
		return nil, rerr
	}
	if jbool(resolved["lyrics"]) {
		return map[string]any{"videoId": videoID, "lyrics": resolved["lyrics"], "source": resolved["source"]}, nil
	}
	return map[string]any{"videoId": videoID, "lyrics": nil, "source": nil}, nil
}

// ytRelated returns the "Up next" queue for a video.
func ytRelated(videoID string) (map[string]any, error) {
	js, err := ytmPost("next", map[string]any{"playlistId": "RDAMVM" + videoID, "isAudioOnly": true})
	if err != nil {
		return nil, err
	}
	watch := obj(mget(js, "contents", "singleColumnMusicWatchNextResultsRenderer", "tabbedRenderer"))
	tabs := ytArrOrEmpty(watch, "watchNextTabbedResultsRenderer", "tabs")
	var queueTab any
	for _, t := range tabs {
		if mstr(t, "tabRenderer", "title") == "Up next" {
			queueTab = t
			break
		}
	}
	queue := obj(mget(queueTab, "tabRenderer", "content", "musicQueueRenderer", "content", "playlistPanelRenderer"))
	tracks := []any{}
	for _, c := range ytArrOrEmpty(queue, "contents") {
		v := obj(mget(c, "playlistPanelVideoRenderer"))
		if v == nil {
			continue
		}
		artists := []any{}
		for _, r := range ytRuns(v, "longBylineText") {
			id := mstr(r, "navigationEndpoint", "browseEndpoint", "browseId")
			if strings.HasPrefix(id, "UC") {
				artists = append(artists, map[string]any{"name": mget(r, "text"), "id": id})
			}
		}
		t := map[string]any{
			"title":      ytText(ytRuns(v, "title")),
			"artists":    artists,
			"duration":   ytText(ytRuns(v, "lengthText")),
			"selected":   jbool(v["selected"]),
			"thumbnails": ytThumbs(mget(v, "thumbnail")),
		}
		putIfPresent(t, v, "videoId", "videoId")
		tracks = append(tracks, t)
	}
	return map[string]any{"videoId": videoID, "count": len(tracks), "tracks": tracks}, nil
}

var (
	ytPlayerJSPathRe = regexp.MustCompile(`/s/player/[^"']*base\.js`)
	ytSigTimestampRe = regexp.MustCompile(`signatureTimestamp:(\d+)`)
	ytmSigMu         = make(chan struct{}, 1)
	ytmSigStamp      int64
	ytmSigSet        bool
)

// ytSignatureTimestamp scrapes the player script's signatureTimestamp.
func ytSignatureTimestamp() (int64, error) {
	ytmSigMu <- struct{}{}
	defer func() { <-ytmSigMu }()
	if ytmSigSet {
		return ytmSigStamp, nil
	}
	html, err := ytmSite.Fetch(ytmBase + "/")
	if err != nil {
		return 0, err
	}
	playerJS := ytPlayerJSPathRe.FindString(html)
	if playerJS == "" {
		return 0, errors.New("Unable to locate player script")
	}
	res, rerr := siteRequest(ytmSite, ytmBase+playerJS, http.MethodGet, nil, map[string]string{"user-agent": ytmUserAgent}, false, ytmHosts)
	if rerr != nil {
		return 0, rerr
	}
	if res.Status < 200 || res.Status >= 300 {
		return 0, fmt.Errorf("Request failed (%d)", res.Status)
	}
	stamp := int64(0)
	if m := ytSigTimestampRe.FindStringSubmatch(string(res.Body)); m != nil {
		if n, perr := strconv.ParseInt(m[1], 10, 64); perr == nil {
			stamp = n
		}
	}
	ytmSigStamp, ytmSigSet = stamp, true
	return stamp, nil
}

// ytParseCipher mirrors parseCipher() (URLSearchParams over the cipher string).
func ytParseCipher(cipher any) any {
	if !jbool(cipher) {
		return nil
	}
	vals, err := url.ParseQuery(jstr(cipher))
	if err != nil {
		return map[string]any{"url": nil, "sp": nil, "s": nil}
	}
	get := func(k string) any {
		if vs, ok := vals[k]; ok && len(vs) > 0 {
			return vs[0]
		}
		return nil
	}
	return map[string]any{"url": get("url"), "sp": get("sp"), "s": get("s")}
}

// ytParseFormat shapes one stream format entry.
func ytParseFormat(f map[string]any) map[string]any {
	mimeType := any(nil)
	if s, ok := f["mimeType"].(string); ok {
		mimeType = strings.Split(s, ";")[0]
	}
	return map[string]any{
		"itag":         firstTruthy(f["itag"]),
		"mimeType":     mimeType,
		"bitrate":      firstTruthy(f["bitrate"], f["averageBitrate"]),
		"quality":      firstTruthy(f["quality"]),
		"audioQuality": firstTruthy(f["audioQuality"]),
		"contentLength": func() any {
			if jbool(f["contentLength"]) {
				return jnumAny(f["contentLength"])
			}
			return nil
		}(),
		"url":    firstTruthy(f["url"]),
		"cipher": ytParseCipher(firstTruthy(f["signatureCipher"], f["cipher"])),
	}
}

// ytDownload returns the audio/video stream formats for a video id.
func ytDownload(videoID string, depth int) (map[string]any, error) {
	stamp, err := ytSignatureTimestamp()
	if err != nil {
		return nil, err
	}
	js, perr := ytmPost("player", map[string]any{
		"videoId": videoID, "contentCheckOk": true, "racyCheckOk": true,
		"playbackContext": map[string]any{"contentPlaybackContext": map[string]any{"signatureTimestamp": stamp}},
	})
	if perr != nil {
		return nil, perr
	}
	status := mstr(js, "playabilityStatus", "status")
	if status != "OK" {
		if depth == 0 {
			if songID, ferr := ytFindSongVideoID(videoID); ferr == nil && songID != "" {
				if resolved, derr := ytDownload(songID, 1); derr == nil && jstr(resolved["status"]) == "OK" {
					resolved["videoId"] = videoID
					return resolved, nil
				}
			}
		}
		ps := obj(js["playabilityStatus"])
		if ps == nil {
			ps = map[string]any{}
		}
		return map[string]any{
			"videoId": videoID,
			"status":  nilIfEmpty(status),
			"reason":  firstTruthy(ps["reason"], nilIfEmpty(ytText(ytRuns(mget(ps, "errorScreen", "playerErrorMessageRenderer"), "reason")))),
		}, nil
	}
	sd := obj(js["streamingData"])
	if sd == nil {
		sd = map[string]any{}
	}
	formats := append(append([]any{}, ytArrOrEmpty(sd, "formats")...), ytArrOrEmpty(sd, "adaptiveFormats")...)
	audio := []any{}
	video := []any{}
	for _, fv := range formats {
		f := obj(fv)
		kind := jstr(f["mimeType"])
		switch {
		case strings.HasPrefix(kind, "audio"):
			audio = append(audio, ytParseFormat(f))
		case strings.HasPrefix(kind, "video"):
			video = append(video, ytParseFormat(f))
		}
	}
	vd := obj(js["videoDetails"])
	if vd == nil {
		vd = map[string]any{}
	}
	out := map[string]any{
		"videoId":       videoID,
		"artist":        firstTruthy(vd["author"]),
		"lengthSeconds": jnumAny(firstTruthy(vd["lengthSeconds"], json.Number("0"))),
		"thumbnail": func() any {
			t := mlist(vd, "thumbnail", "thumbnails")
			if len(t) == 0 {
				return nil
			}
			return firstTruthy(mstr(t[len(t)-1], "url"))
		}(),
		"expiresInSeconds": firstTruthy(sd["expiresInSeconds"]),
		"audioFormats":     audio,
		"videoFormats":     video,
	}
	putIfPresent(out, vd, "title", "title")
	return out, nil
}

// ytmusicScraper builds the CLI surface.
func ytmusicScraper() Scraper {
	return Scraper{
		Name:  "ytmusic",
		Title: "YouTube Music Scraper",
		Commands: map[string]Command{
			"search": {
				Name: "search", Desc: "Search (filters: songs|videos|albums|artists|playlists)", Usage: "<query> [filter]",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Query required")
					}
					pos := append([]string{}, args...)
					filter := ""
					if last := pos[len(pos)-1]; last != "" {
						if _, ok := ytmFilters[last]; ok {
							filter = last
							pos = pos[:len(pos)-1]
						}
					}
					return ytSearch(strings.Join(pos, " "), filter)
				},
			},
			"info": {
				Name: "info", Desc: "Album/artist/playlist detail", Usage: "<browseId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("browseId required")
					}
					return ytInfo(args[0])
				},
			},
			"lyrics": {
				Name: "lyrics", Desc: "Lyrics (synced, with fallback)", Usage: "<videoId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("videoId required")
					}
					return ytLyrics(args[0], 0)
				},
			},
			"related": {
				Name: "related", Desc: "Up-next tracks", Usage: "<videoId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("videoId required")
					}
					return ytRelated(args[0])
				},
			},
			"download": {
				Name: "download", Desc: "Audio stream formats", Usage: "<videoId>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("videoId required")
					}
					return ytDownload(args[0], 0)
				},
			},
		},
	}
}

// ytArrOrEmpty is `mlist(...) || []` for callers that want an array, not nil.
func ytArrOrEmpty(o any, keys ...string) []any {
	if a := mlist(o, keys...); a != nil {
		return a
	}
	return []any{}
}

// firstObj returns the first value that is an object (`a || b || {}`).
func firstObj(vals ...any) map[string]any {
	for _, v := range vals {
		if m := obj(v); m != nil {
			return m
		}
	}
	return nil
}

// nilIfEmpty maps "" to nil (`s || null`).
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nilIfEmptyMap looks a label up in a table, returning nil for "" or a miss.
func nilIfEmptyMap(m map[string]string, key string) any {
	if key == "" {
		return nil
	}
	if v, ok := m[key]; ok {
		return v
	}
	return nil
}

// jnumAny renders a decoded JSON number like JS `Number(v)` (int when integral).
func jnumAny(v any) any {
	switch t := v.(type) {
	case nil:
		return int64(0)
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return n
		}
		if f, err := t.Float64(); err == nil {
			return f
		}
		return int64(0)
	case float64:
		return int64(t)
	case int64:
		return t
	case int:
		return int64(t)
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64); err == nil {
			return n
		}
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f
		}
		return int64(0)
	case bool:
		if t {
			return int64(1)
		}
		return int64(0)
	}
	return int64(0)
}

// init registers the scraper with the package registry (scrapers.All/Find).
func init() { register(ytmusicScraper()) }
