// Package scrapers hosts the Go ports of the Bun/TypeScript scrapers, sharing a
// single hardened transport (transport.go) so every site gets the same SSRF
// guards, per-host rate limiting, timeouts, size caps and retry policy.
package scrapers

import (
	"sort"
	"sync"
)

// Command is one CLI subcommand of a Scraper. Run receives the positional
// arguments after the command name and the parsed --flags map (bare switches
// are "true"); it returns the payload that will be JSON-encoded.
type Command struct {
	Name  string
	Desc  string
	Usage string
	// Flags maps a flag name to "value" (may consume the next token) or "bool".
	Flags map[string]string
	// LocalOnly marks a command that touches the local filesystem (reads an
	// arbitrary path and uploads it, or writes a file next to the process).
	// Such a command must never be exposed over HTTP: a query string cannot be
	// allowed to name a server-side path. The HTTP route table skips these.
	LocalOnly bool
	Run       func(args []string, flags map[string]string) (any, error)
}

// Scraper is a named bundle of commands.
type Scraper struct {
	Name     string
	Title    string
	Commands map[string]Command
}

// registry holds every scraper in this package.
var registry []Scraper

// register appends a scraper to the package registry (called from each
// scraper's init).
func register(s Scraper) { registry = append(registry, s) }

// All returns every scraper ported into this package, ordered by name.
func All() []Scraper {
	out := make([]Scraper, len(registry))
	copy(out, registry)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Find looks a scraper up by its CLI name.
func Find(name string) (Scraper, bool) {
	for _, s := range All() {
		if s.Name == name {
			return s, true
		}
	}
	return Scraper{}, false
}

// MapConcurrent maps fn over items with at most limit goroutines in flight,
// preserving input order (mirrors the TS mapWithConcurrency helper). The
// transport already serialises requests per host, so this wins on latency
// without adding origin load.
func MapConcurrent[T any, R any](items []T, limit int, fn func(T) R) []R {
	out := make([]R, len(items))
	if limit < 1 {
		limit = 1
	}
	if limit > len(items) {
		limit = len(items)
	}
	var wg sync.WaitGroup
	next := 0
	var mu sync.Mutex
	worker := func() {
		defer wg.Done()
		for {
			mu.Lock()
			i := next
			next++
			mu.Unlock()
			if i >= len(items) {
				return
			}
			out[i] = fn(items[i])
		}
	}
	wg.Add(limit)
	for w := 0; w < limit; w++ {
		go worker()
	}
	wg.Wait()
	return out
}
