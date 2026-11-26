package main

// Sync by file: for phones that can't reach the computer over Wi-Fi.
//  • The phone makes a .zip (receipts.json + images/<id>.jpg) and the user emails it,
//    saves it to iCloud/OneDrive, etc. "Import from phone" reads it here.
//  • The computer makes a small lists file (customers, payees, categories, and which
//    receipts it has) that the phone loads, so the phone knows its receipts arrived.

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type phoneFile struct {
	Format   string `json:"format"`
	Receipts []struct {
		Receipt
		ImageOnly bool `json:"imageOnly"`
	} `json:"receipts"`
	Pending struct {
		Customers  []string `json:"customers"`
		Categories []string `json:"categories"`
	} `json:"pending"`
}

func registerPhoneFile(mux *http.ServeMux) {
	mux.HandleFunc("/local/import", local(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			jsonErr(w, 405, "POST only")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			jsonErr(w, 400, "The file is too big or broken.")
			return
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			jsonErr(w, 400, "No file.")
			return
		}
		defer f.Close()
		zr, err := zip.NewReader(f, hdr.Size)
		if err != nil {
			jsonErr(w, 400, "This isn't a receipts file from the phone (it should be a .zip made with \"Send receipts as a file\").")
			return
		}
		files := map[string]*zip.File{}
		for _, zf := range zr.File {
			files[zf.Name] = zf
		}
		jf := files["timesaver-receipts.json"]
		if jf == nil {
			jsonErr(w, 400, "This .zip isn't a receipts file from the Receipts app.")
			return
		}
		var pf phoneFile
		if rc, err := jf.Open(); err == nil {
			err = json.NewDecoder(io.LimitReader(rc, 64<<20)).Decode(&pf)
			rc.Close()
			if err != nil || pf.Format != "timesaver-receipts" {
				jsonErr(w, 400, "The receipts file is damaged.")
				return
			}
		}
		// write a picture from the zip into the images folder
		saveImg := func(id string) (bool, error) {
			zf := files["images/"+id+".jpg"]
			if zf == nil {
				return false, nil
			}
			rc, err := zf.Open()
			if err != nil {
				return false, err
			}
			defer rc.Close()
			tmp := store.imagePath(id) + ".tmp"
			out, err := os.Create(tmp)
			if err != nil {
				return false, err
			}
			_, err = io.Copy(out, io.LimitReader(rc, 64<<20))
			out.Close()
			if err == nil {
				err = os.Rename(tmp, store.imagePath(id))
			}
			return err == nil, err
		}
		added, updated, pictures, same := 0, 0, 0, 0
		now := time.Now().UnixMilli()
		store.mu.Lock()
		defer store.mu.Unlock()
		for _, it := range pf.Receipts {
			rec := it.Receipt
			if !idRe.MatchString(rec.ID) {
				continue
			}
			old := store.findReceipt(rec.ID)
			switch {
			case old == nil: // new on the computer
				ok, err := saveImg(rec.ID)
				if err != nil {
					jsonErr(w, 500, "Couldn't save a picture: "+err.Error())
					return
				}
				rec.HasImage, rec.Received = ok, now
				rec.PdfAt, rec.PdfName, rec.BilledAt, rec.PdfOrder = 0, "", 0, 0
				rec.Source, rec.Original = "", ""
				store.data.Receipts = append(store.data.Receipts, &rec)
				added++
			case it.ImageOnly: // a better scan of a receipt the computer already has: picture only
				ok, err := saveImg(rec.ID)
				if err != nil {
					jsonErr(w, 500, "Couldn't save a picture: "+err.Error())
					return
				}
				if ok {
					old.HasImage, old.Received, old.Updated = true, now, now
					pictures++
				} else {
					same++
				}
			case rec.Updated > old.Received: // changed on the phone since the computer got it
				ok, err := saveImg(rec.ID)
				if err != nil {
					jsonErr(w, 500, "Couldn't save a picture: "+err.Error())
					return
				}
				rec.HasImage = ok || old.HasImage
				rec.Received = now
				rec.PdfAt, rec.PdfName, rec.BilledAt, rec.PdfOrder = old.PdfAt, old.PdfName, old.BilledAt, old.PdfOrder
				rec.Source, rec.Original = old.Source, old.Original
				*old = rec
				updated++
			default: // already here (file imported twice)
				same++
			}
			if rec.Customer != "" {
				store.data.Customers = cleanList(append(store.data.Customers, rec.Customer))
			}
			if rec.Category != "" {
				store.data.Categories = cleanList(append(store.data.Categories, rec.Category))
			}
		}
		store.data.Customers = cleanList(append(store.data.Customers, pf.Pending.Customers...))
		store.data.Categories = cleanList(append(store.data.Categories, pf.Pending.Categories...))
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		lastSyncMu.Lock()
		lastSync = time.Now()
		lastSyncMu.Unlock()
		log.Printf("imported phone file: %d new, %d changed, %d new pictures, %d already here", added, updated, pictures, same)
		writeJSON(w, 200, map[string]int{"added": added, "updated": updated, "pictures": pictures, "same": same})
	}))

	// The lists file for the phone (downloaded from ☰ → Lists file for the phone)
	mux.HandleFunc("/local/listsfile", local(func(w http.ResponseWriter, r *http.Request) {
		d := phoneLists()
		d["format"] = "timesaver-lists"
		d["made"] = time.Now().UnixMilli()
		b, _ := json.Marshal(d)
		name := "TimeSaver-lists-" + time.Now().Format("2006-01-02") + ".json"
		if co := strings.TrimSpace(store.companyName()); co != "" {
			name = safeFileName(co) + " lists " + time.Now().Format("2006-01-02") + ".json"
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	}))
}

// What the phone gets from the computer: over Wi-Fi (/api/lists) and in the lists file.
func phoneLists() map[string]any {
	store.mu.Lock()
	defer store.mu.Unlock()
	payees := store.data.Payees
	if payees == nil {
		payees = []Payee{}
	}
	billed, have := []string{}, []string{}
	cutoff := time.Now().AddDate(0, 0, -180).Format("2006-01-02")
	known := []map[string]any{}
	for _, x := range store.data.Receipts {
		have = append(have, x.ID)
		if x.BilledAt != 0 {
			billed = append(billed, x.ID)
		}
		// recent receipts, so the phone can spot a rescan of one it no longer has
		if x.Total != nil && x.Date >= cutoff {
			known = append(known, map[string]any{"id": x.ID, "date": x.Date, "total": *x.Total, "payee": x.Payee, "customer": x.Customer,
				"category": x.Category, "note": x.Note, "hasImage": x.HasImage, "billed": x.BilledAt != 0})
		}
	}
	return map[string]any{"customers": nz(store.data.Customers), "categories": nz(store.data.Categories), "payees": payees,
		"useNames": store.data.UseNames, "company": store.data.Company.Name, "billed": billed, "known": known, "have": have}
}

func (s *Store) companyName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Company.Name
}

func safeFileName(s string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) || r < 32 {
			return '-'
		}
		return r
	}, s)
}
