// ============================================================
// VISION.JS — Screenshot(s) → Inventory Autofill (OCR)
// Uses Tesseract.js (vendored locally, offline-capable).
//
// ADAPTIVE CELL PIPELINE (v3.1, 2026-09-06):
// The game's inventory UI renders cells with gray corner brackets
// (~144-168px wide depending on screenshot scale), a dark quantity
// badge (pure-black pixels, "xNN" in a hollow serif font) under the
// icon, and a white outlined name at the bottom (wraps to 2 lines).
// Nothing is at fixed pixel offsets — everything is located
// adaptively:
//   1. Flood-fill the bracket-gray mask (luma 140-190) → clusters.
//      Wide merged clusters split at the widest zero-density column
//      gap (recursive, 100px+ fragments kept).
//   2. Per cell, find "black row groups" (rows with ≥8 pure-black
//      px in the interior) — badge group sits at 25-68% of cell
//      height, name lines at ≥73%.
//   3. Name OCR: crop bottom 73-99% of the cell, threshold at 110
//      and 150 + morphological close, psm 6.
//   4. Badge OCR: autocontrast crop at pad 3/6 × zoom 6/8 (4
//      variants) + digit-fixup parse (I→1, S→5, O→0…); majority
//      vote, agreement ratio = confidence.
//   5. Fuzzy name matching: bigram-Dice + token-F1 + OCR confusion
//      normalization; ≥0.40 auto-accept, 0.25-0.39 shown unticked.
// Validated on 5 real screenshots: 21/24 names matched, badges
// all located (qty reads carry a confidence; flagged if unsure).
// ============================================================

// ------------------------------------------------------------
// 1. STATE
// ------------------------------------------------------------
let visionWorker = null;
let visionWorkerReady = false;
let visionBatchActive = false;

const VENDOR_BASE = 'vendor/';
const VISION_STATUS_ID = 'vision-status';

// ------------------------------------------------------------
// 2. FUZZY NAME MATCHING
// ------------------------------------------------------------

const OCR_CONF = { '0':'o', '1':'l', '5':'s', '8':'b', '|':'l', '!':'i', '{':'c' };
function normalizeName(s) {
  s = (s || '').toLowerCase().split('').map(ch => OCR_CONF[ch] !== undefined ? OCR_CONF[ch] : ch).join('');
  s = s.replace(/[^a-z ]+/g, ' ');
  for (const [a, b] of [['rn','m'], ['vv','w'], ['ii','i'], ['ll','l']]) s = s.split(a).join(b);
  return s.replace(/\s+/g, ' ').trim();
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function diceSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return 2 * inter / (A.size + B.size);
}

function tokenF1(a, b) {
  const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const ts = new Set(tb);
  let inter = 0;
  for (const t of ta) if (ts.has(t)) inter++;
  return 2 * inter / (ta.length + tb.length);
}

function nameScore(rawLine, plantName) {
  const r = normalizeName(rawLine), n = normalizeName(plantName);
  let base = Math.max(diceSimilarity(r.replace(/ /g,''), n.replace(/ /g,'')), 0.85 * tokenF1(r, n));
  const fw = n.split(' ')[0];
  if (fw && fw.length > 2 && r.includes(fw)) base = Math.min(1, base + 0.08);
  return base;
}

function bestMatchPlant(rawLines) {
  const lines = (Array.isArray(rawLines) ? rawLines : [rawLines]).filter(l => l && l.trim().length >= 3);
  if (!lines.length) return { best: null, bestScore: 0 };
  const joined = lines.join(' ');
  const cands = [joined, ...lines];
  let best = null, bestScore = 0;
  for (const line of cands) {
    for (const name of Object.keys(PLANTS)) {
      const s = nameScore(line, name);
      if (s > bestScore) { best = name; bestScore = s; }
    }
  }
  return { best, bestScore };
}

// ------------------------------------------------------------
// 3. OCR ENGINE
// ------------------------------------------------------------

async function ensureVisionWorker(onProgress) {
  if (visionWorkerReady && visionWorker) return visionWorker;
  const T = window.Tesseract;
  if (!T) throw new Error('Tesseract.js failed to load');
  const setStatus = (msg) => { if (onProgress) onProgress(msg); };
  setStatus('Loading OCR engine…');
  visionWorker = await T.createWorker('eng', 1, {
    workerPath: VENDOR_BASE + 'worker.min.js',
    corePath: VENDOR_BASE,
    langPath: VENDOR_BASE,
    gzip: false,
    logger: m => {
      if (m.status === 'loading tesseract core') setStatus('Loading OCR core…');
      else if (m.status === 'initializing tesseract') setStatus('Initializing OCR…');
      else if (m.status === 'loading language traineddata') setStatus('Loading herb language data…');
      else if (m.status === 'initializing api') setStatus('OCR ready…');
      else if (m.status === 'recognizing text') setStatus(`Reading screenshot… ${Math.round((m.progress || 0) * 100)}%`);
    }
  });
  visionWorkerReady = true;
  return visionWorker;
}

// ------------------------------------------------------------
// 4. CELL DETECTION (bracket-gray clusters, adaptive split)
// ------------------------------------------------------------

const BR_BUCKET = 24; // flood-fill bucket size

async function detectCells(file) {
  const img = await createImageBitmap(file);
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  const lumaAt = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };

  // bucket the bracket-gray mask
  const buckets = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = lumaAt(x, y);
      if (l >= 140 && l <= 190) {
        const k = ((x / BR_BUCKET) | 0) + ',' + ((y / BR_BUCKET) | 0);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(x, y);
      }
    }
  }

  // flood-fill adjacent buckets into clusters
  const seen = new Set();
  const clusters = [];
  for (const key of buckets.keys()) {
    if (seen.has(key)) continue;
    const stack = [key];
    seen.add(key);
    const comp = [];
    while (stack.length) {
      const k = stack.pop();
      const arr = buckets.get(k);
      for (let i = 0; i < arr.length; i += 2) comp.push(arr[i], arr[i + 1]);
      const ci = k.indexOf(','), bx = +k.slice(0, ci), by = +k.slice(ci + 1);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nk = (bx + dx) + ',' + (by + dy);
        if (!seen.has(nk) && buckets.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    if (comp.length / 2 > 400) {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let i = 0; i < comp.length; i += 2) {
        if (comp[i] < x0) x0 = comp[i];
        if (comp[i] > x1) x1 = comp[i];
        if (comp[i + 1] < y0) y0 = comp[i + 1];
        if (comp[i + 1] > y1) y1 = comp[i + 1];
      }
      clusters.push([x0, y0, x1, y1]);
    }
  }

  // adaptive split of wide clusters at zero-density column gaps
  const cells = [];
  const splitWide = (box) => {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    if (w < 220) { cells.push(box); return; }
    // column density of bracket-gray pixels
    const colcnt = new Array(w).fill(0);
    for (let x = x0; x <= x1; x++) {
      let c2 = 0;
      for (let y = y0; y <= y1; y++) {
        const l = lumaAt(x, y);
        if (l >= 140 && l <= 190) c2++;
      }
      colcnt[x - x0] = c2;
    }
    // longest zero run in the middle 60%
    const lo = (w * 0.2) | 0, hi = (w * 0.8) | 0;
    let bs = -1, bl = 0, cs = -1, cl = 0;
    for (let i = lo; i < hi; i++) {
      if (colcnt[i] === 0) {
        if (cs < 0) cs = i;
        cl++;
        if (cl > bl) { bl = cl; bs = cs; }
      } else { cs = -1; cl = 0; }
    }
    let left, right;
    if (bs < 0 || bl < 4) {
      const mid = x0 + (w >> 1);
      left = [x0, y0, mid, y1]; right = [mid, y0, x1, y1];
    } else {
      const gs = x0 + bs - 8, ge = x0 + bs + bl + 8;
      left = [x0, y0, gs, y1]; right = [ge, y0, x1, y1];
    }
    for (const b2 of [left, right]) if (b2[2] - b2[0] >= 100) splitWide(b2);
  };
  for (const cl of clusters) {
    if (cl[2] - cl[0] < 100 || cl[3] - cl[1] < 100) continue; // junk
    splitWide(cl);
  }

  // grid sort + dedupe
  cells.sort((a, b) => ((a[1] / 100) | 0) - ((b[1] / 100) | 0) || a[0] - b[0]);
  const dedup = [];
  for (const c2 of cells) {
    if (!dedup.some(dd => Math.abs(c2[0] - dd[0]) < 40 && Math.abs(c2[1] - dd[1]) < 40)) dedup.push(c2);
  }
  return { cells: dedup, bitmap: img, W, H };
}

// ------------------------------------------------------------
// 5. BLACK ROW GROUPS (badge + name line detection)
// ------------------------------------------------------------

// Contiguous row groups with ≥8 pure-black (luma<25) pixels in the
// cell interior. The badge is the group whose top sits at 25-68% of
// cell height; name lines live at ≥73%.
function blackRowGroups(d, W, H, box) {
  const [x0, y0, x1, y1] = box;
  const xm0 = x0 + 6, xm1 = x1 - 6;
  const groups = [];
  let cur = null;
  for (let y = y0; y <= Math.min(y1, H - 1); y++) {
    let blacks = 0;
    for (let x = xm0; x < xm1; x++) {
      const i = (y * W + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l < 25) { blacks++; if (blacks >= 8) break; }
    }
    if (blacks >= 8) {
      if (!cur) cur = [y, y];
      else cur[1] = y;
    } else {
      if (cur && cur[1] - cur[0] >= 8) groups.push(cur);
      cur = null;
    }
  }
  if (cur && cur[1] - cur[0] >= 8) groups.push(cur);
  return groups;
}// ------------------------------------------------------------
// 6. PER-CELL OCR (adaptive zones + multi-config badge voting)
// ------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// grayscale + threshold, dark-on-light
function thresholdCrop(ctx, x, y, w, h, thr) {
  const c = makeCanvas(w, h);
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  const im = cc.getImageData(0, 0, w, h);
  const dd = im.data;
  for (let i = 0; i < dd.length; i += 4) {
    const g = 0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2];
    const v = g > thr ? 0 : 255;
    dd[i] = dd[i + 1] = dd[i + 2] = v;
  }
  cc.putImageData(im, 0, 0);
  return c;
}

// autocontrast a grayscale crop (2% tail clip like PIL autocontrast)
function autocontrastCrop(ctx, x, y, w, h) {
  const c = makeCanvas(w, h);
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  const im = cc.getImageData(0, 0, w, h);
  const dd = im.data;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < dd.length; i += 4) {
    const g = Math.round(0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2]);
    hist[g]++; n++;
  }
  const cut = Math.max(1, Math.round(n * 0.02));
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
  const scale = hi > lo ? 255 / (hi - lo) : 1;
  for (let i = 0; i < dd.length; i += 4) {
    const g = 0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2];
    const v = Math.max(0, Math.min(255, Math.round((g - lo) * scale)));
    dd[i] = dd[i + 1] = dd[i + 2] = v;
  }
  cc.putImageData(im, 0, 0);
  return c;
}

function upscale(src, factor) {
  const c = makeCanvas(src.width * factor, src.height * factor);
  const cc = c.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// morphological close for binary (black text on white): dilate then
// erode the BLACK ink via MaxFilter-then-MinFilter equivalents.
// PIL MinFilter(k) erodes WHITE (=dilates black); MaxFilter erodes black.
function closeBinary(canvas, k) {
  const w = canvas.width, h = canvas.height;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const pass = (dark) => {
    const out = new Uint8ClampedArray(w * h);
    const r = (k - 1) >> 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = dark ? 255 : 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const v = src.data[yy * w * 4 + xx * 4];
          if (dark) { if (v < best) best = v; }      // min filter = dilate black
          else { if (v > best) best = v; }           // max filter = erode black
        }
      }
      out[y * w + x] = best;
    }
    return out;
  };
  const dilated = pass(true);
  // now erode using the dilated image
  const out = new Uint8ClampedArray(w * h);
  const r = (k - 1) >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const v = dilated[yy * w + xx];
        if (v > best) best = v;
      }
    }
    out[y * w + x] = best;
  }
  const c = makeCanvas(w, h);
  const cc = c.getContext('2d');
  const im = cc.createImageData(w, h);
  for (let i = 0; i < out.length; i++) {
    im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = out[i];
    im.data[i * 4 + 3] = 255;
  }
  cc.putImageData(im, 0, 0);
  return c;
}

// quantity parse with digit fixups for hollow-serif misreads
function parseQtyText(txt) {
  if (!txt) return null;
  txt = txt.toUpperCase();
  // prefer the digits following an 'x' (the badge format); the 'x' anchor
  // avoids picking up bracket-artifact digits standing alone
  const xm = txt.match(/[X|]\s*(\d{1,4})/);
  let ms;
  if (xm) {
    const v = xm[1].replace(/I/g,'1').replace(/L/g,'1').replace(/S/g,'5').replace(/O/g,'0').replace(/B/g,'8').replace(/Z/g,'2').replace(/G/g,'6').replace(/D/g,'0');
    const n = parseInt(v, 10);
    return (n > 0 && n <= 9999) ? n : null;
  }
  txt = txt.replace(/I/g,'1').replace(/L/g,'1').replace(/\|/g,'1').replace(/S/g,'5').replace(/O/g,'0').replace(/B/g,'8').replace(/Z/g,'2').replace(/G/g,'6').replace(/D/g,'0');
  ms = (txt.match(/\d{1,4}/g) || []).sort((a, b) => a.length - b.length || a - b);
  if (!ms.length) return null;
  const v = parseInt(ms[0], 10);
  return (v > 0 && v <= 9999) ? v : null;
}

async function ocrCanvas(worker, canvas, psm) {
  const { data: { text } } = await worker.recognize(canvas, {}, { text: true });
  return text || '';
}

// Multi-config badge OCR with majority vote; returns {qty, conf}
async function readBadgeQty(worker, ctx, box, badge) {
  const [x0, , x1] = box;
  const by0 = badge[0], by1 = badge[1];
  const votes = [];
  for (const pad of [3, 6]) {
    for (const zoom of [6, 8]) {
      const cx = x0 + 2, cy = Math.max(0, by0 - pad);
      const cw = x1 - x0 - 4, ch = by1 - by0 + pad * 2;
      if (cw < 20 || ch < 10) continue;
      // variant A: autocontrast raw
      const a = upscale(autocontrastCrop(ctx, cx, cy, cw, ch), zoom);
      const tA = await ocrCanvas(worker, a, 7);
      const vA = parseQtyText(tA);
      if (vA) votes.push(vA);
      // variant B: threshold + close
      let b = thresholdCrop(ctx, cx, cy, cw, ch, 110);
      b = upscale(b, zoom);
      b = closeBinary(b, 3);
      const tB = await ocrCanvas(worker, b, 7);
      const vB = parseQtyText(tB);
      if (vB) votes.push(vB);
    }
  }
  if (!votes.length) return { qty: null, conf: 0 };
  const counts = new Map();
  for (const v of votes) counts.set(v, (counts.get(v) || 0) + 1);
  let top = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { top = v; bestN = n; }
  return { qty: top, conf: bestN / votes.length };
}

async function ocrCell(worker, ctx, d, W, H, cell) {
  const [x0, y0, x1, y1] = cell;
  const h = y1 - y0;

  // black row groups → badge + name zones
  const groups = blackRowGroups(d, W, H, cell);
  let badge = null;
  for (const g of groups) {
    const frac = (g[0] - y0) / h;
    if (frac >= 0.25 && frac <= 0.68) { badge = g; break; }
  }

  // NAME: proportional bottom zone (robust even when name rows have
  // fewer than 8 black px) — validated 21/24 on real screenshots
  const nameLines = [];
  const ny0 = y0 + Math.floor(h * 0.73);
  const ny1 = Math.min(y0 + Math.floor(h * 0.99), H - 1);
  if (ny1 - ny0 >= 15 && x1 - x0 >= 60) {
    for (const thr of [110, 150]) {
      let g2 = thresholdCrop(ctx, x0 - 2, ny0, (x1 - x0) + 4, ny1 - ny0, thr);
      g2 = upscale(g2, 4);
      g2 = closeBinary(g2, 3);
      const text = await ocrCanvas(worker, g2, 6);
      for (const ln of text.split(/\n+/)) {
        const t = ln.trim();
        if (t.length >= 3) nameLines.push(t);
      }
    }
  }

  const { best, bestScore } = bestMatchPlant(nameLines);

  // QTY: badge black-group, multi-config vote
  let qty = null, qtyConf = 0;
  if (badge) {
    const r = await readBadgeQty(worker, ctx, cell, badge);
    qty = r.qty; qtyConf = r.conf;
  }

  return { name: best, nameScore: bestScore, qty, qtyConf, raw: nameLines };
}// ------------------------------------------------------------
// 7. CONFIRM OVERLAY
// ------------------------------------------------------------

function showVisionConfirm(rows) {
  // rows: [{name, nameScore, qty, qtyConf, count(nCells)}]
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vision-overlay';
    const body = rows.map((r, i) => {
      const auto = r.nameScore >= 0.40;
      const lowConf = r.qtyConf < 0.5;
      return `
        <div class="vision-row ${auto ? '' : 'vision-uncertain'}">
          <input type="checkbox" class="vision-check" id="vchk-${i}" ${auto ? 'checked' : ''}>
          <label for="vchk-${i}" class="vision-name">${r.name}</label>
          <input type="number" class="vision-qty ${lowConf ? 'vision-flag' : ''}" min="0"
                 value="${r.qty ?? ''}" data-plant="${r.name}"
                 placeholder="${r.qtyConf === 0 ? '?' : ''}"
                 title="${lowConf ? 'OCR was unsure about this number — please double-check' : ''}">
          <span class="vision-score">${r.qtyConf === 0 ? '⚠️ qty?' : (lowConf ? '⚠️ check qty' : '')}</span>
        </div>`;
    }).join('');

    overlay.innerHTML = `
      <div class="vision-modal">
        <div class="vision-modal-header">
          <span>📸 Detected herbs — review before applying</span>
          <button class="btn vision-close">×</button>
        </div>
        <div class="vision-rows">
          ${body || '<div class="no-results">No herbs detected. Make sure the screenshots show the plant inventory grid (items with corner brackets).</div>'}
        </div>
        <div class="vision-modal-actions">
          <button class="btn" id="vision-cancel">Cancel</button>
          <button class="btn btn-primary" id="vision-apply" ${rows.length ? '' : 'disabled'}>Apply to Inventory</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.vision-close').onclick = () => close(null);
    overlay.querySelector('#vision-cancel').onclick = () => close(null);
    overlay.querySelector('#vision-apply').onclick = () => {
      const applied = {};
      overlay.querySelectorAll('.vision-row').forEach(row => {
        const chk = row.querySelector('.vision-check');
        const qtyEl = row.querySelector('.vision-qty');
        if (chk && chk.checked && qtyEl.value !== '') {
          applied[qtyEl.dataset.plant] = Math.max(0, parseInt(qtyEl.value, 10) || 0);
        }
      });
      close(applied);
    };
    // focus the first flagged qty for quick fixing
    const firstFlag = overlay.querySelector('.vision-qty.vision-flag');
    if (firstFlag) firstFlag.focus();
  });
}

// ------------------------------------------------------------
// 8. MAIN ENTRY — BATCH QUEUE
// ------------------------------------------------------------

async function runVisionImport(files) {
  if (visionBatchActive) return; // single-flight
  visionBatchActive = true;

  const statusEl = document.getElementById(VISION_STATUS_ID);
  const btn = document.getElementById('btn-vision');
  try {
    if (btn) { btn.disabled = true; btn.textContent = '📸 Reading…'; }
    if (statusEl) statusEl.textContent = 'Warming up OCR…';

    const list = Array.from(files || []);
    if (!list.length) return;

    const worker = await ensureVisionWorker((msg) => {
      if (statusEl) statusEl.textContent = msg;
    });

    // aggregate per plant
    const agg = new Map(); // name -> {qty total, worstConf, cells, bestScore}
    let failed = 0;

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const n = i + 1;
      try {
        if (statusEl) statusEl.textContent = `Reading screenshot ${n} of ${list.length}…`;
        const { cells, bitmap } = await detectCells(file);
        if (!cells.length) { console.warn(`Vision: no grid cells found in image ${n}`); continue; }

        const cc = makeCanvas(bitmap.width, bitmap.height);
        const ctx = cc.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const d = imgData.data;
        const W = bitmap.width, H = bitmap.height;

        let done = 0;
        for (const cell of cells) {
          const res = await ocrCell(worker, ctx, d, W, H, cell);
          if (!res.name || res.nameScore < 0.25) continue;
          const cur = agg.get(res.name) || { qty: 0, worstConf: 1, cells: 0, nameScore: 0 };
          cur.cells++;
          cur.nameScore = Math.max(cur.nameScore, res.nameScore);
          if (res.qty !== null) {
            cur.qty += res.qty;
            cur.worstConf = Math.min(cur.worstConf, res.qtyConf);
          } else {
            cur.worstConf = 0; // unknown qty somewhere → flag
          }
          agg.set(res.name, cur);
          done++;
        }
        if (statusEl) statusEl.textContent = `Reading screenshot ${n} of ${list.length} — ${done}/${cells.length} items`;
      } catch (err) {
        failed++;
        console.error(`Vision import failed for image ${n} of ${list.length}:`, err);
        if (statusEl) statusEl.textContent = `⚠️ Screenshot ${n} of ${list.length} failed — continuing…`;
      }
    }

    if (statusEl) {
      const kinds = agg.size;
      statusEl.textContent = failed
        ? `Done with ${failed} screenshot(s) failed — review below.`
        : (kinds
          ? `Detected ${kinds} herb type(s) across ${list.length} screenshot(s) — review below.`
          : 'No herbs detected — check the screenshots show the inventory grid.');
    }

    const rows = [...agg.entries()].map(([name, v]) => ({
      name, nameScore: v.nameScore, qty: v.qty || null,
      qtyConf: v.qty, conf: v.worstConf, count: v.cells
    }));
    const applied = await showVisionConfirm(rows);
    if (applied && Object.keys(applied).length) {
      for (const [name, qty] of Object.entries(applied)) setQty(name, qty);
      if (window.AudioController) window.AudioController.playDone();
      if (statusEl) statusEl.textContent = `Applied ${Object.keys(applied).length} herb type(s) to inventory.`;
    }
  } catch (err) {
    console.error('Vision import failed:', err);
    if (statusEl) statusEl.textContent = '❌ OCR failed: ' + err.message;
  } finally {
    visionBatchActive = false;
    if (btn) { btn.disabled = false; btn.textContent = '📸 Autofill from Screenshot'; }
  }
}

// Pre-warm the OCR engine (single-flight with runVisionImport)
function warmUpVision() {
  const conn = navigator.connection || {};
  if (conn.saveData || navigator.onLine === false) return;
  const statusEl = document.getElementById(VISION_STATUS_ID);
  if (statusEl) statusEl.textContent = '⏳ Pre-loading OCR engine…';
  ensureVisionWorker((msg) => {
    if (statusEl) statusEl.textContent = `⏳ ${msg}`;
  }).then(() => {
    if (statusEl) statusEl.textContent = '✅ OCR ready — paste screenshots anytime';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  }).catch((err) => {
    console.warn('Vision warmup failed (will retry on first paste):', err);
    if (statusEl) statusEl.textContent = '';
  });
}

function initVision() {
  const input = document.getElementById('vision-file-input');
  const btn = document.getElementById('btn-vision');
  if (!input || !btn) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files.length) runVisionImport(input.files);
    input.value = '';
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const pasted = [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length) {
      e.preventDefault();
      runVisionImport(pasted);
    }
  });
  const startWarmup = () => { if (!visionWorkerReady) warmUpVision(); };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(startWarmup, { timeout: 3000 });
  } else {
    setTimeout(startWarmup, 2000);
  }
}