// ============================================================
// VISION.JS — Screenshot → Inventory Autofill (OCR)
// Uses Tesseract.js (vendored locally, offline-capable).
// Flow: pick image → OCR → fuzzy-match herb names + quantities
//       → confirm overlay → apply to inventoryState.
// ============================================================

// ------------------------------------------------------------
// 1. STATE
// ------------------------------------------------------------
let visionWorker = null;
let visionWorkerReady = false;

const VENDOR_BASE = 'vendor/';
const VISION_STATUS_ID = 'vision-status';

// ------------------------------------------------------------
// 2. FUZZY NAME MATCHING
// ------------------------------------------------------------

// Normalise: lowercase, strip non-alphanumerics, collapse spaces
function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Token-set similarity (0..1) — robust to OCR word-order noise
function tokenSimilarity(a, b) {
  const ta = new Set(normalizeName(a).split(' '));
  const tb = new Set(normalizeName(b).split(' '));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

// Levenshtein distance for character-level fallback
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function charSimilarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 0;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Combined score; also try family keyword boosting (spirit/vitality etc.)
const FAMILY_HINTS = {
  'SPIRIT': ['spirit', 'qi'],
  'VITALITY': ['vitality', 'health', 'healing', 'life'],
  'AGILITY': ['agility', 'swift', 'speed'],
  'ENDURANCE': ['endurance', 'iron', 'stone', 'flame', 'mountain']
};

function bestMatchPlant(rawLine) {
  let best = null, bestScore = 0, bestAlt = null, bestAltScore = 0;
  for (const name of Object.keys(PLANTS)) {
    let score = Math.max(tokenSimilarity(rawLine, name) * 0.9 + charSimilarity(rawLine, name) * 0.1, 0);
    // boost if a family hint word appears in the OCR line
    const low = normalizeName(rawLine);
    for (const [fam, words] of Object.entries(FAMILY_HINTS)) {
      if (PLANTS[name].family === fam && words.some(w => low.includes(w))) score += 0.05;
    }
    if (score > bestScore) { bestAlt = best; bestAltScore = bestScore; best = name; bestScore = score; }
    else if (score > bestAltScore) { bestAlt = name; bestAltScore = score; }
  }
  return { best, bestScore, bestAlt, bestAltScore };
}

// Parse "x12" / "12x" / "×12" / ": 12" quantity tokens out of a line
function extractQty(line) {
  const patterns = [
    /(?:^|[\s:>x×*])(\d{1,5})\s*(?:x|×|\*)(?:[\s,]|$)/i,   // 12 x  / 12x
    /(?:^|[\s:>])(\d{1,5})\s*$/i,                            // trailing "12"
    /\bx\s*[:=]?\s*(\d{1,5})\b/i,                            // x: 12 / x 12
    /[:\s](\d{1,5})\s*(?:\/|\||$)/i                          // "12 /" separators
  ];
  for (const p of patterns) {
    const m = line.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= 99999) return n;
    }
  }
  return null;
}

// ------------------------------------------------------------
// 3. OCR ENGINE
// ------------------------------------------------------------

async function ensureVisionWorker(onProgress) {
  if (visionWorkerReady && visionWorker) return visionWorker;
  const T = window.Tesseract;
  if (!T) throw new Error('Tesseract.js failed to load');
  const setStatus = (msg) => {
    const el = document.getElementById(VISION_STATUS_ID);
    if (el) el.textContent = msg;
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

// Preprocess image: upscale 2x + grayscale + contrast stretch for game UI text
async function preprocessImage(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(3, Math.max(1.5, 1400 / img.width));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  let min = 255, max = 0;
  const gray = new Uint8ClampedArray(d.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    gray[i] = g;
    if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < gray.length; i++) {
    const v = ((gray[i] - min) / range) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

// ------------------------------------------------------------
// 4. LINE PARSING
// ------------------------------------------------------------

function parseOcrLines(text) {
  const lines = (text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const found = {}; // plantName -> qty

  for (const line of lines) {
    if (line.length < 4) continue;
    // strip leading bullets / counters like "3." etc.
    const cleaned = line.replace(/^[\s\-•·*]+/, '');
    const qty = extractQty(cleaned);
    // Try to find the best plant name anywhere in the line (OCR order can vary)
    const { best, bestScore, bestAlt, bestAltScore } = bestMatchPlant(cleaned);
    const name = bestScore >= 0.55 ? best : (bestAltScore >= 0.62 ? bestAlt : null);
    if (!name || qty === null) continue;
    found[name] = Math.max(found[name] || 0, qty);
  }
  return found;
}

// ------------------------------------------------------------
// 5. CONFIRM OVERLAY
// ------------------------------------------------------------

function showVisionConfirm(found, imgCanvas) {
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
        <div class="vision-preview"></div>
        <div class="vision-rows">${rows || '<div class="no-results">No herbs detected. Try a brighter, sharper screenshot of the inventory screen.</div>'}</div>
        <div class="vision-modal-actions">
          <button class="btn" id="vision-cancel">Cancel</button>
          <button class="btn btn-primary" id="vision-apply" ${Object.keys(found).length ? '' : 'disabled'}>Apply to Inventory</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    if (imgCanvas) {
      const prev = overlay.querySelector('.vision-preview');
      const thumb = imgCanvas;
      thumb.style.maxWidth = '100%';
      thumb.style.maxHeight = '160px';
      thumb.style.display = 'block';
      thumb.style.borderRadius = '8px';
      prev.appendChild(thumb);
    }

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
// 6. MAIN ENTRY
// ------------------------------------------------------------

async function runVisionImport(file) {
  const statusEl = document.getElementById(VISION_STATUS_ID);
  const btn = document.getElementById('btn-vision');
  try {
    if (btn) { btn.disabled = true; btn.textContent = '📸 Reading…'; }
    if (statusEl) statusEl.textContent = 'Warming up OCR…';

    const canvas = await preprocessImage(file);
    const worker = await ensureVisionWorker();
    const { data: { text } } = await worker.recognize(canvas);
    const found = parseOcrLines(text);

    if (statusEl) statusEl.textContent = Object.keys(found).length
      ? `Detected ${Object.keys(found).length} herb type(s) — review below.`
      : 'No herbs detected — check the screenshot shows plant names with quantities.';

    const applied = await showVisionConfirm(found, canvas);
    if (applied && Object.keys(applied).length) {
      // Add on top of existing inventory (user may already have counts entered)
      for (const [name, qty] of Object.entries(applied)) {
        setQty(name, qty);
      }
      if (window.AudioController) window.AudioController.playDone();
    }
  } catch (err) {
    console.error('Vision import failed:', err);
    if (statusEl) statusEl.textContent = '❌ OCR failed: ' + err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📸 Autofill from Screenshot'; }
  }
}

// Init: wire up the hidden file input
function initVision() {
  const input = document.getElementById('vision-file-input');
  const btn = document.getElementById('btn-vision');
  if (!input || !btn) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) runVisionImport(f);
    input.value = ''; // allow re-picking the same file
  });
  // Paste-from-clipboard support (screenshot → Cmd+V straight into the page)
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); runVisionImport(f); }
        break;
      }
    }
  });
}