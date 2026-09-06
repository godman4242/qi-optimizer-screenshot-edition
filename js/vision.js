// ============================================================
// VISION.JS — Screenshot(s) → Inventory Autofill (OCR)
// Uses Tesseract.js (vendored locally, offline-capable).
//
// PIPELINE v4 (2026-09-06). Every number below was measured against the five
// real screenshots in tests/fixtures/; `node tests/ocr-bench.mjs` is the gate
// and prints the score. Do not change a threshold without re-running it.
//
// WHAT THE GAME ACTUALLY RENDERS (looked at, pixel by pixel — the v3 pipeline
// was built on a wrong description of this and paid for it):
//
//   · Each item sits on a rounded COLOURED TILE, tinted by rarity, with four
//     light-grey CORNER BRACKETS. The brackets are the only reliable structure
//     in the frame, so they define both the grid and, via the lower pair,
//     where the tile stops and the name begins.
//   · The QUANTITY BADGE ("x51") is SOLID BLACK glyphs with a WHITE outline,
//     drawn over the icon. v3 believed it was white-on-dark and inverted the
//     crop, handing Tesseract the one polarity it reads worst — then spent
//     twelve OCR passes and a table of I→1 / O→6 guesses undoing the damage.
//     Binarising `luma < 50` gives solid black-on-white in a single pass.
//   · The badge font draws 1 as a seriffed capital I, so "x51" genuinely looks
//     like "x5I". No preprocessing fixes that; a digit whitelist does, because
//     Tesseract can then only emit digits.
//   · The NAME is white text with a thin dark outline on the dark page
//     background, below the tile, wrapping to two lines. Opposite polarity to
//     the badge: `luma > 165` is ink.
//
// COST. v3 ran 15 OCR calls per cell (3 name variants + 3 thresholds × 2 zooms
// × 2 psm for the badge), each wrapped in two setParameters round-trips, all
// on one worker. v4 runs 2 calls per cell across a small worker pool.
// ============================================================

// ============================================================
// PART 1 — MATCHING (pure: no DOM, no canvas, no OCR)
//
// This lived in its own js/vision-match.js until a stale browser cache proved
// the split was a liability: `python3 -m http.server` sends no cache headers,
// so a browser that had loaded an older index.html kept serving that skeleton,
// never requested the new file, and every screenshot then died on
// `ReferenceError: VisionMatch is not defined` — which the UI reported as the
// thoroughly misleading "No herbs detected". One file cannot go half-stale.
//
// The code is still pure and still unit-tested without a browser
// (tests/vision-match.test.mjs loads this file in a node:vm); the separation
// is now a section boundary rather than a network dependency.
//
// The problem it solves: OCR of the in-game herb names is noisy — real reads
// include "Cllewel Mist" (Cloud Mist Herb) and "Silverleai BIER" (Silverleaf
// Herb). Three things make that recoverable:
//   1. CLOSED VOCABULARY — exactly 24 plants, known ahead of time.
//   2. RARITY PRIOR — the game tints each tile by rarity and data.js records
//      every plant's rarity, so 24 candidates drop to 3-6 before a single
//      character is compared.
//   3. ONE-TO-ONE — a plant owns one slot, so no two cells in one screenshot
//      may resolve to the same plant.
// ============================================================

(function (root) {
  'use strict';

  // ----------------------------------------------------------
  // 1. NORMALISATION
  // ----------------------------------------------------------

  // Glyph confusions actually observed in reads off these screenshots.
  // Folded in BOTH directions (read and plant name are both normalised
  // through this table), so it can only ever pull a pair closer.
  const CONFUSION = {
    '0': 'o', '1': 'l', '5': 's', '8': 'b', '6': 'b', '2': 'z',
    '|': 'l', '!': 'l', '{': 'c', '[': 'l', ']': 'l', '@': 'a', '$': 's',
  };
  // How much a plant whose rarity disagrees with the tile colour is discounted.
  // Measured: the tile-colour classifier is right on every cell of the fixture
  // set, so this can be aggressive without risking an unreachable plant.
  const OFF_RARITY_PENALTY = 0.55;

  // Digraph folds, applied to BOTH the read and the plant name so the two land
  // in the same canonical shape. A fold is only safe when it does not destroy a
  // distinguishing part of a real name: 'cl'→'d' was removed because the only
  // plant containing "cl" is Cloud Mist Herb, and folding it turned "cloud"
  // into "doud" — mangling exactly the name it was supposed to help.
  const DIGRAPHS = [['rn', 'm'], ['vv', 'w'], ['ii', 'i'], ['ll', 'l'], ['ss', 's']];

  function normalizeName(s) {
    let t = String(s || '').toLowerCase();
    let out = '';
    for (const ch of t) out += CONFUSION[ch] !== undefined ? CONFUSION[ch] : ch;
    out = out.replace(/[^a-z ]+/g, ' ');
    for (const [a, b] of DIGRAPHS) out = out.split(a).join(b);
    return out.replace(/\s+/g, ' ').trim();
  }

  // ----------------------------------------------------------
  // 2. SIMILARITY
  // ----------------------------------------------------------

  function bigrams(s) {
    const t = s.replace(/ /g, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  }

  function dice(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  // Levenshtein on the space-stripped strings, normalised to 0..1.
  // Catches the single-character slips that bigram-Dice under-weights on
  // short names ("Basic Herb" vs "Basil Herb").
  function editSim(a, b) {
    const s = a.replace(/ /g, ''), t = b.replace(/ /g, '');
    if (!s.length || !t.length) return 0;
    if (s === t) return 1;
    let prev = new Array(t.length + 1);
    let cur = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= t.length; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return 1 - prev[t.length] / Math.max(s.length, t.length);
  }

  // Word-level agreement, tolerant of one bad character per word. The game's
  // names are built from a small word stock ("Grass", "Herb", "Spirit"), so a
  // word that survives OCR intact is strong evidence.
  function tokenSim(a, b) {
    const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
    if (!ta.length || !tb.length) return 0;
    let matched = 0;
    const used = new Array(tb.length).fill(false);
    for (const wa of ta) {
      let bestJ = -1, bestS = 0;
      for (let j = 0; j < tb.length; j++) {
        if (used[j]) continue;
        const s = editSim(wa, tb[j]);
        if (s > bestS) { bestS = s; bestJ = j; }
      }
      if (bestJ >= 0 && bestS >= 0.6) { used[bestJ] = true; matched += bestS; }
    }
    return (2 * matched) / (ta.length + tb.length);
  }

  // Ensemble score in 0..1 for one OCR read against one plant name.
  // The three measures fail in different places, so the max of the pair
  // averages is steadier than any one of them alone.
  function similarity(rawRead, plantName) {
    const r = normalizeName(rawRead);
    const n = normalizeName(plantName);
    if (!r || !n) return 0;
    if (r === n) return 1;
    const d = dice(r, n);
    const e = editSim(r, n);
    const t = tokenSim(r, n);
    let s = Math.max((d + e) / 2, (t + Math.max(d, e)) / 2, t);
    // A correctly-read leading word is worth a nudge: it is the part of the
    // name a clipped cell loses first, so having it is real information.
    const fw = n.split(' ')[0];
    if (fw && fw.length > 2 && r.split(' ').some((w) => editSim(w, fw) >= 0.8)) {
      s = Math.min(1, s + 0.06);
    }
    return s;
  }

  // ----------------------------------------------------------
  // 3. RARITY FROM TILE COLOUR
  // ----------------------------------------------------------

  // The inventory tile behind each icon is tinted by rarity. Measured from
  // the fixture screenshots (median of the tile's left/right margins, which
  // the centred icon never covers):
  //   C common    desaturated grey
  //   U uncommon  green   (g highest)
  //   R rare      blue    (b highest, r lowest)
  //   E epic      purple  (g LOWEST — both r and b beat it)
  //   L legendary gold    (b lowest, r highest)
  // Returns null when the sample is too washed out to call, in which case the
  // caller must fall back to the full 24-plant vocabulary.
  function rarityFromTile(r, g, b) {
    if (![r, g, b].every((v) => typeof v === 'number' && isFinite(v))) return null;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;
    if (mx < 30) return null;            // too dark to judge
    if (chroma < 14) return 'C';         // grey tile
    if (chroma < 20) return null;        // ambiguous band — do not guess
    if (g > r && g > b) return 'U';      // green
    if (g > b && r > b) return 'L';      // gold: blue is the minimum
    if (b > g && r > g) return 'E';      // purple: green is the minimum
    if (b > g && g > r) return 'R';      // blue: red is the minimum
    return null;
  }

  // ----------------------------------------------------------
  // 4. ASSIGNMENT
  // ----------------------------------------------------------

  // Score one read against every plant, then apply the rarity prior as a
  // MULTIPLIER rather than a filter.
  //
  // A hard gate plus a "widen if the gate is not paying off" escape hatch was
  // tried first and was worse than no gate at all: the escape hatch fired on
  // most cells and let a Common plant win a Rare slot. A multiplier keeps every
  // plant reachable — a mis-sampled tile can never make one unreachable — while
  // making an out-of-rarity match need to be far better to win.
  function rankCandidates(read, plantRarities, rarity) {
    const penalty = OFF_RARITY_PENALTY;
    return Object.keys(plantRarities)
      .map((name) => {
        const raw = similarity(read, name);
        const ok = !rarity || plantRarities[name] === rarity;
        return { name, score: ok ? raw : raw * penalty, raw, rarityOk: ok };
      })
      .sort((a, b) => b.score - a.score);
  }

  // Assign plants to reads one-to-one, maximising total score.
  // Greedy over globally-sorted pairs, then 2-opt swaps until no swap
  // improves the total. n is at most a screenful of cells (<= 12), so this
  // settles in microseconds and lands on the optimum in practice.
  function assign(reads, plantRarities, opts) {
    const options = opts || {};
    const minScore = options.minScore !== undefined ? options.minScore : 0.20;
    const ranked = reads.map((rd) =>
      rankCandidates(rd.text || '', plantRarities, rd.rarity || null));

    const pairs = [];
    ranked.forEach((list, i) => {
      for (const c of list) if (c.score >= minScore) pairs.push({ i, name: c.name, score: c.score });
    });
    pairs.sort((a, b) => b.score - a.score);

    const chosen = new Array(reads.length).fill(null);
    const taken = new Set();
    for (const p of pairs) {
      if (chosen[p.i] || taken.has(p.name)) continue;
      chosen[p.i] = { name: p.name, score: p.score };
      taken.add(p.name);
    }

    const scoreOf = (i, name) => {
      if (!name) return 0;
      const hit = ranked[i].find((c) => c.name === name);
      return hit ? hit.score : 0;
    };
    // 2-opt: greedy can lock a strong-but-wrong pairing that a swap undoes.
    for (let pass = 0; pass < reads.length; pass++) {
      let improved = false;
      for (let i = 0; i < reads.length; i++) {
        for (let j = i + 1; j < reads.length; j++) {
          const ni = chosen[i] && chosen[i].name, nj = chosen[j] && chosen[j].name;
          if (!ni && !nj) continue;
          const now = scoreOf(i, ni) + scoreOf(j, nj);
          const swapped = scoreOf(i, nj) + scoreOf(j, ni);
          if (swapped > now + 1e-9) {
            chosen[i] = nj ? { name: nj, score: scoreOf(i, nj) } : null;
            chosen[j] = ni ? { name: ni, score: scoreOf(j, ni) } : null;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    return chosen.map((c, i) => ({
      name: c ? c.name : null,
      score: c ? c.score : 0,
      runnerUp: (ranked[i].find((x) => !c || x.name !== c.name) || { name: null, score: 0 }),
      rarityUsed: reads[i].rarity || null,
    }));
  }

  const api = {
    normalizeName, similarity, editSim, dice, tokenSim,
    rarityFromTile, rankCandidates, assign,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VisionMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ============================================================
// PART 2 — IMAGE PIPELINE AND UI (needs a browser)
// ============================================================

// ------------------------------------------------------------
// 1. CONFIG — every tunable in one place, all measured
// ------------------------------------------------------------

const VISION_CFG = {
  // -- cell detection: the grey corner brackets --
  bracketLumaLo: 140,
  bracketLumaHi: 190,
  bucket: 24,              // flood-fill bucket size, px
  minClusterPx: 400,       // ignore specks
  minCellSide: 100,        // ignore fragments
  wideCellSplit: 220,      // clusters wider than this hold more than one cell

  // -- tile top (bounds the rarity-colour sample only) --
  brightGreyLo: 130,
  brightGreyHi: 195,
  brightGreyChroma: 26,    // brackets are grey; coloured tile pixels are not
  bracketRowFrac: 0.10,    // fraction of the row that must be bracket-grey

  // -- badge --
  badgeDarkLuma: 45,       // "solid black glyph" ink test, for locating the band
  badgeDarkMinPx: 6,       // per row
  badgeRunMin: 8,          // rows
  badgeSearchFrom: 0.20,   // fraction of cell height
  badgeSearchTo: 0.75,     // the name's dark outline lives below this
  badgeThr: 40,            // binarisation: luma < thr is ink   [calibrated 24/24]
  badgeScale: 4,
  badgePsm: '7',           // single line
  badgeWhitelist: '0123456789x',
  badgePadPx: 9,

  // -- name --
  nameThr: 150,            // binarisation: luma > thr is ink   [calibrated: mean sim 0.86]
  nameChromaMax: 90,       // drops the coloured "▶" equipped-marker glyph
  nameScale: 3,            // 4x and 6x both read WORSE than 3x, and slower
  namePsm: '6',            // uniform block; names wrap to two lines
  nameWhitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
  nameMinBand: 10,         // px; below this there is no name to read
  nameBrightLuma: 150,     // ink test used to LOCATE the name lines
  nameBrightMinPx: 3,      // per row
  nameRunMin: 2,           // rows, to ignore single-pixel speckle
  nameLineGapMax: 14,      // px between the two lines of a wrapped name
  nameMaxLines: 2,        // herb names wrap to at most two lines
  nameMidMinPx: 2,        // bright ink required in the middle of the row

  quietPx: 20,             // white margin around every crop
  dpi: '300',              // silences Tesseract's 70dpi fallback heuristics

  // -- matching --
  autoAccept: 0.55,        // row arrives ticked at or above this
  showRow: 0.30,           // below this the read is discarded entirely
  maxWorkers: 4,
};

// ------------------------------------------------------------
// 2. STATE
// ------------------------------------------------------------

let visionPool = null;
let visionPoolPromise = null;
let visionBatchActive = false;
let lastVisionApply = null;   // inventory snapshot for Undo

// Bumped whenever the pipeline changes. Rendered into the footer so the
// question "am I actually running the new version?" can be answered by
// looking at the page instead of guessing at a browser cache.
const VISION_VERSION = '4.1';

const VENDOR_BASE = 'vendor/';
const VISION_STATUS_ID = 'vision-status';

// ------------------------------------------------------------
// 3. OCR WORKER POOL
// ------------------------------------------------------------

// Tesseract parameters are per-worker and every change is a round-trip, so a
// worker remembers its current mode and only reconfigures when the mode
// actually changes. Jobs are handed out same-mode-first for the same reason.
const OCR_MODES = {
  badge: {
    tessedit_pageseg_mode: VISION_CFG.badgePsm,
    tessedit_char_whitelist: VISION_CFG.badgeWhitelist,
    user_defined_dpi: VISION_CFG.dpi,
  },
  name: {
    tessedit_pageseg_mode: VISION_CFG.namePsm,
    tessedit_char_whitelist: VISION_CFG.nameWhitelist,
    user_defined_dpi: VISION_CFG.dpi,
    preserve_interword_spaces: '1',
  },
};

function createOcrPool(onStatus) {
  const slots = [];        // { worker, mode, busy }
  const queue = [];        // { mode, canvas, resolve, reject }
  let spawning = 0;

  function targetWorkers() {
    const cores = navigator.hardwareConcurrency || 2;
    // deviceMemory is Chromium-only; when absent, assume there is enough.
    const mem = navigator.deviceMemory;
    const memCap = (mem !== undefined && mem <= 4) ? 2 : VISION_CFG.maxWorkers;
    return Math.max(1, Math.min(VISION_CFG.maxWorkers, memCap, cores));
  }

  async function spawn(isFirst) {
    const T = window.Tesseract;
    if (!T) throw new Error('Tesseract.js failed to load');
    const worker = await T.createWorker('eng', 1, {
      workerPath: VENDOR_BASE + 'worker.min.js',
      corePath: VENDOR_BASE,
      langPath: VENDOR_BASE,
      gzip: false,
      // tesseract.js calls this unconditionally — passing `undefined` throws
      // "m is not a function" inside the worker bootstrap, which killed every
      // worker after the first.
      logger: (m) => {
        if (!isFirst || !onStatus || !m) return;
        if (m.status === 'loading tesseract core') onStatus('Loading OCR core…');
        else if (m.status === 'initializing tesseract') onStatus('Initializing OCR…');
        else if (m.status === 'loading language traineddata') onStatus('Loading herb language data…');
        else if (m.status === 'initializing api') onStatus('OCR ready…');
      },
      errorHandler: (e) => console.error('Vision: OCR worker error', e),
    });
    slots.push({ worker, mode: null, busy: false });
    pump();
  }

  function pump() {
    if (!queue.length) return;
    for (const slot of slots) {
      if (slot.busy || !queue.length) continue;
      // Prefer a job this worker is already configured for.
      let idx = queue.findIndex((j) => j.mode === slot.mode);
      if (idx < 0) idx = 0;
      const job = queue.splice(idx, 1)[0];
      slot.busy = true;
      (async () => {
        try {
          if (slot.mode !== job.mode) {
            await slot.worker.setParameters(OCR_MODES[job.mode]);
            slot.mode = job.mode;
          }
          const { data } = await slot.worker.recognize(job.canvas, {}, { text: true });
          job.resolve(data.text || '');
        } catch (err) {
          slot.mode = null;   // parameter state is now unknown
          job.reject(err);
        } finally {
          slot.busy = false;
          pump();
        }
      })();
    }
  }

  return {
    async boot() { await spawn(true); },
    // Grow in the background. A failure here is not fatal: one worker still
    // finishes the job, just slower.
    grow() {
      const want = targetWorkers();
      for (let i = slots.length + spawning; i < want; i++) {
        spawning++;
        spawn(false)
          .catch((e) => console.warn('Vision: extra OCR worker failed to start', e))
          .finally(() => { spawning--; });
      }
    },
    size: () => slots.length,
    run(mode, canvas) {
      return new Promise((resolve, reject) => {
        queue.push({ mode, canvas, resolve, reject });
        pump();
      });
    },
    async terminate() {
      const all = slots.splice(0, slots.length);
      await Promise.all(all.map((s) => s.worker.terminate().catch(() => {})));
    },
  };
}

// Single-flight: a paste landing during idle warm-up must join the in-flight
// boot, not start a second ~9MB engine load.
async function ensureVisionPool(onProgress) {
  if (visionPool) return visionPool;
  if (visionPoolPromise) return visionPoolPromise;
  visionPoolPromise = (async () => {
    const setStatus = (m) => { if (onProgress) onProgress(m); };
    setStatus('Loading OCR engine…');
    const pool = createOcrPool(setStatus);
    await pool.boot();
    visionPool = pool;
    return pool;
  })();
  visionPoolPromise.catch(() => { visionPoolPromise = null; });
  return visionPoolPromise;
}

// ------------------------------------------------------------
// 4. IMAGE BUFFERS
// ------------------------------------------------------------

// A screenshot is decoded into four full-resolution buffers (RGBA, luma,
// chroma, plus the canvas itself), so an oversized image is the one input that
// can exhaust memory on a phone. Anything past the cap is scaled down — the
// cap is generous enough that a normal phone or 4K desktop screenshot passes
// through untouched, so this is a safety valve and not a quality trade.
const MAX_ANALYSIS_PIXELS = 12e6;

async function capBitmapSize(bitmap) {
  const px = bitmap.width * bitmap.height;
  if (px <= MAX_ANALYSIS_PIXELS) return bitmap;
  const k = Math.sqrt(MAX_ANALYSIS_PIXELS / px);
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  console.warn(`Vision: screenshot is ${bitmap.width}x${bitmap.height}; scaling to ${w}x${h} to stay within memory.`);
  const c = makeCanvas(w, h);
  const cc = c.getContext('2d');
  cc.imageSmoothingEnabled = true;
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return createImageBitmap(c);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// One pass over the pixels produces every per-pixel quantity the rest of the
// pipeline needs. v3 recomputed luma inside nested loops through a closure,
// several times per image.
function imageBuffers(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const luma = new Uint8Array(n);
  const chroma = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    luma[p] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    chroma[p] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { canvas, ctx, rgba, luma, chroma, W, H };
}

// ------------------------------------------------------------
// 5. CELL DETECTION (grey corner brackets → grid)
// ------------------------------------------------------------

function detectCellsFromBuffers(buf) {
  const { luma, W, H } = buf;
  const { bracketLumaLo: LO, bracketLumaHi: HI, bucket: BK } = VISION_CFG;

  const mask = new Uint8Array(W * H);
  for (let p = 0; p < mask.length; p++) mask[p] = (luma[p] >= LO && luma[p] <= HI) ? 1 : 0;

  // Bucket the mask. Only per-bucket counts and bounds are needed, so no
  // per-pixel coordinate arrays are built (v3 pushed two numbers per masked
  // pixel into a Map of arrays — the single biggest allocation in the run).
  const bw = Math.ceil(W / BK), bh = Math.ceil(H / BK);
  const cnt = new Int32Array(bw * bh);
  const bx0 = new Int32Array(bw * bh).fill(W);
  const by0 = new Int32Array(bw * bh).fill(H);
  const bx1 = new Int32Array(bw * bh).fill(-1);
  const by1 = new Int32Array(bw * bh).fill(-1);
  for (let y = 0; y < H; y++) {
    const rowBucket = ((y / BK) | 0) * bw;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!mask[row + x]) continue;
      const b = rowBucket + ((x / BK) | 0);
      cnt[b]++;
      if (x < bx0[b]) bx0[b] = x;
      if (x > bx1[b]) bx1[b] = x;
      if (y < by0[b]) by0[b] = y;
      if (y > by1[b]) by1[b] = y;
    }
  }

  // Flood-fill adjacent non-empty buckets into clusters.
  const seen = new Uint8Array(bw * bh);
  const clusters = [];
  const stack = [];
  for (let b = 0; b < cnt.length; b++) {
    if (!cnt[b] || seen[b]) continue;
    stack.length = 0;
    stack.push(b);
    seen[b] = 1;
    let px = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (stack.length) {
      const k = stack.pop();
      px += cnt[k];
      if (bx0[k] < x0) x0 = bx0[k];
      if (bx1[k] > x1) x1 = bx1[k];
      if (by0[k] < y0) y0 = by0[k];
      if (by1[k] > y1) y1 = by1[k];
      const kx = k % bw, ky = (k / bw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = ky + dy;
        if (ny < 0 || ny >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx;
          if (nx < 0 || nx >= bw) continue;
          const nk = ny * bw + nx;
          if (!seen[nk] && cnt[nk]) { seen[nk] = 1; stack.push(nk); }
        }
      }
    }
    if (px > VISION_CFG.minClusterPx) clusters.push([x0, y0, x1, y1]);
  }

  // Split clusters wide enough to hold two cells, at their emptiest column.
  const cells = [];
  const splitWide = (box) => {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    if (w < VISION_CFG.wideCellSplit) { cells.push(box); return; }
    const colcnt = new Int32Array(w + 1);
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) if (mask[row + x]) colcnt[x - x0]++;
    }
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
      left = [x0, y0, x0 + bs - 8, y1];
      right = [x0 + bs + bl + 8, y0, x1, y1];
    }
    for (const b of [left, right]) if (b[2] - b[0] >= VISION_CFG.minCellSide) splitWide(b);
  };
  for (const c of clusters) {
    if (c[2] - c[0] < VISION_CFG.minCellSide || c[3] - c[1] < VISION_CFG.minCellSide) continue;
    splitWide(c);
  }

  // Reading order, then drop near-duplicates.
  cells.sort((a, b) => ((a[1] / 100) | 0) - ((b[1] / 100) | 0) || a[0] - b[0]);
  const out = [];
  for (const c of cells) {
    if (!out.some((d) => Math.abs(c[0] - d[0]) < 40 && Math.abs(c[1] - d[1]) < 40)) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------
// 6. CELL ZONES (tile bottom, badge band) AND TILE COLOUR
// ------------------------------------------------------------

// Two things have to come out of a cell: WHERE THE BADGE IS and WHERE THE NAME
// LINES ARE. Both are found from ink, working outward from landmarks that
// exist in every cell, and neither depends on locating the tile's bottom edge.
//
// Finding that edge was tried three ways and all three failed on real cells:
// the row median is dragged into tile range by a wide name line, the 25th
// percentile is dragged out of it by dark icon art, and the lower bracket band
// is indistinguishable from the anti-aliased edges of the first name line —
// which silently cropped "Wild Bitter Grass" down to "Grass". The name band is
// therefore located from the BOTTOM UP, by its own ink, which also yields a
// tighter crop than a tile-relative one ever did.
function cellZones(buf, box) {
  const { luma, chroma, W, H } = buf;
  const [x0, y0, x1, y1] = box;
  const xa = Math.max(0, x0 + 8), xb = Math.min(x1 - 8, W);
  const width = Math.max(1, xb - xa);
  const yEnd = Math.min(y1, H - 1);
  const { brightGreyLo: GLO, brightGreyHi: GHI, brightGreyChroma: GC } = VISION_CFG;

  // Per-row ink counts, one pass.
  const rows = yEnd - y0 + 1;
  const dark = new Int32Array(Math.max(0, rows));
  const bright = new Int32Array(Math.max(0, rows));
  const brightMid = new Int32Array(Math.max(0, rows));
  const grey = new Int32Array(Math.max(0, rows));
  // The corner brackets put ink at the two margins and none in between; a line
  // of text always puts ink in the middle. Counting the centre separately is
  // what tells a bracket row from the first line of a name — the distinction
  // three intensity-only rules all failed to make.
  const mid0 = xa + Math.round((xb - xa) * 0.28);
  const mid1 = xb - Math.round((xb - xa) * 0.28);
  for (let y = y0; y <= yEnd; y++) {
    const row = y * W;
    let d = 0, b = 0, bm = 0, g = 0;
    for (let x = xa; x < xb; x++) {
      const p = row + x;
      const l = luma[p];
      if (l < VISION_CFG.badgeDarkLuma) d++;
      else if (l > VISION_CFG.nameBrightLuma) { b++; if (x >= mid0 && x < mid1) bm++; }
      if (l >= GLO && l <= GHI && chroma[p] <= GC) g++;
    }
    dark[y - y0] = d; bright[y - y0] = b; brightMid[y - y0] = bm; grey[y - y0] = g;
  }

  // TILE TOP: the first bracket-grey band. Only used to bound the colour
  // sample, so an imprecise value costs nothing.
  let tileTop = y0;
  for (let i = 0; i < rows; i++) {
    if (grey[i] / width >= VISION_CFG.bracketRowFrac) { tileTop = y0 + i; break; }
  }

  // BADGE: the longest run of solid-black rows in the middle of the cell. The
  // name's dark outline also makes black rows, so the search stops well above
  // the bottom of the box.
  const badgeHi = Math.round(rows * VISION_CFG.badgeSearchTo);
  let best = null, cur = null;
  for (let i = Math.round(rows * VISION_CFG.badgeSearchFrom); i < badgeHi; i++) {
    if (dark[i] >= VISION_CFG.badgeDarkMinPx) {
      if (!cur) cur = [y0 + i, y0 + i]; else cur[1] = y0 + i;
    } else {
      if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur;
      cur = null;
    }
  }
  if (cur && (!best || cur[1] - cur[0] > best[1] - best[0])) best = cur;
  const badge = best && (best[1] - best[0]) >= VISION_CFG.badgeRunMin ? best : null;

  // NAME BAND: bright-ink runs, collected from the bottom of the box upward.
  // A herb name is one or two lines set close together, so runs are joined
  // across small gaps and the climb stops at the first large gap — which is
  // the empty page background between the tile and the name.
  const floor = badge ? (badge[1] - y0 + 3) : Math.round(rows * 0.45);
  const runs = [];
  cur = null;
  for (let i = Math.max(0, floor); i < rows; i++) {
    if (bright[i] >= VISION_CFG.nameBrightMinPx && brightMid[i] >= VISION_CFG.nameMidMinPx) {
      if (!cur) cur = [i, i]; else cur[1] = i;
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);

  let nameBand = null;
  if (runs.length) {
    let lo = runs[runs.length - 1][0];
    let hi = runs[runs.length - 1][1];
    let lines = 1;
    for (let k = runs.length - 2; k >= 0; k--) {
      const gap = lo - runs[k][1];
      if (gap > VISION_CFG.nameLineGapMax || lines >= VISION_CFG.nameMaxLines) break;
      if (runs[k][1] - runs[k][0] < VISION_CFG.nameRunMin) continue;
      lo = runs[k][0];
      lines++;
    }
    const a = Math.max(y0, y0 + lo - 3);
    const b = Math.min(yEnd, y0 + hi + 3);
    if (b - a >= VISION_CFG.nameMinBand) nameBand = [a, b];
  }

  return { tileTop, badge, nameBand };
}

// Median colour of the tile's left and right margins, sampled ABOVE the badge
// where nothing but the rarity tint and the icon's outer air can be. The icon
// is centred, so the margins stay clean.
function tileColour(buf, box, zones) {
  const { rgba, W, H } = buf;
  const [x0, y0, x1, y1] = box;
  let ya = Math.max(0, zones.tileTop + 8);
  let yb = Math.min((zones.badge ? zones.badge[0] - 4 : y0 + Math.round((y1 - y0) * 0.45)), H - 1);
  if (yb - ya < 6) {
    // Badge sitting high, or a tile top that was never found. Fall back to a
    // fixed slice of the upper cell rather than giving up the rarity prior —
    // losing it costs far more than a slightly noisier colour sample.
    ya = Math.max(0, y0 + Math.round((y1 - y0) * 0.10));
    yb = Math.min(y0 + Math.round((y1 - y0) * 0.40), H - 1);
    if (yb - ya < 6) return null;
  }
  const R = [], G = [], B = [];
  for (const [ca, cb] of [[x0 + 8, x0 + 26], [x1 - 26, x1 - 8]]) {
    for (let y = ya; y <= yb; y += 2) {
      for (let x = Math.max(0, ca); x < Math.min(cb, W); x++) {
        const i = (y * W + x) * 4;
        R.push(rgba[i]); G.push(rgba[i + 1]); B.push(rgba[i + 2]);
      }
    }
  }
  if (R.length < 20) return null;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(R), med(G), med(B)];
}

// ------------------------------------------------------------
// 7. CROPS
// ------------------------------------------------------------

// Upscale first (smooth), threshold second. The other order — which v3 used —
// blurs an already-binary image and leaves grey haloes that Tesseract reads as
// extra strokes.
function binarizedCrop(buf, sx, sy, sw, sh, opts) {
  const { thr, bright, chromaMax, scale } = opts;
  const W = Math.max(1, Math.round(sw * scale));
  const H = Math.max(1, Math.round(sh * scale));
  const q = VISION_CFG.quietPx;
  const out = makeCanvas(W + q * 2, H + q * 2);
  const oc = out.getContext('2d', { willReadFrequently: true });
  oc.fillStyle = '#fff';
  oc.fillRect(0, 0, out.width, out.height);
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(buf.canvas, sx, sy, sw, sh, q, q, W, H);

  const im = oc.getImageData(q, q, W, H);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = bright ? l > thr : l < thr;
    if (ink && chromaMax !== undefined && (Math.max(r, g, b) - Math.min(r, g, b)) > chromaMax) ink = false;
    const v = ink ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  oc.putImageData(im, q, q);
  return out;
}

// Horizontal extent of the ink in a band, so a crop excludes the tile's side
// borders (which otherwise read as stray '1' and '|' strokes).
function inkColumns(buf, box, ya, yb, thr, bright) {
  const { luma, W, H } = buf;
  const [x0, , x1] = box;
  let a = x1, b = x0;
  for (let y = Math.max(0, ya); y <= Math.min(yb, H - 1); y++) {
    const row = y * W;
    for (let x = Math.max(0, x0 + 3); x < Math.min(x1 - 3, W); x++) {
      const l = luma[row + x];
      if (bright ? l > thr : l < thr) { if (x < a) a = x; if (x > b) b = x; }
    }
  }
  return b > a ? [a, b] : [Math.max(0, x0 + 3), Math.min(x1 - 3, W - 1)];
}

// ------------------------------------------------------------
// 8. QUANTITY PARSE
// ------------------------------------------------------------

// With a digit whitelist in force Tesseract can only emit [0-9x], so v3's
// fixup tables (I→1, O→6, doubled-glyph collapse, bracket-pipe stripping) are
// all gone: they existed to undo damage that is no longer done.
function parseQty(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  // Match the WHOLE digit run, never a bounded slice of it: /\d{1,4}/ against a
  // garbled "x99999" happily returns 9999, turning an obviously broken read
  // into a plausible-looking count that would be written straight into the
  // inventory. A run that long is nonsense and must be rejected outright.
  const anchored = t.match(/x\s*(\d+)/);
  const digits = anchored ? anchored[1] : (t.match(/\d+/) || [])[0];
  if (!digits || digits.length > 4) return null;
  const n = parseInt(digits, 10);
  return (n > 0 && n <= 9999) ? n : null;
}

// ------------------------------------------------------------
// 9. PER-IMAGE ANALYSIS
// ------------------------------------------------------------

function thumbnail(buf, box, maxW) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const s = Math.min(1, maxW / w);
  const c = makeCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const cc = c.getContext('2d');
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(buf.canvas, x0, y0, w, h, 0, 0, c.width, c.height);
  try { return c.toDataURL('image/jpeg', 0.6); } catch (e) { return null; }
}

function plantRarityMap() {
  const out = {};
  for (const [name, meta] of Object.entries(PLANTS)) out[name] = meta.rarity;
  return out;
}

async function analyzeImage(pool, bitmap, opts) {
  const options = opts || {};
  const buf = imageBuffers(bitmap);
  const cells = detectCellsFromBuffers(buf);

  // Geometry and crops for every cell first, so all OCR jobs can be queued at
  // once and the worker pool stays saturated.
  const prepared = cells.map((box) => {
    const zones = cellZones(buf, box);
    const rgb = tileColour(buf, box, zones);
    const rarity = rgb ? VisionMatch.rarityFromTile(rgb[0], rgb[1], rgb[2]) : null;

    let badgeCanvas = null;
    if (zones.badge) {
      const [ba, bb] = zones.badge;
      const [ia, ib] = inkColumns(buf, box, ba, bb, VISION_CFG.badgeThr, false);
      const p = VISION_CFG.badgePadPx;
      const sx = Math.max(0, ia - p), sy = Math.max(0, ba - p);
      const sw = Math.min(buf.W - sx, (ib - ia) + p * 2);
      const sh = Math.min(buf.H - sy, (bb - ba) + p * 2);
      if (sw > 8 && sh > 6) {
        badgeCanvas = binarizedCrop(buf, sx, sy, sw, sh,
          { thr: VISION_CFG.badgeThr, bright: false, scale: VISION_CFG.badgeScale });
      }
    }

    let nameCanvas = null;
    if (zones.nameBand && box[2] - box[0] >= 60) {
      const [na, nb] = zones.nameBand;
      const nx = Math.max(0, box[0] + 2);
      const nw = Math.min(buf.W - nx, (box[2] - box[0]) - 4);
      if (nw > 20) {
        nameCanvas = binarizedCrop(buf, nx, na, nw, nb - na, {
          thr: VISION_CFG.nameThr, bright: true,
          chromaMax: VISION_CFG.nameChromaMax, scale: VISION_CFG.nameScale,
        });
      }
    }

    return { box, zones, rgb, rarity, badgeCanvas, nameCanvas };
  });

  // Two OCR calls per cell, all in flight together across the pool.
  // A REJECTED job and a genuinely blank read must never look the same — that
  // is how a pool of dead workers reports itself as "no herbs found". Errors
  // are counted and re-thrown to the caller if every single job failed.
  let ocrErrors = 0;
  const guard = (promise) => promise.catch((e) => {
    ocrErrors++;
    console.error('Vision: OCR job failed', e);
    return '';
  });
  const results = await Promise.all(prepared.map((p) => Promise.all([
    p.nameCanvas ? guard(pool.run('name', p.nameCanvas)) : Promise.resolve(''),
    p.badgeCanvas ? guard(pool.run('badge', p.badgeCanvas)) : Promise.resolve(''),
  ])));
  const attempted = prepared.reduce((n, p) => n + (p.nameCanvas ? 1 : 0) + (p.badgeCanvas ? 1 : 0), 0);
  if (attempted > 0 && ocrErrors === attempted) {
    throw new Error(`every OCR job failed (${ocrErrors}/${attempted}) — the engine is not usable`);
  }

  // Resolve all names together: one plant per slot, rarity-gated.
  const reads = prepared.map((p, i) => ({
    text: (results[i][0] || '').replace(/\s+/g, ' ').trim(),
    rarity: p.rarity,
  }));
  const assigned = VisionMatch.assign(reads, plantRarityMap(), { minScore: VISION_CFG.showRow });

  return prepared.map((p, i) => ({
    box: p.box,
    rarity: p.rarity,
    tileRgb: p.rgb,
    rawName: reads[i].text,
    rawQty: (results[i][1] || '').trim(),
    name: assigned[i].name,
    nameScore: assigned[i].score,
    runnerUp: assigned[i].runnerUp,
    qty: parseQty(results[i][1]),
    thumb: options.thumbs ? thumbnail(buf, p.box, 84) : null,
    ocrErrors,
  }));
}

// ------------------------------------------------------------
// 10. BATCH ANALYSIS
// ------------------------------------------------------------

// Analysis only — no DOM overlay, no inventory writes — so the OCR benchmark
// (tests/ocr-bench.mjs) can measure the real pipeline without driving the UI.
async function analyzeFiles(list, onStatus, opts) {
  const options = opts || {};
  const setStatus = (m) => { if (onStatus) onStatus(m); };
  const pool = await ensureVisionPool(setStatus);
  pool.grow();

  const agg = new Map();
  const perImage = [];
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    const n = i + 1;
    const detail = { file: list[i].name || `image-${n}`, cells: 0, items: [] };
    perImage.push(detail);
    let bitmap = null;
    try {
      setStatus(list.length > 1 ? `Reading screenshot ${n} of ${list.length}…` : 'Reading screenshot…');
      bitmap = await createImageBitmap(list[i]);
      bitmap = await capBitmapSize(bitmap);
      const items = await analyzeImage(pool, bitmap, options);
      detail.cells = items.length;
      detail.items = items;

      for (const it of items) {
        if (!it.name || it.nameScore < VISION_CFG.showRow) continue;
        const cur = agg.get(it.name)
          || { qty: null, conflict: false, score: 0, seen: 0, thumb: null, rarity: null };
        cur.seen++;
        cur.score = Math.max(cur.score, it.nameScore);
        if (!cur.thumb) cur.thumb = it.thumb;
        if (!cur.rarity) cur.rarity = it.rarity;
        if (it.qty !== null) {
          // A plant occupies ONE inventory stack. Seeing it in two overlapping
          // screenshots is the same stack twice, not two stacks — v3 summed
          // them and silently doubled the count of every herb caught in an
          // overlap. Keep the larger read and flag the disagreement.
          if (cur.qty !== null && cur.qty !== it.qty) cur.conflict = true;
          cur.qty = cur.qty === null ? it.qty : Math.max(cur.qty, it.qty);
        }
        agg.set(it.name, cur);
      }
      setStatus(list.length > 1
        ? `Read screenshot ${n} of ${list.length} — ${items.filter((x) => x.name).length}/${items.length} items`
        : `Read ${items.filter((x) => x.name).length} of ${items.length} items`);
    } catch (err) {
      failed++;
      detail.error = String((err && err.message) || err);
      console.error(`Vision import failed for image ${n} of ${list.length}:`, err);
      setStatus(`⚠️ Screenshot ${n} of ${list.length} failed — continuing…`);
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
    }
  }

  const rows = [...agg.entries()].map(([name, v]) => ({
    name,
    nameScore: v.score,
    qty: v.qty,
    conflict: v.conflict,
    seen: v.seen,
    rarity: v.rarity,
    thumb: v.thumb,
  })).sort((a, b) => b.nameScore - a.nameScore);

  const errorText = perImage.map((d) => d.error).filter(Boolean)[0] || null;
  return { rows, perImage, failed, error: errorText };
}

// ------------------------------------------------------------
// 11. CONFIRM OVERLAY
// ------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function showVisionConfirm(inputRows, diagnostic) {
  return new Promise((resolve) => {
    // Anything needing a human decision goes to the TOP, so the dialog opens on
    // the work rather than opening scrolled to it. Within each group, plain
    // alphabetical order — predictable to scan, unlike confidence order.
    const needsEye = (r) => r.nameScore < VISION_CFG.autoAccept || r.qty === null || r.conflict;
    const rows = inputRows.slice().sort((a, b) =>
      (needsEye(b) ? 1 : 0) - (needsEye(a) ? 1 : 0) || a.name.localeCompare(b.name));
    const flagged = rows.filter(needsEye).length;

    // In Replace mode the herbs that were NOT in these screenshots keep their
    // old counts. That is the right behaviour, but it is invisible — a player
    // who screenshots half their inventory has no way to tell which half is
    // now stale unless we say so.
    const seen = new Set(rows.map((r) => r.name));
    const untouched = Object.keys(PLANTS).filter((n) => !seen.has(n) && getQty(n) > 0);

    const overlay = document.createElement('div');
    overlay.className = 'vision-overlay';

    const body = rows.map((r, i) => {
      const auto = r.nameScore >= VISION_CFG.autoAccept;
      const noQty = r.qty === null;
      const warn = noQty ? '⚠️ no number found' : (r.conflict ? '⚠️ screenshots disagreed' : '');
      const thumb = r.thumb
        ? `<img class="vision-thumb" src="${r.thumb}" alt="">`
        : '<span class="vision-thumb vision-thumb-empty">?</span>';
      return `
        <div class="vision-row ${auto ? '' : 'vision-uncertain'}">
          <input type="checkbox" class="vision-check" id="vchk-${i}" ${auto ? 'checked' : ''}>
          ${thumb}
          <label for="vchk-${i}" class="vision-name">${escapeHtml(r.name)}${
        auto ? '' : ' <span class="vision-guess">— best guess, confirm it</span>'}</label>
          <input type="number" class="vision-qty ${noQty || r.conflict ? 'vision-flag' : ''}" min="0"
                 value="${r.qty === null ? '' : r.qty}" data-plant="${escapeHtml(r.name)}"
                 placeholder="${noQty ? '?' : ''}"
                 title="${escapeHtml(warn || 'Read from the screenshot')}">
          <span class="vision-score">${escapeHtml(warn)}</span>
        </div>`;
    }).join('');

    // A crash and a genuinely unreadable screenshot are completely different
    // problems and must never render the same sentence. The old build showed
    // "No herbs detected" for both, which sent players hunting for a better
    // screenshot when the real answer was a stale page in the browser cache.
    const empty = diagnostic
      ? `<div class="no-results vision-error">
          <b>The autofill crashed — this is not your screenshot's fault.</b>
          <div class="vision-error-detail">${escapeHtml(diagnostic)}</div>
          <div class="vision-error-fix">
            Most often this is an out-of-date page held in the browser cache.
            <b>Hard-refresh</b> and try again:
            <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on a Mac,
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on Windows.
            If it keeps happening, open the browser console and send the red text.
          </div>
        </div>`
      : `<div class="no-results">
          No herbs detected. The autofill looks for the inventory grid — tiles with
          grey corner brackets, an <b>xNN</b> badge and the herb name underneath.
          Crop to that grid and try again.
        </div>`;

    overlay.innerHTML = `
      <div class="vision-modal" role="dialog" aria-modal="true" aria-label="Review detected herbs">
        <div class="vision-modal-header">
          <span>📸 ${rows.length} herb${rows.length === 1 ? '' : 's'} detected${
        flagged ? ` — ${flagged} need${flagged === 1 ? 's' : ''} a look` : ' — all confident'}</span>
          <button class="btn vision-close" aria-label="Close">×</button>
        </div>
        ${rows.length ? `<div class="vision-modal-tools">
          <button class="btn vision-mini" id="vision-all" type="button">Select all</button>
          <button class="btn vision-mini" id="vision-none" type="button">Select none</button>
          <label class="vision-mode" title="Replace overwrites each herb's count; Add sums it with what you already have.">
            <input type="radio" name="vision-mode" value="replace" checked> Replace
          </label>
          <label class="vision-mode">
            <input type="radio" name="vision-mode" value="add"> Add to current
          </label>
        </div>` : ''}
        <div class="vision-rows">${body || empty}</div>
        ${untouched.length ? `<div class="vision-untouched">
          ${untouched.length} herb${untouched.length === 1 ? '' : 's'} in your inventory
          ${untouched.length === 1 ? 'was' : 'were'} not in these screenshots and
          ${untouched.length === 1 ? 'keeps its' : 'keep their'} current count:
          ${escapeHtml(untouched.slice(0, 6).join(', '))}${untouched.length > 6 ? ` +${untouched.length - 6} more` : ''}.
        </div>` : ''}
        <div class="vision-modal-actions">
          <span class="vision-hint">${rows.length ? 'Enter to apply · Esc to cancel' : ''}</span>
          <button class="btn" id="vision-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="vision-apply" type="button" ${rows.length ? '' : 'disabled'}>Apply to Inventory</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const apply = () => {
      const modeEl = overlay.querySelector('input[name="vision-mode"]:checked');
      const mode = modeEl ? modeEl.value : 'replace';
      const quantities = {};
      overlay.querySelectorAll('.vision-row').forEach((row) => {
        const chk = row.querySelector('.vision-check');
        const qtyEl = row.querySelector('.vision-qty');
        if (chk && chk.checked && qtyEl.value !== '') {
          quantities[qtyEl.dataset.plant] = Math.max(0, parseInt(qtyEl.value, 10) || 0);
        }
      });
      close({ quantities, mode });
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && rows.length && e.target.tagName !== 'BUTTON') { e.preventDefault(); apply(); }
    }
    document.addEventListener('keydown', onKey, true);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.querySelector('.vision-close').onclick = () => close(null);
    overlay.querySelector('#vision-cancel').onclick = () => close(null);
    overlay.querySelector('#vision-apply').onclick = apply;
    const setAll = (v) => overlay.querySelectorAll('.vision-check').forEach((c) => { c.checked = v; });
    const allBtn = overlay.querySelector('#vision-all');
    const noneBtn = overlay.querySelector('#vision-none');
    if (allBtn) allBtn.onclick = () => setAll(true);
    if (noneBtn) noneBtn.onclick = () => setAll(false);

    // Focus the Apply button, never a number input: focusing an input scrolls
    // the list away from the top AND opens the on-screen keyboard on a phone,
    // covering the very rows the player was asked to check.
    const applyBtn = overlay.querySelector('#vision-apply');
    if (applyBtn) applyBtn.focus({ preventScroll: true });
  });
}

// ------------------------------------------------------------
// 12. MAIN ENTRY
// ------------------------------------------------------------

// ui.js owns the inventory; read through it defensively so vision.js never
// depends on script load order.
function getQty(name) {
  try {
    return (typeof inventoryState === 'object' && inventoryState) ? (inventoryState[name] || 0) : 0;
  } catch (e) {
    return 0;
  }
}

function showVisionUndo(count) {
  const statusEl = document.getElementById(VISION_STATUS_ID);
  if (!statusEl || !lastVisionApply) return;
  const snapshot = lastVisionApply;
  const btn = document.createElement('button');
  btn.className = 'btn vision-mini vision-undo';
  btn.type = 'button';
  btn.textContent = `↩ Undo (${count})`;
  btn.onclick = () => {
    for (const [name, qty] of Object.entries(snapshot)) setQty(name, qty);
    if (lastVisionApply === snapshot) lastVisionApply = null;
    btn.remove();
    statusEl.textContent = 'Reverted — inventory is back to what it was.';
  };
  statusEl.appendChild(document.createTextNode(' '));
  statusEl.appendChild(btn);
}

async function runVisionImport(files) {
  if (visionBatchActive) return;
  visionBatchActive = true;

  const statusEl = document.getElementById(VISION_STATUS_ID);
  const btn = document.getElementById('btn-vision');
  const setStatus = (m) => { if (statusEl) statusEl.textContent = m; };
  try {
    if (btn) { btn.disabled = true; btn.textContent = '📸 Reading…'; }
    setStatus('Warming up OCR…');

    const list = Array.from(files || []).filter((f) => f && /^image\//.test(f.type || ''));
    if (!list.length) { setStatus('That was not an image — paste or pick a screenshot.'); return; }

    const t0 = performance.now();
    const { rows, failed, error } = await analyzeFiles(list, setStatus, { thumbs: true });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    const sure = rows.filter((r) => r.nameScore >= VISION_CFG.autoAccept).length;
    if (failed && !rows.length) setStatus(`❌ The autofill crashed: ${error || 'unknown error'}`);
    else if (failed) setStatus(`Read ${list.length - failed} of ${list.length} screenshots (${failed} failed) — review below.`);
    else if (rows.length) setStatus(`Found ${rows.length} herb type(s) in ${secs}s — ${sure} confident, ${rows.length - sure} to confirm.`);
    else setStatus('No herbs detected — check the screenshots show the inventory grid.');

    const result = await showVisionConfirm(rows, (failed && !rows.length) ? (error || 'unknown error') : null);
    if (result && Object.keys(result.quantities).length) {
      const before = {};
      for (const name of Object.keys(result.quantities)) before[name] = getQty(name);
      for (const [name, qty] of Object.entries(result.quantities)) {
        setQty(name, result.mode === 'add' ? getQty(name) + qty : qty);
      }
      lastVisionApply = before;
      const count = Object.keys(result.quantities).length;
      if (window.AudioController) window.AudioController.playDone();
      setStatus(`Applied ${count} herb type(s).`);
      showVisionUndo(count);
    }
  } catch (err) {
    console.error('Vision import failed:', err);
    setStatus('❌ OCR failed: ' + ((err && err.message) || err));
  } finally {
    visionBatchActive = false;
    if (btn) { btn.disabled = false; btn.textContent = '📸 Autofill from Screenshot'; }
  }
}

// ------------------------------------------------------------
// 13. WARM-UP AND WIRING
// ------------------------------------------------------------

function warmUpVision() {
  if ((navigator.connection || {}).saveData) return;
  const statusEl = document.getElementById(VISION_STATUS_ID);
  if (statusEl) statusEl.textContent = '⏳ Pre-loading OCR engine…';
  ensureVisionPool((msg) => { if (statusEl) statusEl.textContent = `⏳ ${msg}`; })
    .then(() => {
      if (statusEl) statusEl.textContent = '✅ OCR ready — paste a screenshot anytime';
      setTimeout(() => {
        if (statusEl && /OCR ready/.test(statusEl.textContent)) statusEl.textContent = '';
      }, 4000);
    })
    .catch((err) => {
      console.warn('Vision warmup failed (will retry on first paste):', err);
      if (statusEl) statusEl.textContent = '';
    });
}

// Everything vision.js needs from the rest of the page. If the browser is
// serving a half-stale set of files, saying so at startup beats letting the
// first screenshot die with a misleading message.
function checkVisionDependencies() {
  const missing = [];
  if (typeof window.Tesseract === 'undefined') missing.push('vendor/tesseract.min.js');
  if (typeof PLANTS === 'undefined') missing.push('js/data.js');
  if (typeof setQty !== 'function') missing.push('js/ui.js');
  return missing;
}

function stampVisionVersion() {
  const footer = document.querySelector('.footer-credits');
  if (!footer || document.getElementById('vision-version')) return;
  const el = document.createElement('div');
  el.id = 'vision-version';
  el.className = 'vision-version';
  el.textContent = `Screenshot autofill v${VISION_VERSION}`;
  el.title = 'If this number is not the one you expect, the browser is serving a cached page — hard-refresh.';
  footer.parentNode.insertBefore(el, footer.nextSibling);
}

function initVision() {
  const input = document.getElementById('vision-file-input');
  const btn = document.getElementById('btn-vision');
  if (!input || !btn) return;

  stampVisionVersion();
  const missing = checkVisionDependencies();
  if (missing.length) {
    const statusEl = document.getElementById(VISION_STATUS_ID);
    const msg = `⚠️ The page is missing ${missing.join(', ')} — hard-refresh (Cmd/Ctrl+Shift+R).`;
    if (statusEl) statusEl.textContent = msg;
    console.error('Vision:', msg);
  }

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
    if (pasted.length) { e.preventDefault(); runVisionImport(pasted); }
  });

  // Drag and drop anywhere on the page — the natural gesture for a screenshot
  // sitting on the desktop, and the one the app was missing.
  let dragDepth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('vision-dragging');
  });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('vision-dragging'); }
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('vision-dragging');
    if (e.dataTransfer.files && e.dataTransfer.files.length) runVisionImport(e.dataTransfer.files);
  });

  const startWarmup = () => { if (!visionPool) warmUpVision(); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(startWarmup, { timeout: 3000 });
  else setTimeout(startWarmup, 2000);
}

// Test seam: tests/ocr-bench.mjs drives the real pipeline through this.
window.Vision = {
  analyzeFiles, runVisionImport, showVisionConfirm, parseQty, CFG: VISION_CFG,
  _internals: {
    imageBuffers, detectCellsFromBuffers, cellZones, tileColour,
    binarizedCrop, inkColumns, analyzeImage, ensureVisionPool, plantRarityMap,
  },
};
