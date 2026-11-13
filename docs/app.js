/* KellerKraft Receipts — phone app */
'use strict';
const VERSION = '0.1.3';
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
  allRecs = (await DB.all()).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created - a.created);
  const list = $('list'); list.innerHTML = '';
  $('emptyList').classList.toggle('hidden', allRecs.length > 0);
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
    if (got.total != null && !touched.has('total')) { rec.total = got.total; $('fTotal').value = got.total.toFixed(2); found.push('total'); }
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
  if (!current.memoManual) { current.memo = current.payee; $('fMemo').value = current.memo; }
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
  current = rec; isNew = fresh; dirty = fresh; touched = new Set();
  $('editTitle').textContent = fresh ? 'New receipt' : 'Receipt';
  $('editImg').src = URL.createObjectURL(rec.image);
  $('ocrStatus').classList.add('hidden'); $('storeHint').classList.add('hidden');
  $('fDate').value = rec.date || '';
  $('fTotal').value = rec.total != null ? Number(rec.total).toFixed(2) : '';
  $('fPayee').value = rec.payee || '';
  $('fMemo').value = rec.memo || '';
  fillSelect($('fCustomer'), lists.customers, rec.customer, '— Choose customer —', '➕ Add new customer…');
  fillSelect($('fCategory'), lists.categories.concat([DEFAULT_CATEGORY]), rec.category, '— Choose category —', '➕ Add new category…');
  $('fNote').value = rec.note || '';
  $('editMeta').textContent = fresh ? '' : `Scanned ${new Date(rec.created).toLocaleString()} · ${rec.synced ? 'On your computer ✓' : 'Waiting to sync'}`;
  $('editDelete').textContent = (!fresh && rec.synced) ? 'Remove from this phone' : 'Delete receipt';
  show('edit');
  $('scr-edit').querySelector('.scroll').scrollTop = 0;
}
['fDate', 'fTotal', 'fNote'].forEach(id => $(id).addEventListener('input', () => { dirty = true; touched.add(id.slice(1).toLowerCase()); }));
$('fPayee').addEventListener('input', () => {
  dirty = true; touched.add('payee'); current.payee = norm($('fPayee').value);
  if (!current.memoManual) { current.memo = current.payee; $('fMemo').value = current.memo; }
});
$('fPayee').addEventListener('change', () => { if (!acPicking) setPayee($('fPayee').value); });

/* Payee dropdown under the box (iPhone Safari doesn't show a list for typed suggestions) */
let acPicking = false, acHl = -1;
function payeeMatches(q) {
  q = lc(q); if (!q) return [];
  const starts = [], words = [], contains = [];
  for (const n of payeeNames()) {
    const l = lc(n);
    if (l.startsWith(q)) starts.push(n);
    else if (l.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) words.push(n);
    else if (l.includes(q)) contains.push(n);
  }
  return starts.concat(words, contains).slice(0, 8);
}
function renderPayeeSug() {
  const ul = $('payeeSug'), v = $('fPayee').value, q = lc(v);
  const list = payeeMatches(v);
  ul.innerHTML = '';
  if (!q || (list.length === 1 && lc(list[0]) === q)) { ul.classList.add('hidden'); return; }
  list.forEach((n, i) => {
    const li = document.createElement('li');
    const k = lc(n).indexOf(q);
    if (k >= 0) { li.append(n.slice(0, k)); const b = document.createElement('b'); b.textContent = n.slice(k, k + q.length); li.append(b, n.slice(k + q.length)); }
    else li.textContent = n;
    if (i === acHl) li.classList.add('hl');
    li.addEventListener('pointerdown', e => { e.preventDefault(); acPicking = true; });
    li.addEventListener('click', () => { pickPayee(n); });
    ul.append(li);
  });
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'new';
    li.textContent = list.length ? `Not on your list: "${norm(v)}" (new payee)` : `"${norm(v)}" is not on your payee list (new payee)`;
    li.addEventListener('pointerdown', e => { e.preventDefault(); acPicking = true; });
    li.addEventListener('click', () => { pickPayee(norm(v)); });
    ul.append(li);
  }
  ul.classList.remove('hidden');
}
function pickPayee(n) {
  acPicking = false; acHl = -1;
  dirty = true; touched.add('payee');
  setPayee(n);
  $('payeeSug').classList.add('hidden');
  $('fPayee').blur();
}
$('fPayee').addEventListener('input', () => { acHl = -1; renderPayeeSug(); });
$('fPayee').addEventListener('focus', () => {
  renderPayeeSug();
  setTimeout(() => $('fPayee').scrollIntoView({ block: 'start', behavior: 'smooth' }), 250);   // keep the list above the keyboard
});
$('fPayee').addEventListener('blur', () => setTimeout(() => { if (!acPicking) $('payeeSug').classList.add('hidden'); }, 150));
$('fPayee').addEventListener('keydown', e => {
  const items = [...$('payeeSug').querySelectorAll('li')];
  if (!items.length || $('payeeSug').classList.contains('hidden')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acHl = (acHl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; renderPayeeSug(); }
  else if (e.key === 'Enter' && acHl >= 0) { e.preventDefault(); items[acHl].click(); }
  else if (e.key === 'Escape') $('payeeSug').classList.add('hidden');
});
$('fMemo').addEventListener('input', () => {
  dirty = true; current.memo = $('fMemo').value; current.memoManual = !!norm(current.memo);
  if (!current.memoManual) current.memo = current.payee;
});
function selectAdd(sel, key, label) {
  sel.addEventListener('change', () => {
    dirty = true;
    if (sel.value !== '__new__') return;
    const name = norm(prompt(`New ${label} name (spelled as in QuickBooks):`) || '');
    if (!name) { sel.value = current[key] || ''; return; }
    const listKey = key === 'customer' ? 'customers' : 'categories';
    const existing = lists[listKey].find(n => lc(n) === lc(name));
    const v = existing || name;
    if (!existing) { lists[listKey].push(v); lists.pending[listKey].push(v); saveLists(); }
    fillSelect(sel, listKey === 'categories' ? lists[listKey].concat([DEFAULT_CATEGORY]) : lists[listKey], v, sel.options[0].textContent, sel.options[sel.options.length - 1].textContent);
  });
}
selectAdd($('fCustomer'), 'customer', 'customer');
selectAdd($('fCategory'), 'category', 'category');
$('editShare').onclick = () => shareImages([Object.assign({}, current, { date: $('fDate').value || current.date, payee: canonPayee($('fPayee').value) || current.payee, customer: $('fCustomer').value === '__new__' ? '' : $('fCustomer').value, total: parseFloat($('fTotal').value) || current.total })], 'Receipt');
$('editImg').onclick = () => { $('viewerImg').src = $('editImg').src; $('viewer').classList.remove('hidden'); };
$('viewerClose').onclick = () => $('viewer').classList.add('hidden');

$('editSave').onclick = async () => {
  const t = norm($('fTotal').value).replace(/[$,\s]/g, '');
  if (t && isNaN(parseFloat(t))) { alert('The total should be a number, like 17.81'); return; }
  if (!t && !confirm('There is no total. Save anyway?')) return;
  Object.assign(current, {
    date: $('fDate').value || todayISO(), total: t ? Math.round(parseFloat(t) * 100) / 100 : null,
    payee: canonPayee($('fPayee').value), customer: $('fCustomer').value === '__new__' ? '' : $('fCustomer').value,
    category: $('fCategory').value === '__new__' ? '' : $('fCategory').value, note: $('fNote').value.trim(),
    updated: Date.now(), synced: false,
  });
  if (!current.memoManual) current.memo = current.payee;
  await DB.put(current);
  current = null; dirty = false;
  show('home'); await renderHome();
  toast('Saved ✓');
  sync(false);
};
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
function baseURL() {
  let a = norm(settings.addr).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/:\d+$/.test(a)) a += ':8443';
  return 'https://' + a;
}
async function api(method, path, body, timeoutMs = 15000) {
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
const UNREACHABLE = "Can't reach your computer. Check that:\n• this phone is on your home Wi-Fi\n• KellerKraft Receipts is running on the computer\n• the address is right\n• the security certificate is installed and trusted (Phone setup, step 1)";

async function sync(manual) {
  if (syncing) return;
  if (!settings.token) { if (manual) { toast('Connect to your computer first.'); openSettings(); } return; }
  const waiting = (await DB.all()).filter(r => !r.synced);
  if (!manual && !waiting.length && Date.now() - (settings.lastListSync || 0) < 6 * 3600e3) return;
  syncing = true; renderHome();
  let sent = 0;
  try {
    if (lists.pending.customers.length || lists.pending.categories.length) {
      await api('POST', '/api/lists/add', { customers: lists.pending.customers, categories: lists.pending.categories }, manual ? 15000 : 5000);
      lists.pending = { customers: [], categories: [] }; await saveLists();
    }
    for (const r of waiting) {
      const fd = new FormData();
      const { image, thumb, ...meta } = r;
      fd.append('meta', JSON.stringify(meta));
      fd.append('image', image, r.id + '.jpg');
      await api('POST', '/api/receipts', fd, 60000);
      r.synced = true; r.syncedAt = Date.now(); await DB.put(r); sent++;
    }
    const l = await api('GET', '/api/lists');
    lists.customers = sortNames(l.customers || []);
    lists.categories = sortNames(l.categories || []);
    lists.payees = l.payees || [];
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
  $('pairMsg').textContent = settings.token ? `✓ Connected to ${settings.addr}` : 'Not connected yet.';
  $('connSummary').textContent = settings.token ? `✓ Connected to ${settings.addr}` : 'Not connected yet. Tap to set up.';
  $('connCard').open = !settings.token;
  try {
    const est = await navigator.storage.estimate();
    const all = await DB.all();
    $('storeInfo').textContent = `${all.length} receipts on this phone (about ${Math.round((est.usage || 0) / 1048576)} MB).`;
  } catch (e) { $('storeInfo').textContent = ''; }
  $('version').textContent = 'KK Receipts ' + VERSION;
  show('settings');
}
$('btnSettings').onclick = openSettings;
$('setBack').onclick = () => { show('home'); renderHome(); };
$('sBW').onchange = () => { settings.bw = $('sBW').checked; saveSettings(); };
$('sNames').onchange = () => { settings.names = $('sNames').checked; saveSettings(); };
$('btnPair').onclick = async () => {
  const addr = norm($('sAddr').value), code = norm($('sCode').value);
  if (!addr || !/^\d{6}$/.test(code)) { $('pairMsg').textContent = 'Type the computer address and the 6-digit code.'; return; }
  settings.addr = addr; settings.token = '';
  $('pairMsg').textContent = 'Connecting…';
  try {
    const r = await api('POST', '/api/pair', { code, device: 'iPhone' });
    settings.token = r.token; await saveSettings();
    $('pairMsg').textContent = `✓ Connected to ${r.name || 'your computer'}`;
    $('connSummary').textContent = `✓ Connected to ${settings.addr}`;
    sync(true);
  } catch (e) {
    await saveSettings();
    $('pairMsg').textContent = e.unreachable ? UNREACHABLE : (e.status === 403 ? 'That code is wrong or expired. Check the code on the computer.' : e.message);
  }
};
$('btnClean').onclick = async () => {
  const synced = (await DB.all()).filter(r => r.synced);
  if (!synced.length) { toast('No synced receipts to remove.'); return; }
  if (!confirm(`Remove ${synced.length} synced receipt${synced.length > 1 ? 's' : ''} from this phone? They stay on your computer.`)) return;
  for (const r of synced) await DB.del(r.id);
  openSettings();
};

/* ---------- start ---------- */
(async () => {
  try {
    settings = Object.assign(settings, await DB.kvGet('settings') || {});
    const l = await DB.kvGet('lists'); if (l) lists = Object.assign(lists, l);
    lists.pending = lists.pending || { customers: [], categories: [] };
  } catch (e) { alert('This phone is not letting the app save data. Please open it from the Home Screen icon.'); }
  refreshPayeeList();
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
