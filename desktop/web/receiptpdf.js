/* Make a PDF of receipt scans, several per page, each with its date above it.
   Built right here on the computer, no internet and no extra programs. */
'use strict';
const ReceiptPDF = (() => {
  const W = 612, H = 792, M = 36;                 // US Letter, 0.5" margins (points)
  // Helvetica widths (per 1000) for the characters we measure precisely
  const HW = { ' ': 278, '$': 556, ',': 278, '.': 278, '-': 333, '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556 };
  const textW = (s, size) => [...s].reduce((w, c) => w + (HW[c] || (c === c.toUpperCase() && /[A-Z]/.test(c) ? 667 : 520)), 0) * size / 1000;
  const fit = (s, size, max) => { s = String(s || ''); if (textW(s, size) <= max) return s; while (s.length > 1 && textW(s + '…', size) > max) s = s.slice(0, -1); return s + '…'; };
  // PDF text: Latin-1 only, escape \ ( )
  const pdfStr = s => '(' + String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\xFF]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
  const money = n => (n == null || isNaN(n)) ? '' : (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmtDate = d => d ? new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function jpegInfo(b) {               // width, height, colour components
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
      i += 2 + len;
    }
    return null;
  }
  const bytes = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

  /* receipts: [{date, payee, total, note, category, image: Uint8Array (jpeg) | null}] */
  /* header: { company, subtitle, logo: { bytes (jpeg), w, h } } shown at the top of every page */
  function build({ title, receipts, perPage = 2, header = null }) {
    const objs = [];                                  // each: array of parts (string | Uint8Array)
    const add = parts => { objs.push(parts); return objs.length; };
    const fontR = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    const fontB = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    const pagesId = add(null);                        // filled in at the end
    const pageIds = [];
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const total = receipts.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const pages = [];                                 // {ops:[], images:[{name,id}]}

    // ---- receipt pages: each scan with just its date above it
    const grid = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2] }[perPage] || [2, 1];
    const [nc, nr] = grid, gap = 16, dateH = perPage >= 6 ? 16 : 20, dateSize = perPage >= 6 ? 10 : 12;
    // page heading: logo + company name, then "(customer) receipts · dates"
    let headH = 0, logoId = null, lw = 0, lh = 0;
    if (header) {
      if (header.logo && header.logo.bytes) {
        logoId = add(['<< /Type /XObject /Subtype /Image /Width ' + header.logo.w + ' /Height ' + header.logo.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + header.logo.bytes.length + ' >>\nstream\n', header.logo.bytes, '\nendstream']);
        const sc = Math.min(46 / header.logo.h, 150 / header.logo.w); lw = header.logo.w * sc; lh = header.logo.h * sc;
      }
      headH = Math.max(lh, header.company ? 22 : 0) + (header.subtitle ? 20 : 0) + 14;
    }
    const drawHeader = (ops, images) => {
      if (!header) return;
      let y = H - M;
      const tx = logoId ? M + lw + 12 : M;
      if (logoId) { images.push({ name: 'Logo', id: logoId }); ops.push(`q ${lw.toFixed(2)} 0 0 ${lh.toFixed(2)} ${M} ${(y - lh).toFixed(2)} cm /Logo Do Q`); }
      if (header.company) ops.push(`BT /FB 16 Tf ${tx} ${(y - (logoId ? lh / 2 + 6 : 14)).toFixed(2)} Td ${pdfStr(header.company)} Tj ET`);
      y -= Math.max(lh, header.company ? 22 : 0);
      if (header.subtitle) { y -= 16; ops.push(`BT /FR 11 Tf 0.25 g ${M} ${y.toFixed(2)} Td ${pdfStr(header.subtitle)} Tj ET 0 g`); }
      y -= 6; ops.push(`0.7 G 0.6 w ${M} ${y.toFixed(2)} m ${W - M} ${y.toFixed(2)} l S 0 G`);
    };
    const cw = (W - 2 * M - gap * (nc - 1)) / nc, ch = (H - 2 * M - headH - gap * (nr - 1)) / nr;
    for (let s = 0; s < receipts.length; s += perPage) {
      const ops = [], images = [];
      drawHeader(ops, images);
      receipts.slice(s, s + perPage).forEach((r, k) => {
        const col = k % nc, row = Math.floor(k / nc);
        const x0 = M + col * (cw + gap), yTop = H - M - headH - row * (ch + gap);
        ops.push(`BT /FB ${dateSize} Tf ${x0} ${yTop - dateSize} Td ${pdfStr(fmtDate(r.date) || 'No date')} Tj ET`);
        const boxTop = yTop - dateH, boxH = ch - dateH;
        if (r.image) {
          const info = jpegInfo(r.image);
          if (info) {
            const id = add(['<< /Type /XObject /Subtype /Image /Width ' + info.w + ' /Height ' + info.h + ' /ColorSpace /' + (info.c === 1 ? 'DeviceGray' : info.c === 4 ? 'DeviceCMYK' : 'DeviceRGB') +
              ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + r.image.length + ' >>\nstream\n', r.image, '\nendstream']);
            const name = 'Im' + id; images.push({ name, id });
            const sc = Math.min(cw / info.w, boxH / info.h);
            const iw = info.w * sc, ih = info.h * sc, ix = x0 + (cw - iw) / 2, iy = boxTop - ih;   // top-aligned under the date
            ops.push(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /${name} Do Q`);
            ops.push(`0.75 G 0.5 w ${ix.toFixed(2)} ${iy.toFixed(2)} ${iw.toFixed(2)} ${ih.toFixed(2)} re S 0 G`);
          }
        } else ops.push(`BT /FR 10 Tf 0.5 g ${x0} ${boxTop - 14} Td (No scan) Tj ET 0 g`);
      });
      pages.push({ ops, images });
    }

    // page numbers + page objects
    pages.forEach((pg, i) => {
      const content = pg.ops.join('\n');
      const cid = add(['<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream']);
      const xo = pg.images.map(im => `/${im.name} ${im.id} 0 R`).join(' ');
      pageIds.push(add([`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cid} 0 R /Resources << /Font << /FR ${fontR} 0 R /FB ${fontB} 0 R >>${xo ? ' /XObject << ' + xo + ' >>' : ''} >> >>`]));
    });
    objs[pagesId - 1] = [`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`];
    const catalog = add([`<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);
    const info = add([`<< /Title ${pdfStr(title)} /Producer (Time Saver) >>`]);

    // write the file
    const out = [bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    let pos = out[0].length; const offs = [];
    objs.forEach((parts, i) => {
      offs.push(pos);
      const chunk = [bytes(`${i + 1} 0 obj\n`), ...parts.map(p => typeof p === 'string' ? bytes(p) : p), bytes('\nendobj\n')];
      chunk.forEach(c => { out.push(c); pos += c.length; });
    });
    const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '].concat(offs.map(o => String(o).padStart(10, '0') + ' 00000 n ')).join('\n');
    out.push(bytes(`${xref}\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
    return new Blob(out, { type: 'application/pdf' });
  }
  return { build };
})();
