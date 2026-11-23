/* Time Saver — phone app */
'use strict';
const VERSION = '0.2.6';
const DEFAULT_CATEGORY = 'Uncategorized Expenses';
const $ = id => document.getElementById(id);
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = s => norm(s).toLowerCase();
const money = n => (n == null || isNaN(n)) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let settings = { bw: true, names: true, addr: '', token: '' };
let lists = { customers: [], categories: [], payees: [], pending: { customers: [], categories: [] } };
let current = null;      // receipt being edited
let custBefore = '';     // its customer when it was opened (to count customer use)
let isNew = false, dirty = false, touched = new Set();
let syncing = false;

/* ---------- screens & little helpers ---------- */
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 'scr-' + name));
}
function busy(text) { $('busyText').textContent = text || ''; $('busy').classList.toggle('hidden', !text); }
let toastT;
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
const saveSettings = () => DB.kvSet('settings', settings);
const saveLists = () => DB.kvSet('lists', lists);
const sortNames = a => [...new Set(a.map(norm).filter(Boolean))].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

/* ---------- home: month folders → week folders, with search ---------- */
let allRecs = [];
const openFolders = new Set();
let foldersInit = false;
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON3 = MONTHS.map(m => m.slice(0, 3));
const pad2 = n => String(n).padStart(2, '0');
const dOf = iso => new Date((iso || todayISO()) + 'T12:00');
const isoOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function weekStart(iso) { const d = dOf(iso); d.setDate(d.getDate() - d.getDay()); return d; }   // Sunday
function searchText(r) {
  const d = dOf(r.date), m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear();
  return lc([r.payee, r.memo, r.customer, r.category, r.note, r.total != null ? Number(r.total).toFixed(2) : '',
    r.date, `${m}/${day}/${y}`, `${m}/${day}/${String(y).slice(2)}`, `${pad2(m)}/${pad2(day)}/${y}`, `${m}/${day}`, `${pad2(m)}/${pad2(day)}`,
    `${MONTHS[m - 1]} ${day} ${y}`, `${MON3[m - 1]} ${day} ${y}`, `${MONTHS[m - 1]} ${y}`].join(' | '));
}
function sumOf(rs) { return rs.reduce((s, r) => s + (Number(r.total) || 0), 0); }
function itemEl(r) {
  const it = document.createElement('div'); it.className = 'item';
  const img = document.createElement('img'); img.src = r.thumb || ''; img.alt = '';
  const mid = document.createElement('div'); mid.className = 'mid';
  const t1 = document.createElement('div'); t1.className = 't1'; t1.textContent = r.payee || r.memo || '(no payee)';
  const t2 = document.createElement('div'); t2.className = 't2';
  t2.textContent = [dOf(r.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), r.customer || 'No customer'].join(' · ');
  const chip = document.createElement('span'); chip.className = 'chip ' + (r.synced ? 'ok' : 'wait'); chip.textContent = r.synced ? 'On computer ✓' : 'Waiting to sync';
  mid.append(t1, t2, chip);
  const amt = document.createElement('div'); amt.className = 'amt'; amt.textContent = money(r.total);
  it.append(img, mid, amt);
  it.onclick = () => openEdit(r, false);
  return it;
}
const SHARE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>';
function folderEl(key, cls, icon, title, rs, onShare) {
  const d = document.createElement('details'); d.className = 'folder ' + cls; d.open = openFolders.has(key);
  d.addEventListener('toggle', () => { if (d.open) openFolders.add(key); else openFolders.delete(key); });
  const sm = document.createElement('summary');
  const waiting = rs.filter(r => !r.synced).length;
  const ft = document.createElement('div'); ft.className = 'ft';
  const b = document.createElement('span'); b.className = 'fn'; b.textContent = (icon ? icon + '\u2009' : '') + title;
  const fs = document.createElement('span'); fs.className = 'fc'; fs.textContent = '(' + rs.length + ')';
  ft.append(b, fs);
  if (waiting) { const c = document.createElement('span'); c.className = 'chip wait'; c.textContent = `⏳ ${waiting}`; c.title = `${waiting} waiting to sync`; ft.append(c); }
  const amt = document.createElement('div'); amt.className = 'famt'; amt.textContent = money(sumOf(rs));
  sm.append(ft, amt);
  if (onShare) {
    const sb = document.createElement('button'); sb.className = 'iconbtn'; sb.innerHTML = SHARE_SVG;
    sb.setAttribute('aria-label', 'Save all images in ' + title); sb.title = 'Save all images';
    sb.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onShare(); });
    sm.append(sb);
  }
  d.append(sm);
  return d;
}
async function renderHome() {
  const hiddenBilled = 0;
  allRecs = (await DB.all()).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
  const list = $('list'); list.innerHTML = '';
  $('emptyList').classList.toggle('hidden', allRecs.length > 0 || hiddenBilled > 0);
  const q = lc($('search').value);
  if (q) {
    const words = q.split(' ').filter(Boolean);
    const hits = allRecs.filter(r => { const t = searchText(r); return words.every(w => t.includes(w)); });
    const h = document.createElement('div'); h.className = 'results';
    h.textContent = hits.length ? `${hits.length} found · ${money(sumOf(hits))}` : 'Nothing found.';
    list.append(h);
    hits.forEach(r => list.append(itemEl(r)));
  } else {
    // group by month, then by week (Sunday–Saturday)
    const months = new Map();
    for (const r of allRecs) {
      const mk = (r.date || todayISO()).slice(0, 7);
      if (!months.has(mk)) months.set(mk, []);
      months.get(mk).push(r);
    }
    if (!foldersInit && allRecs.length) {
      foldersInit = true;
      const first = [...months.keys()][0];
      openFolders.add('m' + first);
      const wk = isoOf(weekStart(months.get(first)[0].date));
      openFolders.add('w' + first + wk);
    }
    for (const [mk, rs] of months) {
      const [y, m] = mk.split('-').map(Number);
      const md = folderEl('m' + mk, 'month', '📁', `${MONTHS[m - 1]} ${y}`, rs, () => shareImages(rs, `${MONTHS[m - 1]} ${y} receipts`));
      const weeks = new Map();
      for (const r of rs) { const wk = isoOf(weekStart(r.date)); if (!weeks.has(wk)) weeks.set(wk, []); weeks.get(wk).push(r); }
      for (const [wk, wrs] of weeks) {
        const s0 = dOf(wk), e0 = dOf(wk); e0.setDate(e0.getDate() + 6);
        // only show the days inside this month
        const s1 = s0.getMonth() + 1 === m ? s0 : new Date(y, m - 1, 1, 12);
        const e1 = e0.getMonth() + 1 === m ? e0 : new Date(y, m, 0, 12);
        const label = `${MON3[m - 1]} ${s1.getDate()}${e1.getDate() !== s1.getDate() ? ' – ' + e1.getDate() : ''}`;
        const wd = folderEl('w' + mk + wk, 'week', '', label, wrs);
        wrs.forEach(r => wd.append(itemEl(r)));
        md.append(wd);
      }
      list.append(md);
    }
  }
  const waiting = allRecs.filter(r => !r.synced).length;
  const bar = $('syncBar');
  bar.className = 'syncbar';
  if (!settings.token) { bar.textContent = 'Not connected to your computer yet. Tap ⚙︎ to set it up.'; bar.classList.add('warn'); }
  else if (syncing) bar.textContent = 'Syncing…';
  else if (waiting) { bar.textContent = `${waiting} receipt${waiting > 1 ? 's' : ''} waiting to sync. Sync when you're on home Wi-Fi.`; bar.classList.add('warn'); }
  else if (allRecs.length) { bar.textContent = 'All receipts are on your computer ✓'; bar.classList.add('good'); }
  else bar.textContent = '';
}
let searchT;
$('search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(renderHome, 150); });

/* ---------- saving images to Photos / Files (iPhone share menu) ---------- */
function imageName(r) {
  const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [r.date || todayISO(), safe(r.payee || r.memo) || 'receipt', r.total != null ? Number(r.total).toFixed(2) : '', safe(r.customer)]
    .filter(Boolean).join(' ').slice(0, 120) + '.jpg';
}
async function shareImages(recs, title) {
  const used = new Set();
  const files = recs.filter(r => r.image).map(r => {
    let n = imageName(r), k = 2;
    while (used.has(n)) n = n.replace(/( \(\d+\))?\.jpg$/, ` (${k++}).jpg`);
    used.add(n);
    return new File([r.image], n, { type: 'image/jpeg' });
  });
  if (!files.length) { toast('No images to save.'); return; }
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }); }
    catch (e) { if (e.name !== 'AbortError') alert("Couldn't open the share menu: " + e.message); }
    return;
  }
  // fallback (computers / older phones): download the files
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.append(a); a.click(); a.remove();
  }
}

/* ---------- scanning ---------- */
let crop = null; // {canvas, corners, k, ox, oy}
$('camera').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  busy('Opening photo…');
  try {
    const canvas = await Scan.loadImage(f);
    crop = { canvas, corners: Scan.detectCorners(canvas) };
    show('crop'); busy();
    requestAnimationFrame(layoutCrop);
  } catch (err) { busy(); alert("Couldn't open that photo. Please try again."); }
});
function layoutCrop() {
  if (!crop) return;
  const wrap = $('cropWrap'), W = wrap.clientWidth, H = wrap.clientHeight, pad = 22;
  const k = Math.min((W - pad * 2) / crop.canvas.width, (H - pad * 2) / crop.canvas.height);
  const cw = Math.round(crop.canvas.width * k), ch = Math.round(crop.canvas.height * k);
  const c = $('cropCanvas'); c.width = cw; c.height = ch;
  c.style.left = ((W - cw) / 2) + 'px'; c.style.top = ((H - ch) / 2) + 'px';
  c.getContext('2d').drawImage(crop.canvas, 0, 0, cw, ch);
  Object.assign(crop, { k, ox: (W - cw) / 2, oy: (H - ch) / 2 });
  drawCrop();
}
function drawCrop() {
  const pts = crop.corners.map(p => [crop.ox + p.x * crop.k, crop.oy + p.y * crop.k]);
  document.querySelectorAll('.handle').forEach((h, i) => { h.style.left = pts[i][0] + 'px'; h.style.top = pts[i][1] + 'px'; });
  $('cropPoly').setAttribute('points', pts.map(p => p.join(',')).join(' '));
}
document.querySelectorAll('.handle').forEach(h => {
  h.addEventListener('pointerdown', e => { h.setPointerCapture(e.pointerId); e.preventDefault(); });
  h.addEventListener('pointermove', e => {
    if (!h.hasPointerCapture(e.pointerId)) return;
    const r = $('cropWrap').getBoundingClientRect(), i = +h.dataset.i;
    const x = (e.clientX - r.left - crop.ox) / crop.k, y = (e.clientY - r.top - crop.oy) / crop.k;
    crop.corners[i] = { x: Math.max(0, Math.min(crop.canvas.width, x)), y: Math.max(0, Math.min(crop.canvas.height, y)) };
    drawCrop();
  });
});
window.addEventListener('resize', () => { if ($('scr-crop').classList.contains('on')) layoutCrop(); });
$('cropBack').onclick = () => { crop = null; show('home'); };
$('cropWhole').onclick = () => { const W = crop.canvas.width, H = crop.canvas.height; crop.corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]; drawCrop(); };
$('cropOk').onclick = async () => {
  busy('Making the scan…');
  await new Promise(r => setTimeout(r, 30));
  try {
    const out = Scan.process(crop.canvas, crop.corners, settings.bw ? 'bw' : 'gray');
    const blob = await Scan.toBlob(out);
    const rec = { id: uuid(), created: Date.now(), updated: Date.now(), date: todayISO(), total: null, payee: '', memo: '', memoManual: false,
      customer: '', category: DEFAULT_CATEGORY, note: '', image: blob, thumb: Scan.thumb(out), synced: false, ocrText: '' };
    crop = null; busy();
    openEdit(rec, true);
    readReceipt(out, rec);
  } catch (err) { busy(); alert('Something went wrong making the scan. Please try again.'); }
};

/* ---------- reading the receipt (offline OCR) ---------- */
let workerP = null, ocrProgress = null;
function getWorker() {
  if (!workerP) {
    workerP = Tesseract.createWorker('eng', 1, {
      workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract/core', langPath: 'vendor/tesseract/lang',
      gzip: true, workerBlobURL: false, cacheMethod: 'none',
      logger: m => { if (m.status === 'recognizing text' && ocrProgress) ocrProgress(m.progress); },
    }).catch(e => { workerP = null; throw e; });
  }
  return workerP;
}
async function readReceipt(canvas, rec) {
  const st = $('ocrStatus');
  st.classList.remove('hidden'); st.textContent = 'Reading the receipt…';
  ocrProgress = p => { if (current === rec) st.textContent = `Reading the receipt… ${Math.round(p * 100)}%`; };
  try {
    const w = await getWorker();
    const { data } = await w.recognize(canvas);
    rec.ocrText = data.text || '';
    const got = Parse.receipt(rec.ocrText, lists.payees, settings.names);
    if (current !== rec) return;
    const found = [];
    if (got.date && !touched.has('date')) { rec.date = got.date; $('fDate').value = got.date; found.push('date'); }
    if (got.total != null && !touched.has('total')) { rec.total = got.total; $('fTotal').value = got.total.toFixed(2); showNeg(); found.push('total'); }
    if (got.payee && !touched.has('payee')) { setPayee(got.payee); found.push('payee'); }
    else if (!got.payee && got.store && !$('fPayee').value) showStoreHint(got.store);
    st.textContent = found.length ? `✓ Read the ${found.join(', ')}. Please check ${found.length > 1 ? 'them' : 'it'}.` : "Couldn't read this receipt clearly. Please fill it in.";
  } catch (e) {
    if (current === rec) st.textContent = "Couldn't read the receipt automatically. Please fill it in.";
  } finally { ocrProgress = null; }
}

/* ---------- edit form ---------- */
function fillSelect(sel, items, value, placeholder, addLabel) {
  sel.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  add('', placeholder);
  const all = sortNames(items.concat(value ? [value] : []));
  all.forEach(n => add(n, n));
  add('__new__', addLabel);
  sel.value = value || '';
}
function payeeNames() { return (lists.payees || []).map(p => p.name); }
function canonPayee(n) { const k = lc(n); if (!k) return ''; return payeeNames().find(p => lc(p) === k) || norm(n); }
function setPayee(name) {
  current.payee = canonPayee(name); $('fPayee').value = current.payee;
  if (!current.memoManual) current.memo = current.payee;      // memo = payee (not shown on the phone)
  $('storeHint').classList.add('hidden');
  $('payeeSug').classList.add('hidden');
}
function showStoreHint(store) {
  const h = $('storeHint'); h.innerHTML = '';
  h.append('On the receipt: ', Object.assign(document.createElement('b'), { textContent: store }));
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Use as payee';
  b.onclick = () => { setPayee(store); dirty = true; };
  h.append(b); h.classList.remove('hidden');
}
function openEdit(rec, fresh) {
  current = rec; isNew = fresh; dirty = fresh; touched = new Set(); custBefore = lc(rec.customer);
  $('editTitle').textContent = fresh ? 'New receipt' : 'Receipt';
  $('editImg').src = URL.createObjectURL(rec.image);
  $('ocrStatus').classList.add('hidden'); $('storeHint').classList.add('hidden');
  $('fDate').value = rec.date || '';
  $('fTotal').value = rec.total != null ? Number(rec.total).toFixed(2) : ''; showNeg();
  $('fPayee').value = rec.payee || '';
  $('fCustomer').value = rec.customer || '';
  fillSelect($('fCategory'), lists.categories.concat([DEFAULT_CATEGORY]), rec.category, '— Choose category —', '➕ Add new category…');
  $('fNote').value = rec.note || '';
  $('editMeta').textContent = fresh ? '' : `Scanned ${new Date(rec.created).toLocaleString()} · ${rec.synced ? 'On your computer ✓' : 'Waiting to sync'}`;
  $('editDelete').textContent = (!fresh && rec.synced) ? 'Remove from this phone' : 'Delete receipt';
  show('edit');
  $('scr-edit').querySelector('.scroll').scrollTop = 0;
}
/* Totals can be negative (returns). The iPhone number pad has no minus key, so there's a "− Return" button. */
function totalText() {
  let t = norm($('fTotal').value).replace(/[\u2212\u2013\u2014]/g, '-').replace(/[$,\s]/g, '');
  const m = t.match(/^\((.*)\)$/); if (m) t = '-' + m[1];          // (12.34) = -12.34
  if (/^\d.*-$/.test(t)) t = '-' + t.slice(0, -1);                   // 12.34- = -12.34
  return t.replace(/^--/, '');
}
function showNeg() {
  const neg = totalText().startsWith('-');
  $('fNeg').setAttribute('aria-pressed', neg ? 'true' : 'false');
  $('fNeg').textContent = neg ? '✓ Return' : '− Return';
  $('fTotal').classList.toggle('neg', neg);
}
$('fNeg').onclick = () => {
  const t = totalText();
  $('fTotal').value = t.startsWith('-') ? t.slice(1) : '-' + t;
  dirty = true; touched.add('total'); showNeg();
};
$('fTotal').addEventListener('input', showNeg);
['fDate', 'fTotal', 'fNote'].forEach(id => $(id).addEventListener('input', () => { dirty = true; touched.add(id.slice(1).toLowerCase()); }));

/* Customer picker order: the job you last added a receipt to comes first, then the most used, then A–Z.
   Kept on this phone: { "mike": { n: 12, last: 1763900000000 } } */
let custUse = {};
const saveCustUse = () => DB.kvSet('custUse', custUse).catch(() => {});
function noteCustomerUse(name) {
  const k = lc(name); if (!k) return;
  const u = custUse[k] || (custUse[k] = { n: 0, last: 0 });
  u.n++; u.last = Date.now(); saveCustUse();
}
function custOrder(list) {
  const use = n => custUse[lc(n)] || { n: 0, last: 0 };
  let top = null;
  for (const n of list) if (use(n).last && (!top || use(n).last > use(top).last)) top = n;
  list.sort((a, b) => (b === top) - (a === top) || use(b).n - use(a).n || use(b).last - use(a).last || a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return list;
}
// First time: count the receipts already on this phone (and recent ones the computer told us about)
async function seedCustUse() {
  const saved = await DB.kvGet('custUse').catch(() => null);
  if (saved && Object.keys(saved).length) { custUse = saved; return; }
  const onPhone = await DB.all(), ids = new Set();
  for (const r of onPhone) {
    ids.add(r.id); const k = lc(r.customer); if (!k) continue;
    const u = custUse[k] || (custUse[k] = { n: 0, last: 0 }); u.n++; u.last = Math.max(u.last, r.created || 0);
  }
  for (const r of lists.known || []) {
    const k = lc(r.customer); if (!k || ids.has(r.id)) continue;
    const u = custUse[k] || (custUse[k] = { n: 0, last: 0 }); u.n++;
    if (!u.last) u.last = 1;            // older than anything added on this phone
  }
  saveCustUse();
}

/* Type-and-pick lists under a box (iPhone Safari only shows typed suggestions above the keyboard) */
function setupAC(input, ul, getNames, onPick, word, showAllWhenEmpty, order) {
  let picking = false, hl = -1;
  const alpha = list => list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const arrange = order || alpha;
  function matches(q) {
    q = lc(q);
    const names = getNames();
    if (!q) return showAllWhenEmpty ? arrange(names.slice()).slice(0, 60) : [];
    const starts = [], words = [], contains = [];
    for (const n of names) {
      const l = lc(n);
      if (l.startsWith(q)) starts.push(n);
      else if (l.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) words.push(n);
      else if (l.includes(q)) contains.push(n);
    }
    if (order) { order(starts); order(words); order(contains); }
    return starts.concat(words, contains).slice(0, 10);
  }
  function render() {
    const v = input.value, q = lc(v), list = matches(v);
    ul.innerHTML = '';
    if ((!q && !list.length) || (list.length === 1 && lc(list[0]) === q)) { ul.classList.add('hidden'); return; }
    list.forEach((n, i) => {
      const li = document.createElement('li');
      const k = q ? lc(n).indexOf(q) : -1;
      if (k >= 0) { li.append(n.slice(0, k)); const b = document.createElement('b'); b.textContent = n.slice(k, k + q.length); li.append(b, n.slice(k + q.length)); }
      else li.textContent = n;
      if (i === hl) li.classList.add('hl');
      li.addEventListener('pointerdown', e => { e.preventDefault(); picking = true; });
      li.addEventListener('click', () => pick(n));
      ul.append(li);
    });
    if (q && !list.some(n => lc(n) === q)) {
      const li = document.createElement('li'); li.className = 'new';
      li.textContent = `➕ Use "${norm(v)}" (new ${word})`;
      li.addEventListener('pointerdown', e => { e.preventDefault(); picking = true; });
      li.addEventListener('click', () => pick(norm(v)));
      ul.append(li);
    }
    ul.classList.remove('hidden');
  }
  function pick(n) { picking = false; hl = -1; onPick(n); ul.classList.add('hidden'); input.blur(); }
  input.addEventListener('input', () => { hl = -1; render(); });
  input.addEventListener('focus', () => { render(); setTimeout(() => input.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); });
  input.addEventListener('blur', () => setTimeout(() => { if (!picking) ul.classList.add('hidden'); }, 150));
  input.addEventListener('keydown', e => {
    const items = [...ul.querySelectorAll('li')];
    if (!items.length || ul.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render(); }
    else if (e.key === 'Enter' && hl >= 0) { e.preventDefault(); items[hl].click(); }
    else if (e.key === 'Escape') ul.classList.add('hidden');
  });
  return { picking: () => picking, hide: () => ul.classList.add('hidden') };
}

/* Payee */
$('fPayee').addEventListener('input', () => {
  dirty = true; touched.add('payee'); current.payee = norm($('fPayee').value);
  if (!current.memoManual) current.memo = current.payee;
});
const payeeAC = setupAC($('fPayee'), $('payeeSug'), payeeNames, n => { dirty = true; touched.add('payee'); setPayee(n); }, 'payee', false);
$('fPayee').addEventListener('change', () => { if (!payeeAC.picking()) setPayee($('fPayee').value); });

/* Customer: type or pick; a new name is added to the list (and sent to the computer on sync) */
function setCustomer(name) {
  const n = norm(name);
  let v = '';
  if (n) {
    v = lists.customers.find(c => lc(c) === lc(n)) || n;
    if (!lists.customers.some(c => lc(c) === lc(v))) { lists.customers.push(v); lists.pending.customers.push(v); saveLists(); }
  }
  if (current) current.customer = v;
  $('fCustomer').value = v;
}
const custAC = setupAC($('fCustomer'), $('custSug'), () => lists.customers, n => { dirty = true; setCustomer(n); }, 'customer', true, custOrder);
$('fCustomer').addEventListener('input', () => { dirty = true; });
$('fCustomer').addEventListener('change', () => { if (!custAC.picking()) setCustomer($('fCustomer').value); });

/* Category (list with "Add new") */
function selectAdd(sel, key, label) {
  sel.addEventListener('change', () => {
    dirty = true;
    if (sel.value !== '__new__') return;
    const name = norm(prompt(`New ${label} name (spelled as in QuickBooks):`) || '');
    if (!name) { sel.value = current[key] || ''; return; }
    const listKey = 'categories';
    const existing = lists[listKey].find(n => lc(n) === lc(name));
    const v = existing || name;
    if (!existing) { lists[listKey].push(v); lists.pending[listKey].push(v); saveLists(); }
    fillSelect(sel, lists[listKey].concat([DEFAULT_CATEGORY]), v, sel.options[0].textContent, sel.options[sel.options.length - 1].textContent);
  });
}
selectAdd($('fCategory'), 'category', 'category');
$('editShare').onclick = () => shareImages([Object.assign({}, current, { date: $('fDate').value || current.date, payee: canonPayee($('fPayee').value) || current.payee, customer: norm($('fCustomer').value), total: parseFloat(totalText()) || current.total })], 'Receipt');
$('editImg').onclick = () => { $('viewerImg').src = $('editImg').src; $('viewer').classList.remove('hidden'); };
$('viewerClose').onclick = () => $('viewer').classList.add('hidden');

$('editSave').onclick = async () => {
  const t = totalText();
  if (t && isNaN(parseFloat(t))) { alert('The total should be a number, like 17.81'); return; }
  if (!t && !confirm('There is no total. Save anyway?')) return;
  Object.assign(current, {
    date: $('fDate').value || todayISO(), total: t ? Math.round(parseFloat(t) * 100) / 100 : null,
    payee: canonPayee($('fPayee').value), customer: (setCustomer($('fCustomer').value), current.customer),
    category: $('fCategory').value === '__new__' ? '' : $('fCategory').value, note: $('fNote').value.trim(),
    updated: Date.now(), synced: false,
  });
  if (!current.memoManual) current.memo = current.payee;
  if (isNew) {
    const matches = await findRescans(current);
    if (matches.length) {
      const ans = await askRescan(current, matches);
      if (ans.action === 'back') return;
      if (ans.action !== 'separate') { await useRescan(current, ans); return; }
    }
  }
  if (current.customer && (isNew || lc(current.customer) !== custBefore)) noteCustomerUse(current.customer);
  await DB.put(current);
  current = null; dirty = false;
  show('home'); await renderHome();
  toast('Saved ✓');
  sync(false);
};
/* ---------- rescans: the same receipt scanned twice ---------- */
const dayNo = d => d ? Math.round(new Date(d + 'T12:00').getTime() / 864e5) : NaN;
const fmtD = d => d ? new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date';
const fmtMoney = n => n == null ? 'no total' : (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toFixed(2);
// Same date and total, and the same payee when both have one (same rule as the computer)
const payKey = n => lc(n).replace(/[^a-z0-9]/g, '');
async function findRescans(rec) {
  if (rec.total == null || !rec.total || !rec.date) return [];
  const same = x => x.total != null && Math.abs(Number(x.total) - rec.total) < 0.005 && x.date === rec.date &&
    (!payKey(x.payee) || !payKey(rec.payee) || payKey(x.payee) === payKey(rec.payee));
  const onPhone = (await DB.all()).filter(r => r.id !== rec.id);
  const phoneIds = new Set(onPhone.map(r => r.id));
  const out = onPhone.filter(same).map(r => ({ where: 'phone', rec: r }))
    .concat((lists.known || []).filter(k => !phoneIds.has(k.id) && same(k)).map(k => ({ where: 'computer', rec: k })));
  out.sort((a, b) => Math.abs(dayNo(a.rec.date) - dayNo(rec.date)) - Math.abs(dayNo(b.rec.date) - dayNo(rec.date)));
  return out.slice(0, 4);
}
// The computer's picture of a receipt that is no longer on this phone (if the computer can be reached right now)
async function computerImage(id) {
  if (!settings.token || !settings.addr) return null;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(baseURL() + '/api/image?id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + settings.token }, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok || !(r.headers.get('Content-Type') || '').startsWith('image/')) return null;
    return URL.createObjectURL(await r.blob());
  } catch (e) { return null; } finally { clearTimeout(t); }
}
function askRescan(rec, matches) {
  return new Promise(resolve => {
    const urls = [];
    const done = ans => { $('dup').classList.add('hidden'); urls.forEach(u => URL.revokeObjectURL(u)); resolve(ans); };
    const nu = URL.createObjectURL(rec.image); urls.push(nu);
    $('dupNewImg').src = nu;
    $('dupNewInfo').textContent = `${fmtD(rec.date)} · ${fmtMoney(rec.total)}${rec.payee ? ' · ' + rec.payee : ''}`;
    $('dupText').textContent = matches.length > 1
      ? `You already have ${matches.length} receipts with the same date and total. If this is a rescan of one of them, pick which picture to keep.`
      : 'You already have a receipt with the same date and total. If this is a rescan of it, pick which picture to keep.';
    const list = $('dupList'); list.innerHTML = '';
    for (const m of matches) {
      const r = m.rec, card = document.createElement('div'); card.className = 'dupCard';
      let pic;
      if (m.where === 'phone' && r.image) { pic = document.createElement('img'); const u = URL.createObjectURL(r.image); urls.push(u); pic.src = u; pic.alt = 'Earlier scan'; }
      else {
        pic = document.createElement('div'); pic.className = 'noimg'; pic.textContent = 'Getting the picture from your computer…';
        computerImage(r.id).then(u => {
          if (!u) { pic.textContent = 'Picture is on your computer'; return; }
          urls.push(u); const img = document.createElement('img'); img.src = u; img.alt = 'Earlier scan'; pic.replaceWith(img);
        });
      }
      const info = document.createElement('div'); info.className = 'grow';
      const where = m.where === 'computer' ? (r.billed ? 'On your computer, already BILLED (not on this phone any more)' : 'On your computer (not on this phone any more)') : r.synced ? 'On this phone and your computer' : 'Only on this phone (not synced yet)';
      info.innerHTML = '<b></b><div class="small"></div><div class="small muted"></div><div class="btns"></div>';
      info.children[0].textContent = 'Earlier scan';
      info.children[1].textContent = `${fmtD(r.date)} · ${fmtMoney(r.total)}${r.payee ? ' · ' + r.payee : ''}${r.customer ? ' · ' + r.customer : ''}`;
      info.children[2].textContent = where;
      const keepNew = document.createElement('button'); keepNew.className = 'primary'; keepNew.textContent = 'Same receipt: keep the NEW scan';
      const keepOld = document.createElement('button'); keepOld.className = 'secondary'; keepOld.textContent = 'Same receipt: keep this earlier scan';
      keepNew.onclick = () => done({ action: 'new', match: m });
      keepOld.onclick = () => done({ action: 'old', match: m });
      info.children[3].append(keepNew, keepOld);
      card.append(pic, info); list.append(card);
    }
    $('dupNot').onclick = () => done({ action: 'separate' });
    $('dupBack').onclick = () => done({ action: 'back' });
    $('dup').classList.remove('hidden');
  });
}
async function useRescan(rec, { action, match }) {
  const fill = (t, f) => { if (!t[f] && rec[f]) t[f] = rec[f]; };
  if (action === 'new') {
    let t;
    if (match.where === 'phone') {
      t = await DB.get(match.rec.id);
      if (!t.synced && !t.imageOnly) {            // not on the computer yet: the whole receipt goes over with the new picture
        ['payee', 'customer', 'note'].forEach(f => fill(t, f));
        if (!t.category || t.category === DEFAULT_CATEGORY) t.category = rec.category || t.category;
        if (!t.memoManual) t.memo = t.payee;
      } else t.imageOnly = true;                    // already on the computer: only the picture is replaced there
    } else {
      const k = match.rec;                          // only on the computer: bring it back to the phone with the new picture
      t = { id: k.id, created: Date.now(), date: k.date, total: k.total, payee: k.payee || '', memo: k.payee || '', memoManual: false,
        customer: k.customer || '', category: k.category || '', note: k.note || '', ocrText: '', imageOnly: true };
    }
    Object.assign(t, { image: rec.image, thumb: rec.thumb, ocrText: rec.ocrText || t.ocrText || '', updated: Date.now(), synced: false });
    await DB.put(t);
  }
  current = null; dirty = false;
  show('home'); await renderHome();
  if (action === 'new') { toast(match.where === 'phone' && !match.rec.synced ? '✓ The new scan replaced the earlier one' : '✓ The new scan will replace the picture on your computer'); sync(false); }
  else toast('Kept the earlier scan. The new scan was not saved.');
}
$('editBack').onclick = () => {
  if (dirty && !confirm(isNew ? 'Throw away this scan?' : 'Leave without saving your changes?')) return;
  current = null; show('home'); renderHome();
};
$('editDelete').onclick = async () => {
  const synced = !isNew && current.synced;
  if (!confirm(synced ? 'Remove this receipt from the phone? It stays on your computer.' : 'Delete this receipt? This cannot be undone.')) return;
  if (!isNew) await DB.del(current.id);
  current = null; show('home'); renderHome();
};

/* ---------- talking to the computer ---------- */
// Just the computer's address, whatever was typed or pasted ("http://192.168.1.20:8780/setup" -> "192.168.1.20")
function cleanAddr(a) { return norm(a).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').trim(); }
function baseURL() { return 'https://' + cleanAddr(settings.addr) + ':8443'; }
async function api(method, path, body, timeoutMs = 15000, opts = {}) {
  try { return await apiOnce(method, path, body, timeoutMs); }
  catch (e) {
    // The computer may have been given a new address by the Wi-Fi router: look for it, then try once more
    if (!e.unreachable || !settings.token || opts.noSearch) throw e;
    if (!opts.manual && Date.now() - lastAutoSearch < 10 * 60e3) throw e;   // computer probably just off: don't search every time
    lastAutoSearch = Date.now();
    const btn = $('btnSync'), label = btn.textContent; btn.textContent = 'Looking for computer…';
    let found;
    try { found = await findComputer(); } finally { btn.textContent = label; }
    if (!found) throw e;
    toast('✓ Found your computer at its new address: ' + settings.addr);
    return await apiOnce(method, path, body, timeoutMs);
  }
}
let lastAutoSearch = 0;

/* Find this computer again after its address changed. Only the same home network is
   searched (same first three numbers, e.g. 192.168.1.___). The computer is recognized by
   the key it gave this phone, so another computer is never picked by mistake. */
let searching = null;
function findComputer(manual) {
  if (searching) return searching;
  const m = cleanAddr(settings.addr).match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/);
  if (!m) return Promise.resolve(false);
  const prefix = m[1], old = +m[2];
  searching = (async () => {
    const tries = [];
    for (let i = 1; i <= 254; i++) if (i !== old) tries.push(prefix + '.' + i);
    const probe = async ip => {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
      try {
        const r = await fetch('https://' + ip + ':8443/api/lists', { headers: { Authorization: 'Bearer ' + settings.token }, signal: ctl.signal, cache: 'no-store' });
        return r.ok;
      } catch (e) { return false; } finally { clearTimeout(t); }
    };
    try {
      for (let i = 0; i < tries.length; i += 32) {             // 32 at a time, a few seconds per group
        const group = tries.slice(i, i + 32);
        const ok = await Promise.all(group.map(probe));
        const hit = group[ok.indexOf(true)];
        if (hit) {
          settings.addr = hit; await saveSettings();
          return true;
        }
      }
      return false;
    } finally { searching = null; }
  })();
  return searching;
}
function showSearching(on) {
  const b = $('btnFind'); if (!b) return;
  b.disabled = on;
  b.textContent = on ? 'Looking on your Wi-Fi… (up to 30 seconds)' : 'Find my computer on this Wi-Fi';
}
// Only when this button is tapped (Sync never searches by itself)
$('btnFind').onclick = async () => {
  if (!settings.token) { $('pairMsg').textContent = 'Connect with the address and code first.'; return; }
  showSearching(true);
  try { await findNow(); } finally { showSearching(false); }
};
async function findNow() {
  try { await apiOnce('GET', '/api/lists', null, 5000); $('pairMsg').textContent = `✓ Your computer is answering at ${settings.addr}. Nothing to find.`; return; } catch (e) { if (e.status === 401) { $('pairMsg').textContent = 'The computer needs a new code for this phone. Type the 6-digit code shown on the computer (☰ → Phone setup).'; return; } }
  $('pairMsg').textContent = 'Looking for your computer…';
  const ok = await findComputer(true);
  if (ok) { $('sAddr').value = settings.addr; $('pairMsg').textContent = `✓ Found your computer at ${settings.addr}.`; $('connSummary').textContent = `Set up for ${settings.addr}`; sync(true); }
  else $('pairMsg').textContent = "Couldn't find it. Check that Time Saver is open on the computer and that Windows is allowing it (see the computer's ☰ → Phone setup).";
}
// Check the connection for real when Settings is opened
async function checkLive() {
  if (!settings.token) return;
  $('pairMsg').textContent = `Set up for ${settings.addr}. Checking…`;
  try { await apiOnce('GET', '/api/lists', null, 5000); $('pairMsg').textContent = `✓ Connected to ${settings.addr} right now`; $('connSummary').textContent = `✓ Connected to ${settings.addr}`; }
  catch (e) { $('connCard').open = true; $('connSummary').textContent = `⚠ Computer not answering (${settings.addr})`; $('pairMsg').textContent = e.status === 401 ? 'The computer needs a new code for this phone (☰ → Phone setup on the computer).' : `Set up for ${settings.addr}, but the computer isn't answering right now. Is Time Saver open? If the computer's address changed, tap Find my computer.`; }
}
async function apiOnce(method, path, body, timeoutMs = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = {};
  if (settings.token) headers.Authorization = 'Bearer ' + settings.token;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  try {
    const r = await fetch(baseURL() + path, { method, headers, body, signal: ctl.signal, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || ('Error ' + r.status)); e.status = r.status; throw e; }
    return data;
  } catch (e) {
    if (e.status) throw e;
    const x = new Error('unreachable'); x.unreachable = true; throw x;
  } finally { clearTimeout(t); }
}
const UNREACHABLE = "Can't reach your computer. Check that:\n• this phone is on your home Wi-Fi\n• Time Saver is running on the computer\n• the address is right (if it changed: ⚙︎ → Computer connection → Find my computer)\n• the security certificate is installed and trusted (Phone setup, step 1)";

async function sync(manual) {
  if (syncing) return;
  if (!settings.token) { if (manual) { toast('Connect to your computer first.'); openSettings(); } return; }
  const waiting = (await DB.all()).filter(r => !r.synced);
  if (!manual && !waiting.length && Date.now() - (settings.lastListSync || 0) < 10 * 60e3) return;
  syncing = true; renderHome();
  let sent = 0;
  try {
    if (lists.pending.customers.length || lists.pending.categories.length) {
      await api('POST', '/api/lists/add', { customers: lists.pending.customers, categories: lists.pending.categories }, manual ? 15000 : 5000, { manual });
      lists.pending = { customers: [], categories: [] }; await saveLists();
    }
    for (const r of waiting) {
      if (r.imageOnly) {                        // a better scan of a receipt the computer already has
        const fi = new FormData();
        fi.append('id', r.id); fi.append('image', r.image, r.id + '.jpg');
        let res = null;
        try { res = await api('POST', '/api/receipts/image', fi, 60000, { manual }); } catch (e) { if (e.status !== 404) throw e; }
        if (res && res.ok === true) { delete r.imageOnly; r.synced = true; r.syncedAt = Date.now(); await DB.put(r); sent++; continue; }
        delete r.imageOnly;                      // computer doesn't have it any more (or is an older version): send the whole receipt
      }
      const fd = new FormData();
      const { image, thumb, imageOnly, ...meta } = r;
      fd.append('meta', JSON.stringify(meta));
      fd.append('image', image, r.id + '.jpg');
      await api('POST', '/api/receipts', fd, 60000, { manual });
      r.synced = true; r.syncedAt = Date.now(); await DB.put(r); sent++;
    }
    const l = await api('GET', '/api/lists', null, 15000, { manual });
    lists.customers = sortNames(l.customers || []);
    lists.categories = sortNames(l.categories || []);
    lists.payees = l.payees || [];
    lists.known = l.known || [];
    lists.company = l.company || '';
    showCompany();
    if (typeof l.useNames === 'boolean') settings.names = l.useNames;
    settings.lastListSync = Date.now(); await saveSettings(); await saveLists();
    refreshPayeeList();
    if (manual || sent) toast(sent ? `✓ Sent ${sent} receipt${sent > 1 ? 's' : ''} to your computer` : '✓ Up to date');
  } catch (e) {
    if (e.status === 401) { settings.token = ''; await saveSettings(); if (manual || sent) alert('This phone needs to be connected to the computer again (Settings).'); }
    else if (manual) alert(e.unreachable ? UNREACHABLE : ('Sync problem: ' + e.message));
  } finally { syncing = false; renderHome(); }
}
$('btnSync').onclick = () => sync(true);
function refreshPayeeList() {
  const dl = $('payeeList'); dl.innerHTML = '';
  payeeNames().forEach(n => { const o = document.createElement('option'); o.value = n; dl.append(o); });
}

/* ---------- settings ---------- */
async function openSettings() {
  $('sAddr').value = settings.addr || ''; $('sCode').value = '';
  $('sBW').checked = settings.bw !== false; $('sNames').checked = settings.names !== false;
  $('pairMsg').textContent = settings.token ? `Set up for ${settings.addr}` : 'Not connected yet.';
  $('connSummary').textContent = settings.token ? `Set up for ${settings.addr}` : 'Not connected yet. Tap to set up.';
  checkLive();
  $('connCard').open = !settings.token;
  try {
    const est = await navigator.storage.estimate();
    const all = await DB.all();
    const waiting = all.filter(r => !r.synced).length;
    $('storeInfo').textContent = `${all.length} receipts on this phone (about ${Math.round((est.usage || 0) / 1048576)} MB)` + (waiting ? `. ${waiting} not synced yet: they are only on this phone.` : '. All are also on your computer.');
  } catch (e) { $('storeInfo').textContent = ''; }
  $('version').textContent = 'Receipts ' + VERSION;
  show('settings');
}
$('btnSettings').onclick = openSettings;
$('setBack').onclick = () => { show('home'); renderHome(); };
$('sBW').onchange = () => { settings.bw = $('sBW').checked; saveSettings(); };
$('sNames').onchange = () => { settings.names = $('sNames').checked; saveSettings(); };
$('btnPair').onclick = async () => {
  const addr = cleanAddr($('sAddr').value), code = norm($('sCode').value).replace(/\s/g, '');
  if (!addr) { $('pairMsg').textContent = 'Type the computer address shown on the computer (☰ → Phone setup).'; return; }
  const oldAddr = settings.addr, oldTok = settings.token;      // keep the current connection until the new one works
  $('sAddr').value = addr;
  settings.addr = addr;
  $('pairMsg').textContent = 'Connecting…';
  if (!code) {
    // already connected before: just check the (new) address with the existing key
    if (!oldTok) { settings.addr = oldAddr; $('pairMsg').textContent = 'Type the 6-digit code shown on the computer.'; return; }
    try {
      await api('GET', '/api/lists', null, 15000, { noSearch: true });
      await saveSettings();
      $('pairMsg').textContent = `✓ Connected to ${addr}`; $('connSummary').textContent = `✓ Connected to ${addr}`;
      sync(true);
    } catch (e) {
      settings.addr = oldAddr;
      $('pairMsg').textContent = e.status === 401 ? 'The computer needs a new code for this phone. Type the 6-digit code shown on the computer (☰ → Phone setup).' : (e.unreachable ? UNREACHABLE : e.message);
    }
    return;
  }
  if (!/^\d{6}$/.test(code)) { settings.addr = oldAddr; $('pairMsg').textContent = 'The code is 6 digits.'; return; }
  try {
    const r = await api('POST', '/api/pair', { code, device: 'iPhone' }, 15000, { noSearch: true });
    settings.token = r.token; await saveSettings();
    $('sCode').value = '';
    $('pairMsg').textContent = `✓ Connected to ${r.name || 'your computer'}`;
    $('connSummary').textContent = `✓ Connected to ${addr}`;
    sync(true);
  } catch (e) {
    settings.addr = oldAddr; settings.token = oldTok;           // a failed try never breaks the old connection
    $('pairMsg').textContent = e.unreachable ? UNREACHABLE : (e.status === 403 ? 'That code is wrong or was already used. Each code works once. Check the code shown on the computer now (☰ → Phone setup).' : e.message);
  }
};
// Asks the computer NOW which receipts are billed. If it can't be reached, nothing is removed
// and nothing is remembered for later: it only happens when this button is tapped again.
$('btnCleanBilled').onclick = async () => {
  if (!settings.token) { toast('Connect to your computer first (Computer connection below).'); return; }
  const btn = $('btnCleanBilled'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Asking your computer…';
  let billedIds;
  try { billedIds = new Set(((await api('GET', '/api/lists', null, 15000, { manual: true })).billed) || []); }
  catch (e) { alert("Couldn't reach your computer, so nothing was removed.\n\nTry again when the phone is on home Wi-Fi and the program is open on the computer."); return; }
  finally { btn.disabled = false; btn.textContent = label; }
  const billed = (await DB.all()).filter(r => r.synced && billedIds.has(r.id));
  if (!billed.length) { toast('None of the receipts on this phone are marked billed on the computer.'); return; }
  if (!confirm(`${billed.length} receipt${billed.length > 1 ? 's on this phone are' : ' on this phone is'} marked billed on the computer. Remove ${billed.length > 1 ? 'them' : 'it'} from this phone?\n\nThey stay on your computer.`)) return;
  for (const r of billed) await DB.del(r.id);
  toast(`Removed ${billed.length} billed receipt${billed.length > 1 ? 's' : ''} from this phone`);
  openSettings();
};
$('btnClean').onclick = async () => {
  const synced = (await DB.all()).filter(r => r.synced);
  if (!synced.length) { toast('No synced receipts to remove.'); return; }
  if (!confirm(`Remove ${synced.length} synced receipt${synced.length > 1 ? 's' : ''} from this phone? They stay on your computer.`)) return;
  for (const r of synced) await DB.del(r.id);
  openSettings();
};

/* company name (from Company setup on the computer) */
function showCompany() { $('coName').textContent = lists.company ? lists.company : 'Time Saver'; }

/* ---------- start ---------- */
(async () => {
  try {
    settings = Object.assign(settings, await DB.kvGet('settings') || {});
    const l = await DB.kvGet('lists'); if (l) lists = Object.assign(lists, l);
    lists.pending = lists.pending || { customers: [], categories: [] };
  } catch (e) { alert('This phone is not letting the app save data. Please open it from the Home Screen icon.'); }
  try { for (const r of await DB.all()) if (r.billed) { delete r.billed; await DB.put(r); } } catch (e) {}   // earlier version hid billed receipts
  try { await seedCustUse(); } catch (e) {}
  refreshPayeeList();
  showCompany();
  renderHome();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !current) location.reload(); });
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
  }
  sync(false);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(false); });
  setInterval(() => sync(false), 120000);
})();
