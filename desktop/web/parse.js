/* KellerKraft Receipts — pull the date, total and payee out of the receipt text */
'use strict';
const Parse = (() => {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  const lc = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // OCR often mixes up O/0, l/1, S/5 next to digits
  function fixDigits(s) {
    return s.replace(/(?<=\d)[Oo]|[Oo](?=\d)/g, '0')
            .replace(/(?<=\d)[lI|]|[lI|](?=\d)/g, '1')
            .replace(/(?<=\d)[Ss](?=\d)/g, '5');
  }

  function validDate(y, m, d, today) {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    const t = today || new Date();
    const max = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    const min = new Date(t.getFullYear() - 3, t.getMonth(), t.getDate());
    if (dt > max || dt < min) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  function findDate(text, today) {
    const t = fixDigits(text);
    const found = [];
    const add = (idx, iso) => { if (iso) found.push({ idx, iso }); };
    let m;
    let re = /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?!\d)/g;           // 10/14/2026, 10-14-26
    while ((m = re.exec(t))) add(m.index, validDate(+m[3], +m[1], +m[2], today));
    re = /\b(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\b/g;                          // 2026-10-14
    while ((m = re.exec(t))) add(m.index, validDate(+m[1], +m[2], +m[3], today));
    re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4}|\d{2})\b/gi; // Oct 14, 2026
    while ((m = re.exec(t))) add(m.index, validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2], today));
    re = /\b(\d{1,2})\s*-?\s*(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*-?,?\s*(\d{4}|\d{2})\b/gi; // 14 Oct 2026, 14OCT26
    while ((m = re.exec(t))) add(m.index, validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1], today));
    found.sort((a, b) => a.idx - b.idx);
    return found.length ? found[0].iso : null;
  }

  const AMT = /(-?)\$?\s?(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,]\s?(\d{2})(?!\d)/g;
  function amounts(line) {
    const out = []; let m; AMT.lastIndex = 0;
    const l = fixDigits(line);
    while ((m = AMT.exec(l))) out.push(parseFloat((m[1] || '') + m[2].replace(/[,\s]/g, '') + '.' + m[3]));
    return out;
  }

  function findTotal(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const levels = [
      /grand\s*total/i,
      /(amount|balance|total)\s*(due|paid)|amt\s*due/i,
      /^(?!.*(sub|tax|sav|discount|item|qty|tip))[^a-z]*total\b/i,
      /(?<!sub\s?)\btotal\b(?!.*(sav|tax|discount|item))/i,
      /\b(visa|master\s*card|mastercard|amex|discover|debit|credit|card)\b/i,
    ];
    for (const re of levels) {
      const hits = [];
      lines.forEach((ln, i) => {
        if (!re.test(ln) || /sub\s*-?\s*total/i.test(ln)) return;
        let a = amounts(ln);
        if (!a.length && lines[i + 1]) a = amounts(lines[i + 1]);
        if (a.length) hits.push(Math.abs(a[a.length - 1]));
      });
      if (hits.length) return Math.max(...hits);
    }
    // fallback: largest amount that isn't cash given / change
    let best = null;
    lines.forEach(ln => {
      if (/cash|change|tender|sav|you\s*saved/i.test(ln)) return;
      amounts(ln).forEach(a => { if (a > 0 && a < 100000 && (best === null || a > best)) best = a; });
    });
    return best;
  }

  // ---- payee matching (same logic as the KellerKraft Time Saver converter) ----
  const tokens = s => lc(s).replace(/['’`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  function nameIn(vt, dt) {
    if (!vt.length) return false;
    if (dt.includes(vt.join(''))) return true;
    for (let i = 0; i + vt.length <= dt.length; i++) {
      let ok = true;
      for (let j = 0; j < vt.length; j++) if (dt[i + j] !== vt[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  function findPayee(text, payees, useNames = true) {
    const d = lc(text);
    let best = null, bl = 0;
    for (const p of payees || []) for (const w of p.words || []) {
      const k = lc(w); if (k && k.length > bl && d.includes(k)) { best = p.name; bl = k.length; }
    }
    if (best || !useNames) return best;
    const dt = tokens(text); let bv = null, bn = 0;
    for (const p of payees || []) {
      const vt = tokens(p.name), n = vt.join(' ').length;
      if (n > bn && nameIn(vt, dt)) { bv = p.name; bn = n; }
    }
    return bv;
  }
  // The store name printed at the top, used only as a hint
  function storeLine(text) {
    for (const ln of text.split(/\r?\n/).slice(0, 6)) {
      const s = ln.replace(/[^A-Za-z0-9&'.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
      if ((s.match(/[A-Za-z]/g) || []).length >= 3) return s.slice(0, 40);
    }
    return '';
  }

  function receipt(text, payees, useNames, today) {
    return { date: findDate(text, today), total: findTotal(text), payee: findPayee(text, payees, useNames), store: storeLine(text) };
  }
  return { receipt, findDate, findTotal, findPayee, storeLine };
})();
if (typeof module !== 'undefined') module.exports = Parse;
