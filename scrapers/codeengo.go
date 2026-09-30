// codeengo.go — Go port of codeengo.ts (Codeengo text-to-image).
//
// Reference: codeengo.ts — base https://codeengo.com, rateMs 500, timeoutMs
// 60s, JSON POST to /api/image.php with referer /text-to-image.php; `styles`
// lists the presets in declaration order.
//
// DELIBERATE DIVERGENCE (per the port contract): the TS version uploads the
// generated PNG/JPEG to the third-party host https://uguu.se/upload and returns
// the resulting public URL. That upload is NOT ported — the port writes the
// image locally and returns the local path + size, with `url` kept as null so
// the payload key shape stays identical to the TS reference.
package scrapers

import (
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"time"
)

// NewCodeengo builds the Codeengo scraper (exposed so a host binary can embed it).
func NewCodeengo() Scraper { return codeengoScraper() }

func init() { register(codeengoScraper()) }

var codeengoSite = NewSite(SiteConfig{
	Base:      "https://codeengo.com",
	RateMS:    500,
	TimeoutMS: 60000,
	Headers: map[string]string{
		"user-agent":   "Mozilla/5.0 (Linux; Android 10; M2006C3MG)",
		"accept":       "application/json, text/plain, */*",
		"content-type": "application/json",
		"origin":       "https://codeengo.com",
		"referer":      "https://codeengo.com/text-to-image.php",
	},
})

// codeengoStyleNames preserves the TS object declaration order (Object.keys).
var codeengoStyleNames = []string{"cyberpunk", "fantasy", "interior", "anime", "dragon", "butterfly"}

// codeengoStyles mirrors the STYLES record verbatim.
var codeengoStyles = map[string]string{
	"cyberpunk": "A hyper-realistic cyber-enhanced hacker in a rain-soaked Tokyo alley, glowing magenta and cyan neon signs reflecting on wet asphalt, dense fog, holographic displays in windows, cinematic depth of field, SDXL-Lightning render, 8k resolution.",
	"fantasy":   "Floating islands with waterfalls in a sunset sky, ghibli style",
	"interior":  "Minimalist luxury living room with large glass windows overlooking forest",
	"anime":     "cute anime girl with blue eyes",
	"dragon":    "a majestic dragon over a snowy mountain, cinematic lighting, ultra-realistic",
	"butterfly": "Macro photography of a mechanical butterfly on a flower",
}

// codeengoGenerateRaw POSTs the prompt and returns the decoded API payload.
func codeengoGenerateRaw(prompt string) (map[string]any, error) {
	body, err := JSONStringify(map[string]any{"prompt": prompt})
	if err != nil {
		return nil, err
	}
	if len(body) > maxPostBodyBytes {
		return nil, errors.New("Prompt too large")
	}
	text, err := codeengoSite.PostJSON("/api/image.php", body, "/text-to-image.php")
	if err != nil {
		return nil, err
	}
	return DecodeObject(text)
}

// codeengoGenerate writes the generated image locally and reports its size.
// The third-party (uguu.se) upload of the TS version is intentionally omitted.
func codeengoGenerate(prompt string) (map[string]any, error) {
	data, err := codeengoGenerateRaw(prompt)
	if err != nil {
		return nil, err
	}
	success, _ := data["success"].(bool)
	imageURL := GetStr(data, "image")
	if !success || imageURL == "" {
		msg := GetStr(data, "error")
		if msg == "" {
			msg = "unknown error"
		}
		return map[string]any{"success": false, "error": msg}, nil
	}
	buf, err := decodeDataImage(imageURL)
	if err != nil {
		return nil, err
	}
	filename := fmt.Sprintf("codeengo_%d.jpg", time.Now().UnixMilli())
	if err := os.WriteFile(filename, buf, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{
		"success":   true,
		"localPath": filename,
		"url":       nil, // no uguu.se upload in the Go port
		"sizeKB":    math.Round(float64(len(buf)) / 1024),
	}, nil
}

// decodeDataImage mirrors `Buffer.from(image.replace('data:image/png;base64,',”), 'base64')`,
// including Node's lenient decoding (unknown characters are ignored).
func decodeDataImage(image string) ([]byte, error) {
	b64 := strings.Replace(image, "data:image/png;base64,", "", 1)
	clean := make([]byte, 0, len(b64))
	for i := range len(b64) {
		c := b64[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' {
			clean = append(clean, c)
		}
	}
	if rem := len(clean) % 4; rem != 0 {
		clean = append(clean, strings.Repeat("=", 4-rem)...)
	}
	out, err := base64.StdEncoding.DecodeString(string(clean))
	if err != nil {
		return nil, fmt.Errorf("invalid base64 image payload: %w", err)
	}
	return out, nil
}

func codeengoScraper() Scraper {
	return Scraper{
		Name:  "codeengo",
		Title: "Codeengo Text-to-Image",
		Commands: map[string]Command{
			"generate": {
				Desc:  "Generate an image from a style preset or freeform prompt",
				Usage: "<style|prompt>",
				// writes codeengo_<ms>.jpg to the working directory: CLI only.
				LocalOnly: true,
				Run: func(args []string, _ map[string]string) (any, error) {
					arg := argAt(args, 0)
					if arg == "" {
						return nil, errors.New("Usage: codeengo generate <style|prompt>")
					}
					prompt, isStyle := codeengoStyles[arg]
					if !isStyle {
						prompt = arg
					}
					gen, err := codeengoGenerate(prompt)
					if err != nil {
						return nil, err
					}
					if !isStyle {
						return gen, nil
					}
					out := map[string]any{"style": arg}
					for k, v := range gen {
						out[k] = v
					}
					return out, nil
				},
			},
			"styles": {
				Desc: "List all style presets",
				Run: func([]string, map[string]string) (any, error) {
					out := make([]any, 0, len(codeengoStyleNames))
					for _, name := range codeengoStyleNames {
						out = append(out, name)
					}
					return out, nil
				},
			},
			"test": {
				Desc: "Generate all styles (slow)",
				// writes one image per style: CLI only.
				LocalOnly: true,
				Run: func([]string, map[string]string) (any, error) {
					results := make([]any, 0, len(codeengoStyleNames))
					for _, name := range codeengoStyleNames {
						gen, err := codeengoGenerate(codeengoStyles[name])
						if err != nil {
							return nil, err
						}
						out := map[string]any{"style": name}
						for k, v := range gen {
							out[k] = v
						}
						results = append(results, out)
						time.Sleep(1500 * time.Millisecond)
					}
					return results, nil
				},
			},
		},
	}
}
