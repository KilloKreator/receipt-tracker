package main

// Receipt storage: one data.json file + a folder of receipt images, in
// Documents\KellerKraft Receipts. Easy to back up: copy the whole folder.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Payee struct {
	Name  string   `json:"name"`
	Words []string `json:"words"`
}

type Receipt struct {
	ID         string   `json:"id"`
	Created    int64    `json:"created"`
	Updated    int64    `json:"updated"`
	Received   int64    `json:"received"`
	Date       string   `json:"date"`
	Total      *float64 `json:"total"`
	Payee      string   `json:"payee"`
	Memo       string   `json:"memo"`
	MemoManual bool     `json:"memoManual"`
	Customer   string   `json:"customer"`
	Category   string   `json:"category"`
	Note       string   `json:"note"`
	OCRText    string   `json:"ocrText"`
	HasImage   bool     `json:"hasImage"`
	// Set when the receipt has been put in a PDF (to avoid putting it in twice)
	PdfAt   int64  `json:"pdfAt,omitempty"`
	PdfName string `json:"pdfName,omitempty"`
	// Set when the receipt has been billed to the customer (its amount no longer counts as "to bill")
	BilledAt int64 `json:"billedAt,omitempty"`
	// Receipts added on the computer: "computer"; the original file (e.g. a PDF) is kept
	Source   string `json:"source,omitempty"`
	Original string `json:"original,omitempty"`
}

type Device struct {
	Token   string `json:"token"`
	Name    string `json:"name"`
	Created int64  `json:"created"`
}

type Data struct {
	Receipts   []*Receipt `json:"receipts"`
	Customers  []string   `json:"customers"`
	Categories []string   `json:"categories"`
	Payees     []Payee    `json:"payees"`
	UseNames   bool       `json:"useNames"`
	Devices    []Device   `json:"devices"`
	// IIF converter settings (accounts, category rules, export history). Payees above are the master list.
	Converter json.RawMessage `json:"converter,omitempty"`
}

type Store struct {
	mu   sync.Mutex
	dir  string
	data Data
}

func openStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, data: Data{UseNames: true}}
	b, err := os.ReadFile(filepath.Join(dir, "data.json"))
	if err == nil {
		if err := json.Unmarshal(b, &s.data); err != nil {
			// keep a copy of the unreadable file instead of losing it
			os.WriteFile(filepath.Join(dir, "data.json.broken-"+time.Now().Format("20060102-150405")), b, 0644)
			s.data = Data{UseNames: true}
		}
	}
	// The standard QuickBooks catch-all category is always on the list
	s.data.Categories = cleanList(append(s.data.Categories, DefaultCategory))
	return s, nil
}

const DefaultCategory = "Uncategorized Expenses"

// caller holds the lock
func (s *Store) save() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, "data.json.tmp")
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.dir, "data.json"))
}

func (s *Store) imagePath(id string) string { return filepath.Join(s.dir, "images", id+".jpg") }
func (s *Store) originalPath(id, ext string) string {
	return filepath.Join(s.dir, "originals", id+ext)
}

func cleanList(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range in {
		v = strings.Join(strings.Fields(v), " ")
		k := strings.ToLower(v)
		if v == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	return out
}

func cleanPayees(in []Payee) []Payee {
	seen := map[string]int{}
	var out []Payee
	for _, p := range in {
		p.Name = strings.Join(strings.Fields(p.Name), " ")
		if p.Name == "" {
			continue
		}
		var words []string
		for _, w := range p.Words {
			if w = strings.Join(strings.Fields(w), " "); w != "" {
				words = append(words, w)
			}
		}
		if i, ok := seen[strings.ToLower(p.Name)]; ok {
			out[i].Words = append(out[i].Words, words...)
			continue
		}
		seen[strings.ToLower(p.Name)] = len(out)
		out = append(out, Payee{p.Name, words})
	}
	for i := range out {
		out[i].Words = cleanList(out[i].Words)
		if out[i].Words == nil {
			out[i].Words = []string{}
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func (s *Store) findReceipt(id string) *Receipt {
	for _, r := range s.data.Receipts {
		if r.ID == id {
			return r
		}
	}
	return nil
}
