// spotify.go — Go port of spotify.ts (Spotify Open Scraper).
//
// GraphQL persisted queries against api-partner.spotify.com; the bearer token
// is scraped from the embed page's
// __NEXT_DATA__.props.pageProps.state.settings.session.accessToken.
//
// Host pinning: open.spotify.com (embed pages + home) and its API sibling
// api-partner.spotify.com — nothing else, at any redirect hop.
package scrapers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	spotifyBase = "https://open.spotify.com"
	spotifyAPI  = "https://api-partner.spotify.com"
	spotifyUA   = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)

// spotifyHosts is the complete allowlist for every Spotify request, including
// redirect hops.
var spotifyHosts = []string{"open.spotify.com", "api-partner.spotify.com"}

// spotifyHashes are the persisted-query hashes (verbatim from the TS reference).
var spotifyHashes = map[string]string{
	"track":             "612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294",
	"album":             "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10",
	"artist":            "ae0e2958a4ab645b35ca19ac04d0495ae12d9c5d7b7286217674801a9aab281a",
	"artistDiscography": "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599",
	"artistRelated":     "3d031d6cb22a2aa7c8d203d49b49df731f58b1e2799cc38d9876d58771aa66f3",
	"playlist":          "a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4",
	"episode":           "3416929067571ac4b79db16716be3c6ea5f6265f7975a0ee94b1fc5ee1dc1e9d",
	"show":              "aaad798a17a43c0f443c45d630a83df39d2ca1062a090c2e4fb045d6b00ab360",
	"showEpisodes":      "06046f9b939d56c8eb7cdbb687da938de1164c006871aec91dc26e4dc7d8eb08",
	"search":            "eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0",
}

var spotifySite = NewSite(SiteConfig{
	Base:    spotifyBase,
	RateMS:  400,
	Headers: map[string]string{"user-agent": spotifyUA},
})

var (
	spotifyTokenMu sync.Mutex
	spotifyToken   string
)

// spotifyDuration renders milliseconds the way the TS `duration()` does.
func spotifyDuration(ms any) string {
	if !jbool(ms) {
		return "0:00"
	}
	n := jnum(ms)
	return fmt.Sprintf("%d:%02d", n/60000, (n%60000)/1000)
}

var spotifyNextDataRe = regexp.MustCompile(`(?s)__NEXT_DATA__.*?>(.*?)</script`)

// spotifyEmbedState extracts __NEXT_DATA__.props.pageProps.state, or nil.
func spotifyEmbedState(html string) map[string]any {
	if html == "" {
		return nil
	}
	m := spotifyNextDataRe.FindStringSubmatch(html)
	if m == nil {
		return nil
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(m[1]), &root); err != nil {
		return nil
	}
	return mmap(root, "props", "pageProps", "state")
}

func spotifyGetHTML(rawURL string) string {
	body, err := spotifySite.Fetch(rawURL)
	if err != nil {
		return ""
	}
	return body
}

// spotifyGetEmbed returns state.data.entity from an embed page.
func spotifyGetEmbed(kind, id string) map[string]any {
	state := spotifyEmbedState(spotifyGetHTML(spotifyBase + "/embed/" + kind + "/" + id))
	return mmap(state, "data", "entity")
}

// spotifyAccessToken scrapes and caches the session access token.
func spotifyAccessToken() (string, error) {
	spotifyTokenMu.Lock()
	defer spotifyTokenMu.Unlock()
	if spotifyToken != "" {
		return spotifyToken, nil
	}
	state := spotifyEmbedState(spotifyGetHTML(spotifyBase + "/embed/track/6PQ88X9TkUIAUIZJHW2upE"))
	token := mstr(state, "settings", "session", "accessToken")
	if token == "" {
		return "", errors.New("Failed to get access token")
	}
	spotifyToken = token
	return token, nil
}

var spotifyUnreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

// uriComponent encodes exactly like JS encodeURIComponent (space-as-%20, not +).
func uriComponent(s string) string {
	var b strings.Builder
	for i := range len(s) {
		c := s[i]
		if strings.IndexByte(spotifyUnreserved, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// spotifyGraph runs one persisted query. The returned map is the GraphQL `data`
// object; a GraphQL/HTTP failure is an error whose message matches the TS
// `{ error }` payloads.
func spotifyGraph(op, hash string, variables map[string]any) (map[string]any, error) {
	token, err := spotifyAccessToken()
	if err != nil {
		return nil, err
	}
	vars, err := json.Marshal(variables)
	if err != nil {
		return nil, err
	}
	ext, err := json.Marshal(map[string]any{"persistedQuery": map[string]any{"version": 1, "sha256Hash": hash}})
	if err != nil {
		return nil, err
	}
	target := spotifyAPI + "/pathfinder/v1/query?operationName=" + op +
		"&variables=" + uriComponent(string(vars)) +
		"&extensions=" + uriComponent(string(ext))
	res, err := siteRequest(spotifySite, target, http.MethodGet, nil, map[string]string{
		"authorization": "Bearer " + token,
		"user-agent":    spotifyUA,
	}, false, spotifyHosts)
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("%s failed: %d", op, res.Status)
	}
	payload, err := apiDecodeMap(res.Body)
	if err != nil {
		return nil, err
	}
	if errs := arr(payload["errors"]); len(errs) > 0 {
		return nil, errors.New(mstr(obj(errs[0]), "message"))
	}
	return obj(payload["data"]), nil
}

// spotifyImgURL mirrors imgUrl(): sources[0].url from any of four shapes.
func spotifyImgURL(img any) any {
	o := obj(img)
	if o == nil {
		return nil
	}
	var sources []any
	if s := arr(o["sources"]); s != nil {
		sources = s
	} else if items := arr(o["items"]); len(items) > 0 {
		sources = arr(mget(items[0], "sources"))
	} else if s := arr(mget(o, "image", "sources")); s != nil {
		sources = s
	} else if s := arr(mget(o, "coverArt", "sources")); s != nil {
		sources = s
	}
	if len(sources) > 0 {
		return strOrNil(sources[0], "url")
	}
	return nil
}

// spotifyArtistsName maps artist items to their display names (always strings):
// `profile?.name || name || ”`.
func spotifyArtistsName(items any) []any {
	out := []any{}
	for _, a := range arr(items) {
		out = append(out, firstTruthy(mstr(a, "profile", "name"), mstr(a, "name"), ""))
	}
	return out
}

// putIfPresent copies a key only when the source actually has it (TS undefined
// keys vanish from JSON.stringify output while explicit nulls survive).
func putIfPresent(m map[string]any, src any, key string, path ...string) {
	if v, ok := mgetOK(src, path...); ok {
		m[key] = v
	}
}

// firstListItemURL returns item[0].url of an array, or nil.
func firstListItemURL(list any) any {
	items := arr(list)
	if len(items) == 0 {
		return nil
	}
	return strOrNil(items[0], "url")
}

// spotifyFmtGraphTrack shapes one GraphQL track.
func spotifyFmtGraphTrack(t map[string]any) map[string]any {
	if t == nil {
		t = map[string]any{}
	}
	albumOf := obj(mget(t, "albumOfTrack"))
	if albumOf == nil {
		albumOf = map[string]any{}
	}
	audioPreviews := mget(t, "previews", "audioPreviews")
	out := map[string]any{}
	putIfPresent(out, t, "title", "name")
	putIfPresent(out, t, "id", "id")
	putIfPresent(out, t, "uri", "uri")
	putIfPresent(out, t, "trackNumber", "trackNumber")
	putIfPresent(out, t, "discNumber", "discNumber")
	out["artists"] = spotifyArtistsName(firstTruthy(mget(t, "artists", "items"), mget(t, "firstArtist", "items"), mget(t, "otherArtists", "items")))
	putIfPresent(out, albumOf, "album", "name")
	if date := mget(albumOf, "date"); jbool(date) {
		out["releaseDate"] = firstTruthy(mstr(date, "isoString"))
	} else {
		out["releaseDate"] = nil
	}
	out["duration"] = spotifyDuration(mget(t, "duration", "totalMilliseconds"))
	if cr := obj(mget(t, "contentRating")); cr != nil {
		out["explicit"] = mstr(cr, "label") == "EXPLICIT"
	} else {
		out["explicit"] = false
	}
	out["playcount"] = firstTruthy(mget(t, "playcount"))
	out["preview"] = firstTruthy(mstr(t, "audioPreview", "url"), firstListItemURL(audioPreviews))
	out["cover"] = firstTruthy(spotifyImgURL(mget(albumOf, "coverArt")), spotifyImgURL(mget(t, "visualIdentity", "squareCoverImage")))
	return out
}

// spotifyFetchAll pages through a connexion-style root key.
func spotifyFetchAll(op, hash, uri, rootKey string, pageSize, maxPages int, extra map[string]any) []any {
	all := []any{}
	offset := 0
	for len(all) < maxPages*pageSize {
		vars := map[string]any{"uri": uri, "offset": offset, "limit": pageSize}
		for k, v := range extra {
			vars[k] = v
		}
		data, err := spotifyGraph(op, hash, vars)
		if err != nil {
			break
		}
		root := obj(data[rootKey])
		if root == nil {
			break
		}
		var page map[string]any
		for _, k := range []string{"content", "episodesV2", "discography"} {
			if p := obj(root[k]); p != nil {
				page = p
				break
			}
		}
		if page == nil {
			break
		}
		items := arr(page["items"])
		if len(items) == 0 {
			break
		}
		all = append(all, items...)
		offset += len(items)
		if total, ok := mgetOK(page, "totalCount"); ok && jnum(total) != 0 && int64(offset) >= jnum(total) {
			break
		}
		if len(items) < pageSize {
			break
		}
	}
	return all
}

func spotifyTrack(id string) (map[string]any, error) {
	data, gerr := spotifyGraph("getTrack", spotifyHashes["track"], map[string]any{"uri": "spotify:track:" + id})
	var t map[string]any
	if gerr == nil {
		t = obj(data["trackUnion"])
	}
	if t == nil {
		return map[string]any{"error": "Track not found"}, nil
	}
	if _, hasType := t["__typename"]; hasType {
		if _, isStr := t["message"].(string); isStr && !jbool(t["name"]) {
			// Spotify returns {__typename, message} instead of a track for
			// unknown/removed ids.
			return map[string]any{"error": "Track not found", "detail": t["message"]}, nil
		}
	}
	out := spotifyFmtGraphTrack(t)
	out["type"] = "track"
	if !jbool(out["preview"]) {
		if embed := spotifyGetEmbed("track", id); embed != nil {
			if preview := mstr(embed, "audioPreview", "url"); preview != "" {
				out["preview"] = preview
			}
		}
	}
	relItems := mlist(mget(t, "associationsV3", "related"), "items")
	if len(relItems) > 0 {
		related := []any{}
		for _, r := range relItems {
			ro := obj(r)
			d := obj(ro["data"])
			if d == nil {
				d = ro
			}
			m := map[string]any{}
			putIfPresent(m, d, "title", "name")
			putIfPresent(m, d, "id", "id")
			putIfPresent(m, d, "uri", "uri")
			related = append(related, m)
		}
		out["relatedTracks"] = related
	}
	return out, nil
}

func spotifyAlbum(id string) (map[string]any, error) {
	data, gerr := spotifyGraph("getAlbum", spotifyHashes["album"], map[string]any{
		"uri": "spotify:album:" + id, "locale": "", "offset": 0, "limit": 50,
	})
	var a map[string]any
	if gerr == nil {
		a = obj(data["albumUnion"])
	}
	if a == nil {
		return map[string]any{"error": "Album not found"}, nil
	}
	var rawTracks []any
	if items := mlist(a, "tracksV2", "items"); items != nil {
		rawTracks = items
	} else if items := mlist(a, "trackList", "items"); items != nil {
		rawTracks = items
	}
	tracks := []any{}
	for _, iv := range rawTracks {
		i := obj(iv)
		t := obj(i["track"])
		if t == nil {
			t = i
		}
		tracks = append(tracks, spotifyFmtGraphTrack(t))
	}
	out := map[string]any{
		"type":    "album",
		"artists": spotifyArtistsName(mget(a, "artists", "items")),
	}
	putIfPresent(out, a, "title", "name")
	putIfPresent(out, a, "id", "id")
	putIfPresent(out, a, "uri", "uri")
	if date := mget(a, "date"); jbool(date) {
		var releaseDate any
		if iso := mstr(date, "isoString"); iso != "" {
			releaseDate = iso
		} else {
			releaseDate = fmt.Sprintf("%v-%v-%v", mget(date, "year"), mget(date, "month"), mget(date, "day"))
		}
		out["releaseDate"] = releaseDate
	} else {
		out["releaseDate"] = nil
	}
	if tv2 := obj(a["tracksV2"]); tv2 != nil {
		out["totalTracks"] = tv2["totalCount"]
	} else {
		out["totalTracks"] = len(tracks)
	}
	copyright := []any{}
	if a["copyright"] != nil {
		for _, c := range mlist(a, "copyright", "items") {
			copyright = append(copyright, mstr(c, "text"))
		}
	}
	out["copyright"] = copyright
	out["cover"] = spotifyImgURL(a["coverArt"])
	out["tracks"] = tracks
	if more := mlist(a, "moreAlbumsByArtist", "items"); len(more) > 0 {
		items := []any{}
		for _, mv := range more {
			m := obj(mv)
			entry := map[string]any{"cover": spotifyImgURL(m["coverArt"])}
			putIfPresent(entry, m, "title", "name")
			putIfPresent(entry, m, "id", "id")
			putIfPresent(entry, m, "uri", "uri")
			putIfPresent(entry, mget(m, "date"), "releaseYear", "year")
			items = append(items, entry)
		}
		out["moreAlbums"] = items
	}
	return out, nil
}

// spotifyFmtRelease is the shared album/single/EP/compilation shape.
func spotifyFmtRelease(x map[string]any) map[string]any {
	m := map[string]any{}
	putIfPresent(m, x, "title", "name")
	putIfPresent(m, x, "id", "id")
	putIfPresent(m, x, "uri", "uri")
	m["type"] = firstTruthy(x["type"], x["__typename"])
	if m["type"] == nil {
		delete(m, "type")
	}
	putIfPresent(m, mget(x, "date"), "releaseYear", "year")
	m["cover"] = spotifyImgURL(x["coverArt"])
	return m
}

// spotifyReleases flattens a `{items:[{releases:{items:[]}}]}` group.
func spotifyReleases(group any) []any {
	out := []any{}
	for _, item := range arr(mget(group, "items")) {
		rels := mlist(item, "releases", "items")
		if rels == nil {
			rels = []any{item}
		}
		for _, r := range rels {
			out = append(out, spotifyFmtRelease(obj(r)))
		}
	}
	return out
}

func spotifyArtist(id string) (map[string]any, error) {
	uri := "spotify:artist:" + id
	overview, _ := spotifyGraph("queryArtistOverview", spotifyHashes["artist"], map[string]any{
		"uri": uri, "locale": "", "includePrerelease": false,
	})
	related, _ := spotifyGraph("queryArtistRelated", spotifyHashes["artistRelated"], map[string]any{"uri": uri})
	disc, _ := spotifyGraph("queryArtistDiscographyAll", spotifyHashes["artistDiscography"], map[string]any{
		"uri": uri, "offset": 0, "limit": 100,
		"includePrerelease": false, "includeSingles": true, "includeAlbums": true, "includeCompilations": true,
	})
	a := obj(overview["artistUnion"])
	if a == nil {
		return map[string]any{"error": "Artist not found"}, nil
	}
	allList := []any{}
	for _, i := range arr(mget(disc, "artistUnion", "discography", "all", "items")) {
		rels := mlist(i, "releases", "items")
		if rels == nil {
			rels = []any{i}
		}
		allList = append(allList, rels...)
	}
	splitByType := func(kind string) []any {
		out := []any{}
		for _, r := range allList {
			ro := obj(r)
			t := strings.ToUpper(mstr(ro, "type"))
			if t == "" {
				t = strings.ToUpper(mstr(ro, "__typename"))
			}
			if t == kind {
				out = append(out, spotifyFmtRelease(ro))
			}
		}
		return out
	}
	dg := obj(a["discography"])
	if dg == nil {
		dg = map[string]any{}
	}
	relContent := obj(a["relatedContent"])
	if relContent == nil {
		relContent = map[string]any{}
	}
	profile := obj(a["profile"])
	if profile == nil {
		profile = map[string]any{}
	}
	out := map[string]any{
		"type":     "artist",
		"name":     profile["name"],
		"id":       a["id"],
		"uri":      a["uri"],
		"verified": jbool(mget(a, "visuals", "avatarImage", "extractedColors")),
	}
	if stats := obj(a["stats"]); stats != nil {
		cities := []any{}
		for _, c := range arr(mget(stats, "topCities", "items")) {
			cities = append(cities, map[string]any{
				"city":      mget(c, "city"),
				"country":   mget(c, "country"),
				"listeners": mget(c, "numberOfListeners"),
			})
		}
		top := map[string]any{"topCities": cities}
		putIfPresent(top, stats, "followers", "followers")
		putIfPresent(top, stats, "monthlyListeners", "monthlyListeners")
		putIfPresent(top, stats, "worldRank", "worldRank")
		out["stats"] = top
	} else {
		out["stats"] = nil
	}
	out["image"] = spotifyImgURL(mget(a, "visuals", "avatarImage"))
	topTracks := []any{}
	for _, iv := range arr(mget(dg, "topTracks", "items")) {
		i := obj(iv)
		t := obj(i["track"])
		if t == nil {
			t = obj(i)
		}
		topTracks = append(topTracks, spotifyFmtGraphTrack(t))
	}
	out["topTracks"] = topTracks
	popular := []any{}
	for _, xv := range arr(mget(dg, "popularReleasesAlbums", "items")) {
		x := obj(xv)
		popular = append(popular, map[string]any{
			"title":       x["name"],
			"id":          x["id"],
			"uri":         x["uri"],
			"type":        x["type"],
			"releaseYear": mget(x, "date", "year"),
			"cover":       spotifyImgURL(x["coverArt"]),
		})
	}
	out["popularReleases"] = popular
	if len(allList) > 0 {
		out["albums"] = splitByType("ALBUM")
		out["singles"] = splitByType("SINGLE")
		out["compilations"] = splitByType("COMPILATION")
		out["eps"] = splitByType("EP")
	} else {
		out["albums"] = spotifyReleases(dg["albums"])
		out["singles"] = spotifyReleases(dg["singles"])
		out["compilations"] = spotifyReleases(dg["compilations"])
		out["eps"] = []any{}
	}
	mapRelatedArtist := func(ra map[string]any) map[string]any {
		m := map[string]any{"id": ra["id"], "uri": ra["uri"]}
		putIfPresent(m, ra, "name", "profile", "name")
		m["image"] = spotifyImgURL(mget(ra, "visuals", "avatarImage"))
		return m
	}
	relArtists := []any{}
	for _, rav := range arr(mget(relContent, "relatedArtists", "items")) {
		relArtists = append(relArtists, mapRelatedArtist(obj(rav)))
	}
	out["relatedArtists"] = relArtists
	out["appearsOn"] = spotifyReleases(relContent["appearsOn"])
	featuring := []any{}
	for _, fv := range arr(mget(relContent, "featuringV2", "items")) {
		f := obj(fv)
		d := obj(f["data"])
		if d == nil {
			d = f
		}
		fm := map[string]any{"cover": spotifyImgURL(d["images"])}
		putIfPresent(fm, d, "name", "name")
		putIfPresent(fm, d, "id", "id")
		putIfPresent(fm, d, "uri", "uri")
		featuring = append(featuring, fm)
	}
	out["featuring"] = featuring
	if b := obj(profile["biography"]); b != nil {
		out["biography"] = b["text"]
	} else {
		out["biography"] = nil
	}
	links := []any{}
	for _, lv := range arr(mget(profile, "externalLinks", "items")) {
		l := obj(lv)
		links = append(links, map[string]any{"name": l["name"], "url": l["url"]})
	}
	out["externalLinks"] = links
	playlists := []any{}
	for _, pv := range arr(mget(profile, "playlistsV2", "items")) {
		p := obj(pv)
		d := obj(p["data"])
		if d == nil {
			d = p
		}
		pm := map[string]any{"cover": spotifyImgURL(d["images"])}
		putIfPresent(pm, d, "name", "name")
		putIfPresent(pm, d, "id", "id")
		putIfPresent(pm, d, "uri", "uri")
		playlists = append(playlists, pm)
	}
	out["artistPlaylists"] = playlists
	// The dedicated related query can carry a richer list; it wins when present.
	if list := arr(mget(related, "artistUnion", "relatedContent", "relatedArtists", "items")); len(list) > 0 {
		items := []any{}
		for _, rav := range list {
			items = append(items, mapRelatedArtist(obj(rav)))
		}
		out["relatedArtists"] = items
	}
	return out, nil
}

func spotifyPlaylist(id string) (map[string]any, error) {
	data, gerr := spotifyGraph("fetchPlaylist", spotifyHashes["playlist"], map[string]any{
		"uri": "spotify:playlist:" + id, "offset": 0, "limit": 100, "enableWatchFeedEntrypoint": false,
	})
	var p map[string]any
	if gerr == nil {
		p = obj(data["playlistV2"])
	}
	if p == nil || mstr(p, "__typename") == "NotFound" {
		return map[string]any{"error": "Playlist not found"}, nil
	}
	content := obj(p["content"])
	if content == nil {
		content = map[string]any{}
	}
	pageItems := arr(content["items"])
	toTrack := func(i any) map[string]any {
		t := obj(mget(i, "itemV2", "data"))
		if t == nil {
			t = obj(mget(i, "data"))
		}
		if t == nil {
			t = obj(i)
		}
		return spotifyFmtGraphTrack(t)
	}
	tracks := []any{}
	for _, i := range pageItems {
		tracks = append(tracks, toTrack(i))
	}
	totalAny, totalOK := mgetOK(content, "totalCount")
	total := jnum(totalAny)
	if totalOK && total > int64(len(pageItems)) {
		rest := spotifyFetchAll("fetchPlaylist", spotifyHashes["playlist"], "spotify:playlist:"+id, "playlistV2",
			100, int((total+99)/100), map[string]any{"enableWatchFeedEntrypoint": false})
		if int64(len(rest)) > int64(len(pageItems)) {
			for _, i := range rest[len(pageItems):] {
				tracks = append(tracks, toTrack(i))
			}
		}
	}
	out := map[string]any{
		"description": p["description"],
		"owner":       mstr(p, "ownerV2", "data", "username"), // "" when absent → null below
		"trackCount":  firstTruthy(totalAny),
		"cover":       spotifyImgURL(p["images"]),
		"tracks":      tracks,
		"type":        "playlist",
	}
	putIfPresent(out, p, "title", "name")
	putIfPresent(out, p, "id", "id")
	putIfPresent(out, p, "uri", "uri")
	if out["owner"] == "" {
		out["owner"] = nil
	}
	if !jbool(out["trackCount"]) {
		out["trackCount"] = len(tracks)
	}
	if followers, ok := mgetOK(p, "followers"); ok {
		if _, isNum := followers.(json.Number); isNum {
			out["followers"] = followers
		} else {
			out["followers"] = mget(followers, "totalCount")
		}
	} else {
		out["followers"] = nil
	}
	return out, nil
}

func spotifyShow(id string) (map[string]any, error) {
	meta, _ := spotifyGraph("queryShowMetadataV2", spotifyHashes["show"], map[string]any{"uri": "spotify:show:" + id})
	eps, _ := spotifyGraph("queryPodcastEpisodes", spotifyHashes["showEpisodes"], map[string]any{
		"uri": "spotify:show:" + id, "offset": 0, "limit": 50,
	})
	s := obj(meta["podcastUnionV2"])
	if s == nil {
		return map[string]any{"error": "Show not found"}, nil
	}
	ev := obj(mget(eps, "podcastUnionV2", "episodesV2"))
	epItems := []any{}
	for _, iv := range arr(mget(ev, "items")) {
		i := obj(iv)
		e := obj(i["data"])
		if e == nil {
			e = obj(mget(i, "entity", "data"))
		}
		if e == nil {
			e = map[string]any{}
		}
		m := map[string]any{
			"title":    e["name"],
			"id":       e["id"],
			"uri":      e["uri"],
			"duration": spotifyDuration(mget(e, "duration", "totalMilliseconds")),
			"cover":    spotifyImgURL(e["coverArt"]),
		}
		m["description"] = e["description"]
		if rd := mget(e, "releaseDate"); jbool(rd) {
			m["releaseDate"] = firstTruthy(mstr(rd, "isoString"))
		} else {
			m["releaseDate"] = nil
		}
		epItems = append(epItems, m)
	}
	rating := obj(s["rating"])
	avgRating := obj(mget(rating, "averageRating"))
	contentRating := obj(s["contentRatingV2"])
	out := map[string]any{
		"type":        "show",
		"description": firstTruthy(s["description"], s["htmlDescription"]),
	}
	putIfPresent(out, s, "title", "name")
	putIfPresent(out, s, "id", "id")
	putIfPresent(out, s, "uri", "uri")
	putIfPresent(out, s, "mediaType", "mediaType")
	if pub := obj(s["publisher"]); pub != nil {
		out["publisher"] = pub["name"]
	} else {
		out["publisher"] = s["publisher"]
	}
	if rating != nil && avgRating != nil {
		out["rating"] = map[string]any{"average": avgRating["average"], "totalRatings": avgRating["totalRatings"]}
	} else {
		out["rating"] = nil
	}
	if contentRating != nil {
		explicit := false
		for _, l := range arr(contentRating["labels"]) {
			if jstr(l) == "EXPLICIT" {
				explicit = true
			}
		}
		out["explicit"] = explicit
	} else {
		out["explicit"] = false
	}
	if ev != nil {
		out["totalEpisodes"] = ev["totalCount"]
	} else {
		out["totalEpisodes"] = len(epItems)
	}
	out["episodes"] = epItems
	return out, nil
}

func spotifyEpisode(id string) (map[string]any, error) {
	data, gerr := spotifyGraph("getEpisodeOrChapter", spotifyHashes["episode"], map[string]any{"uri": "spotify:episode:" + id})
	var e map[string]any
	if gerr == nil {
		e = obj(data["episodeUnionV2"])
	}
	if e == nil || mstr(e, "__typename") == "NotFound" {
		return map[string]any{"error": "Episode not found"}, nil
	}
	out := map[string]any{
		"type":     "episode",
		"duration": spotifyDuration(mget(e, "duration", "totalMilliseconds")),
		"show":     firstTruthy(mstr(e, "podcastV2", "data", "name")),
		"preview":  firstTruthy(mstr(e, "previewPlayback", "url"), firstListItemURL(mget(e, "audio", "items"))),
		"cover":    spotifyImgURL(e["coverArt"]),
	}
	putIfPresent(out, e, "title", "name")
	putIfPresent(out, e, "id", "id")
	putIfPresent(out, e, "uri", "uri")
	putIfPresent(out, e, "description", "description")
	if rd := mget(e, "releaseDate"); jbool(rd) {
		out["releaseDate"] = firstTruthy(mstr(rd, "isoString"))
	} else {
		out["releaseDate"] = nil
	}
	if cr := obj(e["contentRating"]); cr != nil {
		out["explicit"] = mstr(cr, "label") == "EXPLICIT"
	} else {
		out["explicit"] = false
	}
	return out, nil
}

// spotifyUnwrap digs `item.data || data || self` out of a search node.
func spotifyUnwrap(item any) map[string]any {
	i := obj(item)
	if i == nil {
		return map[string]any{}
	}
	if nested := obj(mget(i, "item", "data")); nested != nil {
		return nested
	}
	if direct := obj(i["data"]); direct != nil {
		return direct
	}
	return i
}

func spotifyFmtSearchTrack(d map[string]any) map[string]any {
	m := map[string]any{
		"type":    "track",
		"artists": spotifyArtistsName(mget(d, "artists", "items")),
	}
	putIfPresent(m, d, "name", "name")
	putIfPresent(m, d, "id", "id")
	putIfPresent(m, d, "uri", "uri")
	m["album"] = firstTruthy(mstr(d, "albumOfTrack", "name"))
	m["duration"] = firstTruthy(func() any {
		if jbool(d["duration"]) {
			return spotifyDuration(mget(d, "duration", "totalMilliseconds"))
		}
		return nil
	}())
	m["explicit"] = mstr(d, "contentRating", "label") == "EXPLICIT"
	m["cover"] = firstTruthy(spotifyImgURL(mget(d, "albumOfTrack", "coverArt")), spotifyImgURL(d["visualIdentity"]))
	return m
}

func spotifyFmtSearchArtist(d map[string]any) map[string]any {
	m := map[string]any{
		"type":     "artist",
		"name":     mget(d, "profile", "name"),
		"verified": jbool(mget(d, "onPlatformReputationTrait", "verification", "isVerified")),
		"image":    firstTruthy(spotifyImgURL(mget(d, "visuals", "avatarImage")), spotifyImgURL(d["visualIdentity"])),
	}
	if m["name"] == nil {
		m["name"] = nil
	}
	putIfPresent(m, d, "id", "id")
	putIfPresent(m, d, "uri", "uri")
	return m
}

func spotifyFmtSearchAlbum(d map[string]any) map[string]any {
	m := map[string]any{
		"type":    "album",
		"artists": spotifyArtistsName(mget(d, "artists", "items")),
		"year":    numOrNil(mget(d, "date"), "year"),
		"image":   spotifyImgURL(d["coverArt"]),
	}
	putIfPresent(m, d, "name", "name")
	putIfPresent(m, d, "id", "id")
	putIfPresent(m, d, "uri", "uri")
	return m
}

func spotifyFmtSearchPlaylist(d map[string]any) map[string]any {
	m := map[string]any{"type": "playlist"}
	putIfPresent(m, d, "name", "name")
	id := d["id"]
	if !jbool(id) {
		if uri, ok := d["uri"].(string); ok && uri != "" {
			parts := strings.Split(uri, ":")
			id = parts[len(parts)-1]
		} else {
			id = nil
		}
	}
	m["id"] = id
	putIfPresent(m, d, "uri", "uri")
	m["owner"] = firstTruthy(mstr(d, "ownerV2", "data", "username"), mstr(d, "ownerV2", "username"))
	m["description"] = firstTruthy(d["description"])
	m["image"] = spotifyImgURL(d["images"])
	return m
}

func spotifyFmtSearchEpisode(d map[string]any) map[string]any {
	m := map[string]any{
		"type":        "episode",
		"description": firstTruthy(d["description"]),
		"image":       spotifyImgURL(d["coverArt"]),
	}
	putIfPresent(m, d, "name", "name")
	putIfPresent(m, d, "id", "id")
	putIfPresent(m, d, "uri", "uri")
	return m
}

func spotifyFmtSearchPodcast(d map[string]any) map[string]any {
	m := map[string]any{
		"type":      "podcast",
		"publisher": firstTruthy(mstr(d, "publisher", "name"), d["publisher"]),
		"image":     spotifyImgURL(d["coverArt"]),
	}
	putIfPresent(m, d, "name", "name")
	putIfPresent(m, d, "id", "id")
	putIfPresent(m, d, "uri", "uri")
	return m
}

// spotifyFormatSearchAny dispatches on __typename.
func spotifyFormatSearchAny(d map[string]any) any {
	if d == nil {
		return nil
	}
	switch mstr(d, "__typename") {
	case "Track":
		return spotifyFmtSearchTrack(d)
	case "Artist":
		return spotifyFmtSearchArtist(d)
	case "Album":
		return spotifyFmtSearchAlbum(d)
	case "Playlist":
		return spotifyFmtSearchPlaylist(d)
	case "Episode":
		return spotifyFmtSearchEpisode(d)
	case "Podcast":
		return spotifyFmtSearchPodcast(d)
	default:
		m := map[string]any{"type": strings.ToLower(mstr(d, "__typename"))}
		putIfPresent(m, d, "name", "name")
		putIfPresent(m, d, "uri", "uri")
		return m
	}
}

func spotifySearch(query string, limit int) (map[string]any, error) {
	variables := map[string]any{
		"searchTerm": query, "offset": 0, "limit": limit, "numberOfTopResults": 5,
		"includeAudiobooks": true, "includePreReleases": true, "includeAlbumPreReleases": false,
		"includeAuthors": false, "includeEpisodeContentRatingsV2": false,
	}
	data, gerr := spotifyGraph("searchDesktop", spotifyHashes["search"], variables)
	if gerr != nil {
		return map[string]any{"error": gerr.Error()}, nil
	}
	sv := obj(data["searchV2"])
	if sv == nil {
		return map[string]any{"error": "No search results"}, nil
	}
	results := map[string]any{}
	topList := mlist(sv, "topResultsV2", "featured")
	if topList == nil {
		topList = mlist(sv, "topResultsV2", "itemsV2")
	}
	if topList == nil {
		topList = []any{}
	}
	if len(topList) > 0 {
		items := []any{}
		for _, d := range topList {
			if v := spotifyFormatSearchAny(spotifyUnwrap(d)); v != nil {
				items = append(items, v)
			}
		}
		results["topResults"] = items
	}
	sections := []struct {
		outKey  string
		srcKey  string
		formatt func(map[string]any) map[string]any
	}{
		{"tracks", "tracksV2", spotifyFmtSearchTrack},
		{"artists", "artists", spotifyFmtSearchArtist},
		{"albums", "albumsV2", spotifyFmtSearchAlbum},
		{"playlists", "playlists", spotifyFmtSearchPlaylist},
		{"episodes", "episodes", spotifyFmtSearchEpisode},
		{"podcasts", "podcasts", spotifyFmtSearchPodcast},
	}
	for _, sec := range sections {
		if items := mlist(sv, sec.srcKey, "items"); items != nil {
			mapped := []any{}
			for _, d := range items {
				mapped = append(mapped, sec.formatt(spotifyUnwrap(d)))
			}
			results[sec.outKey] = mapped
		}
	}
	if genres := mlist(sv, "genres", "items"); genres != nil {
		mapped := []any{}
		for _, g := range genres {
			u := spotifyUnwrap(g)
			gm := map[string]any{"type": "genre", "image": spotifyImgURL(u["image"])}
			putIfPresent(gm, u, "name", "name")
			mapped = append(mapped, gm)
		}
		results["genres"] = mapped
	}
	if users := mlist(sv, "users", "items"); users != nil {
		mapped := []any{}
		for _, u := range users {
			nu := spotifyUnwrap(u)
			mapped = append(mapped, map[string]any{
				"type": "user", "name": firstTruthy(nu["displayName"], nu["name"]),
				"id": firstTruthy(nu["id"]), "uri": firstTruthy(nu["uri"]), "image": spotifyImgURL(nu["avatar"]),
			})
		}
		results["users"] = mapped
	}
	return map[string]any{"query": query, "limit": limit, "results": results}, nil
}

func spotifyDetailByURI(uri string) any {
	parts := strings.Split(uri, ":")
	if len(parts) < 3 {
		return nil
	}
	kind, id := parts[1], parts[2]
	var out map[string]any
	switch kind {
	case "track":
		out, _ = spotifyTrack(id)
	case "artist":
		out, _ = spotifyArtist(id)
	case "album":
		out, _ = spotifyAlbum(id)
	case "playlist":
		out, _ = spotifyPlaylist(id)
	default:
		return nil
	}
	return out
}

var spotifyInitialStateRe = regexp.MustCompile(`(?s)id="initialState"[^>]*>(.*?)</script>`)

// spotifyURITail mirrors `String(uri).split(':').pop()`.
func spotifyURITail(uri any) string {
	if s, ok := uri.(string); ok && s != "" {
		parts := strings.Split(s, ":")
		return parts[len(parts)-1]
	}
	return "undefined"
}

func spotifyHome(withDetail bool, limit int) (map[string]any, error) {
	html, err := spotifySite.Fetch(spotifyBase + "/")
	if err != nil || html == "" {
		return map[string]any{"error": "Home not reachable"}, nil
	}
	m := spotifyInitialStateRe.FindStringSubmatch(html)
	if m == nil {
		return map[string]any{"error": "Home data not found"}, nil
	}
	raw, derr := base64.StdEncoding.DecodeString(strings.TrimSpace(m[1]))
	if derr != nil {
		return map[string]any{"error": "Home data parse failed"}, nil
	}
	var root map[string]any
	if jerr := json.Unmarshal(raw, &root); jerr != nil {
		return map[string]any{"error": "Home data parse failed"}, nil
	}
	home := obj(mget(root, "home", "data"))
	if home == nil {
		return map[string]any{"error": "Home sections missing"}, nil
	}
	allSections := mlist(home, "sections")
	if allSections == nil {
		allSections = []any{}
	}
	sections := []any{}
	for _, s := range allSections {
		so := obj(s)
		items := mlist(so, "items")
		if items == nil {
			items = []any{}
		}
		if limit > 0 && len(items) > limit {
			items = items[:limit]
		}
		outItems := []any{}
		for _, it := range items {
			io := obj(it)
			base := map[string]any{"title": io["title"], "uri": io["uri"], "id": spotifyURITail(io["uri"]), "imageUrl": io["imageUrl"]}
			if withDetail {
				base["detail"] = spotifyDetailByURI(mstr(io, "uri"))
			}
			outItems = append(outItems, base)
		}
		sections = append(sections, map[string]any{"title": so["title"], "uri": so["uri"], "items": outItems})
	}
	return map[string]any{
		"greeting":     home["greetingLabel"],
		"sectionCount": len(sections),
		"sections":     sections,
	}, nil
}

// spotifyScraper builds the CLI surface (commands, flags and payloads identical
// to the TS reference).
func spotifyScraper() Scraper {
	return Scraper{
		Name:  "spotify",
		Title: "Spotify Open Scraper",
		Commands: map[string]Command{
			"home": {
				Name: "home", Desc: "Home page sections (--nodetail, --limit=N)", Usage: "[--nodetail] [--limit=N]",
				Flags: map[string]string{"nodetail": "bool", "limit": "value"},
				Run: func(args []string, flags map[string]string) (any, error) {
					_, noDetail := flags["nodetail"]
					return spotifyHome(!noDetail, cliInt(flags["limit"], 0, 0))
				},
			},
			"search": {
				Name: "search", Desc: "Full search", Usage: "<query> [--limit=N]",
				Flags: map[string]string{"limit": "value"},
				Run: func(args []string, flags map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Missing query")
					}
					return spotifySearch(strings.Join(args, " "), cliInt(flags["limit"], 10, 10))
				},
			},
			"track":    spotifyIDCommand("track", "Track detail (playcount, preview, related)", "Missing id", spotifyTrack),
			"artist":   spotifyIDCommand("artist", "Full artist (stats, discography, related)", "Missing id", spotifyArtist),
			"album":    spotifyIDCommand("album", "Full album (all tracks, copyright, more)", "Missing id", spotifyAlbum),
			"playlist": spotifyIDCommand("playlist", "Full playlist (all tracks, paginated)", "Missing id", spotifyPlaylist),
			"show":     spotifyIDCommand("show", "Podcast/show + episodes", "Missing id", spotifyShow),
			"episode":  spotifyIDCommand("episode", "Episode detail", "Missing id", spotifyEpisode),
		},
	}
}

func spotifyIDCommand(name, desc, missing string, fn func(string) (map[string]any, error)) Command {
	return Command{
		Name: name, Desc: desc, Usage: "<id>",
		Run: func(args []string, _ map[string]string) (any, error) {
			if len(args) == 0 || args[0] == "" {
				return nil, errors.New(missing)
			}
			return fn(args[0])
		},
	}
}

// cliInt mirrors `parseInt(flags[k] || '<def>') || def2`.
func cliInt(raw string, fallback, zeroFallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	if n == 0 {
		return zeroFallback
	}
	return n
}

// init registers the scraper with the package registry (scrapers.All/Find).
func init() { register(spotifyScraper()) }
