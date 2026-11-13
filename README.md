# KellerKraft Receipts

Scan receipts on an iPhone, assign them to customers, and sync them to a Windows
computer over your own Wi-Fi. Nothing is stored online.

* **`docs/`** — the iPhone web app (published with GitHub Pages at
  https://killokreator.github.io/receipt-tracker/). It works offline once added to the
  Home Screen. Receipts, customers and payees are kept on the phone and on your
  computer only, never in this repository.
* **`desktop/`** — the Windows program (`KellerKraft-Receipts.exe`), shown at
  http://localhost:8780 with two tabs:
  * **Receipts** — receipts synced from the phone, totals per customer
  * **IIF Converter** — bank/card CSV → QuickBooks Desktop IIF. Fills in the customer
    when a receipt has the same amount and payee.

  One master list of payees, customers and categories is shared by both tabs and the
  phone. It is imported from QuickBooks reports on the computer and saved, with all
  receipts and settings, in `Documents\KellerKraft Receipts` — never in this repository.

## Build the Windows program

```bash
cd desktop
GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o KellerKraft-Receipts.exe .
```

Receipt reading uses [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache 2.0),
included in `docs/vendor/tesseract` so it works without internet.
