package main

// KellerKraft Receipts — Windows program.
// • Receives receipts from the iPhone app over your home Wi-Fi (HTTPS, port 8443)
// • Shows them in your web browser at http://localhost:8780 (only on this computer)
// Nothing is sent to the internet.

import (
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"embed"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

const (
	appVersion = "0.2.7"
	httpPort   = 8780 // dashboard + phone setup page
	httpsPort  = 8443 // phone sync
	phoneApp   = "https://killokreator.github.io/receipt-tracker/"
)

//go:embed web
var webFS embed.FS

var (
	store   *Store
	ca      *certs
	dataDir string

	pairMu      sync.Mutex
	pairCode    string
	pairExpires time.Time

	lastSyncMu sync.Mutex
	lastSync   time.Time
)

func main() {
	home, _ := os.UserHomeDir()
	dataDir = filepath.Join(home, "Documents", "KellerKraft Receipts")
	if d := os.Getenv("KK_RECEIPTS_DIR"); d != "" {
		dataDir = d
	}
	os.MkdirAll(dataDir, 0755)
	if f, err := os.OpenFile(filepath.Join(dataDir, "log.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); err == nil {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	}
	log.Printf("KellerKraft Receipts %s starting, data folder %s", appVersion, dataDir)

	// Already running? Just open the dashboard.
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", httpPort))
	if err != nil {
		// Already running. If it's a different version (e.g. you just installed an update),
		// ask it to stop and take over; otherwise just open the dashboard.
		if old := runningVersion(); old != "" && old != appVersion {
			log.Printf("version %s is running; replacing it with %s", old, appVersion)
			stopRunning()
			for i := 0; i < 40 && err != nil; i++ {
				time.Sleep(250 * time.Millisecond)
				ln, err = net.Listen("tcp", fmt.Sprintf(":%d", httpPort))
			}
		}
		if err != nil {
			log.Printf("already running (%v); opening dashboard", err)
			openBrowser(fmt.Sprintf("http://localhost:%d/", httpPort))
			return
		}
	}

	if store, err = openStore(dataDir); err != nil {
		fatal("Could not open the data folder: " + err.Error())
	}
	if ca, err = loadOrCreateCA(filepath.Join(dataDir, "certs")); err != nil {
		fatal("Could not create the security certificate: " + err.Error())
	}
	newPairCode()

	// Phone sync server (HTTPS). The certificate is refreshed if the Wi-Fi address changes.
	go func() {
		var mu sync.Mutex
		var cur tls.Certificate
		var curIPs string
		getCert := func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			mu.Lock()
			defer mu.Unlock()
			ips := lanIPs()
			key := fmt.Sprint(ips)
			if cur.PrivateKey == nil || key != curIPs {
				c, err := ca.serverCert(ips)
				if err != nil {
					return nil, err
				}
				cur, curIPs = c, key
			}
			return &cur, nil
		}
		srv := &http.Server{
			Addr:              fmt.Sprintf(":%d", httpsPort),
			Handler:           phoneAPI(),
			TLSConfig:         &tls.Config{GetCertificate: getCert, MinVersion: tls.VersionTLS12},
			ReadHeaderTimeout: 20 * time.Second,
		}
		if err := srv.ListenAndServeTLS("", ""); err != nil {
			log.Printf("phone sync server stopped: %v", err)
		}
	}()

	go func() {
		time.Sleep(400 * time.Millisecond)
		if os.Getenv("KK_NO_BROWSER") == "" {
			openBrowser(fmt.Sprintf("http://localhost:%d/", httpPort))
		}
	}()
	srv := &http.Server{Handler: localSite(), ReadHeaderTimeout: 20 * time.Second}
	log.Fatal(srv.Serve(ln))
}

// Version of the copy that is already running ("" if it can't be asked)
func runningVersion() string {
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/local/version", httpPort))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var v struct{ Version string }
	if resp.StatusCode != 200 {
		// versions before 0.2.4 have no /local/version: ask the full state instead
		r2, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/local/state", httpPort))
		if err != nil {
			return ""
		}
		defer r2.Body.Close()
		json.NewDecoder(r2.Body).Decode(&v)
		return v.Version
	}
	json.NewDecoder(resp.Body).Decode(&v)
	return v.Version
}

func stopRunning() {
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/local/quit", httpPort), strings.NewReader("{}"))
	req.Header.Set("X-KK", "1")
	req.Header.Set("Content-Type", "application/json")
	c := http.Client{Timeout: 3 * time.Second}
	if resp, err := c.Do(req); err == nil {
		resp.Body.Close()
	}
}

func fatal(msg string) {
	log.Print(msg)
	showError(msg)
	os.Exit(1)
}

func newPairCode() {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	pairMu.Lock()
	pairCode = fmt.Sprintf("%06d", n.Int64())
	pairExpires = time.Now().Add(15 * time.Minute)
	pairMu.Unlock()
}

func randToken() string {
	b := make([]byte, 24)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
func jsonErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

/* ------------------------------------------------------------------ phone API (HTTPS) */

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func phoneAPI() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pair", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Code, Device string }
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		pairMu.Lock()
		ok := time.Now().Before(pairExpires) && subtle.ConstantTimeCompare([]byte(req.Code), []byte(pairCode)) == 1
		pairMu.Unlock()
		if !ok {
			time.Sleep(time.Second) // slow down guessing
			jsonErr(w, 403, "wrong or expired code")
			return
		}
		tok := randToken()
		store.mu.Lock()
		store.data.Devices = append(store.data.Devices, Device{Token: tok, Name: strings.TrimSpace(req.Device), Created: time.Now().Unix()})
		store.save()
		store.mu.Unlock()
		newPairCode()
		host, _ := os.Hostname()
		log.Printf("phone connected: %s", req.Device)
		writeJSON(w, 200, map[string]string{"token": tok, "name": host})
	})
	mux.HandleFunc("/api/lists", authed(func(w http.ResponseWriter, r *http.Request) {
		store.mu.Lock()
		d := map[string]any{"customers": nz(store.data.Customers), "categories": nz(store.data.Categories), "payees": store.data.Payees, "useNames": store.data.UseNames}
		if store.data.Payees == nil {
			d["payees"] = []Payee{}
		}
		store.mu.Unlock()
		writeJSON(w, 200, d)
	}))
	mux.HandleFunc("/api/lists/add", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Customers, Categories []string }
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		store.mu.Lock()
		store.data.Customers = cleanList(append(store.data.Customers, req.Customers...))
		store.data.Categories = cleanList(append(store.data.Categories, req.Categories...))
		err := store.save()
		store.mu.Unlock()
		if err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/api/receipts", authed(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			jsonErr(w, 405, "POST only")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 30<<20)
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			jsonErr(w, 400, "bad upload")
			return
		}
		var rec Receipt
		if err := json.Unmarshal([]byte(r.FormValue("meta")), &rec); err != nil || !idRe.MatchString(rec.ID) {
			jsonErr(w, 400, "bad receipt")
			return
		}
		rec.HasImage = false
		if f, _, err := r.FormFile("image"); err == nil {
			defer f.Close()
			tmp := store.imagePath(rec.ID) + ".tmp"
			out, err := os.Create(tmp)
			if err == nil {
				_, err = io.Copy(out, f)
				out.Close()
			}
			if err == nil {
				err = os.Rename(tmp, store.imagePath(rec.ID))
			}
			if err != nil {
				jsonErr(w, 500, "could not save image: "+err.Error())
				return
			}
			rec.HasImage = true
		}
		rec.Received = time.Now().UnixMilli()
		store.mu.Lock()
		if old := store.findReceipt(rec.ID); old != nil {
			if !rec.HasImage {
				rec.HasImage = old.HasImage
			}
			rec.PdfAt, rec.PdfName = old.PdfAt, old.PdfName // the phone doesn't know about PDFs
			*old = rec
		} else {
			store.data.Receipts = append(store.data.Receipts, &rec)
		}
		if rec.Customer != "" {
			store.data.Customers = cleanList(append(store.data.Customers, rec.Customer))
		}
		if rec.Category != "" {
			store.data.Categories = cleanList(append(store.data.Categories, rec.Category))
		}
		err := store.save()
		store.mu.Unlock()
		if err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		lastSyncMu.Lock()
		lastSync = time.Now()
		lastSyncMu.Unlock()
		log.Printf("received receipt %s (%s, %s)", rec.ID, rec.Payee, rec.Customer)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><meta name=viewport content="width=device-width"><body style="font:18px -apple-system,sans-serif;padding:24px"><h2>✓ Secure connection works</h2><p>Your iPhone trusts this computer. Go back to the KK Receipts app.</p>`)
	})
	// Every reply allows the phone app's web address to call in (requests still need the phone's key)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		ok := false
		store.mu.Lock()
		for _, d := range store.data.Devices {
			if tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(d.Token)) == 1 {
				ok = true
			}
		}
		store.mu.Unlock()
		if !ok {
			jsonErr(w, 401, "phone not connected")
			return
		}
		h(w, r)
	}
}

/* ------------------------------------------------------------------ local site (HTTP) */

func isLocal(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Dashboard actions: only from this computer, and only from the dashboard page itself
func local(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLocal(r) {
			http.Error(w, "Only available on the computer itself", 403)
			return
		}
		if r.Method == http.MethodPost && r.Header.Get("X-KK") != "1" {
			http.Error(w, "forbidden", 403)
			return
		}
		h(w, r)
	}
}

func pageFile(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b, err := webFS.ReadFile("web/" + name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	}
}

func localSite() http.Handler {
	mux := http.NewServeMux()
	dash := pageFile("dashboard.html")
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if !isLocal(r) {
			http.Redirect(w, r, "/setup", http.StatusFound)
			return
		}
		dash(w, r)
	})
	mux.HandleFunc("/setup", pageFile("setup.html"))
	convPage := pageFile("converter.html")
	mux.HandleFunc("/converter", local(convPage))
	// IIF converter: its settings + the master lists + receipts (for filling in customers)
	mux.HandleFunc("/local/converter", local(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var in struct {
				Settings json.RawMessage `json:"settings"`
				Payees   *[]Payee        `json:"payees"`
				UseNames *bool           `json:"useNames"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&in) != nil {
				jsonErr(w, 400, "bad request")
				return
			}
			store.mu.Lock()
			defer store.mu.Unlock()
			if len(in.Settings) > 0 && string(in.Settings) != "null" {
				store.data.Converter = in.Settings
			}
			if in.Payees != nil {
				store.data.Payees = cleanPayees(*in.Payees)
			}
			if in.UseNames != nil {
				store.data.UseNames = *in.UseNames
			}
			if err := store.save(); err != nil {
				jsonErr(w, 500, err.Error())
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		type lite struct {
			ID       string   `json:"id"`
			Date     string   `json:"date"`
			Total    *float64 `json:"total"`
			Payee    string   `json:"payee"`
			Customer string   `json:"customer"`
			Note     string   `json:"note"`
		}
		store.mu.Lock()
		rs := []lite{}
		for _, x := range store.data.Receipts {
			rs = append(rs, lite{x.ID, x.Date, x.Total, x.Payee, x.Customer, x.Note})
		}
		var settings any = nil
		if len(store.data.Converter) > 0 {
			settings = store.data.Converter
		}
		payees := store.data.Payees
		if payees == nil {
			payees = []Payee{}
		}
		resp := map[string]any{"settings": settings, "payees": payees, "useNames": store.data.UseNames,
			"customers": nz(store.data.Customers), "categories": nz(store.data.Categories), "receipts": rs}
		store.mu.Unlock()
		writeJSON(w, 200, resp)
	}))
	// scripts used by the dashboard (PDF reader etc.), built into this program
	mux.HandleFunc("/assets/", local(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/assets/")
		if strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		b, err := webFS.ReadFile("web/" + name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".mjs") {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		w.Write(b)
	}))
	mux.HandleFunc("/ca.crt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", `attachment; filename="KellerKraft-Receipts.crt"`)
		w.Write(ca.caDER)
	})
	mux.HandleFunc("/qr.png", local(func(w http.ResponseWriter, r *http.Request) {
		png, err := qrcode.Encode(r.URL.Query().Get("u"), qrcode.Medium, 320)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(png)
	}))
	// Receipts added on the computer (a picture or PDF turned into a scan, plus the original file)
	mux.HandleFunc("/local/upload", local(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 60<<20)
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			jsonErr(w, 400, "upload too big or broken")
			return
		}
		var rec Receipt
		if err := json.Unmarshal([]byte(r.FormValue("meta")), &rec); err != nil {
			jsonErr(w, 400, "bad receipt")
			return
		}
		rec.ID = "pc-" + randToken()[:20]
		now := time.Now().UnixMilli()
		rec.Created, rec.Updated, rec.Received, rec.Source = now, now, now, "computer"
		rec.PdfAt, rec.PdfName = 0, ""
		if rec.Memo == "" {
			rec.Memo = rec.Payee
		}
		save := func(field, path string) (bool, error) {
			f, _, err := r.FormFile(field)
			if err != nil {
				return false, nil
			}
			defer f.Close()
			os.MkdirAll(filepath.Dir(path), 0755)
			out, err := os.Create(path + ".tmp")
			if err != nil {
				return false, err
			}
			_, err = io.Copy(out, f)
			out.Close()
			if err == nil {
				err = os.Rename(path+".tmp", path)
			}
			return err == nil, err
		}
		ok, err := save("image", store.imagePath(rec.ID))
		if err != nil {
			jsonErr(w, 500, "could not save: "+err.Error())
			return
		}
		rec.HasImage = ok
		rec.Original = ""
		if ext := strings.ToLower(filepath.Ext(r.FormValue("originalName"))); ext == ".pdf" {
			if ok, _ := save("original", store.originalPath(rec.ID, ".pdf")); ok {
				rec.Original = "pdf"
			}
		}
		store.mu.Lock()
		store.data.Receipts = append(store.data.Receipts, &rec)
		if rec.Customer != "" {
			store.data.Customers = cleanList(append(store.data.Customers, rec.Customer))
		}
		if rec.Category != "" {
			store.data.Categories = cleanList(append(store.data.Categories, rec.Category))
		}
		err = store.save()
		store.mu.Unlock()
		if err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		log.Printf("added receipt %s on the computer (%s, %s)", rec.ID, rec.Payee, rec.Customer)
		writeJSON(w, 200, map[string]string{"id": rec.ID})
	}))
	mux.HandleFunc("/orig/", local(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/orig/"), ".pdf")
		if !idRe.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		http.ServeFile(w, r, store.originalPath(id, ".pdf"))
	}))
	mux.HandleFunc("/img/", local(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/img/"), ".jpg")
		if !idRe.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, store.imagePath(id))
	}))
	mux.HandleFunc("/local/state", local(func(w http.ResponseWriter, r *http.Request) {
		addrs := lanAddrs()
		ips := []string{}
		for _, a := range addrs {
			ips = append(ips, a.IP)
		}
		pairMu.Lock()
		code, exp := pairCode, pairExpires
		pairMu.Unlock()
		if time.Now().After(exp) {
			newPairCode()
			pairMu.Lock()
			code, exp = pairCode, pairExpires
			pairMu.Unlock()
		}
		lastSyncMu.Lock()
		ls := lastSync
		lastSyncMu.Unlock()
		store.mu.Lock()
		rs := make([]Receipt, 0, len(store.data.Receipts))
		for _, x := range store.data.Receipts {
			rs = append(rs, *x)
		}
		resp := map[string]any{
			"version": appVersion, "dataDir": dataDir, "ips": ips, "addrs": addrs, "httpPort": httpPort, "httpsPort": httpsPort,
			"pairCode": code, "pairExpires": exp.UnixMilli(), "phoneApp": phoneApp, "devices": len(store.data.Devices),
			"receipts": rs, "customers": nz(store.data.Customers), "categories": nz(store.data.Categories),
			"payees": store.data.Payees, "useNames": store.data.UseNames, "autostart": autostartEnabled(),
			"lastSync": func() int64 {
				if ls.IsZero() {
					return 0
				}
				return ls.UnixMilli()
			}(),
		}
		if store.data.Payees == nil {
			resp["payees"] = []Payee{}
		}
		store.mu.Unlock()
		writeJSON(w, 200, resp)
	}))
	mux.HandleFunc("/local/receipt", local(func(w http.ResponseWriter, r *http.Request) {
		var in Receipt
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		rec := store.findReceipt(in.ID)
		if rec == nil {
			jsonErr(w, 404, "not found")
			return
		}
		rec.Date, rec.Total, rec.Payee, rec.Memo, rec.MemoManual = in.Date, in.Total, in.Payee, in.Memo, in.MemoManual
		rec.Customer, rec.Category, rec.Note = in.Customer, in.Category, in.Note
		rec.Updated = time.Now().UnixMilli()
		if rec.Customer != "" {
			store.data.Customers = cleanList(append(store.data.Customers, rec.Customer))
		}
		if rec.Category != "" {
			store.data.Categories = cleanList(append(store.data.Categories, rec.Category))
		}
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/markpdf", local(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			IDs   []string
			Name  string
			Clear bool
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		now := time.Now().UnixMilli()
		for _, id := range in.IDs {
			if rec := store.findReceipt(id); rec != nil {
				if in.Clear {
					rec.PdfAt, rec.PdfName = 0, ""
				} else {
					rec.PdfAt, rec.PdfName = now, in.Name
				}
				rec.Updated = now
			}
		}
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/assign", local(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			IDs      []string
			Customer string
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		cust := strings.Join(strings.Fields(in.Customer), " ")
		store.mu.Lock()
		defer store.mu.Unlock()
		now := time.Now().UnixMilli()
		for _, id := range in.IDs {
			if rec := store.findReceipt(id); rec != nil {
				rec.Customer, rec.Updated = cust, now
			}
		}
		if cust != "" {
			store.data.Customers = cleanList(append(store.data.Customers, cust))
		}
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/delete", local(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ ID string }
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in) != nil || !idRe.MatchString(in.ID) {
			jsonErr(w, 400, "bad request")
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		out := store.data.Receipts[:0]
		for _, x := range store.data.Receipts {
			if x.ID != in.ID {
				out = append(out, x)
			}
		}
		store.data.Receipts = out
		// keep the photo in a "deleted" folder, just in case
		os.MkdirAll(filepath.Join(store.dir, "deleted"), 0755)
		os.Rename(store.imagePath(in.ID), filepath.Join(store.dir, "deleted", in.ID+".jpg"))
		os.Rename(store.originalPath(in.ID, ".pdf"), filepath.Join(store.dir, "deleted", in.ID+".pdf"))
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/lists", local(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Customers, Categories *[]string
			Payees                *[]Payee
			UseNames              *bool
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&in) != nil {
			jsonErr(w, 400, "bad request")
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		if in.Customers != nil {
			store.data.Customers = cleanList(*in.Customers)
		}
		if in.Categories != nil {
			store.data.Categories = cleanList(append(*in.Categories, DefaultCategory))
		}
		if in.Payees != nil {
			store.data.Payees = cleanPayees(*in.Payees)
		}
		if in.UseNames != nil {
			store.data.UseNames = *in.UseNames
		}
		if err := store.save(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/newcode", local(func(w http.ResponseWriter, r *http.Request) {
		newPairCode()
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/forgetphones", local(func(w http.ResponseWriter, r *http.Request) {
		store.mu.Lock()
		store.data.Devices = nil
		err := store.save()
		store.mu.Unlock()
		if err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/autostart", local(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ On bool }
		json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in)
		if err := setAutostart(in.On); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"on": autostartEnabled()})
	}))
	mux.HandleFunc("/local/netcheck", local(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, netCheck())
	}))
	mux.HandleFunc("/local/netfix", local(func(w http.ResponseWriter, r *http.Request) {
		if err := netFix(); err != nil {
			jsonErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, netCheck())
	}))
	mux.HandleFunc("/local/openfolder", local(func(w http.ResponseWriter, r *http.Request) {
		openFolder(dataDir)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/local/version", local(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"version": appVersion})
	}))
	mux.HandleFunc("/local/quit", local(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); os.Exit(0) }()
	}))
	mux.HandleFunc("/local/export.csv", local(func(w http.ResponseWriter, r *http.Request) {
		cust := r.URL.Query().Get("customer")
		store.mu.Lock()
		rs := make([]Receipt, 0)
		for _, x := range store.data.Receipts {
			if cust == "" || x.Customer == cust || (cust == "(none)" && x.Customer == "") {
				rs = append(rs, *x)
			}
		}
		store.mu.Unlock()
		sort.Slice(rs, func(i, j int) bool { return rs[i].Date < rs[j].Date })
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="receipts.csv"`)
		w.Write([]byte("\xEF\xBB\xBF"))
		cw := csv.NewWriter(w)
		cw.Write([]string{"Date", "Customer", "Payee", "Category", "Total", "Memo", "Note"})
		for _, x := range rs {
			t := ""
			if x.Total != nil {
				t = strconv.FormatFloat(*x.Total, 'f', 2, 64)
			}
			cw.Write([]string{x.Date, x.Customer, x.Payee, x.Category, t, x.Memo, x.Note})
		}
		cw.Flush()
	}))
	return mux
}

/* ------------------------------------------------------------------ helpers */

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		log.Printf("could not open browser: %v", err)
	}
}

func openFolder(dir string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	cmd.Start()
}
