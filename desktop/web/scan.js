/* KellerKraft Receipts — document scanning (runs fully on the phone, no internet)
   1. find the receipt's 4 corners in the photo
   2. straighten it (perspective correction)
   3. make it look like a clean black & white scan (like iOS Notes)            */
'use strict';
const Scan = (() => {

  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      // Draw into a canvas (browsers apply the photo's rotation automatically)
      const max = 2600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  function toGray(data, n) {
    const g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    return g;
  }

  function otsu(g) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }

  // Box blur using an integral image
  function boxBlur(g, w, h, r) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
      }
    }
    return out;
  }

  /* Find the receipt: the biggest bright (paper-colored) area. Returns 4 corners
     [topLeft, topRight, bottomRight, bottomLeft] in canvas pixels. */
  function detectCorners(canvas) {
    const W = canvas.width, H = canvas.height;
    const s = 360 / Math.max(W, H), w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    const g0 = toGray(c.getContext('2d').getImageData(0, 0, w, h).data, w * h);
    const gb = boxBlur(g0, w, h, 2);
    const g = new Uint8ClampedArray(gb);
    const t = otsu(g);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) mask[i] = g[i] > t ? 1 : 0;
    // largest bright connected area
    const seen = new Uint8Array(w * h); let best = null, bestN = 0;
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0, n = 0; stack[sp++] = start; seen[start] = 1;
      let tl = [0, 0, 1e9], tr = [0, 0, -1e9], br = [0, 0, -1e9], bl = [0, 0, 1e9];
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; n++;
        if (x + y < tl[2]) tl = [x, y, x + y];
        if (x + y > br[2]) br = [x, y, x + y];
        if (x - y > tr[2]) tr = [x, y, x - y];
        if (x - y < bl[2]) bl = [x, y, x - y];
        const nb = [p - 1, p + 1, p - w, p + w];
        for (let k = 0; k < 4; k++) {
          const q = nb[k];
          if (q < 0 || q >= w * h) continue;
          if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
      if (n > bestN) { bestN = n; best = [tl, tr, br, bl]; }
    }
    const frac = bestN / (w * h);
    // Not found clearly (e.g. white paper on a white table): use the whole photo with a small margin
    if (!best || frac < 0.08 || frac > 0.97) return defaultCorners(W, H);
    return best.map(([x, y]) => ({ x: Math.min(W, Math.max(0, x / s)), y: Math.min(H, Math.max(0, y / s)) }));
  }

  function defaultCorners(W, H) {
    const m = 0.03;
    return [{ x: W * m, y: H * m }, { x: W * (1 - m), y: H * m }, { x: W * (1 - m), y: H * (1 - m) }, { x: W * m, y: H * (1 - m) }];
  }

  // Solve for the 3x3 perspective matrix that maps the output rectangle to the photo's quad
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i], { x: u, y: v } = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    // Gaussian elimination
    for (let c = 0; c < 8; c++) {
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [...h, 1];
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /* Straighten + clean up. Returns a canvas with the finished black & white scan. */
  function process(canvas, corners, mode) {
    const [tl, tr, br, bl] = corners;
    let ow = Math.max(dist(tl, tr), dist(bl, br)), oh = Math.max(dist(tl, bl), dist(tr, br));
    const k = Math.min(1, 2000 / Math.max(ow, oh));
    ow = Math.max(20, Math.round(ow * k)); oh = Math.max(20, Math.round(oh * k));
    const H = homography(
      [{ x: 0, y: 0 }, { x: ow - 1, y: 0 }, { x: ow - 1, y: oh - 1 }, { x: 0, y: oh - 1 }], corners);
    const W0 = canvas.width, H0 = canvas.height;
    const src = toGray(canvas.getContext('2d').getImageData(0, 0, W0, H0).data, W0 * H0);
    const g = new Uint8ClampedArray(ow * oh);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const d = H[6] * x + H[7] * y + 1;
        const u = (H[0] * x + H[1] * y + H[2]) / d, v = (H[3] * x + H[4] * y + H[5]) / d;
        const x0 = Math.floor(u), y0 = Math.floor(v);
        if (x0 < 0 || y0 < 0 || x0 >= W0 - 1 || y0 >= H0 - 1) { g[y * ow + x] = 255; continue; }
        const fx = u - x0, fy = v - y0, i = y0 * W0 + x0;
        g[y * ow + x] = (src[i] * (1 - fx) + src[i + 1] * fx) * (1 - fy) + (src[i + W0] * (1 - fx) + src[i + W0 + 1] * fx) * fy;
      }
    }
    const out = mode === 'gray' ? g : scanLook(g, ow, oh);
    const c = document.createElement('canvas'); c.width = ow; c.height = oh;
    const ctx = c.getContext('2d'), id = ctx.createImageData(ow, oh);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) { id.data[j] = id.data[j + 1] = id.data[j + 2] = out[i]; id.data[j + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // Even out shadows, then push paper to white and ink to black (soft edges keep text readable)
  function scanLook(g, w, h) {
    const r = Math.max(12, Math.round(Math.min(w, h) / 14));
    const bg = boxBlur(g, w, h, r);
    const out = new Uint8ClampedArray(w * h);
    for (let i = 0; i < g.length; i++) {
      const v = Math.min(1.2, g[i] / (bg[i] + 1));      // ~1 = paper, lower = ink
      let o = (v - 0.62) / (0.90 - 0.62);               // contrast curve
      o = o < 0 ? 0 : o > 1 ? 1 : o;
      out[i] = Math.round(255 * o * o * (3 - 2 * o));
    }
    return out;
  }

  function toBlob(canvas, type = 'image/jpeg', q = 0.72) {
    return new Promise(res => canvas.toBlob(res, type, q));
  }
  function thumb(canvas, size = 160) {
    const s = size / Math.max(canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  return { loadImage, detectCorners, defaultCorners, process, toBlob, thumb };
})();
