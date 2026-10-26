'use strict';
/* MiScan — escáner de documentos PWA. Todo corre en el dispositivo. */

// ---------- utilidades ----------
const $ = (s, e = document) => e.querySelector(s);
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const cv = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = t => new Date(t).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });
const main = $('#main'), titleEl = $('#title'), backBtn = $('#back'), toastEl = $('#toast');
const S = { doc: null, page: null, docs: [], mode: 'doc', idFront: null, stream: null, raf: 0, placing: null, queue: [], back: null };
const cfg = {
  get: (k, d) => { try { const v = JSON.parse(localStorage.getItem('ms_' + k)); return v ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('ms_' + k, JSON.stringify(v))
};
const toast = m => { toastEl.textContent = m; toastEl.style.opacity = 1; clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.style.opacity = 0, 2600); };
const on = (el, fn) => { el.onclick = async e => { try { await fn(e); } catch (err) { console.error(err); toast('Error: ' + err.message); } }; };
window.addEventListener('unhandledrejection', e => toast('Error: ' + (e.reason && e.reason.message || e.reason)));

const CDN = {
  tess: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js',
  pdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js'
};
const loaded = {};
const loadScript = u => loaded[u] || (loaded[u] = new Promise((ok, no) => {
  const s = document.createElement('script'); s.src = u; s.onload = ok;
  s.onerror = () => { delete loaded[u]; no(new Error('Necesita internet la primera vez (' + u.split('/')[2] + ')')); };
  document.head.append(s);
}));

function modal(html) {
  const m = h('<div class="modal"><div class="box">' + html + '</div></div>');
  document.body.append(m); m.close = () => m.remove();
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  return m;
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function saveOrShare(blob, name, share) {
  const file = new File([blob], name, { type: blob.type });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  download(blob, name);
}
const toBlob = (c, type = 'image/jpeg', q = .92) => new Promise(r => c.toBlob(r, type, q));
const loadImg = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });

// ---------- base de datos (IndexedDB) ----------
const DB = new Promise((ok, no) => {
  const r = indexedDB.open('miscan', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
const tx = async (mode, f) => {
  const db = await DB;
  return new Promise((ok, no) => { const t = db.transaction('docs', mode); const q = f(t.objectStore('docs')); t.oncomplete = () => ok(q && q.result); t.onerror = () => no(t.error); });
};
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = d => tx('readwrite', s => s.put(d));
const dbDel = id => tx('readwrite', s => s.delete(id));

async function saveDoc(doc) {
  const pages = [];
  for (const p of doc.pages) {
    if (!p.blob) p.blob = await toBlob(p.base, 'image/jpeg', .93);
    pages.push({ id: p.id, base: p.blob, filter: p.filter, bright: p.bright, contr: p.contr, ocr: p.ocr,
      sigs: p.sigs.map(s => ({ x: s.x, y: s.y, w: s.w, data: s.data })), stamps: p.stamps });
  }
  await dbPut({ id: doc.id, name: doc.name, created: doc.created, pages });
}
async function hydrate(raw) {
  const doc = { id: raw.id, name: raw.name, created: raw.created, pages: [] };
  for (const r of raw.pages) {
    const bm = await createImageBitmap(r.base);
    const base = cv(bm.width, bm.height); base.getContext('2d').drawImage(bm, 0, 0);
    const sigs = [];
    for (const s of r.sigs || []) sigs.push({ ...s, img: await loadImg(s.data) });
    doc.pages.push({ id: r.id, base, blob: r.base, filter: r.filter, bright: r.bright || 0, contr: r.contr || 0,
      sigs, stamps: r.stamps || [], ocr: r.ocr || null, filtered: null, hist: [] });
  }
  return doc;
}
const newPage = (base, filter = 'magic') => ({ id: uid(), base, blob: null, filter, bright: 0, contr: 0, sigs: [], stamps: [], ocr: null, filtered: null, hist: [] });

// ---------- procesamiento de imagen ----------
function toCanvas(src, w, hh, max = 2600) {
  const k = Math.min(1, max / Math.max(w, hh));
  const c = cv(Math.round(w * k), Math.round(hh * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
async function fileToCanvas(f) {
  let bm;
  try { bm = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
  catch { bm = await loadImg(URL.createObjectURL(f)); }
  return toCanvas(bm, bm.width, bm.height);
}

// homografía cuadrado unitario -> cuadrilátero (Heckbert)
function homography(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, d, e, f, g, hh;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x; d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y; g = 0; hh = 0;
  } else {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den;
    a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + hh * p3.x; c = p0.x;
    d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + hh * p3.y; f = p0.y;
  }
  return { a, b, c, d, e, f, g, h: hh };
}
// corrección de perspectiva: q = [TL, TR, BR, BL] en píxeles de src
function warp(src, q) {
  const dist = (p, r) => Math.hypot(p.x - r.x, p.y - r.y);
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), hh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const m = Math.max(w, hh); if (m > 2400) { w *= 2400 / m; hh *= 2400 / m; }
  w = Math.max(2, Math.round(w)); hh = Math.max(2, Math.round(hh));
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const H = homography(q);
  const out = cv(w, hh), oc = out.getContext('2d'), od = oc.createImageData(w, hh), o = od.data;
  for (let y = 0; y < hh; y++) {
    const v = (y + .5) / hh;
    for (let x = 0; x < w; x++) {
      const u = (x + .5) / w, z = H.g * u + H.h * v + 1;
      let X = (H.a * u + H.b * v + H.c) / z - .5, Y = (H.d * u + H.e * v + H.f) / z - .5;
      X = X < 0 ? 0 : X > sw - 1.001 ? sw - 1.001 : X; Y = Y < 0 ? 0 : Y > sh - 1.001 ? sh - 1.001 : Y;
      const x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, oi = (y * w + x) * 4;
      for (let k = 0; k < 3; k++)
        o[oi + k] = (sd[i00 + k] * (1 - fx) + sd[i10 + k] * fx) * (1 - fy) + (sd[i01 + k] * (1 - fx) + sd[i11 + k] * fx) * fy;
      o[oi + 3] = 255;
    }
  }
  oc.putImageData(od, 0, 0);
  return out;
}

// detección automática de bordes del documento (sin librerías)
function autoQuad(src) {
  const k = 300 / Math.max(src.width, src.height), w = Math.round(src.width * k), hh = Math.round(src.height * k);
  const c = cv(w, hh), x = c.getContext('2d'); x.drawImage(src, 0, 0, w, hh);
  const d = x.getImageData(0, 0, w, hh).data, n = w * hh, g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 151 + d[i * 4 + 2] * 28) >> 8;
  const hist = new Array(256).fill(0); g.forEach(v => hist[v]++);
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  for (const pol of [1, 0]) {
    const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = (pol ? g[i] > th : g[i] <= th) ? 1 : 0;
    const comp = largestComponent(m, w, hh); if (!comp) continue;
    const frac = comp.n / n; if (frac < .12 || frac > .96) continue;
    let tl = null, tr = null, br = null, bl = null, a = 1e9, b = -1e9, cc = -1e9, dd = 1e9;
    for (const p of comp.pts) {
      const px = p % w, py = (p / w) | 0, s = px + py, df = px - py;
      if (s < a) { a = s; tl = [px, py]; } if (s > b) { b = s; br = [px, py]; }
      if (df > cc) { cc = df; tr = [px, py]; } if (df < dd) { dd = df; bl = [px, py]; }
    }
    const area = Math.abs((tl[0] * tr[1] - tr[0] * tl[1]) + (tr[0] * br[1] - br[0] * tr[1]) + (br[0] * bl[1] - bl[0] * br[1]) + (bl[0] * tl[1] - tl[0] * bl[1])) / 2;
    if (area < comp.n * .5) continue;
    return [tl, tr, br, bl].map(p => ({ x: p[0] / w, y: p[1] / hh }));
  }
  return null;
}
function largestComponent(m, w, hh) {
  const n = w * hh, seen = new Uint8Array(n), st = new Int32Array(n); let best = null;
  for (let i = 0; i < n; i++) {
    if (!m[i] || seen[i]) continue;
    let sp = 0, cnt = 0; st[sp++] = i; seen[i] = 1; const pts = [];
    while (sp) {
      const p = st[--sp]; cnt++; pts.push(p); const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st[sp++] = p + 1; }
      if (y > 0 && m[p - w] && !seen[p - w]) { seen[p - w] = 1; st[sp++] = p - w; }
      if (y < hh - 1 && m[p + w] && !seen[p + w]) { seen[p + w] = 1; st[sp++] = p + w; }
    }
    if (!best || cnt > best.n) best = { n: cnt, pts };
  }
  return best;
}

// estimación del fondo (para quitar sombras)
function bgEstimate(src) {
  const s = Math.max(2, Math.round(Math.max(src.width, src.height) / 160));
  const sw = Math.ceil(src.width / s), sh = Math.ceil(src.height / s);
  const sm = cv(sw, sh), sc = sm.getContext('2d'); sc.imageSmoothingQuality = 'high'; sc.drawImage(src, 0, 0, sw, sh);
  const id = sc.getImageData(0, 0, sw, sh), a = id.data;
  for (let it = 0; it < 2; it++) {
    const b = new Uint8ClampedArray(a);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) for (let k = 0; k < 3; k++) {
      let mx = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy)), xx = Math.min(sw - 1, Math.max(0, x + dx));
        const v = b[(yy * sw + xx) * 4 + k]; if (v > mx) mx = v;
      }
      a[(y * sw + x) * 4 + k] = mx;
    }
  }
  sc.putImageData(id, 0, 0);
  const big = cv(src.width, src.height), bc = big.getContext('2d'); bc.imageSmoothingQuality = 'high';
  bc.drawImage(sm, 0, 0, src.width, src.height);
  return bc.getImageData(0, 0, src.width, src.height);
}
const lvl = v => Math.max(0, Math.min(255, (v - 55) * 255 / 180));
function process(base, f, br = 0, ct = 0) {
  if (f === 'orig' && !br && !ct) return base;
  const W = base.width, H = base.height, out = cv(W, H), c = out.getContext('2d'); c.drawImage(base, 0, 0);
  const id = c.getImageData(0, 0, W, H), d = id.data, len = W * H * 4;
  if (f === 'gray') {
    for (let i = 0; i < len; i += 4) { const l = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = l; }
  } else if (f !== 'orig') {
    const bg = bgEstimate(base).data;
    for (let i = 0; i < len; i += 4) {
      let r = Math.min(255, d[i] / Math.max(bg[i], 1) * 255), g = Math.min(255, d[i + 1] / Math.max(bg[i + 1], 1) * 255), b = Math.min(255, d[i + 2] / Math.max(bg[i + 2], 1) * 255);
      if (f === 'magic') { r = lvl(r); g = lvl(g); b = lvl(b); }
      else if (f === 'bw' || f === 'eco') {
        const l = .299 * r + .587 * g + .114 * b;
        const v = f === 'bw' ? (l < 165 ? 0 : 255) : (l < 150 ? 0 : l > 205 ? 255 : (l - 150) / 55 * 255);
        r = g = b = v;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }
  if (br || ct) {
    const a = 1 + ct / 100, lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - 128) * a + 128 + br * 2.55;
    for (let i = 0; i < len; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  c.putImageData(id, 0, 0);
  return out;
}
// imagen final = filtro + firmas + marcas
function final(p) {
  const f = p.filtered || (p.filtered = process(p.base, p.filter, p.bright, p.contr));
  const o = cv(f.width, f.height), c = o.getContext('2d'); c.drawImage(f, 0, 0);
  const W = o.width, Hh = o.height;
  for (const s of p.sigs) { const w = s.w * W, hh = w * s.img.height / s.img.width; c.drawImage(s.img, s.x * W - w / 2, s.y * Hh - hh / 2, w, hh); }
  for (const t of p.stamps) {
    const px = t.size * W; c.font = 'bold ' + px + 'px system-ui,sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = px / 7; c.strokeStyle = '#fff'; c.fillStyle = '#d11'; c.strokeText(t.text, t.x * W, t.y * Hh); c.fillText(t.text, t.x * W, t.y * Hh);
  }
  return o;
}
function rotate90(c) {
  const o = cv(c.height, c.width), x = o.getContext('2d'); x.translate(o.width, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0); return o;
}
function composeID(front, back) {
  const W = 1240, H = 1754, o = cv(W, H), c = o.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  const put = (img, cy) => {
    const s = Math.min(900 / img.width, 680 / img.height), w = img.width * s, hh = img.height * s, x = (W - w) / 2, y = cy - hh / 2;
    c.drawImage(img, x, y, w, hh); c.strokeStyle = '#bbb'; c.lineWidth = 2; c.strokeRect(x, y, w, hh);
  };
  put(front, 520); put(back, 1250); return o;
}

// ---------- OCR y exportación ----------
let worker = null, ocrProg = null;
async function ocrPage(p) {
  await loadScript(CDN.tess);
  if (!worker) worker = await Tesseract.createWorker('spa+eng', 1, { logger: m => { if (ocrProg && m.status) ocrProg(m.status + ' ' + Math.round((m.progress || 0) * 100) + '%'); } });
  const f = final(p), { data } = await worker.recognize(f);
  p.ocr = { text: data.text.trim(), W: f.width, H: f.height,
    words: (data.words || []).filter(w => w.text.trim()).map(w => ({ t: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })) };
  return p.ocr;
}
async function buildPDF(doc, searchable) {
  await loadScript(CDN.pdf);
  const { jsPDF } = window.jspdf; let pdf;
  for (let i = 0; i < doc.pages.length; i++) {
    const p = doc.pages[i], f = final(p);
    if (searchable && (!p.ocr || p.ocr.W !== f.width)) { toast('Reconociendo texto ' + (i + 1) + '/' + doc.pages.length); await ocrPage(p); }
    const PW = 595, PH = PW * f.height / f.width, s = PW / f.width, o = PH > PW ? 'p' : 'l';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [PW, PH], orientation: o, compress: true }); else pdf.addPage([PW, PH], o);
    pdf.addImage(f.toDataURL('image/jpeg', cfg.get('q', .85)), 'JPEG', 0, 0, PW, PH);
    if (searchable && p.ocr) for (const w of p.ocr.words) {
      const hh = (w.y1 - w.y0) * s; pdf.setFontSize(Math.max(4, hh * .85));
      pdf.text(w.t, w.x0 * s, w.y1 * s - hh * .2, { renderingMode: 'invisible' });
    }
  }
  return pdf.output('blob');
}

// ---------- navegación ----------
function stopCam() { cancelAnimationFrame(S.raf); if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; } }
function view(title, back) {
  stopCam(); S.placing = null; titleEl.textContent = title; S.back = back || null;
  backBtn.style.display = back ? '' : 'none'; main.innerHTML = ''; main.scrollTop = 0;
}
backBtn.onclick = () => S.back && S.back();
const ensureDoc = () => { if (!S.doc) S.doc = { id: uid(), name: 'Escaneo ' + fmtDate(Date.now()), created: Date.now(), pages: [] }; return S.doc; };
const inputs = { cam: $('#cam'), imp: $('#imp') };
inputs.cam.onchange = async () => { const f = inputs.cam.files[0]; inputs.cam.value = ''; if (f) cropView(await fileToCanvas(f)); };
inputs.imp.onchange = async () => { S.queue = [...inputs.imp.files]; inputs.imp.value = ''; await nextQueued(); };
async function nextQueued() {
  const f = S.queue.shift(); if (!f) return S.doc ? docView() : homeView();
  toast('Cargando imagen…'); cropView(await fileToCanvas(f));
}

// ---------- inicio ----------
async function homeView() {
  view('MiScan'); S.doc = null; S.idFront = null; S.mode = 'doc';
  main.append(h(`<div class="tiles">
    <button class="tile p" id="b1"><b>📷</b>Escanear</button>
    <button class="tile" id="b2"><b>🪪</b>Documento de ID</button>
    <button class="tile" id="b3"><b>🔳</b>Códigos QR / barras</button>
    <button class="tile" id="b4"><b>🖼️</b>Importar imágenes</button></div>`));
  main.append(h('<h2>Mis documentos</h2>'));
  const list = h('<div class="list"></div>'); main.append(list);
  main.append(h('<div class="row"><button id="b5">⚙️ Ajustes</button></div>'));
  on($('#b1'), () => cameraView('doc')); on($('#b2'), () => { S.idFront = null; cameraView('id'); });
  on($('#b3'), qrView); on($('#b4'), () => inputs.imp.click()); on($('#b5'), settingsModal);
  S.docs = (await dbAll() || []).sort((a, b) => b.created - a.created);
  if (!S.docs.length) list.innerHTML = '<p class="mu">Aún no tienes documentos. Toca Escanear para empezar.</p>';
  for (const d of S.docs) {
    const url = d.pages[0] ? URL.createObjectURL(d.pages[0].base) : '';
    const it = h(`<div class="it"><img src="${url}"><div class="t"><div>${esc(d.name)}</div><div>${d.pages.length} pág. · ${fmtDate(d.created)}</div></div></div>`);
    it.onclick = async () => { try { S.doc = await hydrate(d); docView(); } catch (e) { toast('Error: ' + e.message); } };
    list.append(it);
  }
}

// ---------- ajustes ----------
function settingsModal() {
  const m = modal(`<h3>Ajustes</h3>
    <label>Webhook (n8n) para enviar códigos escaneados</label>
    <input type="url" id="wh" placeholder="https://tu-n8n/webhook/..." value="${esc(cfg.get('hook', ''))}">
    <label>Calidad del PDF: <span id="qv"></span>%</label>
    <input type="range" id="qq" min="50" max="100" value="${Math.round(cfg.get('q', .85) * 100)}">
    <div class="row"><button id="sv" class="p">Guardar</button><button id="cl">Cerrar</button></div>`);
  const upd = () => $('#qv', m).textContent = $('#qq', m).value; upd(); $('#qq', m).oninput = upd;
  $('#sv', m).onclick = () => { cfg.set('hook', $('#wh', m).value.trim()); cfg.set('q', $('#qq', m).value / 100); m.close(); toast('Guardado'); };
  $('#cl', m).onclick = () => m.close();
}

// ---------- cámara ----------
async function cameraView(mode) {
  S.mode = mode; view(mode === 'id' ? (S.idFront ? 'ID: reverso' : 'ID: frente') : 'Escanear', () => S.doc && S.doc.pages.length ? docView() : homeView());
  main.append(h('<video id="vd" playsinline muted autoplay></video>'));
  main.append(h(`<div class="cam-row"><button id="imp2">🖼️</button><button class="shutter" id="shot"></button><button id="tc" style="visibility:hidden">🔦</button></div>`));
  main.append(h('<p class="mu" style="text-align:center">Pon el documento sobre un fondo oscuro y toma la foto.</p>'));
  on($('#imp2'), () => inputs.imp.click());
  const vd = $('#vd');
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    vd.srcObject = S.stream; await vd.play();
  } catch (e) {
    main.innerHTML = '<p>La cámara en vivo no está disponible (hace falta abrir la app por https). Usa la cámara del sistema:</p>';
    const b = h('<button class="p tile" style="width:100%">📷 Abrir cámara</button>'); main.append(b); b.onclick = () => inputs.cam.click(); return;
  }
  const tr = S.stream.getVideoTracks()[0], caps = tr.getCapabilities ? tr.getCapabilities() : {};
  if (caps.torch) { const tc = $('#tc'); tc.style.visibility = 'visible'; let t = false; tc.onclick = async () => { t = !t; await tr.applyConstraints({ advanced: [{ torch: t }] }); tc.classList.toggle('on', t); }; }
  on($('#shot'), async () => {
    const c = toCanvas(vd, vd.videoWidth, vd.videoHeight); if (navigator.vibrate) navigator.vibrate(30); cropView(c);
  });
}

// ---------- recorte ----------
function cropView(src) {
  view('Recortar', () => S.doc && S.doc.pages.length ? docView() : homeView());
  main.append(h('<canvas id="cv"></canvas>'));
  main.append(h('<div class="row"><button id="auto">✨ Auto</button><button id="all">Todo</button><button id="rot">⟳</button></div>'));
  main.append(h('<div class="row"><button id="ok" class="p">Siguiente</button></div>'));
  const c = $('#cv'), x = c.getContext('2d');
  let img = src, k, q, drag = null;
  const layout = () => {
    k = Math.min((innerWidth - 28) / img.width, (innerHeight - 270) / img.height, 1);
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  };
  const setNorm = n => q = n.map(p => ({ x: p.x * c.width, y: p.y * c.height }));
  const inset = [{ x: .06, y: .06 }, { x: .94, y: .06 }, { x: .94, y: .94 }, { x: .06, y: .94 }];
  const draw = () => {
    x.drawImage(img, 0, 0, c.width, c.height);
    x.fillStyle = '#0007'; x.beginPath(); x.rect(0, 0, c.width, c.height); x.moveTo(q[0].x, q[0].y);
    for (const i of [3, 2, 1, 0]) x.lineTo(q[i].x, q[i].y); x.fill('evenodd');
    x.strokeStyle = '#10b981'; x.lineWidth = 3; x.beginPath(); q.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.stroke();
    x.fillStyle = '#fff'; x.strokeStyle = '#10b981';
    for (const p of q) { x.beginPath(); x.arc(p.x, p.y, 13, 0, 7); x.fill(); x.stroke(); }
  };
  const runAuto = () => { const a = autoQuad(img); if (a) { setNorm(a); toast('Bordes detectados'); } else { setNorm(inset); toast('No se detectaron bordes, ajusta a mano'); } draw(); };
  layout(); setNorm(inset); draw(); setTimeout(runAuto, 30);
  const pos = e => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * c.width / r.width, y: (e.clientY - r.top) * c.height / r.height }; };
  c.onpointerdown = e => {
    const p = pos(e); let b = -1, bd = 60;
    q.forEach((pt, i) => { const d = Math.hypot(pt.x - p.x, pt.y - p.y); if (d < bd) { bd = d; b = i; } });
    if (b >= 0) { drag = b; c.setPointerCapture(e.pointerId); }
  };
  c.onpointermove = e => { if (drag === null) return; const p = pos(e); q[drag] = { x: Math.max(0, Math.min(c.width, p.x)), y: Math.max(0, Math.min(c.height, p.y)) }; draw(); };
  c.onpointerup = () => drag = null;
  on($('#auto'), runAuto);
  on($('#all'), () => { setNorm([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]); draw(); });
  on($('#rot'), () => { img = rotate90(img); layout(); setNorm(inset); draw(); setTimeout(runAuto, 30); });
  on($('#ok'), async () => {
    toast('Procesando…'); await new Promise(r => setTimeout(r, 30));
    const base = warp(img, q.map(p => ({ x: p.x / k, y: p.y / k })));
    await afterCrop(base);
  });
}
async function afterCrop(base) {
  ensureDoc();
  if (S.mode === 'id') {
    if (!S.idFront) { S.idFront = base; toast('Ahora el reverso de la ID'); return cameraView('id'); }
    const page = newPage(composeID(S.idFront, base), 'orig'); S.idFront = null; S.mode = 'doc'; return editView(page);
  }
  editView(newPage(base));
}

// ---------- edición ----------
const FILTERS = [['orig', 'Original'], ['magic', 'Mágico'], ['noshadow', 'Sin sombra'], ['bw', 'Blanco y negro'], ['eco', 'Eco'], ['gray', 'Grises']];
function editView(p) {
  S.page = p;
  const inDoc = () => S.doc.pages.includes(p);
  view('Editar', () => inDoc() ? docView() : homeView());
  main.append(h('<canvas id="pv"></canvas>'));
  main.append(h('<div class="bar" id="fb"></div>'));
  main.append(h(`<div class="bar" id="tb">
    <button id="t-adj">☀️ Ajustes</button><button id="t-rot">⟳ Girar</button><button id="t-sig">✍️ Firmar</button>
    <button id="t-mk">🏷️ Marca</button><button id="t-ocr">🔤 Texto</button><button id="t-und">↩ Deshacer</button></div>`));
  main.append(h(`<div id="adj" style="display:none"><label>Brillo</label><input type="range" id="rb" min="-50" max="50" value="${p.bright}">
    <label>Contraste</label><input type="range" id="rc" min="-50" max="80" value="${p.contr}"></div>`));
  main.append(h(`<div class="row"><button id="add">＋ Otra página</button><button id="done" class="p">Listo</button></div>`));
  const pv = $('#pv');
  const refresh = redo => {
    if (redo) p.filtered = null;
    const f = final(p); pv.width = f.width; pv.height = f.height; pv.getContext('2d').drawImage(f, 0, 0);
  };
  const fb = $('#fb');
  for (const [id, label] of FILTERS) {
    const b = h(`<button class="${p.filter === id ? 'on' : ''}">${label}</button>`);
    b.onclick = () => { p.filter = id; fb.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); toast('Aplicando…'); setTimeout(() => refresh(true), 20); };
    fb.append(b);
  }
  refresh();
  let tm; const slide = () => { p.bright = +$('#rb').value; p.contr = +$('#rc').value; clearTimeout(tm); tm = setTimeout(() => refresh(true), 150); };
  $('#rb').oninput = slide; $('#rc').oninput = slide;
  on($('#t-adj'), () => { const a = $('#adj'); a.style.display = a.style.display === 'none' ? '' : 'none'; });
  on($('#t-rot'), () => { p.base = rotate90(p.base); p.blob = null; p.ocr = null; p.sigs = []; p.stamps = []; p.hist = []; refresh(true); });
  on($('#t-sig'), () => sigModal(p));
  on($('#t-mk'), () => markModal(p));
  on($('#t-ocr'), () => ocrModal(p));
  on($('#t-und'), () => {
    const last = p.hist.pop() || (p.stamps.length ? 't' : p.sigs.length ? 's' : null);
    if (last === 't') p.stamps.pop(); else if (last === 's') p.sigs.pop(); else return toast('Nada que deshacer');
    p.ocr = null; refresh();
  });
  pv.onclick = e => {
    if (!S.placing) return;
    const r = pv.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height, pl = S.placing;
    if (pl.type === 'sig') { p.sigs.push({ x: nx, y: ny, w: pl.w, data: pl.data, img: pl.img }); p.hist.push('s'); }
    else { p.stamps.push({ text: pl.text, x: nx, y: ny, size: pl.size }); p.hist.push('t'); }
    p.ocr = null; S.placing = null; refresh();
  };
  const commit = async () => { if (!inDoc()) S.doc.pages.push(p); toast('Guardando…'); await saveDoc(S.doc); };
  on($('#add'), async () => { await commit(); S.queue.length ? nextQueued() : cameraView('doc'); });
  on($('#done'), async () => { await commit(); S.queue.length ? nextQueued() : docView(); });
}

function sigModal(p) {
  const saved = cfg.get('sigs', []);
  const m = modal(`<h3>Firma</h3>
    ${saved.length ? '<div class="mu">Guardadas (toca para usar):</div><div class="sigs" id="sl"></div>' : ''}
    <div class="mu">Dibuja una nueva:</div>
    <canvas id="sg" width="600" height="240" style="width:100%;background:#fff;border-radius:10px;touch-action:none"></canvas>
    <label>Tamaño: <span id="szv"></span>%</label><input type="range" id="sz" min="12" max="60" value="30">
    <div class="row"><button id="clr">Borrar</button><button id="use" class="p">Usar y colocar</button></div>
    <div class="row"><button id="cl">Cerrar</button></div>`);
  const sl = $('#sl', m); let chosen = null;
  if (sl) saved.forEach(d => { const i = h(`<img src="${d}">`); i.onclick = () => { sl.querySelectorAll('img').forEach(x => x.classList.remove('on')); i.classList.add('on'); chosen = d; }; sl.append(i); });
  const sg = $('#sg', m), c = sg.getContext('2d'); c.lineWidth = 6; c.lineCap = c.lineJoin = 'round'; c.strokeStyle = '#111'; let dr = false, inked = false;
  const pt = e => { const r = sg.getBoundingClientRect(); return [(e.clientX - r.left) * 600 / r.width, (e.clientY - r.top) * 240 / r.height]; };
  sg.onpointerdown = e => { dr = true; inked = true; sg.setPointerCapture(e.pointerId); const [a, b] = pt(e); c.beginPath(); c.moveTo(a, b); c.lineTo(a + .1, b); c.stroke(); };
  sg.onpointermove = e => { if (!dr) return; const [a, b] = pt(e); c.lineTo(a, b); c.stroke(); };
  sg.onpointerup = () => dr = false;
  const szv = $('#szv', m), sz = $('#sz', m); szv.textContent = sz.value; sz.oninput = () => szv.textContent = sz.value;
  $('#clr', m).onclick = () => { c.clearRect(0, 0, 600, 240); inked = false; };
  $('#cl', m).onclick = () => m.close();
  $('#use', m).onclick = async () => {
    let data = chosen;
    if (inked) {
      const d = c.getImageData(0, 0, 600, 240).data; let x0 = 600, y0 = 240, x1 = 0, y1 = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 600; x++) if (d[(y * 600 + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const t = cv(x1 - x0 + 12, y1 - y0 + 12); t.getContext('2d').drawImage(sg, x0 - 6, y0 - 6, t.width, t.height, 0, 0, t.width, t.height);
      data = t.toDataURL('image/png'); cfg.set('sigs', [data, ...saved].slice(0, 6));
    }
    if (!data) return toast('Dibuja o elige una firma');
    S.placing = { type: 'sig', data, img: await loadImg(data), w: sz.value / 100 };
    m.close(); toast('Toca en la página donde va la firma');
  };
}
function markModal(p) {
  const m = modal(`<h3>Marca / texto</h3>
    <label>Texto</label><input type="text" id="mt" value="${esc(fmtDate(Date.now()))}">
    <div class="row"><button id="mn">Fecha y hora</button><button id="mc">Copia fiel</button></div>
    <label>Tamaño: <span id="szv"></span></label><input type="range" id="sz" min="2" max="12" value="4">
    <div class="row"><button id="use" class="p">Colocar</button><button id="cl">Cerrar</button></div>`);
  const sz = $('#sz', m); $('#szv', m).textContent = sz.value; sz.oninput = () => $('#szv', m).textContent = sz.value;
  $('#mn', m).onclick = () => $('#mt', m).value = fmtDate(Date.now());
  $('#mc', m).onclick = () => $('#mt', m).value = 'COPIA FIEL';
  $('#cl', m).onclick = () => m.close();
  $('#use', m).onclick = () => { const t = $('#mt', m).value.trim(); if (!t) return; S.placing = { type: 'stamp', text: t, size: sz.value / 100 }; m.close(); toast('Toca en la página para colocarla'); };
}
async function ocrModal(p) {
  const m = modal(`<h3>Texto reconocido</h3><p class="mu" id="st">Preparando…</p><textarea id="tx"></textarea>
    <div class="row"><button id="cp" class="p">Copiar</button><button id="cl">Cerrar</button></div>`);
  $('#cl', m).onclick = () => m.close();
  $('#cp', m).onclick = async () => { await navigator.clipboard.writeText($('#tx', m).value); toast('Copiado'); };
  ocrProg = s => { const e = $('#st', m); if (e) e.textContent = s; };
  try {
    const f = final(p);
    const o = p.ocr && p.ocr.W === f.width ? p.ocr : await ocrPage(p);
    $('#tx', m).value = o.text; $('#st', m).textContent = 'Listo (' + o.words.length + ' palabras)';
  } catch (e) { $('#st', m).textContent = 'Error: ' + e.message; }
}

// ---------- documento ----------
function thumb(p) {
  const f = final(p), k = Math.min(1, 360 / f.width), t = cv(Math.round(f.width * k), Math.round(f.height * k));
  t.getContext('2d').drawImage(f, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', .6);
}
function docView() {
  const d = S.doc; view(d.name, homeView);
  if (!d.pages.length) main.append(h('<p class="mu">Sin páginas.</p>'));
  const grid = h('<div class="grid"></div>'); main.append(grid);
  d.pages.forEach((p, i) => {
    const t = h(`<div class="pg"><img src="${thumb(p)}"><div class="bt"><button data-a="l">◀</button><button data-a="e">✏️</button><button data-a="d" class="d">🗑</button><button data-a="r">▶</button></div></div>`);
    t.querySelector('img').onclick = () => editView(p);
    t.querySelectorAll('button').forEach(b => on(b, async () => {
      const a = b.dataset.a;
      if (a === 'e') return editView(p);
      if (a === 'd') { if (!confirm('¿Eliminar esta página?')) return; d.pages.splice(i, 1); }
      if (a === 'l' && i > 0) [d.pages[i - 1], d.pages[i]] = [d.pages[i], d.pages[i - 1]];
      if (a === 'r' && i < d.pages.length - 1) [d.pages[i + 1], d.pages[i]] = [d.pages[i], d.pages[i + 1]];
      if (!d.pages.length) { await dbDel(d.id); S.doc = null; return homeView(); }
      await saveDoc(d); docView();
    }));
    grid.append(t);
  });
  main.append(h(`<div class="row"><button id="ap">＋ Escanear más</button><button id="ai">🖼️ Importar</button></div>`));
  main.append(h('<h2>Exportar</h2>'));
  main.append(h(`<label style="display:flex;gap:8px;align-items:center;margin:0 0 8px"><input type="checkbox" id="srch" checked> PDF con texto buscable (OCR)</label>`));
  main.append(h(`<div class="tiles">
    <button class="p" id="x-pdf">📄 PDF</button><button id="x-sh">📤 Compartir PDF</button>
    <button id="x-img">🖼️ Imágenes JPG</button><button id="x-txt">🔤 Texto (TXT)</button>
    <button id="x-doc">📝 Word</button><button id="x-ocr">🔍 Reconocer todo</button></div>`));
  main.append(h(`<div class="row"><button id="ren">✏️ Renombrar</button><button id="del" class="d">Eliminar documento</button></div>`));
  const safe = () => d.name.replace(/[^\w\-áéíóúñ ]+/g, '').trim().replace(/\s+/g, '_') || 'escaneo';
  on($('#ap'), () => cameraView('doc')); on($('#ai'), () => inputs.imp.click());
  const pdf = async share => { toast('Generando PDF…'); await saveOrShare(await buildPDF(d, $('#srch').checked), safe() + '.pdf', share); await saveDoc(d); };
  on($('#x-pdf'), () => pdf(false)); on($('#x-sh'), () => pdf(true));
  on($('#x-img'), async () => { for (let i = 0; i < d.pages.length; i++) { download(await toBlob(final(d.pages[i]), 'image/jpeg', .92), safe() + '_' + (i + 1) + '.jpg'); await new Promise(r => setTimeout(r, 300)); } });
  const allText = async () => {
    const out = [];
    for (let i = 0; i < d.pages.length; i++) {
      const p = d.pages[i], f = final(p);
      if (!p.ocr || p.ocr.W !== f.width) { toast('Reconociendo ' + (i + 1) + '/' + d.pages.length); await ocrPage(p); }
      out.push(p.ocr.text);
    }
    await saveDoc(d); return out;
  };
  on($('#x-ocr'), async () => { await allText(); toast('Texto listo en todas las páginas'); });
  on($('#x-txt'), async () => download(new Blob([(await allText()).map((t, i) => '--- Página ' + (i + 1) + ' ---\n' + t).join('\n\n')], { type: 'text/plain' }), safe() + '.txt'));
  on($('#x-doc'), async () => {
    const t = await allText();
    const body = t.map((x, i) => '<h3>Página ' + (i + 1) + '</h3>' + x.split('\n').map(l => '<p>' + esc(l) + '</p>').join('')).join('');
    download(new Blob(['\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' + body + '</body></html>'], { type: 'application/msword' }), safe() + '.doc');
  });
  on($('#ren'), async () => { const n = prompt('Nombre del documento', d.name); if (n) { d.name = n.trim(); await saveDoc(d); docView(); } });
  on($('#del'), async () => { if (!confirm('¿Eliminar todo el documento?')) return; await dbDel(d.id); S.doc = null; homeView(); });
}

// ---------- códigos QR / barras ----------
async function qrView() {
  view('Códigos', homeView);
  let paused = false, last = { v: '', t: 0 };
  main.append(h('<video id="vd" playsinline muted autoplay style="max-height:42dvh"></video>'));
  main.append(h(`<div class="row"><button id="cont" class="${cfg.get('cont', true) ? 'on' : ''}">🔁 Continuo</button><button id="fromimg">🖼️ Desde imagen</button></div>`));
  main.append(h('<div id="res"></div>'));
  main.append(h(`<div class="row"><button id="csv">⬇️ CSV</button><button id="clr" class="d">Limpiar historial</button></div>`));
  main.append(h('<h2>Historial</h2><div class="list" id="hist"></div>'));
  const renderHist = () => {
    const hs = cfg.get('scans', []), box = $('#hist'); box.innerHTML = hs.length ? '' : '<p class="mu">Sin escaneos.</p>';
    hs.slice(0, 50).forEach(s => box.append(h(`<div class="it"><div class="t"><div>${esc(s.v)}</div><div>${esc(s.fmt)} · ${fmtDate(s.ts)}</div></div></div>`)));
  };
  renderHist();
  const found = async (v, fmt) => {
    const now = Date.now(), cont = cfg.get('cont', true);
    if (v === last.v && now - last.t < 2500) return; last = { v, t: now };
    const item = { v, fmt, ts: now }; cfg.set('scans', [item, ...cfg.get('scans', [])].slice(0, 500));
    if (navigator.vibrate) navigator.vibrate(60);
    const isUrl = /^https?:\/\//i.test(v);
    $('#res').innerHTML = ''; const r = h(`<div class="res"><div class="mu">${esc(fmt)}</div><div>${esc(v)}</div>
      <div class="row"><button id="cp">Copiar</button>${isUrl ? '<button id="op">Abrir</button>' : ''}</div></div>`); $('#res').append(r);
    on($('#cp', r), async () => { await navigator.clipboard.writeText(v); toast('Copiado'); });
    if (isUrl) on($('#op', r), () => window.open(v, '_blank', 'noopener'));
    renderHist();
    const hook = cfg.get('hook', ''); if (hook) fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }).catch(() => toast('No se pudo enviar al webhook'));
    if (!cont) paused = true;
  };
  const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'code_93', 'upc_a', 'upc_e', 'itf', 'data_matrix', 'pdf417', 'aztec'] }) : null;
  const decodeCanvas = async c => {
    if (detector) { const r = await detector.detect(c); return r[0] ? [r[0].rawValue, r[0].format] : null; }
    await loadScript(CDN.qr); const id = c.getContext('2d').getImageData(0, 0, c.width, c.height), q = jsQR(id.data, id.width, id.height); return q ? [q.data, 'qr_code'] : null;
  };
  on($('#cont'), () => { const v = !cfg.get('cont', true); cfg.set('cont', v); $('#cont').classList.toggle('on', v); paused = false; });
  on($('#csv'), () => { const hs = cfg.get('scans', []); download(new Blob(['\ufeffvalor,formato,fecha\n' + hs.map(s => '"' + s.v.replace(/"/g, '""') + '",' + s.fmt + ',' + new Date(s.ts).toISOString()).join('\n')], { type: 'text/csv' }), 'codigos.csv'); });
  on($('#clr'), () => { if (confirm('¿Borrar historial?')) { cfg.set('scans', []); renderHist(); } });
  on($('#fromimg'), () => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
    i.onchange = async () => { const f = i.files[0]; if (!f) return; const r = await decodeCanvas(await fileToCanvas(f)); r ? found(r[0], r[1]) : toast('No se encontró ningún código'); };
    i.click();
  });
  const vd = $('#vd');
  try { S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); vd.srcObject = S.stream; await vd.play(); }
  catch { return toast('No se pudo abrir la cámara (necesita https). Usa "Desde imagen".'); }
  const tmp = cv(1, 1); let busy = false;
  const loop = async () => {
    S.raf = requestAnimationFrame(loop);
    if (busy || paused || vd.readyState < 2) return; busy = true;
    try {
      tmp.width = vd.videoWidth; tmp.height = vd.videoHeight; tmp.getContext('2d').drawImage(vd, 0, 0);
      const r = await decodeCanvas(tmp); if (r) await found(r[0], r[1]);
    } catch { } busy = false;
  };
  vd.onclick = () => { paused = false; $('#res').innerHTML = ''; };
  loop();
}

// ---------- arranque ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
homeView();
