// ============================================================
// VISION-MATCH.JS — pure matching logic for the screenshot autofill.
//
// No DOM, no canvas, no OCR. Everything here is a pure function of its
// arguments, so it is unit-testable in Node (tests/vision-match.test.mjs)
// without a browser. The image side lives in vision.js.
//
// The problem this file solves: OCR of the in-game herb names is noisy —
// real reads from real screenshots include "Vid Sofie" (Wild Spirit Grass),
// "Clannal Mier" (Cloud Mist Herb) and "Silvenie ig" (Silverleaf Herb).
// Three things make that recoverable:
//
//   1. CLOSED VOCABULARY. There are exactly 24 plants, known ahead of time.
//   2. RARITY PRIOR. The game tints each inventory tile by rarity, and
//      data.js already records every plant's rarity. Reading the tile colour
//      narrows 24 candidates to 3-6 before a single character is compared.
//   3. ONE-TO-ONE. A plant occupies exactly one slot, so within a single
//      screenshot no two cells may resolve to the same plant.
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
