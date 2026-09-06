// ============================================================
// Test harness — loads the real game files (data.js, alchemy.js,
// optimizer.js) in a sandboxed Node vm and runs assertions.
// Run: node tests/run-tests.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'js');

// ---------- Sandbox ----------
const sandbox = {
  console,
  performance: { now: () => Date.now() },
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox, { filename: file });
}
load('data.js');
load('alchemy.js');
load('optimizer.js');

function run(code) {
  return vm.runInContext(code, sandbox);
}
// JSON-stringify helper so literals are evaluated inside the sandbox
const S = JSON.stringify;

// ---------- Tiny test framework ----------
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: expected ${S(b)}, got ${S(a)}`);
}
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      failures.push({ name, err: e });
      console.log(`  ✗ ${name}\n      ${e.message}`);
    });
}
async function section(title, tests) {
  console.log(`\n■ ${title}`);
  for (const t of tests) await test(t[0], t[1]);
}

// ============================================================
(async () => {
  console.log('════════════════════════════════════════════════');
  console.log('  QI OPTIMIZER — TEST SUITE');
  console.log('════════════════════════════════════════════════');

  await section('Data integrity', [
    ['all recipes reference known plants', () => {
      for (const r of run('RECIPES')) {
        for (const p of Object.keys(r.ingredients)) {
          assert(run('PLANTS')[p], `recipe "${r.name}" references unknown plant "${p}"`);
        }
      }
    }],
    ['all plants have score + rarity + family', () => {
      for (const [name, p] of Object.entries(run('PLANTS'))) {
        assert(Array.isArray(p.score) && p.score.length > 0, `${name} missing score`);
        assert(['C', 'U', 'R', 'E', 'L'].includes(p.rarity), `${name} bad rarity`);
        assert(['VITALITY', 'ENDURANCE', 'AGILITY', 'SPIRIT'].includes(p.family), `${name} bad family`);
      }
    }],
  ]);

  await section('Inventory & cost utilities', [
    ['canCraft true when sufficient', () => {
      assertEq(run(`canCraft(${S({ 'Basic Herb': 6 })}, ${S({ 'Basic Herb': 10 })})`), true);
    }],
    ['canCraft false when insufficient', () => {
      assertEq(run(`canCraft(${S({ 'Basic Herb': 6 })}, ${S({ 'Basic Herb': 5 })})`), false);
    }],
    ['canCraft false when plant missing entirely', () => {
      assertEq(run(`canCraft(${S({ 'Basic Herb': 1 })}, {})`), false);
    }],
    ['deduct/restore roundtrip restores exact inventory', () => {
      const recipe = run('RECIPES')[0];
      const start = { 'Common Spirit Grass': 10, 'Bitter Jade Grass': 5, 'Wild Spirit Grass': 10 };
      const out = run(`
        const inv = ${S(start)};
        deductInv(inv, ${S(recipe.ingredients)});
        restoreInv(inv, ${S(recipe.ingredients)});
        inv;
      `);
      assertEq(S(out), S(start), 'roundtrip');
    }],
    ['getCost = Σ qty × base score', () => {
      // Focus Pill: Basic Herb ×6, score 19 → 114
      assertEq(run(`getCost(${S({ 'Basic Herb': 6 })})`), 114, 'Focus Pill cost');
    }],
  ]);

  await section('Qi multi', [
    ['getTotalQiMulti sums only QiMulti effects', () => {
      const pill = { effects: [{ stat: 'QiMulti', pct: 30 }, { stat: 'Speed', pct: 200 }, { stat: 'QiMulti', pct: 30 }] };
      assertEq(run(`getTotalQiMulti(${S(pill)})`), 60);
    }],
    ['no QiMulti effects ⇒ 0', () => {
      const pill = { effects: [{ stat: 'Vitality', pct: 3 }] };
      assertEq(run(`getTotalQiMulti(${S(pill)})`), 0);
    }],
  ]);

  await section('Conflict logic', [
    ['same base + shared duration ⇒ conflict', () => {
      assertEq(run(`arePillsSimilar(
        { basePill: 'X', predictedDurations: new Set([300]) },
        { basePill: 'X', predictedDurations: new Set([300, 450]) })`), true);
    }],
    ['same base + disjoint durations ⇒ no conflict', () => {
      assertEq(run(`arePillsSimilar(
        { basePill: 'X', predictedDurations: new Set([300]) },
        { basePill: 'X', predictedDurations: new Set([450, 600]) })`), false);
    }],
    ['missing predictedDurations (localStorage round-trip) ⇒ safe conflict', () => {
      assertEq(run(`arePillsSimilar(
        { basePill: 'X' },
        { basePill: 'X', predictedDurations: new Set([300]) })`), true);
    }],
    ['different base pills ⇒ never conflict', () => {
      assertEq(run(`arePillsSimilar(
        { basePill: 'A', predictedDurations: new Set([300]) },
        { basePill: 'B', predictedDurations: new Set([300]) })`), false);
    }],
  ]);

  await section('Predicted durations', [
    ['regular pill keeps base duration', () => {
      // Focus Pill: dur 300, no swaps → delta 0 → dur 300
      const d = run(`[...getAllPredictedDurations({ basePill: 'Focus Pill', ingredients: ${S({ 'Basic Herb': 6 })} })]`);
      assert(S(d) === S([300]), `expected [300], got ${S(d)}`);
    }],
    ['durationless pill (duration 0) ⇒ {0}', () => {
      const ing = run(`RECIPES.find(r => r.name === 'Longevity Restoration Pill').ingredients`);
      const d = run(`[...getAllPredictedDurations({ basePill: 'Longevity Restoration Pill', ingredients: ${S(ing)} })]`);
      assert(S(d) === S([0]), `expected [0], got ${S(d)}`);
    }],
    ['upgrade within family increases duration to +50% cap', () => {
      // Qi Gathering Pill (dur 300): swap 2× Wild Spirit Grass (62) → Thousand Year Lotus (100)
      // delta = 2×38 = +76 → clamp +50 → 300 × 1.5 = 450
      const d = run(`[...getAllPredictedDurations({
        basePill: 'Qi Gathering Pill',
        ingredients: ${S({ 'Common Spirit Grass': 3, 'Bitter Jade Grass': 1, 'Thousand Year Lotus': 2 })}
      })]`);
      assert(d.includes(450), `expected 450, got ${S(d)}`);
    }],
    ['multi-value score plant yields multiple durations', () => {
      // Note: getAllPredictedDurations is family-agnostic — it compares scores only.
      // Delta must sit BELOW the clamp for variance to survive: 1× Cloud Mist Herb (80/81)
      // + 5× Dandelion of Qi (12) vs 6× Basic Herb (19): delta = 61..62 − 35 = 26..27
      const d = run(`[...getAllPredictedDurations({
        basePill: 'Focus Pill',
        ingredients: ${S({ 'Cloud Mist Herb': 1, 'Dandelion of Qi': 5 })}
      })]`);
      assert(d.length === 2 && d.includes(378) && d.includes(381), `expected [378, 381], got ${S(d)}`);
    }],
    ['negative delta reduces duration, never ≤ 0', () => {
      // Focus Pill (300s): swap Basic Herb (19) → Dandelion of Qi (12): delta = 6×(12-19) = -42 → 300×0.58 = 174
      const d = run(`[...getAllPredictedDurations({
        basePill: 'Focus Pill',
        ingredients: ${S({ 'Dandelion of Qi': 6 })}
      })]`);
      assert(d.every((x) => x > 0), `durations must be positive, got ${S(d)}`);
      assert(d.includes(174), `expected 174, got ${S(d)}`);
    }],
  ]);

  await section('Integration — derivation + optimizer', [
    ['every generated pill is craftable from inventory', async () => {
      const inventory = { 'Basic Herb': 20, 'Common Spirit Grass': 10, 'Wild Spirit Grass': 10, 'Bitter Jade Grass': 5 };
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      assert(pills.length > 0, 'should generate at least one pill');
      for (const p of pills) {
        assert(run(`canCraft(${S(p.ingredients)}, ${S(inventory)})`), `pill "${p.name}" not craftable`);
      }
    }],
    ['minQi filter: strict ⊆ loose', async () => {
      const inventory = { 'Starlight Dew Herb': 6, 'Azure Serpent Grass': 6 };
      const loose = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const strict = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 100, 'alchemist')`);
      assert(strict.length <= loose.length, `strict (${strict.length}) > loose (${loose.length})`);
      assert(loose.length > 0, 'loose should find pills');
      for (const p of strict) {
        assert(run(`getTotalQiMulti(${S(p)})`) >= 100, `pill "${p.name}" below minQi`);
      }
    }],
    ['optimizer never exceeds maxPills', async () => {
      const inventory = {
        'Basic Herb': 50, 'Common Spirit Grass': 50, 'Wild Spirit Grass': 50, 'Bitter Jade Grass': 50,
        'Healing Sunflower': 50, 'Mountain Green Herb': 50, 'Wild Bitter Grass': 50, 'Red Ginseng': 50,
      };
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const set3 = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 3)`);
      assert(set3.length <= 3, `expected ≤3, got ${set3.length}`);
      const set1 = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 1)`);
      assert(set1.length <= 1, `expected ≤1, got ${set1.length}`);
      assert(set1.length === 1, 'with rich inventory, maxPills=1 should still yield 1 pill');
    }],
    ['optimizer never overdrafts inventory', async () => {
      const inventory = { 'Basic Herb': 6, 'Common Spirit Grass': 4, 'Wild Spirit Grass': 3, 'Bitter Jade Grass': 2 };
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const set = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 99)`);
      const used = {};
      for (const p of set) {
        for (const [plant, qty] of Object.entries(p.ingredients)) {
          used[plant] = (used[plant] || 0) + qty;
        }
      }
      for (const [plant, qty] of Object.entries(used)) {
        assert(qty <= inventory[plant], `overdraft: ${plant} used ${qty} > stock ${inventory[plant]}`);
      }
      assert(set.length >= 1, 'should craft at least the base Focus Pill (6 Basic Herb)');
    }],
    ['two pills in result never conflict', async () => {
      const inventory = {
        'Basic Herb': 60, 'Common Spirit Grass': 60, 'Wild Spirit Grass': 60, 'Bitter Jade Grass': 30,
        'Healing Sunflower': 60, 'Mountain Green Herb': 60, 'Wild Bitter Grass': 60, 'Red Ginseng': 60,
      };
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const set = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 99)`);
      assert(set.length >= 2, `rich inventory should yield several pills, got ${set.length}`);
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const conflict = run(`arePillsSimilar(${S(set[i])}, ${S(set[j])})`);
          // NB: JSON round-trip drops the Set — arePillsSimilar then treats same-base as conflict.
          // Recompute durations on the copies to make the check meaningful:
          if (conflict && set[i].basePill === set[j].basePill) {
            const ok = run(`
              (() => {
                const a = ${S(set[i])}; const b = ${S(set[j])};
                a.predictedDurations = getAllPredictedDurations(a);
                b.predictedDurations = getAllPredictedDurations(b);
                return arePillsSimilar(a, b);
              })()
            `);
            assert(!ok, `conflict: "${set[i].name}" vs "${set[j].name}"`);
          }
        }
      }
    }],
    ['optimizer picks the highest-Qi pill for maxPills=1', async () => {
      // Concentration Pill (QiMulti 200) vs Focus Pill (8) — both craftable
      const inventory = { 'Starlight Dew Herb': 6, 'Azure Serpent Grass': 6, 'Basic Herb': 6 };
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const set = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 1)`);
      assertEq(set.length, 1);
      const qi = run(`getTotalQiMulti(${S(set[0])})`);
      assert(qi >= 200, `expected QiMulti ≥200 (Concentration family), got ${qi} (${set[0].name})`);
    }],
    ['empty inventory yields no pills', async () => {
      const pills = await run(`generateAllDerivations({}, 0, 3, 1, 'alchemist')`);
      assertEq(pills.length, 0);
    }],
    ['findBestSet on empty pill list returns empty set', async () => {
      const set = await run(`findBestSet([], {}, 5)`);
      assertEq(set.length, 0);
    }],
  ]);

  await section('calcMode behaviour', [
    ['handcrafted: pct ×3, duration ×3 (1 + cap0/100 + 2)', () => {
      const pill = run(`computePill(
        { name: 'Focus Pill', ingredients: ${S({ 'Basic Herb': 6 })}, effects: [{ stat: 'QiMulti', pct: 8, duration: 300 }] },
        ${S({ 'Basic Herb': 6 })}, ${S({ 'Basic Herb': 6 })}, 'handcrafted')`);
      assertEq(pill.effects[0].pct, 24, 'handcrafted pct');
      assertEq(pill.effects[0].duration, 900, 'handcrafted duration');
      assertEq(pill.type, 'Regular');
    }],
    ['alchemist: regular pill keeps base effects', () => {
      const pill = run(`computePill(
        { name: 'Focus Pill', ingredients: ${S({ 'Basic Herb': 6 })}, effects: [{ stat: 'QiMulti', pct: 8, duration: 300 }] },
        ${S({ 'Basic Herb': 6 })}, ${S({ 'Basic Herb': 6 })}, 'alchemist')`);
      assertEq(pill.effects[0].pct, 8, 'alchemist pct');
      assertEq(pill.effects[0].duration, 300, 'alchemist duration');
    }],
    ['upgrade pill type is Heavenly when score sum rises', () => {
      // Same-family swap (VITALITY): Basic Herb (19) → Bitter Jade Grass (84)
      // delta = 6×65 = 390 → clamp +50 → pct = ceil(8×1.5) = 12, dur = 450
      const pill = run(`computePill(
        { name: 'Focus Pill', ingredients: ${S({ 'Basic Herb': 6 })}, effects: [{ stat: 'QiMulti', pct: 8, duration: 300 }] },
        ${S({ 'Basic Herb': 6 })}, ${S({ 'Bitter Jade Grass': 6 })}, 'alchemist')`);
      assertEq(pill.type, 'Heavenly', 'type');
      assertEq(pill.effects[0].pct, 12, 'capped pct');
      assertEq(pill.effects[0].duration, 450, 'capped duration');
    }],
    ['downgrade pill type is Imperfect when score sum falls', () => {
      // Same-family swap (VITALITY): Bitter Jade Grass (84) → Basic Herb (19)
      // Qi Gathering Pill: delta = −65 → clamp −50 → pct = ceil(5×0.5) = 3, dur = round(300×0.5) = 150
      const pill = run(`computePill(
        { name: 'Qi Gathering Pill', ingredients: ${S({ 'Common Spirit Grass': 3, 'Bitter Jade Grass': 1, 'Wild Spirit Grass': 2 })}, effects: [{ stat: 'QiMulti', pct: 5, duration: 300 }] },
        ${S({ 'Common Spirit Grass': 3, 'Bitter Jade Grass': 1, 'Wild Spirit Grass': 2 })},
        ${S({ 'Common Spirit Grass': 3, 'Basic Herb': 1, 'Wild Spirit Grass': 2 })}, 'alchemist')`);
      assertEq(pill.type, 'Imperfect', 'type');
      assertEq(pill.effects[0].pct, 3, 'imperfect pct');
      assertEq(pill.effects[0].duration, 150, 'imperfect duration');
    }],
  ]);

  await section('Stress & performance', [
    ['full inventory (all plants ×99): derivation + optimize < 10s, respects maxPills=5', async () => {
      const allPlants = Object.keys(run('PLANTS'));
      const inventory = {};
      for (const p of allPlants) inventory[p] = 99;
      const t0 = Date.now();
      const pills = await run(`generateAllDerivations(${S(inventory)}, 0, 3, 1, 'alchemist')`);
      const genMs = Date.now() - t0;
      const t1 = Date.now();
      const set = await run(`findBestSet(${S(pills)}, ${S(inventory)}, 5)`);
      const optMs = Date.now() - t1;
      console.log(`      → ${pills.length} pills derived in ${genMs}ms; best set of ${set.length} found in ${optMs}ms`);
      assert(set.length <= 5, `expected ≤5, got ${set.length}`);
      assert(set.length > 0, 'rich inventory should yield pills');
      assert(genMs < 10000, `derivation too slow: ${genMs}ms`);
      assert(optMs < 10000, `optimization too slow: ${optMs}ms`);
      // total Qi of chosen set should be high (top pills are 200+ QiMulti)
      const totalQi = set.reduce((s, p) => s + run(`getTotalQiMulti(${S(p)})`), 0);
      console.log(`      → total QiMulti of set: ${totalQi}`);
      assert(totalQi >= 400, `total Qi suspiciously low: ${totalQi}`);
    }],
  ]);

  // ---------- Summary ----------
  console.log('\n════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   • ${f.name}: ${f.err.message}`);
  }
  console.log('════════════════════════════════════════════════');
  process.exit(failed ? 1 : 0);
})();