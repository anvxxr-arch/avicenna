// freeconvert.go — Go port of freeconvert.ts (FreeConvert video compressor).
//
// Reference: freeconvert.ts — base https://api.freeconvert.com/v1, rateMs 600,
// headers `accept: application/json`. One command:
//
//	freeconvert compress <file> [target%]
//
// Flow, identical to the TS: GET /account/guest (text/plain JWT) →
// POST /process/jobs with the Bearer token (import/upload → compress →
// export/url) → multipart upload of the input to the job's signed upload form
// → poll GET /process/jobs/<id> until status "completed" → download the
// export/url result to downloads/. The returned payload is
// {id, status, upload, job, saved}: `job` is the final job document untouched,
// `saved` the finished download. That download is a local side effect (the
// file the TS writes next to its other scraped media), so a JSON-only API
// consumer never sees it.
//
// Two deliberate deviations, both forced by the Go CLI contract:
//   - the TS progress line <status processing...> goes to stderr, because
//     stdout carries the JSON document the dispatcher emits;
//   - the TS returns `saved: null` when the job carries no export URL;
//     Clean() collapses that empty object to an omitted key, exactly as every
//     other ported scraper handles nils.
package scrapers

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const fcAPI = "https://api.freeconvert.com/v1"

// fcHosts is the only host the TS itself talks to: the API origin. The
// per-job upload/export hosts (server<N>-<xx>.freeconvert.com) are pinned
// per request from the job document, mirroring requestExternal()'s explicit
// per-URL allowlist.
var fcHosts = []string{"api.freeconvert.com"}

var fcSite = NewSite(SiteConfig{
	Base:   fcAPI,
	RateMS: 600,
	Headers: map[string]string{
		"accept": "application/json",
	},
})

// fcGuestTokenRe is the 3-part JWT shape check from guestToken().
var fcGuestTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)

// fcFilenameRe mirrors the content-disposition filename extraction.
var fcFilenameRe = regexp.MustCompile(`filename="?([^";]+)`)

// fcGuestToken fetches the anonymous JWT. The endpoint returns the raw token
// as text/plain (not JSON). The absolute URL is used because the base carries
// the /v1 prefix, which the site-relative path join would drop.
func fcGuestToken() (string, error) {
	res, err := siteRequest(fcSite, fcAPI+"/account/guest", http.MethodGet, nil, nil, true, fcHosts)
	if err != nil {
		return "", err
	}
	if res.Status < 200 || res.Status >= 300 {
		return "", fmt.Errorf("HTTP %d", res.Status)
	}
	token := strings.TrimSpace(strings.Trim(strings.TrimSpace(string(res.Body)), `"`))
	if !fcGuestTokenRe.MatchString(token) {
		return "", errors.New("guest token missing/invalid")
	}
	return token, nil
}

// fcJobBody builds the three-task pipeline the TS posts.
func fcJobBody(target int) map[string]any {
	return map[string]any{
		"tasks": map[string]any{
			"import-1": map[string]any{"operation": "import/upload"},
			"compress-1": map[string]any{
				"operation":     "compress",
				"input":         "import-1",
				"input_format":  "mp4",
				"output_format": "mp4",
				"options": map[string]any{
					"video_codec_compress":              "libx264",
					"compress_video":                    "by_percentage",
					"video_compress_quality_percentage": target,
				},
			},
			"export-1": map[string]any{"operation": "export/url", "input": "compress-1", "filename": "wOrvCj_compressed.mp4"},
		},
	}
}

// fcIsValidURL is isValidUrl() from core/fetch.ts: a public http(s) URL.
func fcIsValidURL(raw string) bool {
	if raw == "" || len(raw) > 2048 {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return false
	}
	if u.User != nil {
		return false
	}
	return !IsBlockedHost(u.Hostname())
}

// fcForm is the import/upload task result (the signed upload form).
type fcForm struct {
	URL        string
	Parameters map[string]any
}

// fcFindForm returns the upload form of the freshly created job.
func fcFindForm(job map[string]any) (*fcForm, error) {
	for _, t := range arr(job["tasks"]) {
		if mstr(obj(t), "operation") != "import/upload" {
			continue
		}
		form := mmap(t, "result", "form")
		if form == nil {
			break
		}
		u := mstr(form, "url")
		if u == "" || !fcIsValidURL(u) {
			break
		}
		return &fcForm{URL: u, Parameters: mmap(form, "parameters")}, nil
	}
	return nil, errors.New("no upload form URL")
}

// fcUpload posts the input file to the job's signed upload form as
// multipart/form-data: a `signature` field plus the file as `video/mp4`,
// matching the TS FormData wire format.
func fcUpload(form *fcForm, token, file string) (any, error) {
	u, err := url.Parse(form.URL)
	if err != nil {
		return nil, errors.New("no upload form URL")
	}
	data, err := os.ReadFile(file) // mirrors fs.readFileSync(file)
	if err != nil {
		return nil, err
	}
	sig := mstr(form.Parameters, "signature")
	boundary := "----WebKitFormBoundary" + strconv.FormatInt(time.Now().UnixNano(), 36)
	var b strings.Builder
	part := func(name, filename, ctype, value string) {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Disposition: form-data; name=\"" + name + "\"")
		if filename != "" {
			b.WriteString("; filename=\"" + filename + "\"")
		}
		b.WriteString("\r\n")
		if ctype != "" {
			b.WriteString("Content-Type: " + ctype + "\r\n")
		}
		b.WriteString("\r\n" + value + "\r\n")
	}
	// Empty signature parts are still emitted: FormData would send them.
	part("signature", "", "", sig)
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Disposition: form-data; name=\"file\"; filename=\"" + filepath.Base(file) + "\"\r\n")
	b.WriteString("Content-Type: video/mp4\r\n\r\n")
	body := append([]byte(b.String()), data...)
	body = append(body, []byte("\r\n--"+boundary+"--\r\n")...)

	res, err := siteRequestOpts(fcSite, form.URL, http.MethodPost, body, map[string]string{
		"authorization": "Bearer " + token,
		"content-type":  "multipart/form-data; boundary=" + boundary,
	}, true, false, []string{u.Hostname()})
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("upload HTTP %d", res.Status)
	}
	out, err := apiDecodeMap(res.Body)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// fcWaitDone polls the job until it completes (120 tries, 5s apart, through
// the site limiter — never a busy loop). The non-terminal status line the TS
// prints to stdout goes to stderr here, since stdout is the JSON document.
func fcWaitDone(id, token string) (map[string]any, error) {
	headers := map[string]string{"accept": "application/json", "authorization": "Bearer " + token}
	for i := 0; i < 120; i++ {
		res, err := siteRequest(fcSite, fcAPI+"/process/jobs/"+id, http.MethodGet, nil, headers, true, fcHosts)
		if err != nil {
			return nil, err
		}
		if res.Status < 200 || res.Status >= 300 {
			return nil, fmt.Errorf("job poll HTTP %d", res.Status)
		}
		job, err := apiDecodeMap(res.Body)
		if err != nil {
			return nil, err
		}
		switch mstr(job, "status") {
		case "completed":
			return job, nil
		case "failed", "error":
			raw, _ := JSONStringify(Clean(job))
			return nil, errors.New("job failed: " + raw)
		}
		fmt.Fprintf(os.Stderr, "status %s...\n", mstr(job, "status"))
		time.Sleep(5 * time.Second)
	}
	return nil, errors.New("timeout waiting for job")
}

// fcDownload saves an exported URL into `dir`, returning the saved record.
// The filename mirrors the TS: <Date.now()>_<md5>_<content-disposition name>.
func fcDownload(rawURL, dir string) (map[string]any, error) {
	if !fcIsValidURL(rawURL) {
		return nil, errors.New("download URL blocked by guards")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("download URL blocked by guards")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	res, err := siteRequestMedia(fcSite, rawURL, nil, []string{u.Hostname()})
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("HTTP %d", res.Status)
	}
	sum := md5.Sum(res.Body)
	digest := hex.EncodeToString(sum[:])
	name := "compressed.mp4"
	if m := fcFilenameRe.FindStringSubmatch(res.Header.Get("Content-Disposition")); m != nil && m[1] != "" {
		name = m[1]
	}
	file := filepath.Join(dir, fmt.Sprintf("%d_%s_%s", time.Now().UnixMilli(), digest, name))
	if err := os.WriteFile(file, res.Body, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{
		"file":  file,
		"url":   rawURL,
		"md5":   digest,
		"bytes": len(res.Body),
	}, nil
}

// fcCompress runs the whole pipeline and returns the CLI payload.
func fcCompress(input string, target int) (any, error) {
	if _, err := os.Stat(input); err != nil {
		return nil, errors.New("input file not found: " + input)
	}
	token, err := fcGuestToken()
	if err != nil {
		return nil, err
	}
	payload, err := JSONStringify(fcJobBody(target))
	if err != nil {
		return nil, err
	}
	res, err := siteRequestOpts(fcSite, fcAPI+"/process/jobs", http.MethodPost, []byte(payload), map[string]string{
		// postAjax() derives this content-type from the JSON body; the API
		// answers 400 "tasks are not valid" without it.
		"content-type":  "application/json",
		"authorization": "Bearer " + token,
	}, true, false, fcHosts)
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("HTTP %d for %s", res.Status, res.URL)
	}
	created, err := apiDecodeMap(res.Body)
	if err != nil {
		return nil, err
	}
	id := mstr(created, "id")
	if id == "" {
		raw, _ := JSONStringify(Clean(created))
		return nil, errors.New("no job id: " + raw)
	}
	form, err := fcFindForm(created)
	if err != nil {
		return nil, err
	}
	upload, err := fcUpload(form, token, input)
	if err != nil {
		return nil, err
	}
	job, err := fcWaitDone(id, token)
	if err != nil {
		return nil, err
	}
	exportURL := ""
	for _, t := range arr(job["tasks"]) {
		if mstr(obj(t), "operation") == "export/url" {
			exportURL = mstr(t, "result", "url")
			break
		}
	}
	var saved any
	if exportURL != "" {
		saved, err = fcDownload(exportURL, "downloads")
		if err != nil {
			return nil, err
		}
	}
	return Clean(map[string]any{
		"id":     id,
		"status": mstr(job, "status"),
		"upload": upload,
		"job":    job,
		"saved":  saved,
	}), nil
}

// NewFreeConvert builds the FreeConvert scraper (embeddable).
func NewFreeConvert() Scraper { return freeConvertScraper() }

func init() { register(freeConvertScraper()) }

// fcTargetClamp mirrors `Math.min(100, Math.max(1, parseInt(pos[1] || '60') || 60))`.
func fcTargetClamp(raw string) int {
	if raw == "" {
		raw = "60"
	}
	n, ok := ParseIntJS(raw)
	if !ok || n == 0 {
		n = 60
	}
	if n < 1 {
		n = 1
	}
	if n > 100 {
		n = 100
	}
	return n
}

func freeConvertScraper() Scraper {
	return Scraper{
		Name:  "freeconvert",
		Title: "FreeConvert Video Compressor",
		Commands: map[string]Command{
			"compress": {
				Name:  "compress",
				Desc:  "Upload + compress a video to target size percentage",
				Usage: "<file> [target%]",
				// reads a caller-named local file and uploads it: CLI only.
				LocalOnly: true,
				Run: func(args []string, _ map[string]string) (any, error) {
					input := "downloads/input.mp4"
					if len(args) > 0 {
						input = args[0]
					}
					raw := ""
					if len(args) > 1 {
						raw = args[1]
					}
					return fcCompress(input, fcTargetClamp(raw))
				},
			},
		},
	}
}
