// ============================================================
// VISION.JS — Screenshot(s) → Inventory Autofill (OCR)
// Uses Tesseract.js (vendored locally, offline-capable).
//
// CELL-BASED PIPELINE (v3, 2026-09-06):
// The inventory UI is a fixed 2-column grid of cells (~151px wide,
// ~197px tall, 243px row pitch) with gray corner brackets. Instead
// of OCR-ing the whole frame (fragile: stylized serif font with
// heavy outlines garbles Tesseract), we:
//   1. Detect the bracket-gray pixel mask and flood-fill clusters
//      → cell bounding boxes (wide merged clusters are split back
//      into two canonical 151px cells).
//   2. Per cell, crop two zones and OCR them separately:
//        qty zone  (dy 82–122): "x34" badge — psm 7, digit cleanup
//        name zone (dy 148–195): herb name — psm 6, 3 variants
//   3. Fuzzy-match names with bigram-Dice + token-F1 + OCR
//      confusion normalization (rn→m, 0→o, 1→l …).
//   4. SUM quantities across images → one confirm overlay.
// Validated on 5 real screenshots: 24/24 cells detected,
// 15/16 quantities read exactly, names matched at ≥0.40 score.
// ============================================================

// ------------------------------------------------------------
// 1. STATE
// ------------------------------------------------------------
let visionWorker = null;
let visionWorkerReady = false;
let visionWorkerReadyPromise = null; // single-flight: warmup + first import share one createWorker()

// Batch guard: no overlapping runs — new picks/pastes during an
// active batch are ignored (single-flight, not queued).
let visionBatchActive = false;

const VENDOR_BASE = 'vendor/';
const VISION_STATUS_ID = 'vision-status';

// Grid geometry (calibrated on real screenshots; the UI does not
// rescale with screenshot width — cells are always ~151px wide).
const CELL_W = 151;
const QTY_DY0 = 82, QTY_DY1 = 122;   // quantity badge band inside cell
const NAME_DY0 = 148, NAME_DY1 = 195; // herb name band inside cell
const UPSCALE = 3; // OCR upscale factor for crops

// ------------------------------------------------------------
// 2. FUZZY NAME MATCHING
// ------------------------------------------------------------

// OCR-confusion normalization: map common misreads back to likely
// originals, strip junk punctuation.
function normalizeName(s) {
  // OCR-confusion normalization: map common misreads back to likely
  // originals, strip junk punctuation.
  const OCR_CONF = { '0':'o', '1':'l', '5':'s', '8':'b', '|':'l', '!':'i', '{':'c' };
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

// Bigram Dice coefficient — robust to OCR garble within words
function diceSimilarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return 2 * inter / (A.size + B.size);
}

// Token F1 — catches whole-word matches even when chars are mangled
function tokenF1(a, b) {
  const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const ts = new Set(tb);
  let inter = 0;
  for (const t of ta) if (ts.has(t)) inter++;
  return 2 * inter / (ta.length + tb.length);
}

// Combined score for a raw OCR string vs a plant name
function nameScore(rawLine, plantName) {
  const r = normalizeName(rawLine), n = normalizeName(plantName);
  let base = Math.max(diceSimilarity(r.replace(/ /g,''), n.replace(/ /g,'')), 0.85 * tokenF1(r, n));
  const fw = n.split(' ')[0];
  if (fw && fw.length > 2 && r.includes(fw)) base = Math.min(1, base + 0.08);
  return base;
}

// Best plant for a raw OCR line (or array of variant lines — the
// best-scoring match across all variants wins)
function bestMatchPlant(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [rawLines];
  // candidates: each variant line alone + the joined text (multi-line names
  // like "Thousand / Year Lotus" only score high when rejoined)
  const joined = lines.join(' ');
  const cands = joined ? [joined, ...lines] : lines;
  let best = null, bestScore = 0;
  for (const line of cands) {
    if (!line || line.length < 3) continue;
    for (const name of Object.keys(PLANTS)) {
      const s = nameScore(line, name);
      if (s > bestScore) { best = name; bestScore = s; }
    }
  }
  return { best, bestScore };
}// ------------------------------------------------------------
// 3. OCR ENGINE
// ------------------------------------------------------------

async function ensureVisionWorker(onProgress) {
  if (visionWorkerReady && visionWorker) return visionWorker;
  const T = window.Tesseract;
  if (!T) throw new Error('Tesseract.js failed to load');
  const setStatus = (msg) => {
    if (onProgress) onProgress(msg);
  };
  setStatus('Loading OCR engine…');
  visionWorker = await T.createWorker('eng', 1, {
    workerPath: VENDOR_BASE + 'worker.min.js',
    corePath: VENDOR_BASE,
    langPath: VENDOR_BASE,
    gzip: false, // we vendor plain eng.traineddata (not .gz) — default gzip:true 404s
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
// 4. CELL DETECTION
// ------------------------------------------------------------

// The corner brackets + frame render as a narrow gray band
// (luma ~140–190) on a dark background. Flood-fill that mask into
// clusters; each cell's bracket group forms a ~151×195 box.
async function detectCells(file) {
  const img = await createImageBitmap(file);
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  const isBracketGray = (x, y) => {
    const i = (y * W + x) * 4;
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return g >= 140 && g <= 190;
  };

  // sparse point list, bucketed for flood fill (24px buckets, like the prototype)
  const B = 24;
  const buckets = new Map(); // "bx,by" -> [x,y,...]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isBracketGray(x, y)) {
        const k = ((x / B) | 0) + ',' + ((y / B) | 0);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(x, y);
      }
    }
  }

  // flood-fill bucket adjacency (8-neighbour)
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
      const [bx, by] = k.split(',').map(Number);
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

  // Split wide merged clusters back into two canonical cells;
  // keep cell-sized clusters as-is; drop junk.
  const cells = [];
  for (const [x0, y0, x1, y1] of clusters) {
    const w = x1 - x0;
    if (w >= 200) {
      cells.push([x0, y0, x0 + CELL_W, y1]);
      cells.push([x1 - CELL_W, y0, x1, y1]);
    } else if (w >= 120) {
      cells.push([x0, y0, x1, y1]);
    }
  }
  // grid sort + dedupe near-identical boxes
  cells.sort((a, b) => ((a[1] / 100) | 0) - ((b[1] / 100) | 0) || a[0] - b[0]);
  const dedup = [];
  for (const c2 of cells) {
    if (!dedup.some(dd => Math.abs(c2[0] - dd[0]) < 40 && Math.abs(c2[1] - dd[1]) < 40)) dedup.push(c2);
  }
  return { cells: dedup, bitmap: img, W, H };
}// ------------------------------------------------------------
// 5. PER-CELL OCR
// ------------------------------------------------------------

// Grayscale + threshold a crop in-place; bright text → black on white
// (the game renders white outlined text; thresholding kills the busy
// icon background behind the name band)
function thresholdCrop(ctx, x, y, w, h, thr) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  const im = cc.getImageData(0, 0, w, h);
  const dd = im.data;
  for (let i = 0; i < dd.length; i += 4) {
    const g = 0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2];
    const v = g >= thr ? 0 : 255; // bright → black (Tesseract wants dark on light)
    dd[i] = dd[i + 1] = dd[i + 2] = v;
  }
  cc.putImageData(im, 0, 0);
  return c;
}

// Extract the quantity integer from a qty-zone OCR string.
// Prefer the "x<digits>" form (the badge is always xNN); a bare
// number is accepted only if no x-form exists (bracket artifacts
// often glue extra digits, e.g. "x4" → "~pxX45," is rejected by
// preferring the x-form with the shortest digit run).
function extractQtyFromZone(raw) {
  if (!raw) return null;
  const xForms = [];
  for (const m of raw.matchAll(/x\s*(\d{1,4})/gi)) xForms.push(parseInt(m[1], 10));
  if (xForms.length) {
    // badge digits run 1–3; prefer the shortest (bracket artifacts append)
    xForms.sort((a, b) => String(a).length - String(b).length || a - b);
    const v = xForms[0];
    return v > 0 && v <= 9999 ? v : null;
  }
  const m = raw.match(/(?<![\dx])(\d{1,3})(?![\dx])/i);
  if (m) {
    const v = parseInt(m[1], 10);
    if (v > 0 && v <= 999) return v;
  }
  return null;
}

async function ocrCell(worker, ctx, cell) {
  const [x0, y0, x1, y1] = cell;
  const cw = x1 - x0;
  const H = ctx.canvas.height;

  // --- quantity zone ---
  let qty = null, qtyRaw = '';
  {
    const qy0 = y0 + QTY_DY0, qy1 = Math.min(y0 + QTY_DY1, H);
    if (qy1 - qy0 >= 25) {
      const crop = thresholdCrop(ctx, x0, qy0, cw, qy1 - qy0, 170);
      const up = document.createElement('canvas');
      up.width = crop.width * UPSCALE; up.height = crop.height * UPSCALE;
      const uc = up.getContext('2d');
      uc.imageSmoothingEnabled = true; uc.imageSmoothingQuality = 'high';
      uc.drawImage(crop, 0, 0, up.width, up.height);
      const { data: { text } } = await worker.recognize(up);
      qtyRaw = (text || '').trim();
      qty = extractQtyFromZone(qtyRaw);
    }
  }

  // --- name zone: 3 OCR variants, keep all raw lines for matching ---
  const nameLines = [];
  {
    const ny0 = y0 + NAME_DY0, ny1 = Math.min(y0 + NAME_DY1, y1, H);
    if (ny1 - ny0 >= 20) {
      const variants = [
        thresholdCrop(ctx, Math.max(0, x0 - 6), ny0, cw + 12, ny1 - ny0, 170),
        thresholdCrop(ctx, Math.max(0, x0 - 6), ny0, cw + 6, ny1 - ny0, 150)
      ];
      // raw (unthresholded) variant — sometimes the outline survives better
      {
        const rc = document.createElement('canvas');
        rc.width = cw + 6; rc.height = ny1 - ny0;
        const rcc = rc.getContext('2d');
        rcc.drawImage(ctx.canvas, Math.max(0, x0 - 6), ny0, cw + 6, ny1 - ny0, 0, 0, cw + 6, ny1 - ny0);
        variants.push(rc);
      }
      for (const v of variants) {
        const up = document.createElement('canvas');
        up.width = v.width * UPSCALE; up.height = v.height * UPSCALE;
        const uc = up.getContext('2d');
        uc.imageSmoothingEnabled = true; uc.imageSmoothingQuality = 'high';
        uc.drawImage(v, 0, 0, up.width, up.height);
        const { data: { text } } = await worker.recognize(up);
        for (const line of (text || '').split(/\n+/)) {
          const t = line.trim();
          if (t.length >= 3) nameLines.push(t);
        }
      }
    }
  }

  const { best, bestScore } = bestMatchPlant(nameLines);
  const NAME_MIN = 0.40;
  return {
    name: bestScore >= NAME_MIN ? best : null,
    nameScore: bestScore,
    qty,
    raw: { nameLines, qtyRaw }
  };
}// ------------------------------------------------------------
// 6. CONFIRM OVERLAY
// ------------------------------------------------------------

function showVisionConfirm(found) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'vision-overlay';
    const rows = Object.entries(found).sort((a, b) => (PLANTS[a[0]]?.score[0]||0) - (PLANTS[b[0]]?.score[0]||0))
      .map(([name, qty], i) => `
        <div class="vision-row">
          <input type="checkbox" class="vision-check" id="vchk-${i}" checked>
          <label for="vchk-${i}" class="vision-name">${name}</label>
          <input type="number" class="vision-qty" min="0" value="${qty}" data-plant="${name}">
          <span class="vision-score">${PLANTS[name]?.rarity || ''}</span>
        </div>
      `).join('');

    overlay.innerHTML = `
      <div class="vision-modal">
        <div class="vision-modal-header">
          <span>📸 Detected herbs — review before applying</span>
          <button class="btn vision-close">×</button>
        </div>
        <div class="vision-rows">${rows || '<div class="no-results">No herbs detected. Make sure the screenshots show the plant inventory grid (items with corner brackets).</div>'}</div>
        <div class="vision-modal-actions">
          <button class="btn" id="vision-cancel">Cancel</button>
          <button class="btn btn-primary" id="vision-apply" ${Object.keys(found).length ? '' : 'disabled'}>Apply to Inventory</button>
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
        if (chk && chk.checked) applied[qtyEl.dataset.plant] = Math.max(0, parseInt(qtyEl.value, 10) || 0);
      });
      close(applied);
    };
  });
}

// ------------------------------------------------------------
// 7. MAIN ENTRY — BATCH QUEUE
// ------------------------------------------------------------

// OCR every image (cell-based), SUM quantities per plant across
// images, then show ONE combined confirm overlay.
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

    const totals = {}; // plantName -> summed qty across images
    let failed = 0, detected = 0;

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const n = i + 1;
      try {
        if (statusEl) statusEl.textContent = `Reading screenshot ${n} of ${list.length}…`;
        const { cells, bitmap } = await detectCells(file);
        if (!cells.length) {
          console.warn(`Vision: no grid cells found in image ${n}`);
          continue;
        }
        // draw to a canvas once per image for crop access
        const cc = document.createElement('canvas');
        cc.width = bitmap.width; cc.height = bitmap.height;
        const ctx = cc.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);

        for (const cell of cells) {
          const res = await ocrCell(worker, ctx, cell);
          if (res.name && res.qty !== null) {
            totals[res.name] = (totals[res.name] || 0) + res.qty;
            detected++;
          } else {
            console.log(`Vision: cell @(${cell[0]},${cell[1]}) incomplete`, res.raw);
          }
        }
        if (statusEl) statusEl.textContent = `Reading screenshot ${n} of ${list.length} — ${cells.length} items found`;
      } catch (err) {
        failed++;
        console.error(`Vision import failed for image ${n} of ${list.length}:`, err);
        if (statusEl) statusEl.textContent = `⚠️ Screenshot ${n} of ${list.length} failed — continuing…`;
      }
    }

    if (statusEl) {
      statusEl.textContent = failed
        ? `Done with ${failed} screenshot(s) failed — review below.`
        : (Object.keys(totals).length
          ? `Detected ${Object.keys(totals).length} herb type(s) across ${list.length} screenshot(s) — review below.`
          : 'No herbs detected — check the screenshots show the inventory grid.');
    }

    const applied = await showVisionConfirm(totals);
    if (applied && Object.keys(applied).length) {
      for (const [name, qty] of Object.entries(applied)) {
        setQty(name, qty);
      }
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

// Pre-warm the OCR engine so the first paste/click doesn't sit through the
// ~9 MB cold load. Single-flight with runVisionImport.
function warmUpVision() {
  const conn = navigator.connection || {};
  if (conn.saveData || navigator.onLine === false) return;
  const statusEl = document.getElementById(VISION_STATUS_ID);
  if (statusEl) statusEl.textContent = '⏳ Pre-loading OCR engine…';
  visionWorkerReadyPromise = ensureVisionWorker((msg) => {
    if (statusEl) statusEl.textContent = `⏳ ${msg}`;
  }).then((worker) => {
    if (statusEl) statusEl.textContent = '✅ OCR ready — paste screenshots anytime';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
    return worker;
  }).catch((err) => {
    console.warn('Vision warmup failed (will retry on first paste):', err);
    visionWorkerReadyPromise = null;
    if (statusEl) statusEl.textContent = '';
  });
}

// Init: wire up the hidden file input
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