// api_go.go — NontonAnimeID Go JSON API server.
//
// The single backend owner of every scraper route: `nontonanime serve` exposes the
// package-level scraper functions in nontonanime.go over HTTP, mirroring
// api/nontonanime/server.ts route-for-route (minus the /api/nontonanime prefix).
// Stdlib only — no module dependencies.
//
//	nontonanime serve [-addr :8899] [-cors] [-adminToken TOKEN] [-spec]
//	nontonanime openapi
//
// Env fallbacks (flags win): API_ADDR, API_HOST, API_PORT, API_CORS, API_ADMIN_TOKEN.
// Every response is wrapped in {"api":"nontonanime-go","version":"1","data":...};
// errors are {"api":...,"version":"1","error":{"code":...,"message":...}}.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"reflect"
	"regexp"
	"sort"
	"sync"

	"nontonanime/scrapers"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// === CONSTANTS ===
const (
	apiName    = "nontonanime-go"
	apiVersion = "1"

	// seconds — mirrors server.ts TTL_SHORT / TTL_LONG
	ttlShort = 300  // fast-moving grids (home/latest/search)
	ttlLong  = 1800 // slow-moving (genres, detail, top, season, list)
	ttlNone  = -1   // no-store

	apiRootPath    = "/api/v1"
	apiOpenAPIPath = "/api/v1/openapi.json"
	apiPurgePath   = "/api/v1/admin/purge"

	apiMaxBodyBytes = 64 << 10 // request body cap (http.MaxBytesReader)
	apiGracePeriod  = 5 * time.Second
)

var apiStarted = time.Now()

func apiUptimeSeconds() int { return int(time.Since(apiStarted) / time.Second) }

// === ENVELOPE ===
type apiEnvelope struct {
	API     string      `json:"api"`
	Version string      `json:"version"`
	Data    interface{} `json:"data"`
}

type apiErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type apiErrorEnvelope struct {
	API     string       `json:"api"`
	Version string       `json:"version"`
	Error   apiErrorInfo `json:"error"`
}

func apiData(v interface{}) apiEnvelope {
	return apiEnvelope{API: apiName, Version: apiVersion, Data: v}
}

func apiErr(code, msg string) apiErrorEnvelope {
	return apiErrorEnvelope{API: apiName, Version: apiVersion, Error: apiErrorInfo{Code: code, Message: msg}}
}

// Payload types for routes that do not map onto a scraper struct.
type HealthData struct {
	OK      bool `json:"ok"`
	UptimeS int  `json:"uptime_s"`
}

type IndexData struct {
	Name    string   `json:"name"`
	UptimeS int      `json:"uptime_s"`
	Routes  []string `json:"routes"`
}

type PurgeData struct {
	Purged int `json:"purged"`
}

// === FAULTS + HANDLER PLUMBING ===
type apiFault struct {
	Status  int
	Code    string
	Message string
}

func apiBadRequest(msg string) *apiFault {
	return &apiFault{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}
func apiNotFound(msg string) *apiFault {
	return &apiFault{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}
func apiUnauthorized(msg string) *apiFault {
	return &apiFault{Status: http.StatusUnauthorized, Code: "unauthorized", Message: msg}
}
func apiUpstream(msg string) *apiFault {
	return &apiFault{Status: http.StatusBadGateway, Code: "upstream_error", Message: msg}
}
func apiInternal(msg string) *apiFault {
	return &apiFault{Status: http.StatusInternalServerError, Code: "internal", Message: msg}
}

// Scraper-error classification — identical ordering/patterns to server.ts err().
var (
	// Client-side faults: the caller omitted or mangled an argument. Anything
	// matched here answers 400, so the wording covers every scraper's guard
	// ("Missing id", "Query required", "Parameter URL wajib", "Usage: …").
	apiBadReqRe = regexp.MustCompile(`(?i)required|missing|invalid|unknown|too short|must be|not allowed|blocked|rejected|Illegal chars|scheme|usage|wajib|harus`)
	// Upstream faults: the origin answered with a refusal we cannot fix here.
	apiUpstreamRe = regexp.MustCompile(`(?i)WAF blocked|HTTP (4\d\d|5\d\d)`)
	apiHTTP404Re  = regexp.MustCompile(`(?i)HTTP 404`)
)

func apiFaultFromError(err error) *apiFault {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case apiBadReqRe.MatchString(msg):
		return apiBadRequest(msg)
	case apiUpstreamRe.MatchString(msg), apiHTTP404Re.MatchString(msg):
		return apiUpstream(msg)
	default:
		return apiInternal(msg)
	}
}

// apiResult is a handler outcome: payload + cache TTL in seconds (ttlNone = no-store).
type apiResult struct {
	Data interface{}
	TTL  int
}

type apiHandler func(*apiServer, map[string][]string) (apiResult, *apiFault)

type apiParam struct {
	Name     string
	Required bool
	Schema   map[string]interface{}
	Desc     string
}

type apiRoute struct {
	Path        string
	OperationID string
	Summary     string
	Tag         string
	TTL         int
	Params      []apiParam
	RespSchema  string      // components schema of the per-route envelope
	PayloadName string      // components schema of the `data` payload
	Payload     interface{} // typed zero value used to derive the payload schema
	Handler     apiHandler
}

func apiWrap(v interface{}, err error, ttl int) (apiResult, *apiFault) {
	if err != nil {
		return apiResult{}, apiFaultFromError(err)
	}
	return apiResult{Data: v, TTL: ttl}, nil
}

// === INPUT BOUNDS (mirror server.ts pg()/parseInt + the Go scraper guards) ===
// jsParseInt reproduces JS parseInt(): optional sign, leading whitespace, stops at
// the first invalid character; (0,false) = NaN.
func jsParseInt(s string) (int, bool) {
	t := strings.TrimSpace(s)
	i := 0
	neg := false
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		neg = t[i] == '-'
		i++
	}
	if i+1 < len(t) && t[i] == '0' && (t[i+1] == 'x' || t[i+1] == 'X') {
		start := i + 2
		j := start
		for j < len(t) && isHexDigit(t[j]) {
			j++
		}
		if j == start {
			return 0, false
		}
		n, err := strconv.ParseUint(t[start:j], 16, 64)
		if err != nil {
			return 0, false
		}
		v := int(n)
		if neg {
			v = -v
		}
		return v, true
	}
	start := i
	for i < len(t) && t[i] >= '0' && t[i] <= '9' {
		i++
	}
	if i == start {
		return 0, false
	}
	n, err := strconv.Atoi(t[start:i])
	if err != nil {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}

func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// apiPage: page clamped 1..50, NaN falls back to 1 (server.ts pg()).
func apiPage(v string) int {
	n, ok := jsParseInt(v)
	if !ok {
		n = 1
	}
	return clampInt(n, 1, 50)
}

// apiServerNum: server clamped 1..20, NaN falls back to 1 (server.ts stream route).
func apiServerNum(v string) int {
	n, ok := jsParseInt(v)
	if !ok {
		n = 1
	}
	return clampInt(n, 1, 20)
}

// first: first value of a query key — url.Values.Get equivalent on a raw map.
func first(q map[string][]string, key string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}

// apiAdvKeys mirrors the filter list server.ts forwards (values sliced to 64 units).
var apiAdvKeys = []string{"sort", "status", "type", "score_min", "score_max", "year_min", "year_max", "genre", "rating", "mode", "studio", "season", "s", "page"}

// === ROUTE HANDLERS ===
func init() {
	apiCommandHook = handleAPICommand
}

// apiIndexPathList is the route list the index handler advertises. It is filled
// in init(), never by a package-level call: apiRoutes → handwrittenRoutes →
// hIndex → apiRoutes would otherwise be an initialization cycle, and hIndex
// only reads the list at request time anyway.
var apiIndexPathList []string

func init() { apiIndexPathList = apiIndexPaths() }

func hIndex(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	return apiResult{Data: IndexData{Name: apiName, UptimeS: apiUptimeSeconds(), Routes: apiIndexPathList}, TTL: ttlLong}, nil
}

func hHealth(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	return apiResult{Data: HealthData{OK: true, UptimeS: apiUptimeSeconds()}, TTL: ttlNone}, nil
}

func hHome(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getHomeContent(apiPage(first(q, "page")))
	return apiWrap(v, err, ttlShort)
}

func hLatest(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getLatestEpisodes(apiPage(first(q, "page")))
	return apiWrap(v, err, ttlShort)
}

func hRecent(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getRecentEpisodes(apiPage(first(q, "page")))
	return apiWrap(v, err, ttlShort)
}

func hList(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getList(apiPage(first(q, "page")))
	return apiWrap(v, err, ttlLong)
}

func hSearch(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	query := first(q, "q")
	if query == "" {
		return apiResult{}, apiBadRequest("Query required (?q=)")
	}
	v, err := searchAnime(query)
	return apiWrap(v, err, ttlShort)
}

func hAdvSearch(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	opts := map[string]string{}
	for _, k := range apiAdvKeys {
		if v := first(q, k); v != "" {
			opts[k] = trunc16(v, 64)
		}
	}
	// filtered queries vary too much to share an edge entry safely
	ttl := ttlShort
	if len(opts) > 1 {
		ttl = 60
	}
	v, err := advancedSearch(opts)
	return apiWrap(v, err, ttl)
}

func hAnime(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Anime URL required (?url=)")
	}
	d, err := getAnimeDetail(u)
	if err != nil {
		return apiResult{}, apiFaultFromError(err)
	}
	if d == nil {
		return apiResult{}, apiNotFound("Anime not found")
	}
	return apiResult{Data: d, TTL: ttlLong}, nil
}

func hEpisode(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	d, err := getEpisodeInfo(u)
	if err != nil {
		return apiResult{}, apiFaultFromError(err)
	}
	if d == nil {
		return apiResult{}, apiNotFound("Episode not found")
	}
	return apiResult{Data: d, TTL: ttlShort}, nil
}

func hStream(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	v, err := getEpisodeStream(u, apiServerNum(first(q, "server")))
	return apiWrap(v, err, ttlNone)
}

func hResolve(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	sel := first(q, "server")
	if sel == "" {
		sel = "1"
	}
	// a query-string value lands in logs, so bound it like every other param
	v, err := resolveServer(u, trunc16(sel, 64))
	return apiWrap(v, err, ttlNone)
}

func hServers(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	v, err := getEpisodeServers(u)
	return apiWrap(v, err, ttlNone)
}

func hNav(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	v, err := getEpisodeNav(u)
	return apiWrap(v, err, ttlShort)
}

func hMeta(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	u := first(q, "url")
	if u == "" {
		return apiResult{}, apiBadRequest("Episode URL required (?url=)")
	}
	v, err := getEpisodeMeta(u)
	return apiWrap(v, err, ttlLong)
}

func hGenres(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getGenres(first(q, "sort"))
	return apiWrap(v, err, ttlLong)
}

func hGenre(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	slug := first(q, "slug")
	if slug == "" {
		return apiResult{}, apiBadRequest("Genre slug required (?slug=)")
	}
	v, err := getGenreAnime(slug, apiPage(first(q, "page")))
	return apiWrap(v, err, ttlShort)
}

func hOngoing(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getOngoingAnime(first(q, "sort"))
	return apiWrap(v, err, ttlShort)
}

func hPopular(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getPopularSeries()
	return apiWrap(v, err, ttlLong)
}

func hSchedule(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getSchedule()
	return apiWrap(v, err, ttlShort)
}

func hTop(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	v, err := getTopAnime()
	return apiWrap(v, err, ttlLong)
}

func hSeason(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	season := first(q, "season")
	if season == "" {
		return apiResult{}, apiBadRequest("Season required (?season=winter&year=2024)")
	}
	yearRaw := first(q, "year")
	if yearRaw == "" {
		return apiResult{}, apiBadRequest("Year required (?season=winter&year=2024)")
	}
	v, err := getSeasonAnime(season, atoi(yearRaw), apiPage(first(q, "page")))
	return apiWrap(v, err, ttlLong)
}

func hMore(s *apiServer, q map[string][]string) (apiResult, *apiFault) {
	ids := []int{}
	for _, tok := range strings.Split(first(q, "ids"), ",") {
		if n, ok := jsNumberToInt(tok); ok {
			ids = append(ids, n)
		}
	}
	offset, ok := jsParseInt(first(q, "offset"))
	if !ok {
		offset = 0
	}
	v, err := loadMoreHome(ids, offset)
	return apiWrap(v, err, ttlNone)
}

// jsNumberToInt reproduces JS Number(x) for the `ids` query param: "" -> 0,
// non-numeric -> not finite (dropped), 0x hex honoured.
func jsNumberToInt(s string) (int, bool) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, true
	}
	neg := false
	if t[0] == '+' || t[0] == '-' {
		neg = t[0] == '-'
		t = t[1:]
	}
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		n, err := strconv.ParseUint(t[2:], 16, 64)
		if err != nil {
			return 0, false
		}
		v := int(n)
		if neg {
			v = -v
		}
		return v, true
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	v := int(f)
	if neg && v > 0 {
		v = -v
	}
	return v, true
}

// === ROUTE TABLE (single source of truth for serving + OpenAPI) ===
func urlParam(desc string) apiParam {
	return apiParam{Name: "url", Required: true, Desc: desc,
		Schema: map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 2048}}
}

var apiPageParam = apiParam{Name: "page", Desc: "1-based page (clamped 1..50)",
	Schema: map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 50, "default": 1}}

func handwrittenRoutes() []*apiRoute {
	return []*apiRoute{
		{
			Path: apiRootPath, OperationID: "apiIndex", Tag: "system", TTL: ttlLong,
			Summary:    "API index: name, uptime and the route list",
			RespSchema: "IndexResponse", PayloadName: "IndexData", Payload: IndexData{},
			Handler: hIndex,
		},
		{
			Path: apiRootPath + "/health", OperationID: "health", Tag: "system", TTL: ttlNone,
			Summary:    "Liveness probe (never cached)",
			RespSchema: "HealthResponse", PayloadName: "HealthData", Payload: HealthData{},
			Handler: hHealth,
		},
		{
			Path: apiRootPath + "/home", OperationID: "getHome", Tag: "content", TTL: ttlShort,
			Summary:    "Home page: latest episodes + per-section series grids",
			Params:     []apiParam{apiPageParam},
			RespSchema: "HomeResponse", PayloadName: "HomeContent", Payload: HomeContent{},
			Handler: hHome,
		},
		{
			Path: apiRootPath + "/latest", OperationID: "getLatest", Tag: "episodes", TTL: ttlShort,
			Summary:    "Latest episodes grid",
			Params:     []apiParam{apiPageParam},
			RespSchema: "LatestResponse", PayloadName: "EpisodeList", Payload: []Episode(nil),
			Handler: hLatest,
		},
		{
			Path: apiRootPath + "/recent", OperationID: "getRecent", Tag: "episodes", TTL: ttlShort,
			Summary:    "Recently updated episodes",
			Params:     []apiParam{apiPageParam},
			RespSchema: "RecentResponse", PayloadName: "EpisodeList", Payload: []Episode(nil),
			Handler: hRecent,
		},
		{
			Path: apiRootPath + "/list", OperationID: "getList", Tag: "catalog", TTL: ttlLong,
			Summary:    "Full anime list",
			Params:     []apiParam{apiPageParam},
			RespSchema: "ListResponse", PayloadName: "AnimeCardList", Payload: []AnimeCard(nil),
			Handler: hList,
		},
		{
			Path: apiRootPath + "/search", OperationID: "search", Tag: "catalog", TTL: ttlShort,
			Summary: "Keyword search",
			Params: []apiParam{{Name: "q", Required: true, Desc: "Search query (min 2 chars)",
				Schema: map[string]interface{}{"type": "string", "minLength": 2, "maxLength": 100}}},
			RespSchema: "SearchResponse", PayloadName: "AnimeCardList", Payload: []AnimeCard(nil),
			Handler: hSearch,
		},
		{
			Path: apiRootPath + "/advsearch", OperationID: "advancedSearch", Tag: "catalog", TTL: ttlShort,
			Summary:    "Advanced search with filters (values truncated to 64 chars)",
			Params:     apiAdvSearchParams(),
			RespSchema: "AdvSearchResponse", PayloadName: "AnimeCardList", Payload: []AnimeCard(nil),
			Handler: hAdvSearch,
		},
		{
			Path: apiRootPath + "/anime", OperationID: "getAnime", Tag: "content", TTL: ttlLong,
			Summary:    "Anime detail by site URL (404 when unknown)",
			Params:     []apiParam{urlParam("Absolute anime URL on the source site")},
			RespSchema: "AnimeResponse", PayloadName: "AnimeDetail", Payload: (*AnimeDetail)(nil),
			Handler: hAnime,
		},
		{
			Path: apiRootPath + "/episode", OperationID: "getEpisode", Tag: "episodes", TTL: ttlShort,
			Summary:    "Episode info: streams + downloads (404 when unknown)",
			Params:     []apiParam{urlParam("Absolute episode URL on the source site")},
			RespSchema: "EpisodeResponse", PayloadName: "StreamResult", Payload: (*StreamResult)(nil),
			Handler: hEpisode,
		},
		{
			Path: apiRootPath + "/stream", OperationID: "getStream", Tag: "streaming", TTL: ttlNone,
			Summary: "Resolved embed URL for one server (nonce-derived, never cached)",
			Params: []apiParam{urlParam("Absolute episode URL on the source site"),
				{Name: "server", Desc: "1-based server number (clamped 1..20)",
					Schema: map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 20, "default": 1}}},
			RespSchema: "StreamResponse", PayloadName: "StreamUrl", Payload: "",
			Handler: hStream,
		},
		{
			Path: apiRootPath + "/resolve", OperationID: "resolveServer", Tag: "streaming", TTL: ttlNone,
			Summary: "Resolve a server by number or name (nonce-derived, never cached)",
			Params: []apiParam{urlParam("Absolute episode URL on the source site"),
				{Name: "server", Desc: "Server number or name (default \"1\")",
					Schema: map[string]interface{}{"type": "string", "maxLength": 64, "default": "1"}}},
			RespSchema: "ResolveResponse", PayloadName: "StreamUrl", Payload: "",
			Handler: hResolve,
		},
		{
			Path: apiRootPath + "/servers", OperationID: "getServers", Tag: "streaming", TTL: ttlNone,
			Summary:    "Server tabs + player nonce (nonce-bearing, never cached)",
			Params:     []apiParam{urlParam("Absolute episode URL on the source site")},
			RespSchema: "ServersResponse", PayloadName: "ServersResult", Payload: ServersResult{},
			Handler: hServers,
		},
		{
			Path: apiRootPath + "/nav", OperationID: "getNav", Tag: "episodes", TTL: ttlShort,
			Summary:    "Prev/all/next episode navigation",
			Params:     []apiParam{urlParam("Absolute episode URL on the source site")},
			RespSchema: "NavResponse", PayloadName: "EpisodeNav", Payload: EpisodeNav{},
			Handler: hNav,
		},
		{
			Path: apiRootPath + "/meta", OperationID: "getMeta", Tag: "episodes", TTL: ttlLong,
			Summary:    "Episode metadata (series, poster, genres)",
			Params:     []apiParam{urlParam("Absolute episode URL on the source site")},
			RespSchema: "MetaResponse", PayloadName: "EpisodeMeta", Payload: EpisodeMeta{},
			Handler: hMeta,
		},
		{
			Path: apiRootPath + "/genres", OperationID: "getGenres", Tag: "catalog", TTL: ttlLong,
			Summary: "Genre grid",
			Params: []apiParam{{Name: "sort", Desc: "Optional sort mode",
				Schema: map[string]interface{}{"type": "string", "enum": []string{"az", "popular", "ongoing"}}}},
			RespSchema: "GenresResponse", PayloadName: "GenreList", Payload: []Genre(nil),
			Handler: hGenres,
		},
		{
			Path: apiRootPath + "/genre", OperationID: "getGenre", Tag: "catalog", TTL: ttlShort,
			Summary: "Anime cards for one genre slug",
			Params: []apiParam{{Name: "slug", Required: true, Desc: "Genre slug (a-z 0-9 -)",
				Schema: map[string]interface{}{"type": "string", "pattern": "^[a-z0-9-]+$", "maxLength": 80}}, apiPageParam},
			RespSchema: "GenreResponse", PayloadName: "AnimeCardList", Payload: []AnimeCard(nil),
			Handler: hGenre,
		},
		{
			Path: apiRootPath + "/ongoing", OperationID: "getOngoing", Tag: "catalog", TTL: ttlShort,
			Summary: "Ongoing series (gacha grid)",
			Params: []apiParam{{Name: "sort", Desc: "Optional sort value ([a-z0-9_], max 32)",
				Schema: map[string]interface{}{"type": "string", "pattern": "^[a-z0-9_]+$", "maxLength": 32}}},
			RespSchema: "OngoingResponse", PayloadName: "OngoingEntryList", Payload: []OngoingEntry(nil),
			Handler: hOngoing,
		},
		{
			Path: apiRootPath + "/popular", OperationID: "getPopular", Tag: "catalog", TTL: ttlLong,
			Summary:    "Popular series (per-tab lists)",
			RespSchema: "PopularResponse", PayloadName: "SeasonResultList", Payload: []SeasonResult(nil),
			Handler: hPopular,
		},
		{
			Path: apiRootPath + "/schedule", OperationID: "getSchedule", Tag: "catalog", TTL: ttlShort,
			Summary:    "Weekly release schedule",
			RespSchema: "ScheduleResponse", PayloadName: "ScheduleEntryList", Payload: []ScheduleEntry(nil),
			Handler: hSchedule,
		},
		{
			Path: apiRootPath + "/top", OperationID: "getTop", Tag: "catalog", TTL: ttlLong,
			Summary:    "Top-rated anime",
			RespSchema: "TopResponse", PayloadName: "TopAnimeList", Payload: []TopAnime(nil),
			Handler: hTop,
		},
		{
			Path: apiRootPath + "/season", OperationID: "getSeason", Tag: "catalog", TTL: ttlLong,
			Summary: "Seasonal anime by season + year",
			Params: []apiParam{
				{Name: "season", Required: true, Desc: "Season name",
					Schema: map[string]interface{}{"type": "string", "enum": []string{"spring", "summer", "fall", "autumn", "winter"}}},
				{Name: "year", Required: true, Desc: "Year (clamped 1990..2100 by the scraper)",
					Schema: map[string]interface{}{"type": "integer", "minimum": 1990, "maximum": 2100, "default": 2024}},
				apiPageParam,
			},
			RespSchema: "SeasonResponse", PayloadName: "SeasonResultList", Payload: []SeasonResult(nil),
			Handler: hSeason,
		},
		{
			Path: apiRootPath + "/more", OperationID: "loadMore", Tag: "episodes", TTL: ttlNone,
			Summary: "Load-more AJAX grid (nonce-derived, never cached)",
			Params: []apiParam{
				{Name: "offset", Desc: "Offset into the grid (clamped 0..100000)",
					Schema: map[string]interface{}{"type": "integer", "minimum": 0, "maximum": 100000, "default": 0}},
				{Name: "ids", Desc: "Comma-separated already-displayed post IDs (first 200 used)",
					Schema: map[string]interface{}{"type": "string"}},
			},
			RespSchema: "MoreResponse", PayloadName: "EpisodeList", Payload: []Episode(nil),
			Handler: hMore,
		},
	}
}

func apiAdvSearchParams() []apiParam {
	desc := map[string]string{
		"sort": "Sort key", "status": "Airing status", "type": "Series type",
		"score_min": "Minimum score", "score_max": "Maximum score",
		"year_min": "Earliest year", "year_max": "Latest year",
		"genre": "Genre slug", "rating": "Rating filter", "mode": "Query mode",
		"studio": "Studio slug", "season": "Season slug", "s": "Keyword",
	}
	out := make([]apiParam, 0, len(apiAdvKeys))
	for _, k := range apiAdvKeys {
		if k == "page" {
			out = append(out, apiPageParam)
			continue
		}
		out = append(out, apiParam{Name: k, Desc: desc[k] + " (truncated to 64 chars)",
			Schema: map[string]interface{}{"type": "string", "maxLength": 64}})
	}
	return out
}

var apiRouteIdx = func() map[string]*apiRoute {
	rs := apiRoutes()
	m := make(map[string]*apiRoute, len(rs))
	for _, rt := range rs {
		m[rt.Path] = rt
	}
	return m
}()

// === HTTP SERVER ===
type apiServer struct {
	cors       bool
	spec       bool
	adminToken string
}

func cacheControlValue(ttl int) string {
	if ttl == ttlNone {
		return "no-store"
	}
	return fmt.Sprintf("public, max-age=%d, s-maxage=%d, stale-while-revalidate=%d", ttl, ttl*2, ttl*4)
}

// apiResponseWriter records whether a body was already written (panic safety).
type apiResponseWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *apiResponseWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.status = code
	w.wrote = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *apiResponseWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}

func (s *apiServer) setCommonHeaders(w http.ResponseWriter, ttl int) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", cacheControlValue(ttl))
	if s.cors {
		h.Set("Access-Control-Allow-Origin", "*")
	}
}

func (s *apiServer) writeJSON(w http.ResponseWriter, status, ttl int, body interface{}) {
	b, err := json.Marshal(body)
	if err != nil {
		// never echo the encoder error: map it to the internal envelope
		b, _ = json.Marshal(apiErr("internal", "Response encoding failed"))
		status, ttl = http.StatusInternalServerError, ttlNone
	}
	s.setCommonHeaders(w, ttl)
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func apiLog(r *http.Request, status int, d time.Duration) {
	fmt.Fprintf(os.Stderr, "%s [api] %s %s -> %d %dms\n",
		time.Now().Format(time.RFC3339), r.Method, r.URL.RequestURI(), status, d.Milliseconds())
}

func (s *apiServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rw := &apiResponseWriter{ResponseWriter: w}
	start := time.Now()
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Fprintf(os.Stderr, "%s [api] panic on %s %s: %v\n",
				time.Now().Format(time.RFC3339), r.Method, r.URL.RequestURI(), rec)
			if !rw.wrote {
				s.writeJSON(rw, http.StatusInternalServerError, ttlNone, apiErr("internal", "Internal server error"))
			}
			apiLog(r, http.StatusInternalServerError, time.Since(start))
		}
	}()
	s.dispatch(rw, r, start)
}

func (s *apiServer) dispatch(w *apiResponseWriter, r *http.Request, start time.Time) {
	// request body cap (GET routes carry none; POST /admin/purge is bounded too)
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, apiMaxBodyBytes)
	}
	if s.cors && r.Method == http.MethodOptions {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Max-Age", "86400")
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		apiLog(r, http.StatusNoContent, time.Since(start))
		return
	}
	path := r.URL.Path

	// admin purge — hidden entirely when no token is configured
	if path == apiPurgePath {
		s.handlePurge(w, r, start)
		return
	}
	if r.Method != http.MethodGet {
		s.writeJSON(w, http.StatusMethodNotAllowed, ttlNone, apiErr("bad_request", "GET only"))
		apiLog(r, http.StatusMethodNotAllowed, time.Since(start))
		return
	}
	if path == apiOpenAPIPath {
		if !s.spec {
			s.writeJSON(w, http.StatusNotFound, ttlNone, apiErr("not_found", "Not found"))
			apiLog(r, http.StatusNotFound, time.Since(start))
			return
		}
		doc, err := marshalOpenAPI()
		if err != nil {
			s.writeJSON(w, http.StatusInternalServerError, ttlNone, apiErr("internal", "OpenAPI generation failed"))
			apiLog(r, http.StatusInternalServerError, time.Since(start))
			return
		}
		s.setCommonHeaders(w, ttlLong)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(doc)
		apiLog(r, http.StatusOK, time.Since(start))
		return
	}
	rt := apiRouteIdx[path]
	if rt == nil {
		s.writeJSON(w, http.StatusNotFound, ttlNone, apiErr("not_found", "Not found"))
		apiLog(r, http.StatusNotFound, time.Since(start))
		return
	}
	res, flt := rt.Handler(s, r.URL.Query())
	if flt != nil {
		fmt.Fprintf(os.Stderr, "%s [api] %s %s -> ERR %s: %s\n",
			time.Now().Format(time.RFC3339), r.Method, r.URL.RequestURI(), flt.Code, flt.Message)
		s.writeJSON(w, flt.Status, ttlNone, apiErr(flt.Code, flt.Message))
		apiLog(r, flt.Status, time.Since(start))
		return
	}
	s.writeJSON(w, http.StatusOK, res.TTL, apiData(res.Data))
	apiLog(r, http.StatusOK, time.Since(start))
}

func (s *apiServer) handlePurge(w *apiResponseWriter, r *http.Request, start time.Time) {
	if s.adminToken == "" {
		s.writeJSON(w, http.StatusNotFound, ttlNone, apiErr("not_found", "Not found"))
		apiLog(r, http.StatusNotFound, time.Since(start))
		return
	}
	if r.Method != http.MethodPost {
		s.writeJSON(w, http.StatusMethodNotAllowed, ttlNone, apiErr("bad_request", "POST only"))
		apiLog(r, http.StatusMethodNotAllowed, time.Since(start))
		return
	}
	// token only via the Authorization header — a query-string token leaks into
	// access logs, browser history and any intermediate proxy.
	auth := r.Header.Get("Authorization")
	supplied := ""
	if strings.HasPrefix(auth, "Bearer ") {
		supplied = auth[len("Bearer "):]
	}
	if supplied == "" || subtle.ConstantTimeCompare([]byte(supplied), []byte(s.adminToken)) != 1 {
		s.writeJSON(w, http.StatusUnauthorized, ttlNone, apiErr("unauthorized", "Unauthorized"))
		apiLog(r, http.StatusUnauthorized, time.Since(start))
		return
	}
	// The Go server keeps no origin LRU of its own (the scraper's page cache is
	// internal and not introspectable) — report 0 rather than invent numbers.
	s.writeJSON(w, http.StatusOK, ttlNone, apiData(PurgeData{Purged: 0}))
	apiLog(r, http.StatusOK, time.Since(start))
}

// === SERVE SUBCOMMAND ===
type serveOpts struct {
	addr       string
	cors       *bool
	adminToken *string
	spec       *bool
	help       bool
}

func parseServeArgs(args []string) (serveOpts, error) {
	var o serveOpts
	value := func(i *int, body, name string) (string, error) {
		if eq := strings.Index(body, "="); eq != -1 {
			return body[eq+1:], nil
		}
		if *i+1 >= len(args) {
			return "", fmt.Errorf("flag %s requires a value", name)
		}
		*i++
		return args[*i], nil
	}
	boolVal := func(body string) bool {
		eq := strings.Index(body, "=")
		if eq == -1 {
			return true
		}
		switch strings.ToLower(body[eq+1:]) {
		case "0", "false", "no", "off":
			return false
		}
		return true
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			return o, fmt.Errorf("unexpected argument %q", a)
		}
		body := strings.TrimLeft(a, "-")
		name := body
		if eq := strings.Index(body, "="); eq != -1 {
			name = body[:eq]
		}
		switch name {
		case "addr", "host", "port":
			v, err := value(&i, body, name)
			if err != nil {
				return o, err
			}
			switch name {
			case "addr":
				o.addr = normalizeAddr(v)
			case "host":
				_, port, _ := net.SplitHostPort(o.addr)
				if port == "" {
					port = "8899"
				}
				o.addr = net.JoinHostPort(v, port)
			default: // port
				host, _, err := net.SplitHostPort(o.addr)
				if err != nil || host == "" {
					host = "127.0.0.1"
				}
				o.addr = net.JoinHostPort(host, v)
			}
		case "cors":
			b := boolVal(body)
			o.cors = &b
		case "adminToken":
			v, err := value(&i, body, name)
			if err != nil {
				return o, err
			}
			o.adminToken = &v
		case "spec":
			b := boolVal(body)
			o.spec = &b
		case "h", "help":
			o.help = true
		default:
			return o, fmt.Errorf("unknown flag %q", a)
		}
	}
	return o, nil
}

// normalizeAddr accepts ":8899", "127.0.0.1:8899", "0.0.0.0:8899" and a bare port.
func normalizeAddr(a string) string {
	a = strings.TrimSpace(a)
	if a == "" {
		return ""
	}
	if strings.Contains(a, ":") {
		return a
	}
	if _, err := strconv.Atoi(a); err == nil {
		return "127.0.0.1:" + a
	}
	return net.JoinHostPort(a, "8899")
}

func envTruthy(k string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func printServeUsage() {
	fmt.Print(`Usage: nontonanime serve [-addr :8899] [-cors] [-adminToken TOKEN] [-spec]

  -addr       bind address (default 127.0.0.1:8899; env API_ADDR / API_HOST / API_PORT)
  -cors       send permissive Access-Control-Allow-Origin: * (env API_CORS=1)
  -adminToken enable POST /api/v1/admin/purge with Authorization: Bearer TOKEN
              (env API_ADMIN_TOKEN; unset = route hidden behind 404)
  -spec       also serve the OpenAPI 3.1 document at GET /api/v1/openapi.json

Env is a fallback — flags win. Routes live under /api/v1.
`)
}

// handleAPICommand serves the API subcommands. It reports false for any other
// command so main falls through to the CLI table.
func handleAPICommand(cmd string, args []string) bool {
	switch cmd {
	case "openapi":
		if err := writeOpenAPI(os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "[ERROR] %s\n", err.Error())
			os.Exit(1)
		}
		return true
	case "serve":
		opts, err := parseServeArgs(args)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[ERROR] %s\n", err.Error())
			printServeUsage()
			os.Exit(2)
		}
		if opts.help {
			printServeUsage()
			return true
		}
		if err := runServe(opts); err != nil {
			fmt.Fprintf(os.Stderr, "[ERROR] %s\n", err.Error())
			os.Exit(1)
		}
		return true
	}
	return false
}

func runServe(opts serveOpts) error {
	addr := opts.addr
	if addr == "" {
		addr = envOr("API_ADDR", "")
	}
	if addr == "" {
		addr = net.JoinHostPort(envOr("API_HOST", "127.0.0.1"), envOr("API_PORT", "8899"))
	}
	addr = normalizeAddr(addr)

	cors := envTruthy("API_CORS")
	if opts.cors != nil {
		cors = *opts.cors
	}
	adminToken := envOr("API_ADMIN_TOKEN", "")
	if opts.adminToken != nil {
		adminToken = *opts.adminToken
	}
	spec := opts.spec != nil && *opts.spec

	s := &apiServer{cors: cors, spec: spec, adminToken: adminToken}
	srv := &http.Server{
		Addr:              addr,
		Handler:           s,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      180 * time.Second, // a retrying scrape chain can take ~60s+
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[nontonanime-api] http://%s%s (cors=%v spec=%v purge=%v)\n",
		ln.Addr().String(), apiRootPath, cors, spec, adminToken != "")

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigCh:
		fmt.Fprintf(os.Stderr, "[api] %s — draining (grace %s)...\n", sig, apiGracePeriod)
		ctx, cancel := context.WithTimeout(context.Background(), apiGracePeriod)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "[api] bye")
		return nil
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			return err
		}
		return nil
	}
}

// === OPENAPI 3.1 GENERATION ===
func writeOpenAPI(w io.Writer) error {
	doc, err := marshalOpenAPI()
	if err != nil {
		return err
	}
	_, err = w.Write(append(doc, '\n'))
	return err
}

func marshalOpenAPI() ([]byte, error) { return json.MarshalIndent(buildOpenAPIDoc(), "", "  ") }

func apiSchemaOf(t reflect.Type, reg map[string]interface{}, seen map[reflect.Type]bool) map[string]interface{} {
	for t != nil && t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t == nil {
		return map[string]interface{}{}
	}
	switch t.Kind() {
	case reflect.Struct:
		if name := t.Name(); name != "" {
			if _, ok := reg[name]; !ok && !seen[t] {
				seen[t] = true
				reg[name] = map[string]interface{}{"type": "object"} // cycle placeholder
				reg[name] = apiStructSchema(t, reg, seen)
			}
			return map[string]interface{}{"$ref": "#/components/schemas/" + name}
		}
		return apiStructSchema(t, reg, seen)
	case reflect.Slice, reflect.Array:
		return map[string]interface{}{"type": "array", "items": apiSchemaOf(t.Elem(), reg, seen)}
	case reflect.Map:
		return map[string]interface{}{"type": "object", "additionalProperties": apiSchemaOf(t.Elem(), reg, seen)}
	case reflect.String:
		return map[string]interface{}{"type": "string"}
	case reflect.Bool:
		return map[string]interface{}{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]interface{}{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]interface{}{"type": "number"}
	default:
		return map[string]interface{}{}
	}
}

func apiStructSchema(t reflect.Type, reg map[string]interface{}, seen map[reflect.Type]bool) map[string]interface{} {
	props := map[string]interface{}{}
	required := []string{}
	for i := range t.NumField() {
		f := t.Field(i)
		if f.PkgPath != "" { // unexported
			continue
		}
		name := f.Name
		omit := false
		if tag := f.Tag.Get("json"); tag != "" {
			parts := strings.Split(tag, ",")
			if parts[0] == "-" {
				continue
			}
			if parts[0] != "" {
				name = parts[0]
			}
			for _, o := range parts[1:] {
				if o == "omitempty" {
					omit = true
				}
			}
		}
		props[name] = apiSchemaOf(f.Type, reg, seen)
		if !omit {
			required = append(required, name)
		}
	}
	out := map[string]interface{}{"type": "object", "properties": props}
	if len(required) > 0 {
		sort.Strings(required)
		out["required"] = required
	}
	return out
}

func apiErrorContent() map[string]interface{} {
	return map[string]interface{}{
		"application/json": map[string]interface{}{
			"schema": map[string]interface{}{"$ref": "#/components/schemas/ErrorEnvelope"},
		},
	}
}

func apiErrorResponses() map[string]interface{} {
	return map[string]interface{}{
		"400": map[string]interface{}{"description": "bad_request — missing/invalid param or host-guard rejection",
			"content": apiErrorContent()},
		"404": map[string]interface{}{"description": "not_found — unknown route or unknown resource",
			"content": apiErrorContent()},
		"405": map[string]interface{}{"description": "Method not allowed (GET only)",
			"content": apiErrorContent()},
		"500": map[string]interface{}{"description": "internal",
			"content": apiErrorContent()},
		"502": map[string]interface{}{"description": "upstream_error — scrape failed (WAF/HTTP error)",
			"content": apiErrorContent()},
	}
}

func buildOpenAPIDoc() map[string]interface{} {
	reg := map[string]interface{}{}

	reg["Envelope"] = map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"api":     map[string]interface{}{"type": "string", "const": apiName},
			"version": map[string]interface{}{"type": "string", "const": apiVersion},
			"data":    map[string]interface{}{"description": "Route payload — see the per-route response schema"},
		},
		"required": []string{"api", "version", "data"},
	}
	reg["ApiError"] = map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"code": map[string]interface{}{"type": "string",
				"enum": []string{"bad_request", "not_found", "upstream_error", "internal", "unauthorized"}},
			"message": map[string]interface{}{"type": "string"},
		},
		"required": []string{"code", "message"},
	}
	reg["ErrorEnvelope"] = map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"api":     map[string]interface{}{"type": "string", "const": apiName},
			"version": map[string]interface{}{"type": "string", "const": apiVersion},
			"error":   map[string]interface{}{"$ref": "#/components/schemas/ApiError"},
		},
		"required": []string{"api", "version", "error"},
	}
	reg["PurgeData"] = map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"purged": map[string]interface{}{"type": "integer",
				"description": "Entries evicted (always 0 — the Go server keeps no origin LRU)"},
		},
		"required": []string{"purged"},
	}

	// payload schemas, derived from the same Go types the handlers return
	for _, rt := range apiRoutes() {
		t := reflect.TypeOf(rt.Payload)
		for t != nil && t.Kind() == reflect.Ptr {
			t = t.Elem()
		}
		if t != nil && t.Kind() == reflect.Struct {
			apiSchemaOf(t, reg, map[reflect.Type]bool{}) // registered under its own name
			continue
		}
		reg[rt.PayloadName] = apiSchemaOf(t, reg, map[reflect.Type]bool{})
	}

	// per-route envelope: {api, version, data: <payload>}
	envelopeFor := func(payloadSchema string) map[string]interface{} {
		return map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"api":     map[string]interface{}{"type": "string", "const": apiName},
				"version": map[string]interface{}{"type": "string", "const": apiVersion},
				"data":    map[string]interface{}{"$ref": "#/components/schemas/" + payloadSchema},
			},
			"required": []string{"api", "version", "data"},
		}
	}

	paths := map[string]interface{}{}

	for _, rt := range apiRoutes() {
		payloadSchema := rt.PayloadName
		respSchemaName := rt.RespSchema
		envelope := envelopeFor(payloadSchema)
		reg[respSchemaName] = envelope

		params := make([]interface{}, 0, len(rt.Params))
		for _, p := range rt.Params {
			params = append(params, map[string]interface{}{
				"name":        p.Name,
				"in":          "query",
				"required":    p.Required,
				"description": p.Desc,
				"schema":      p.Schema,
			})
		}
		responses := map[string]interface{}{
			"200": map[string]interface{}{
				"description": "Envelope response",
				"headers": map[string]interface{}{
					"Cache-Control": map[string]interface{}{
						"description": cacheControlDescription(rt.TTL),
						"schema":      map[string]interface{}{"type": "string", "example": cacheControlValue(rt.TTL)},
					},
				},
				"content": map[string]interface{}{
					"application/json": map[string]interface{}{
						"schema": map[string]interface{}{"$ref": "#/components/schemas/" + respSchemaName},
					},
				},
			},
		}
		for code, r := range apiErrorResponses() {
			responses[code] = r
		}
		op := map[string]interface{}{
			"operationId": rt.OperationID,
			"summary":     rt.Summary,
			"tags":        []string{rt.Tag},
			"parameters":  params,
			"responses":   responses,
		}
		paths[rt.Path] = map[string]interface{}{"get": op}
	}

	// admin purge (conditional, so it is documented without joining /api/v1/* index)
	paths[apiPurgePath] = map[string]interface{}{
		"post": map[string]interface{}{
			"operationId": "purgeCache",
			"summary":     "Purge origin cache entries (404 when no admin token is configured; 401 without a valid Bearer token)",
			"tags":        []string{"admin"},
			"security":    []interface{}{map[string]interface{}{"bearerAuth": []interface{}{}}},
			"responses": map[string]interface{}{
				"200": map[string]interface{}{
					"description": "Purge report (purged is always 0 — no origin LRU)",
					"content": map[string]interface{}{
						"application/json": map[string]interface{}{
							"schema": map[string]interface{}{"$ref": "#/components/schemas/PurgeResponse"},
						},
					},
				},
				"401": map[string]interface{}{"description": "unauthorized — missing/incorrect Bearer token",
					"content": apiErrorContent()},
				"404": map[string]interface{}{"description": "not_found — no admin token configured",
					"content": apiErrorContent()},
			},
		},
	}
	reg["PurgeResponse"] = map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"api":     map[string]interface{}{"type": "string", "const": apiName},
			"version": map[string]interface{}{"type": "string", "const": apiVersion},
			"data":    map[string]interface{}{"$ref": "#/components/schemas/PurgeData"},
		},
		"required": []string{"api", "version", "data"},
	}

	// OpenAPI document itself (served only with -spec)
	paths[apiOpenAPIPath] = map[string]interface{}{
		"get": map[string]interface{}{
			"operationId": "getOpenAPI",
			"summary":     "This OpenAPI 3.1 document (only served when the server runs with -spec)",
			"tags":        []string{"system"},
			"responses": map[string]interface{}{
				"200": map[string]interface{}{
					"description": "OpenAPI 3.1 document",
					"content": map[string]interface{}{
						"application/json": map[string]interface{}{
							"schema": map[string]interface{}{"type": "object"},
						},
					},
				},
			},
		},
	}

	return map[string]interface{}{
		"openapi": "3.1.0",
		"info": map[string]interface{}{
			"title":   "NontonAnimeID API (Go)",
			"version": apiVersion,
			"description": "Go-owned JSON API over the nontonanime scrapers. Every response is wrapped in the " +
				"`Envelope`; failures use `ErrorEnvelope` with a code of bad_request|not_found|upstream_error|internal. " +
				"Cacheable GETs answer `public, max-age=<ttl>, s-maxage=<ttl*2>, stale-while-revalidate=<ttl*4>`; " +
				"nonce-derived routes (/stream, /resolve, /servers, /more, /health) and every error answer `no-store`.",
		},
		"servers": []interface{}{map[string]interface{}{"url": apiRootPath}},
		"tags": []interface{}{
			map[string]interface{}{"name": "system", "description": "Index, health, OpenAPI"},
			map[string]interface{}{"name": "content", "description": "Home and detail pages"},
			map[string]interface{}{"name": "catalog", "description": "Grids, search and rankings"},
			map[string]interface{}{"name": "episodes", "description": "Episode listings and navigation"},
			map[string]interface{}{"name": "streaming", "description": "Nonce-derived stream resolution (never cached)"},
			map[string]interface{}{"name": "admin", "description": "Token-gated administration"},
		},
		"paths": paths,
		"components": map[string]interface{}{
			"securitySchemes": map[string]interface{}{
				"bearerAuth": map[string]interface{}{"type": "http", "scheme": "bearer"},
			},
			"schemas": reg,
		},
		"x-cache-policy": map[string]interface{}{
			"ttl_short_seconds": ttlShort,
			"ttl_long_seconds":  ttlLong,
			"no_store_routes":   []string{apiRootPath + "/health", apiRootPath + "/stream", apiRootPath + "/resolve", apiRootPath + "/servers", apiRootPath + "/more"},
		},
	}
}

func cacheControlDescription(ttl int) string {
	if ttl == ttlNone {
		return "nonce-derived route — always `no-store`"
	}
	return fmt.Sprintf("`public, max-age=%d, s-maxage=%d, stale-while-revalidate=%d`", ttl, ttl*2, ttl*4)
}

// === SCRAPER-BACKED ROUTES ===
// One route per command of every scraper ported into package scrapers:
// /api/v1/<scraper>/<command>. Positional args come from repeatable ?args=…,
// flags from their own query keys, so CLI and HTTP cannot drift apart.
func hScraperCommand(name string, cmd scrapers.Command) apiHandler {
	return func(_ *apiServer, q map[string][]string) (apiResult, *apiFault) {
		var args []string
		for _, a := range q["args"] {
			if a != "" {
				args = append(args, a)
			}
		}
		flags := map[string]string{}
		for k, vs := range q {
			if k == "args" || len(vs) == 0 || vs[0] == "" {
				continue
			}
			flags[k] = vs[0]
		}
		out, err := cmd.Run(args, flags)
		ttl := ttlShort
		switch name {
		case "detail", "info", "track", "album", "artist", "sections", "list", "genrelist", "supported":
			ttl = ttlLong
		}
		return apiWrap(out, err, ttl)
	}
}

func scraperRoutes() []*apiRoute {
	var out []*apiRoute
	for _, sc := range scrapers.All() {
		names := make([]string, 0, len(sc.Commands))
		for n := range sc.Commands {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			cmd := sc.Commands[n]
			// Filesystem-touching commands stay CLI-only: a query string must
			// never name a path on the server (read-and-upload, or write-out).
			if cmd.LocalOnly {
				continue
			}
			params := []apiParam{{
				Name: "args", Desc: "positional arguments (?args=value, repeatable)",
				Schema: map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
			}}
			for fname, kind := range cmd.Flags {
				if kind == "value" {
					params = append(params, apiParam{Name: fname, Desc: "flag --" + fname,
						Schema: map[string]interface{}{"type": "string"}})
				}
			}
			summary := cmd.Desc
			if summary == "" {
				summary = sc.Title + " " + n
			}
			out = append(out, &apiRoute{
				Path:        apiRootPath + "/" + sc.Name + "/" + n,
				OperationID: sc.Name + "_" + n,
				Summary:     summary,
				Tag:         sc.Name,
				TTL:         ttlShort,
				Params:      params,
				RespSchema:  "GenericResponse",
				PayloadName: "GenericData",
				Payload:     map[string]interface{}{},
				Handler:     hScraperCommand(n, cmd),
			})
		}
	}
	return out
}

// apiRoutes is the single source of truth for serving and OpenAPI: the
// handwritten anime routes plus one route per command of every ported scraper.
// Lazy because scrapers.All() depends on other packages' init functions.
var apiRoutes = sync.OnceValue(func() []*apiRoute {
	return append(handwrittenRoutes(), scraperRoutes()...)
})

// apiIndexPaths is the route list advertised by the index handler (lazy: it
// reads apiRoutes, so it cannot be a package-initialised value).
func apiIndexPaths() []string {
	rs := apiRoutes()
	paths := make([]string, 0, len(rs)+1)
	for _, rt := range rs {
		if rt.Path != apiRootPath {
			paths = append(paths, rt.Path)
		}
	}
	paths = append(paths, apiOpenAPIPath) // served only with -spec; listed like the TS index
	sort.Strings(paths)
	return paths
}
