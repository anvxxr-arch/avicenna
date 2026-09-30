// Temporary scratch test — deleted after the sakana port is verified.
package scrapers

import (
	"encoding/json"
	"mime"
	"mime/multipart"
	"os"
	"strings"
	"testing"
)

var zzSakanaFixtures = []string{
	"**bold** and *italic* and _under_",
	"- item one\n- item two\n1. first\n2. second\n# Head\n## Sub",
	"<plan>secret plan</plan>visible<think>hidden</think>after<source-chip id=\"1\"/>end",
	"line1\nline2   with\tspace\u00a0nbsp",
	"<b>bold</b> <a href=\"x\">link</a> 3.14 keep",
	"multi\n\n\nblank\n \nlines",
	"no markdown here",
}

func TestZZSakanaMultipartData(t *testing.T) {
	payload := `{"inputs":"hi","id":null,"flag":true}`
	body, ct, err := sakanaMultipartData(payload)
	if err != nil {
		t.Fatal(err)
	}
	mt, params, err := mime.ParseMediaType(ct)
	if err != nil || mt != "multipart/form-data" || params["boundary"] == "" {
		t.Fatalf("bad content-type %q (%v)", ct, err)
	}
	mr := multipart.NewReader(strings.NewReader(string(body)), params["boundary"])
	f, err := mr.ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Value["data"]) != 1 || f.Value["data"][0] != payload {
		t.Fatalf("data field = %#v", f.Value["data"])
	}
	if len(f.File) != 0 {
		t.Fatalf("unexpected file parts: %v", f.File)
	}
}
func TestZZSakanaCollectStream(t *testing.T) {
	body := `{"type":"createdMessage","messageId":"m-1"}
not json at all
{"type":"stream","token":"Hello"}
{"type":"stream","token":" wor\u0000ld"}
{"type":"stream","token":"!"}
` + `{"type":"done"}`
	var echoed []string
	full, msgID := sakanaCollectStream([]byte(body), func(s string) { echoed = append(echoed, s) })
	if full != "Hello world!" {
		t.Fatalf("full = %q", full)
	}
	if msgID != "m-1" {
		t.Fatalf("msgID = %#v", msgID)
	}
	if strings.Join(echoed, "|") != "Hello| world|!" {
		t.Fatalf("echoed = %#v", echoed)
	}
	// A final event without a trailing newline is never flushed (reader-loop
	// semantics).
	full2, _ := sakanaCollectStream([]byte("{\"type\":\"stream\",\"token\":\"a\"}\n{\"type\":\"stream\",\"token\":\"b\"}"), nil)
	if full2 != "a" {
		t.Fatalf("trailing partial line must be dropped, got %q", full2)
	}
}

func TestZZSakanaConversationLimit(t *testing.T) {
	cases := map[string]int{"": 20, "5": 5, "0": 20, "abc": 20, "-3": -3, " 7x": 7}
	for in, want := range cases {
		if got := sakanaConversationLimit(in); got != want {
			t.Fatalf("limit(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestZZSakanaCleanTextTable(t *testing.T) {
	if os.Getenv("SK_CORPUS") == "" {
		t.Skip("corpus mode only")
	}
	for _, f := range zzSakanaFixtures {
		out, err := json.Marshal(sakanaCleanText(sakanaStripTags(f)))
		if err != nil {
			t.Fatal(err)
		}
		println(string(out))
	}
}
