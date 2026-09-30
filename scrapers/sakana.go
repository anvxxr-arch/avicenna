// sakana.go — Go port of sakana.ts (SakanaAI Chat, chat.sakana.ai).
//
// The reference authenticates in three hops, and so does this port:
//
//  1. Firebase anonymous signup — POST identitytoolkit.googleapis.com
//     /v1/accounts:signUp with the real web API key (SAKANA_FIREBASE_KEY). The
//     key committed in the reference is a redacted placeholder ('AIzaSy...f_I4'),
//     so without the env var every command fails with the actionable message
//     "(is SAKANA_FIREBASE_KEY valid?)" — that IS the contract.
//  2. POST chat.sakana.ai/api/auth/login, form-encoded, redirect:'manual': the
//     sakana-chat= session cookie is read off the 3xx Set-Cookie.
//  3. Authenticated calls carrying that cookie: /api/agents, /api/conversations,
//     DELETE /conversation/:id, and the chat flow — POST /conversation to open a
//     conversation, then POST /conversation/:id whose body is an SSE stream
//     accumulated token by token into the final answer.
//
// Hosts are pinned: chat.sakana.ai for the site, identitytoolkit.googleapis.com
// for the signup hop (mechanically the reference's requestExternal child site).
// The chat POST body is framed as multipart/form-data with a single `data` field,
// exactly the shape Bun's FormData produces in the reference. The site timeout is
// the stream's 120s deadline — the reference's per-call abort signals (15s default,
// 30s for login/create, 120s for the stream) all bound the same two hosts.
package scrapers

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"regexp"
	"strings"
)

const (
	sakanaBaseURL = "https://chat.sakana.ai"
	// sakanaFirebaseSignup is the Firebase signup endpoint; the `key` query
	// parameter is appended per request.
	sakanaFirebaseSignup = "https://identitytoolkit.googleapis.com/v1/accounts:signUp"
	// sakanaFirebaseKeyDefault is the reference's committed key: a redacted
	// placeholder, which is why SAKANA_FIREBASE_KEY must be set for the flow to
	// get past signup.
	sakanaFirebaseKeyDefault = "AIzaSy...f_I4"
	sakanaTenantID           = "sakana-talk-prd-pvl72"
	sakanaCreator            = "rynaqrtz"
)

// sakanaChatHosts is the complete host allowlist for the authenticated API
// calls (the pinned origin only).
var sakanaChatHosts = []string{"chat.sakana.ai"}

// sakanaFirebaseHosts is the signup hop's explicit allowlist.
var sakanaFirebaseHosts = []string{"identitytoolkit.googleapis.com"}

// sakanaModels is MODELS from the reference, in order (the error message joins
// it verbatim).
var sakanaModels = []string{"namazu", "sakana", "namazu-v2", "namazu-pro", "llama"}

// sakanaFirebaseKey is `process.env.SAKANA_FIREBASE_KEY || '<redacted>'`.
func sakanaFirebaseKey() string {
	if k := os.Getenv("SAKANA_FIREBASE_KEY"); k != "" {
		return k
	}
	return sakanaFirebaseKeyDefault
}

// sakanaSite is the pinned chat.sakana.ai client: rateMs 500 like the reference,
// 120s timeout for the SSE stream.
var sakanaSite = NewSite(SiteConfig{
	Base:   sakanaBaseURL,
	RateMS: 500,
	// The reference's longest deadline on this flow (AbortSignal.timeout(120_000)
	// for the chat stream); the shorter 30s create/login signals only bound the
	// same hosts.
	TimeoutMS: 120_000,
	Headers: map[string]string{
		"user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
	},
})

// sakanaApi is the reference's `site.request()` (follow:false): guards, limiter,
// retries — and a 3xx is reported with the reference's wording, since it never
// follows redirects on the JSON paths. The login hop uses siteRequest directly,
// because there a 3xx is the answer (`redirect:'manual'`).
func sakanaApi(rawURL, method string, body []byte, headers map[string]string) (*APIResp, error) {
	res, err := siteRequest(sakanaSite, rawURL, method, body, headers, false, sakanaChatHosts)
	if err != nil {
		return nil, err
	}
	if res.Status >= 300 && res.Status < 400 {
		return nil, fmt.Errorf("Redirect %d not allowed for %s", res.Status, rawURL)
	}
	return res, nil
}

// sakanaSignupIDToken signs up anonymously on Firebase and returns the id token.
func sakanaSignupIDToken() (string, error) {
	body, err := JSONStringify(map[string]any{
		"returnSecureToken": true,
		"tenantId":          sakanaTenantID,
	})
	if err != nil {
		return "", err
	}
	res, err := sakanaSite.External(
		sakanaFirebaseSignup+"?key="+sakanaFirebaseKey(),
		[]byte(body),
		"application/json",
		sakanaFirebaseHosts,
	)
	if err != nil {
		return "", err
	}
	// The body is decoded regardless of status: Firebase reports the bad-key case
	// as a 400 whose JSON error message is what the CLI surfaces.
	token, msg := "", ""
	if m, derr := apiDecodeMap(res.Body); derr == nil {
		token = jstr(m["idToken"])
		msg = mstr(m, "error", "message")
	}
	if token == "" {
		detail := msg
		if detail == "" {
			detail = fmt.Sprint(res.Status)
		}
		return "", fmt.Errorf("Firebase signup failed: %s (is SAKANA_FIREBASE_KEY valid?)", detail)
	}
	return token, nil
}

// sakanaLoginCookie exchanges the id token for the sakana-chat= session cookie.
//
// The reference passes `redirect:'manual'`, but its core `request()` still throws
// on any 3xx when `follow` is false — so a redirect here is an error, not a
// cookie source (on the live site the login answers 2xx with Set-Cookie). The
// hop therefore goes through the same redirect-refusing path as every other call.
func sakanaLoginCookie(idToken string) (string, error) {
	form := "idToken=" + EncodeURIComponent(idToken)
	res, err := sakanaApi(sakanaBaseURL+"/api/auth/login", http.MethodPost,
		[]byte(form),
		map[string]string{
			"content-type": "application/x-www-form-urlencoded",
			"origin":       sakanaBaseURL,
			"referer":      sakanaBaseURL,
		})
	if err != nil {
		return "", err
	}
	if res.Status < 200 || res.Status >= 300 {
		return "", fmt.Errorf("login HTTP %d", res.Status)
	}
	for _, raw := range res.Header.Values("Set-Cookie") {
		name := raw
		if i := strings.IndexByte(name, ';'); i >= 0 {
			name = name[:i]
		}
		if strings.HasPrefix(strings.TrimSpace(name), "sakana-chat=") {
			return strings.TrimSpace(name), nil
		}
	}
	return "", errors.New("Failed to get session cookie")
}

// sakanaGetCookie runs the signup + login pair (getCookie in the reference).
func sakanaGetCookie() (string, error) {
	idToken, err := sakanaSignupIDToken()
	if err != nil {
		return "", err
	}
	return sakanaLoginCookie(idToken)
}

// sakanaGetModels lists the agent ids.
func sakanaGetModels() ([]any, error) {
	cookie, err := sakanaGetCookie()
	if err != nil {
		return nil, err
	}
	res, err := sakanaApi(sakanaBaseURL+"/api/agents", http.MethodGet, nil,
		map[string]string{"cookie": cookie})
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("agents HTTP %d", res.Status)
	}
	var rows []any
	if err := json.Unmarshal(res.Body, &rows); err != nil {
		return nil, err
	}
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, mstr(r, "id"))
	}
	return out, nil
}

// sakanaGetConversations lists recent conversations.
func sakanaGetConversations(limit int) ([]any, error) {
	cookie, err := sakanaGetCookie()
	if err != nil {
		return nil, err
	}
	res, err := sakanaApi(fmt.Sprintf("%s/api/conversations?limit=%d", sakanaBaseURL, limit),
		http.MethodGet, nil, map[string]string{"cookie": cookie})
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("conversations HTTP %d", res.Status)
	}
	var rows []any
	if err := json.Unmarshal(res.Body, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// sakanaNull is the reference's `null` for a delete whose body is not JSON
// (`res.json().catch(() => null)`). It is a value rather than a bare nil because
// Clean drops untyped nils — and the reference does emit the key as null.
type sakanaNull struct{}

func (sakanaNull) MarshalJSON() ([]byte, error) { return []byte("null"), nil }

// sakanaDeleteConversation deletes one conversation. A non-JSON body is `null`,
// like the reference's `res.json().catch(() => null)`.
func sakanaDeleteConversation(id string) (any, error) {
	cookie, err := sakanaGetCookie()
	if err != nil {
		return nil, err
	}
	res, err := sakanaApi(sakanaBaseURL+"/conversation/"+EncodeURIComponent(id), http.MethodDelete, nil,
		map[string]string{"cookie": cookie, "origin": sakanaBaseURL})
	if err != nil {
		return nil, err
	}
	if res.Status < 200 || res.Status >= 300 {
		return nil, fmt.Errorf("delete HTTP %d", res.Status)
	}
	var v any
	if err := json.Unmarshal(res.Body, &v); err != nil || v == nil {
		return sakanaNull{}, nil
	}
	return v, nil
}

// === ANSWER CLEANUP (cleanText + the tag strippers, verbatim) ===

// sakanaJSWS is JS `\s` (Go's RE2 \s is ASCII-only, so the Unicode spaces are
// spelled out to keep the whitespace collapse identical).
const sakanaJSWS = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	sakanaPlanRe   = regexp.MustCompile(`(?s)<plan>.*?</plan>`)
	sakanaThinkRe  = regexp.MustCompile(`(?s)<think>.*?</think>`)
	sakanaChipRe   = regexp.MustCompile(`<source-chip[^>]*/>`)
	sakanaTagRe    = regexp.MustCompile(`</?[a-zA-Z0-9_-]+[^>]*>`)
	sakanaBold2Re  = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	sakanaItalicRe = regexp.MustCompile(`\*([^*]+)\*`)
	sakanaUnderRe  = regexp.MustCompile(`_([^_]+)_`)
	sakanaBulletRe = regexp.MustCompile(`(?m)^-` + sakanaJSWS + `+`)
	sakanaNumberRe = regexp.MustCompile(`(?m)^\d+\.` + sakanaJSWS + `+`)
	sakanaHeadRe   = regexp.MustCompile(`#{1,6}` + sakanaJSWS + `*`)
	sakanaSpaceRe  = regexp.MustCompile(sakanaJSWS + `+`)
)

// sakanaCleanText is cleanText() from the reference.
func sakanaCleanText(text string) string {
	text = sakanaBold2Re.ReplaceAllString(text, "$1")
	text = sakanaItalicRe.ReplaceAllString(text, "$1")
	text = sakanaUnderRe.ReplaceAllString(text, "$1")
	text = sakanaBulletRe.ReplaceAllString(text, "")
	text = sakanaNumberRe.ReplaceAllString(text, "")
	text = sakanaHeadRe.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "\n", " ")
	text = sakanaSpaceRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

// sakanaStripTags removes the plan/think blocks and inline tags before cleanup.
func sakanaStripTags(text string) string {
	text = sakanaPlanRe.ReplaceAllString(text, "")
	text = sakanaThinkRe.ReplaceAllString(text, "")
	text = sakanaChipRe.ReplaceAllString(text, "")
	return sakanaTagRe.ReplaceAllString(text, "")
}

// === CHAT ===

type sakanaChatOpts struct {
	Model           string
	ConversationID  string
	ParentMessageID string
	NeedSearch      int
	Thinking        int
	ToneMode        string
	StreamOutput    bool
}

type sakanaChatResult struct {
	Text            string
	ConversationID  string
	ParentMessageID any
}

func sakanaHasModel(model string) bool {
	for _, m := range sakanaModels {
		if m == model {
			return true
		}
	}
	return false
}

// sakanaUUID is randomUUID() from node:crypto.
func sakanaUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on Linux; a zero UUID would still be a valid
		// message id, so never surface an error the reference cannot produce.
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// sakanaMultipartData frames the chat payload the way Bun's FormData does in the
// reference: a multipart/form-data body whose single part is `data`.
func sakanaMultipartData(payload string) (body []byte, contentType string, err error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreatePart(textproto.MIMEHeader{
		"Content-Disposition": {`form-data; name="data"`},
	})
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write([]byte(payload)); err != nil {
		return nil, "", err
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), mw.FormDataContentType(), nil
}

// sakanaCollectStream walks the SSE body: it accumulates the `stream` tokens
// (NUL-stripped, and handed to emit when the caller wants them echoed) and
// returns the raw text plus the `createdMessage` messageId as delivered. Like
// the reference's reader loop, a trailing partial line is never flushed and
// non-JSON lines are skipped.
func sakanaCollectStream(body []byte, emit func(string)) (string, any) {
	lines := strings.Split(string(body), "\n")
	if len(lines) > 0 {
		lines = lines[:len(lines)-1]
	}
	full := ""
	var messageID any
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(trimmed), &ev); err != nil {
			continue // skip non-JSON lines
		}
		switch jstr(ev["type"]) {
		case "createdMessage":
			if v := ev["messageId"]; jbool(v) {
				messageID = v
			}
		case "stream":
			if v := ev["token"]; jbool(v) {
				token := strings.ReplaceAll(jstr(v), "\x00", "")
				full += token
				if emit != nil {
					emit(token)
				}
			}
		}
	}
	return full, messageID
}

// sakanaChat mirrors chat() in the reference: create a conversation when none is
// given, POST the follow-up message as multipart/form-data and accumulate the
// SSE stream.
func sakanaChat(question string, o sakanaChatOpts) (sakanaChatResult, error) {
	var zero sakanaChatResult
	model := o.Model
	if model == "" {
		model = "namazu"
	}
	toneMode := o.ToneMode
	if toneMode == "" {
		toneMode = "default"
	}
	if question == "" {
		return zero, errors.New("Question is required.")
	}
	if o.Thinking != 0 && o.NeedSearch != 0 {
		return zero, errors.New("Thinking and Web Search cannot be used together.")
	}
	if !sakanaHasModel(model) {
		return zero, fmt.Errorf("Model not found. Available: %s", strings.Join(sakanaModels, ", "))
	}
	cookie, err := sakanaGetCookie()
	if err != nil {
		return zero, err
	}
	convID := o.ConversationID
	var parentID any
	parentSet := false
	if o.ParentMessageID != "" {
		parentID, parentSet = o.ParentMessageID, true
	}
	if convID == "" {
		body, err := JSONStringify(map[string]any{
			"inputs":           question,
			"enableThinking":   o.Thinking == 1,
			"toneMode":         toneMode,
			"webSearchEnabled": o.NeedSearch == 1,
			"agentId":          model,
		})
		if err != nil {
			return zero, err
		}
		res, err := sakanaApi(sakanaBaseURL+"/conversation", http.MethodPost, []byte(body), map[string]string{
			"cookie":       cookie,
			"content-type": "application/json",
			"origin":       sakanaBaseURL,
			"referer":      sakanaBaseURL,
		})
		if err != nil {
			return zero, err
		}
		if res.Status < 200 || res.Status >= 300 {
			return zero, fmt.Errorf("conversation create HTTP %d", res.Status)
		}
		m, err := apiDecodeMap(res.Body)
		if err != nil {
			return zero, err
		}
		convID = jstr(m["conversationId"])
		if v, ok := mgetOK(m, "systemMessageId"); ok {
			parentID, parentSet = v, true
		}
	}
	payload := map[string]any{
		"inputs":           question,
		"is_retry":         false,
		"is_continue":      false,
		"enableThinking":   o.Thinking == 1,
		"toneMode":         toneMode,
		"webSearchEnabled": o.NeedSearch == 1,
		"userMessageId":    sakanaUUID(),
	}
	if parentSet {
		payload["id"] = parentID
	}
	payloadJSON, err := JSONStringify(payload)
	if err != nil {
		return zero, err
	}
	mpBody, mpType, err := sakanaMultipartData(payloadJSON)
	if err != nil {
		return zero, err
	}
	res, err := sakanaApi(sakanaBaseURL+"/conversation/"+convID, http.MethodPost, mpBody, map[string]string{
		"cookie":           cookie,
		"content-type":     mpType,
		"origin":           sakanaBaseURL,
		"referer":          sakanaBaseURL,
		"x-requested-with": "com.xbrowser.play",
	})
	if err != nil {
		return zero, err
	}
	// The reference also rejects a bodyless 2xx here (`!res.body`).
	if res.Status < 200 || res.Status >= 300 || res.Status == http.StatusNoContent {
		return zero, fmt.Errorf("chat stream HTTP %d", res.Status)
	}
	var emit func(string)
	if o.StreamOutput {
		emit = func(token string) { fmt.Print(token) }
	}
	full, msgID := sakanaCollectStream(res.Body, emit)
	if msgID == nil {
		// The reference returns `null` when the stream never announced a
		// createdMessage; Clean drops bare nils, so the typed null carries it.
		msgID = sakanaNull{}
	}
	cleaned := sakanaCleanText(sakanaStripTags(full))
	if o.StreamOutput {
		fmt.Print("\n")
	}
	return sakanaChatResult{Text: cleaned, ConversationID: convID, ParentMessageID: msgID}, nil
}

// === CLI ===

func sakanaBit(b bool) int {
	if b {
		return 1
	}
	return 0
}

// sakanaConversationLimit mirrors `parseInt(f.limit || '20') || 20`.
func sakanaConversationLimit(raw string) int {
	if raw == "" {
		return 20
	}
	if n, ok := ParseIntJS(raw); ok && n != 0 {
		return n
	}
	return 20
}

// sakanaScraper builds the CLI surface (commands, flags and payloads identical
// to the TS reference).
func sakanaScraper() Scraper {
	return Scraper{
		Name:  "sakana",
		Title: "SakanaAI Chat (chat.sakana.ai)",
		Commands: map[string]Command{
			"chat": {
				Name: "chat", Desc: "Tanya SakanaAI", Usage: "<question> [--model namazu] [--search] [--thinking] [--stream]",
				Flags: map[string]string{"model": "value"},
				Run: func(args []string, flags map[string]string) (any, error) {
					question := strings.Join(args, " ")
					model := flags["model"]
					if model == "" {
						model = "namazu"
					}
					search := flags["search"] != ""
					thinking := flags["thinking"] != ""
					res, err := sakanaChat(question, sakanaChatOpts{
						Model:        model,
						NeedSearch:   sakanaBit(search),
						Thinking:     sakanaBit(thinking),
						StreamOutput: flags["stream"] != "",
					})
					if err != nil {
						return nil, err
					}
					return Clean(map[string]any{
						"creator": sakanaCreator,
						"info": map[string]any{
							"model":    model,
							"search":   search,
							"thinking": thinking,
							"status":   "ok",
						},
						"data": map[string]any{
							"text":            res.Text,
							"conversationId":  res.ConversationID,
							"parentMessageId": res.ParentMessageID,
						},
					}), nil
				},
			},
			"models": {
				Name: "models", Desc: "List available agent models",
				Run: func(_ []string, _ map[string]string) (any, error) {
					models, err := sakanaGetModels()
					if err != nil {
						return nil, err
					}
					return Clean(map[string]any{
						"creator": sakanaCreator,
						"info":    map[string]any{"command": "models", "status": "ok"},
						"data":    map[string]any{"models": models},
					}), nil
				},
			},
			"conversations": {
				Name: "conversations", Desc: "List recent conversations", Usage: "[--limit N]",
				Flags: map[string]string{"limit": "value"},
				Run: func(_ []string, flags map[string]string) (any, error) {
					convs, err := sakanaGetConversations(sakanaConversationLimit(flags["limit"]))
					if err != nil {
						return nil, err
					}
					return Clean(map[string]any{
						"creator": sakanaCreator,
						"info":    map[string]any{"command": "conversations", "status": "ok"},
						"data":    map[string]any{"conversations": convs},
					}), nil
				},
			},
			"delete": {
				Name: "delete", Desc: "Delete a conversation by id", Usage: "<id>",
				Run: func(args []string, _ map[string]string) (any, error) {
					if len(args) == 0 || args[0] == "" {
						return nil, errors.New("Missing conversation ID")
					}
					deleted, err := sakanaDeleteConversation(args[0])
					if err != nil {
						return nil, err
					}
					return Clean(map[string]any{
						"creator": sakanaCreator,
						"info":    map[string]any{"command": "delete", "status": "ok"},
						"data":    map[string]any{"deleted": deleted},
					}), nil
				},
			},
		},
	}
}

// init registers the scraper with the package registry (scrapers.All/Find).
func init() { register(sakanaScraper()) }
