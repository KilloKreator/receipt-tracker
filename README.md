# KellerKraft Receipts

Scan receipts on an iPhone, assign them to customers, and sync them to a Windows
computer over your own Wi-Fi. Nothing is stored online.

* **`docs/`** — the iPhone web app (published with GitHub Pages at
  https://killokreator.github.io/receipt-tracker/). It works offline once added to the
  Home Screen. Receipts, customers and payees are kept on the phone and on your
  computer only, never in this repository.
* **`desktop/`** — the Windows program (`KellerKraft-Receipts.exe`). It receives
  receipts from the phone and shows them at http://localhost:8780.
  Data is saved in `Documents\KellerKraft Receipts`.

## Build the Windows program

```bash
cd desktop
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o KellerKraft-Receipts.exe .
```

Receipt reading uses [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache 2.0),
included in `docs/vendor/tesseract` so it works without internet.
