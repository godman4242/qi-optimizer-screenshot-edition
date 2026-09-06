// ============================================================
// tests/vision-match.test.mjs — unit tests for the OCR matching logic.
// Node built-in test runner, no npm deps.
//
// The strings in here are REAL OCR reads captured from the fixture
// screenshots by `node tests/ocr-bench.mjs --diag`. They are the regression
// surface: if the matcher stops recognising these, the autofill has broken
// for the screenshots we know a real player takes.
//
//   node --test tests/
// ============================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(__dirname, '..', 'js');

// vision-match.js is a plain <script> that attaches to the global object, and
// vision.js is the same but also touches window/document/navigator when it
// runs. Both are loaded into one sandbox with just enough of a browser for
// their top level.
const sandbox = { console, performance, setTimeout, clearTimeout, requestIdleCallback: undefined };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.navigator = { hardwareConcurrency: 4 };
sandbox.document = { getElementById: () => null, createElement: () => ({ getContext: () => null }), addEventListener: () => {} };
vm.createContext(sandbox);
for (const f of ['data.js', 'vision-match.js', 'vision.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sandbox, { filename: f });
}
// Top-level `const` in a classic script lands in the context's global LEXICAL
// scope, not on the sandbox object — so PLANTS has to be read back by
// evaluating its name inside the context, exactly as run-tests.js does.
const grab = (expr) => vm.runInContext(expr, sandbox);
const VM = grab('VisionMatch');
const parseQty = grab('Vision').parseQty;
const CFG = grab('Vision').CFG;
const PLANTS = grab('PLANTS');
const rarities = Object.fromEntries(Object.entries(PLANTS).map(([n, m]) => [n, m.rarity]));

describe('normalizeName', () => {
  test('folds the glyph confusions the badge/name fonts actually produce', () => {
    // Digits fold to their letter lookalikes and doubled letters collapse, so
    // both sides of a comparison land in the same shape. The output is a
    // canonical form, not English: '1'→'l', then 'll'→'l'.
    assert.equal(VM.normalizeName('W1ld B1tter Grass'), 'wld bltter gras');
    assert.equal(VM.normalizeName('Wild Bitter Grass'), 'wild bitter gras');
    // ...and the fold is symmetric, which is the property that matters.
    assert.equal(VM.normalizeName('Cloud Mist Herb'), 'cloud mist herb');
    assert.equal(VM.normalizeName('Herb!'), 'herbl');
    assert.equal(VM.normalizeName('  Basic   Herb  '), 'basic herb');
  });
  test('a digit-for-letter slip still matches the right plant', () => {
    assert.ok(VM.similarity('W1ld B1tter Grass', 'Wild Bitter Grass') > 0.8);
  });
  test('is total — never throws on junk, null or undefined', () => {
    for (const v of [null, undefined, '', '   ', '@@@ ###', 12345]) {
      assert.equal(typeof VM.normalizeName(v), 'string');
    }
  });
});

describe('similarity', () => {
  test('an exact name scores 1', () => {
    assert.equal(VM.similarity('Wild Bitter Grass', 'Wild Bitter Grass'), 1);
  });
  test('is bounded to 0..1 for every plant pair and for junk', () => {
    const names = Object.keys(PLANTS);
    for (const a of names) {
      for (const b of names) {
        const s = VM.similarity(a, b);
        assert.ok(s >= 0 && s <= 1, `${a} vs ${b} = ${s}`);
      }
      assert.ok(VM.similarity('', a) >= 0);
      assert.ok(VM.similarity('#$%^&*', a) <= 1);
    }
  });
  test('every plant is its own best match against all 24', () => {
    const names = Object.keys(PLANTS);
    for (const truth of names) {
      let best = null, bestScore = -1;
      for (const cand of names) {
        const s = VM.similarity(truth, cand);
        if (s > bestScore) { bestScore = s; best = cand; }
      }
      assert.equal(best, truth, `"${truth}" matched "${best}" better than itself`);
    }
  });

  // Real reads, from `node tests/ocr-bench.mjs --diag`.
  const REAL_READS = [
    ['Dandelion of Qf', 'Dandelion of Qi'],
    ['Flame Mushroom', 'Crimson Flame Mushroom'],
    ['Heavenly Spirit Vine', 'Heavenly Spirit Vine'],
    ['Red Ginsen', 'Red Ginseng'],
    ['Willd Spirit', 'Wild Spirit Grass'],
    ['Cllewel Mist', 'Cloud Mist Herb'],
    ['Spirit Grass', 'Common Spirit Grass'],
    ['Mountain Green Her', 'Mountain Green Herb'],
    ['Moonlight Jada Leaf', 'Moonlight Jade Leaf'],
    ['Spirit Spring Herb', 'Spirit Spring Herb'],
    ['Healing SUnOWeER', 'Healing Sunflower'],
    ['Bitter Jads Grass', 'Bitter Jade Grass'],
    ['Black rem Roof', 'Black Iron Root'],
    ['Blue Wawa Coral Blears', 'Blue Wave Coral Herb'],
    ['Basic Remy', 'Basic Herb'],
    ['Nine Suns Flame Grass', 'Nine Suns Flame Grass'],
    ['Wild Bitter Grass', 'Wild Bitter Grass'],
    ['Silverleai BIER', 'Silverleaf Herb'],
    ['ARE Sempent Grass', 'Azure Serpent Grass'],
    ['P uipllel Bightning Ordifial', 'Purple Lightning Orchid'],
    ['Starlight Dew Herb', 'Starlight Dew Herb'],
    ['Seven Star Flower', 'Seven Star Flower'],
    ['Irombene Grass', 'Ironbone Grass'],
    ['Thousand Year', 'Thousand Year Lotus'],
  ];

  test('every real OCR read still ranks its true plant first, rarity-gated', () => {
    const wrong = [];
    for (const [read, truth] of REAL_READS) {
      const ranked = VM.rankCandidates(read, rarities, PLANTS[truth].rarity);
      if (ranked[0].name !== truth) wrong.push(`"${read}" → ${ranked[0].name}, expected ${truth}`);
    }
    assert.equal(wrong.length, 0, `matcher regressed on real reads:\n  ${wrong.join('\n  ')}`);
  });

  test('at least 20 of the 24 real reads clear the auto-accept bar', () => {
    const auto = CFG.autoAccept;
    const cleared = REAL_READS.filter(([read, truth]) =>
      VM.rankCandidates(read, rarities, PLANTS[truth].rarity)[0].score >= auto).length;
    assert.ok(cleared >= 20, `only ${cleared}/24 cleared ${auto}`);
  });
});

describe('rarityFromTile', () => {
  // Median tile colours measured off the fixture screenshots.
  const MEASURED = [
    [[108, 104, 101], 'C', 'Dandelion of Qi, grey tile'],
    [[74, 97, 72], 'U', 'Red Ginseng, green tile'],
    [[70, 77, 98], 'R', 'Cloud Mist Herb, blue tile'],
    [[92, 72, 101], 'E', 'Crimson Flame Mushroom, purple tile'],
    [[132, 120, 69], 'L', 'Heavenly Spirit Vine, gold tile'],
    [[88, 107, 76], 'U', 'Wild Bitter Grass'],
    [[80, 64, 99], 'E', 'Black Iron Root'],
    [[82, 87, 104], 'R', 'Bitter Jade Grass'],
    [[127, 116, 68], 'L', 'Starlight Dew Herb'],
    [[99, 97, 98], 'C', 'Basic Herb'],
  ];
  for (const [rgb, expected, label] of MEASURED) {
    test(`${label} → ${expected}`, () => {
      assert.equal(VM.rarityFromTile(rgb[0], rgb[1], rgb[2]), expected);
    });
  }
  test('refuses to guess on garbage rather than inventing a rarity', () => {
    assert.equal(VM.rarityFromTile(2, 3, 4), null);          // too dark
    assert.equal(VM.rarityFromTile(NaN, 10, 10), null);
    assert.equal(VM.rarityFromTile(undefined, 1, 2), null);
  });
});

describe('assign', () => {
  test('never gives two cells in one screenshot the same plant', () => {
    const reads = [
      { text: 'Grass', rarity: 'U' },
      { text: 'Grass', rarity: 'U' },
      { text: 'Grass', rarity: 'U' },
    ];
    const out = VM.assign(reads, rarities, { minScore: 0.1 });
    const names = out.map((o) => o.name).filter(Boolean);
    assert.equal(new Set(names).size, names.length, `duplicate assignment: ${names}`);
  });

  test('resolves a whole real screenshot correctly (inv-04)', () => {
    const reads = [
      { text: 'Wild Bitter Grass', rarity: 'U' },
      { text: 'Silverleai BIER', rarity: 'E' },
      { text: 'ARE Sempent Grass', rarity: 'E' },
      { text: 'P uipllel Bightning Ordifial', rarity: 'E' },
      { text: 'Starlight Dew Herb', rarity: 'L' },
      { text: 'Seven Star Flower', rarity: 'R' },
    ];
    const expected = ['Wild Bitter Grass', 'Silverleaf Herb', 'Azure Serpent Grass',
      'Purple Lightning Orchid', 'Starlight Dew Herb', 'Seven Star Flower'];
    // JSON round-trip: values crossing out of the vm realm carry that realm's
    // prototypes, which deepStrictEqual rejects even when the contents match.
    assert.deepEqual(JSON.parse(JSON.stringify(VM.assign(reads, rarities).map((o) => o.name))), expected);
  });

  test('the rarity prior decides a read that is otherwise ambiguous', () => {
    // "Grass" alone matches many plants. The tile colour is the tie-breaker.
    const asU = VM.assign([{ text: 'Grass', rarity: 'U' }], rarities)[0].name;
    const asR = VM.assign([{ text: 'Grass', rarity: 'R' }], rarities)[0].name;
    assert.equal(rarities[asU], 'U');
    assert.equal(rarities[asR], 'R');
    assert.notEqual(asU, asR);
  });

  test('a wrong rarity is a penalty, not a ban — a clear read still wins', () => {
    // Tile colour misread as Common; the name is unmistakably a Legendary.
    const out = VM.assign([{ text: 'Thousand Year Lotus', rarity: 'C' }], rarities)[0];
    assert.equal(out.name, 'Thousand Year Lotus');
  });

  test('an unreadable cell is left unassigned rather than guessed', () => {
    const out = VM.assign([{ text: '', rarity: 'U' }], rarities, { minScore: 0.3 })[0];
    assert.equal(out.name, null);
    assert.equal(out.score, 0);
  });

  test('handles zero reads without throwing', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(VM.assign([], rarities))), []);
  });
});

describe('parseQty', () => {
  test('reads the badge formats the digit whitelist can produce', () => {
    assert.equal(parseQty('x51'), 51);
    assert.equal(parseQty('X51'), 51);
    assert.equal(parseQty('x 51'), 51);
    assert.equal(parseQty('1x4'), 4);      // leading tile-border stroke
    assert.equal(parseQty('x4\n'), 4);
    assert.equal(parseQty('70'), 70);      // 'x' itself dropped
  });
  test('rejects nonsense instead of inventing a count', () => {
    for (const v of ['', null, undefined, 'xx', 'x0', 'x99999']) {
      assert.equal(parseQty(v), null, `parseQty(${JSON.stringify(v)}) should be null`);
    }
  });
  test('prefers the x-anchored digits over a stray leading stroke', () => {
    assert.equal(parseQty('1 x28'), 28);
    assert.equal(parseQty('11x6'), 6);
  });
});
