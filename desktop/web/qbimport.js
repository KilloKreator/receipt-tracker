/* Read names from a QuickBooks list report (Vendor / Customer Contact List).
   Works with a PDF ("Print → Save as PDF") or a CSV/Excel export saved as CSV.
   Everything happens on this computer. */
'use strict';
const QBImport = (() => {
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const HEADER = /^(vendor|customer|customer\s*:\s*job|customer\s*\/\s*job|payee|name|full\s*name|active\s+(customer|vendor)s?)$/i;

  async function fromFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf') || file.type === 'application/pdf') return fromPDF(await file.arrayBuffer());
    return fromCSV(await file.text());
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function fromCSV(text) {
    const rows = parseCSV(text).filter(r => r.some(c => norm(c)));
    let hi = rows.findIndex(r => r.some(c => HEADER.test(norm(c))));
    let col = 0;
    if (hi >= 0) col = rows[hi].findIndex(c => HEADER.test(norm(c))); else hi = -1;
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      // QuickBooks Excel exports often put the name in the first non-empty cell
      let v = norm(r[col]);
      if (!v && hi < 0) v = norm(r.find(c => norm(c)));
      if (v && !/^total\b/i.test(v)) out.push(v);
    }
    return finish(out);
  }

  /* ---------- PDF ---------- */
  let pdfjs = null;
  async function loadPDFjs() {
    if (!pdfjs) {
      pdfjs = await import('/assets/vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.mjs';
    }
    return pdfjs;
  }
  async function fromPDF(buf) {
    const lib = await loadPDFjs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const out = [];
    for (let pn = 1; pn <= doc.numPages; pn++) {
      const page = await doc.getPage(pn);
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => norm(it.str)).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      // group into lines (same height on the page)
      const lines = [];
      items.sort((a, b) => b.y - a.y || a.x - b.x).forEach(it => {
        const ln = lines.find(l => Math.abs(l.y - it.y) < 2.5);
        if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
      });
      lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
      // find the name column's heading ("Vendor", "Customer", …). Pages without it hold other columns: skip.
      let head = null, headLine = null;
      for (const l of lines) { const h = l.items.find(it => HEADER.test(norm(it.s))); if (h) { head = h; headLine = l; break; } }
      if (!head) continue;
      const next = headLine.items.find(it => it.x > head.x + head.w + 4);
      const right = next ? (head.x + head.w + next.x) / 2 : Infinity;
      const rows = [];
      for (const l of lines) {
        if (l.y >= headLine.y - 1) continue;                       // above / on the heading
        const parts = l.items.filter(it => it.x < right);
        if (!parts.length) continue;
        const text = norm(parts.map(p => p.s).join(' '));
        if (!text || /^page\s+\d+$/i.test(text) || /^total\b/i.test(text)) continue;
        rows.push({ x: parts[0].x, text });
      }
      if (!rows.length) continue;
      // indented rows are jobs under the customer above them ("Customer:Job")
      const base = Math.min(...rows.map(r => r.x));
      let parent = null;
      for (const r of rows) {
        if (r.x > base + 6 && parent && !r.text.includes(':')) out.push(parent + ':' + r.text);
        else { out.push(r.text); parent = r.text; }
      }
    }
    return finish(out);
  }

  function finish(list) {
    const seen = new Set(), out = [];
    for (const v of list) { const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  }
  return { fromFile, fromCSV, fromPDF };
})();
