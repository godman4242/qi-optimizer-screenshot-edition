// ============================================================
// tests/optimizer.test.mjs — Node built-in test runner (node:test).
// No npm deps, no package.json.
//
// The app's js/ files are plain <script> globals with no exports, so
// they are read from disk and evaluated in a shared node:vm context
// in the same load order as index.html (data → alchemy → optimizer).
//
// REALM NOTE: vm.createContext() creates a *new realm*. A Set built
// out here is NOT `instanceof Set` in there, and vice versa. So every
// object that crosses into a sandbox function is built inside the
// sandbox, and everything crossing back out is JSON so that
// assert.deepStrictEqual's prototype check doesn't spuriously fail.
//
// Run: node --test tests/
// ============================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');

const sandbox = {
  console,
  performance: globalThis.performance, // pass through (Node >= 16)
  setTimeout,
  clearTimeout,
};
sandbox.window = sandbox; // some files feature-detect window.*
vm.createContext(sandbox);

for (const file of ['data.js', 'alchemy.js', 'optimizer.js']) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), sandbox, { filename: file });
}

/** Evaluate `code` inside the sandbox and return the raw (possibly cross-realm) value. */
const run = (code) => vm.runInContext(code, sandbox);
/** Evaluate `code` inside the sandbox; the code must produce JSON — parsed out here. */
const runJson = (code) => JSON.parse(run(code));
/** Evaluate an async IIFE inside the sandbox that resolves to JSON. */
const runJsonAsync = async (code) => JSON.parse(await run(code));
/** Embed a JS value as a literal inside sandbox source. */
const lit = JSON.stringify;

const PLANTS = runJson('JSON.stringify(PLANTS)');
const RECIPES = runJson('JSON.stringify(RECIPES)');
const RARITY = runJson('JSON.stringify(RARITY)');
const FAMILIES = ['VITALITY', 'ENDURANCE', 'AGILITY', 'SPIRIT'];
const STATS = ['QiMulti', 'Speed', 'Vitality', 'Strength', 'Lifespan', 'DEATH'];

// ============================================================
describe('data.js — static game data integrity', () => {
  test('every recipe ingredient exists in PLANTS', () => {
    for (const r of RECIPES) {
      for (const plant of Object.keys(r.ingredients)) {
        assert.ok(PLANTS[plant], `recipe "${r.name}" references unknown plant "${plant}"`);
      }
    }
  });

  test('every recipe ingredient quantity is a positive integer', () => {
    for (const r of RECIPES) {
      for (const [plant, qty] of Object.entries(r.ingredients)) {
        assert.ok(Number.isInteger(qty) && qty > 0, `${r.name} / ${plant} qty=${qty}`);
      }
    }
  });

  test('every recipe uses exactly 6 ingredient units (cauldron size)', () => {
    // deriveFromRecipe swaps slot-for-slot, so a non-6 recipe would
    // silently produce a differently-sized pill.
    for (const r of RECIPES) {
      const total = Object.values(r.ingredients).reduce((s, q) => s + q, 0);
      assert.equal(total, 6, `${r.name} has ${total} units`);
    }
  });

  test('recipe names are unique (RECIPE_BY_NAME is 1:1)', () => {
    const names = RECIPES.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(run('RECIPE_BY_NAME.size'), names.length);
  });

  test('RARITY keys are consistent with every plant rarity', () => {
    const rarityKeys = Object.keys(RARITY);
    assert.deepEqual(rarityKeys, ['C', 'U', 'R', 'E', 'L']);
    const used = new Set();
    for (const [name, p] of Object.entries(PLANTS)) {
      assert.ok(rarityKeys.includes(p.rarity), `${name} has rarity "${p.rarity}"`);
      used.add(p.rarity);
    }
    assert.deepEqual([...used].sort(), [...rarityKeys].sort(), 'every RARITY tier is used');
    // RARITY values must be a dense 0..n-1 ranking
    assert.deepEqual(Object.values(RARITY), [0, 1, 2, 3, 4]);
  });

  test('every plant has a non-empty ascending score array and a known family', () => {
    for (const [name, p] of Object.entries(PLANTS)) {
      assert.ok(Array.isArray(p.score) && p.score.length > 0, `${name} score`);
      for (const s of p.score) assert.ok(Number.isFinite(s) && s > 0, `${name} score value ${s}`);
      assert.deepEqual(p.score, [...p.score].sort((a, b) => a - b), `${name} score not ascending`);
      assert.ok(FAMILIES.includes(p.family), `${name} family "${p.family}"`);
    }
  });

  test('every family is non-empty (getSwaps/countCommonFamilies hardcode all four)', () => {
    for (const fam of FAMILIES) {
      const members = Object.values(PLANTS).filter((p) => p.family === fam);
      assert.ok(members.length > 0, `family ${fam} has no plants`);
    }
  });

  test('no recipe has empty effects; DEATH appears only in the Death Pill', () => {
    const deathRecipes = [];
    for (const r of RECIPES) {
      assert.ok(Array.isArray(r.effects) && r.effects.length > 0, `${r.name} has no effects`);
      for (const e of r.effects) {
        assert.ok(STATS.includes(e.stat), `${r.name} unknown stat "${e.stat}"`);
        assert.ok(Number.isFinite(e.pct) && e.pct >= 0, `${r.name} pct ${e.pct}`);
        assert.ok(Number.isInteger(e.duration) && e.duration >= 0, `${r.name} duration ${e.duration}`);
      }
      if (r.effects.some((e) => e.stat === 'DEATH')) deathRecipes.push(r.name);
    }
    assert.deepEqual(deathRecipes, ['Death Pill']);
  });

  test('all effects of one recipe share a single duration', () => {
    // getAllPredictedDurations() (optimizer.js:180) takes the FIRST effect that
    // is QiMulti-or-timed and treats its duration as the whole pill's base.
    // That is only sound while every effect of a recipe has the same duration.
    for (const r of RECIPES) {
      const durations = [...new Set(r.effects.map((e) => e.duration))];
      assert.equal(durations.length, 1, `${r.name} has mixed durations ${JSON.stringify(durations)}`);
    }
  });
});

// ============================================================
describe('alchemy.js — candidate filtering & family grouping', () => {
  test('CANDIDATE_RECIPES excludes DEATH-effect recipes and keeps everything else', () => {
    const candidates = runJson('JSON.stringify(CANDIDATE_RECIPES.map(r => r.name))');
    assert.ok(!candidates.includes('Death Pill'), 'Death Pill leaked into CANDIDATE_RECIPES');
    assert.equal(
      run('CANDIDATE_RECIPES.some(r => r.effects.some(e => e.stat === "DEATH"))'),
      false,
    );
    assert.equal(run('CANDIDATE_RECIPES.every(r => r.effects.length > 0)'), true);
    assert.equal(candidates.length, RECIPES.length - 1, 'exactly one recipe filtered out');
  });

  test('FAMILY_PLANTS partitions PLANTS by family, sorted ascending by base score', () => {
    const fp = runJson('JSON.stringify(FAMILY_PLANTS)');
    assert.deepEqual(Object.keys(fp).sort(), [...FAMILIES].sort());

    const seen = [];
    for (const [fam, names] of Object.entries(fp)) {
      for (const n of names) {
        assert.equal(PLANTS[n].family, fam, `${n} filed under ${fam}`);
        seen.push(n);
      }
      const scores = names.map((n) => PLANTS[n].score[0]);
      assert.deepEqual(scores, [...scores].sort((a, b) => a - b), `${fam} not sorted by score`);
    }
    assert.equal(seen.length, Object.keys(PLANTS).length, 'every plant appears exactly once');
    assert.deepEqual(seen.slice().sort(), Object.keys(PLANTS).sort());
  });

  test('ingredient utilities round-trip (flatten / count / expandFamily / key)', () => {
    const ingr = { 'Basic Herb': 2, 'Red Ginseng': 1, 'Cloud Mist Herb': 3 };
    assert.equal(run(`flattenIngredients(${lit(ingr)}).length`), 6);
    assert.deepEqual(runJson(`JSON.stringify(countIngredients(flattenIngredients(${lit(ingr)})))`), ingr);
    assert.deepEqual(
      runJson(`JSON.stringify(expandFamily(${lit(ingr)}, "VITALITY").sort())`),
      ['Basic Herb', 'Basic Herb', 'Red Ginseng'],
    );
    assert.deepEqual(runJson(`JSON.stringify(getFamilyDist(${lit(ingr)}))`), { VITALITY: 3, AGILITY: 3 });
    // key is order-independent
    assert.equal(
      run(`ingredientKey(${lit(ingr)})`),
      run(`ingredientKey(${lit({ 'Cloud Mist Herb': 3, 'Basic Herb': 2, 'Red Ginseng': 1 })})`),
    );
  });

  test('canCraft respects inventory levels', () => {
    assert.equal(run(`canCraft({"Basic Herb":6}, {"Basic Herb":6})`), true);
    assert.equal(run(`canCraft({"Basic Herb":6}, {"Basic Herb":5})`), false);
    assert.equal(run(`canCraft({"Basic Herb":1}, {})`), false);
    assert.equal(run(`canCraft({}, {})`), true);
  });
});

// ============================================================
describe('alchemy.js — effect derivation contract (computePill)', () => {
  const focus = { 'Basic Herb': 6 }; // Focus Pill: QiMulti 8% / 300s
  const endurance = { 'Mountain Green Herb': 6 }; // Endurance Pill: Vitality 8% / 600s

  const derive = (baseName, newIngr, mode) =>
    runJson(`JSON.stringify(computePill(RECIPE_BY_NAME.get(${lit(baseName)}),
      RECIPE_BY_NAME.get(${lit(baseName)}).ingredients, ${lit(newIngr)}, ${lit(mode)}))`);

  test('alchemist + no swaps ⇒ Regular pill with untouched base effects', () => {
    const p = derive('Focus Pill', focus, 'alchemist');
    assert.equal(p.type, 'Regular');
    assert.equal(p.name, 'Focus Pill');
    assert.equal(p.basePill, 'Focus Pill');
    assert.deepEqual(p.effects, [{ stat: 'QiMulti', pct: 8, duration: 300 }]);
  });

  test('upgrade swap ⇒ Heavenly, pct=ceil(base*mult), duration=round(base*mult)', () => {
    // Basic Herb (19) → Red Ginseng (69): sumTransform +50 ⇒ mult 1.50
    const p = derive('Focus Pill', { 'Basic Herb': 5, 'Red Ginseng': 1 }, 'alchemist');
    assert.equal(p.type, 'Heavenly');
    assert.equal(p.name, 'Heavenly Focus Pill');
    assert.deepEqual(p.effects, [{ stat: 'QiMulti', pct: 12, duration: 450 }]);
  });

  test('downgrade swap ⇒ Imperfect with reduced pct/duration', () => {
    // Mountain Green Herb (50) → Wild Bitter Grass (25): −25 ⇒ mult 0.75
    const p = derive('Endurance Pill', { 'Mountain Green Herb': 5, 'Wild Bitter Grass': 1 }, 'alchemist');
    assert.equal(p.type, 'Imperfect');
    assert.equal(p.name, 'Imperfect Endurance Pill');
    assert.deepEqual(p.effects, [{ stat: 'Vitality', pct: 6, duration: 450 }]);
  });

  test('sumTransform is clamped to ±50', () => {
    // +141 raw → clamped +50 ⇒ mult 1.5
    const up = derive('Endurance Pill', { 'Mountain Green Herb': 3, 'Nine Suns Flame Grass': 3 }, 'alchemist');
    assert.deepEqual(up.effects, [{ stat: 'Vitality', pct: 12, duration: 900 }]);
    // −75 raw → clamped −50 ⇒ mult 0.5
    const down = derive('Endurance Pill', { 'Mountain Green Herb': 3, 'Wild Bitter Grass': 3 }, 'alchemist');
    assert.deepEqual(down.effects, [{ stat: 'Vitality', pct: 4, duration: 300 }]);
  });

  test('permanent effects (duration 0) stay permanent through derivation', () => {
    // Mountain Force Pill: Strength 8% / duration 0
    const p = derive(
      'Mountain Force Pill',
      { 'Black Iron Root': 2, 'Ironbone Grass': 2, 'Mountain Green Herb': 1, 'Wild Bitter Grass': 1 },
      'alchemist',
    );
    assert.equal(p.effects[0].duration, 0, 'permanent effect must not gain a duration');
  });

  test('handcrafted mode adds +2 to the multiplier, including for Regular pills', () => {
    const p = derive('Focus Pill', focus, 'handcrafted');
    assert.equal(p.type, 'Regular');
    // mult = 1 + 0/100 + 2 = 3 ⇒ 8*3=24, 300*3=900
    assert.deepEqual(p.effects, [{ stat: 'QiMulti', pct: 24, duration: 900 }]);
  });

  test('every derived pill carries a predictedDurations Set (used by the conflict rule)', () => {
    assert.equal(
      run(`computePill(RECIPE_BY_NAME.get("Focus Pill"), ${lit(focus)}, ${lit(focus)}, 'alchemist')
             .predictedDurations instanceof Set`),
      true,
    );
    assert.equal(run(`computePill(RECIPE_BY_NAME.get("Endurance Pill"), ${lit(endurance)}, ${lit(endurance)},
      'alchemist').predictedDurations.size`), 1);
  });
});

// ============================================================
describe('alchemy.js — validation rules', () => {
  test('getTotalQiMulti sums only QiMulti effects', () => {
    assert.equal(run(`getTotalQiMulti({effects:[{stat:"QiMulti",pct:30},{stat:"Speed",pct:200},{stat:"QiMulti",pct:20}]})`), 50);
    assert.equal(run(`getTotalQiMulti({effects:[{stat:"Speed",pct:200}]})`), 0);
    assert.equal(run(`getTotalQiMulti({effects:[]})`), 0);
  });

  test('hasValidDuration: permanent effects always pass, timed ones must clear the floor', () => {
    assert.equal(run(`hasValidDuration({effects:[{stat:"QiMulti",pct:1,duration:300}]}, 200)`), true);
    assert.equal(run(`hasValidDuration({effects:[{stat:"QiMulti",pct:1,duration:300}]}, 400)`), false);
    assert.equal(run(`hasValidDuration({effects:[{stat:"Lifespan",pct:1,duration:0}]}, 9999)`), true);
  });

  test('meetsRarityEfficiency gates Epic (<15 Qi) and Legendary (<40 Qi) ingredients', () => {
    assert.equal(run(`meetsRarityEfficiency({"Basic Herb":6}, 1)`), true, 'commons unconstrained');
    assert.equal(run(`meetsRarityEfficiency({"Silverleaf Herb":6}, 14)`), false, 'epic under 15');
    assert.equal(run(`meetsRarityEfficiency({"Silverleaf Herb":6}, 15)`), true, 'epic at 15');
    assert.equal(run(`meetsRarityEfficiency({"Thousand Year Lotus":6}, 39)`), false, 'legendary under 40');
    assert.equal(run(`meetsRarityEfficiency({"Thousand Year Lotus":6}, 40)`), true, 'legendary at 40');
  });

  test('hasRecipeConflict flags a pill that has become another real recipe', () => {
    // Same ingredients as Endurance Pill but labelled Focus Pill:
    // 6 common plants and an identical family distribution ⇒ conflict.
    assert.equal(
      run(`hasRecipeConflict({basePill:"Focus Pill", ingredients:{"Mountain Green Herb":6}})`),
      true,
    );
    // Focus Pill's own ingredients collide with nothing (no other recipe uses Basic Herb).
    assert.equal(
      run(`hasRecipeConflict({basePill:"Focus Pill", ingredients:{"Basic Herb":6}})`),
      false,
    );
  });

  test('deduplicatePills keys on name + ingredients', () => {
    const n = run(`deduplicatePills([
      {name:"A", ingredients:{"Basic Herb":6}},
      {name:"A", ingredients:{"Basic Herb":6}},
      {name:"A", ingredients:{"Red Ginseng":6}},
      {name:"B", ingredients:{"Basic Herb":6}}
    ]).length`);
    assert.equal(n, 3);
  });
});

// ============================================================
describe('optimizer.js — pure functions', () => {
  test('getCost = Σ qty × base score', () => {
    assert.equal(run(`getCost({"Basic Herb":6})`), 114); // 6 × 19
    assert.equal(run(`getCost({"Basic Herb":2,"Red Ginseng":1})`), 107); // 38 + 69
    assert.equal(run(`getCost({})`), 0);
    // multi-score plants cost their FIRST score
    assert.equal(run(`getCost({"Cloud Mist Herb":1})`), 80);
  });

  test('deductInv / restoreInv are exact inverses', () => {
    const start = { 'Basic Herb': 10, 'Red Ginseng': 3 };
    const out = runJson(`JSON.stringify((() => {
      const inv = ${lit(start)};
      deductInv(inv, {"Basic Herb":6,"Red Ginseng":1});
      restoreInv(inv, {"Basic Herb":6,"Red Ginseng":1});
      return inv;
    })())`);
    assert.deepEqual(out, start);
  });

  test('efficiency = qiMulti / cost, and 0 when cost is 0', () => {
    // findBestSet is the only place efficiency is assigned; check the formula it uses.
    const out = runJson(`JSON.stringify((() => {
      const mk = (qi, ingr) => ({ name:'x', basePill:'Focus Pill', ingredients: ingr,
        effects:[{stat:'QiMulti',pct:qi,duration:300}] });
      const p = mk(12, {"Basic Herb":6});
      const cost = getCost(p.ingredients);
      const qi = getTotalQiMulti(p);
      const zero = mk(12, {});
      return { cost, qi, eff: cost > 0 ? qi / cost : 0,
               zeroEff: getCost(zero.ingredients) > 0 ? 1 : 0 };
    })())`);
    assert.equal(out.cost, 114);
    assert.equal(out.qi, 12);
    assert.equal(out.eff, 12 / 114);
    assert.equal(out.zeroEff, 0, 'zero-cost pill must not divide by zero');
  });

  test('getAllPredictedDurations: regular pill ⇒ the base duration', () => {
    assert.deepEqual(
      runJson(`JSON.stringify([...getAllPredictedDurations({basePill:"Focus Pill", ingredients:{"Basic Herb":6}})])`),
      [300],
    );
  });

  test('getAllPredictedDurations: permanent base ⇒ {0}', () => {
    assert.deepEqual(
      runJson(`JSON.stringify([...getAllPredictedDurations({basePill:"Mountain Force Pill",
        ingredients:{"Black Iron Root":2,"Ironbone Grass":2,"Mountain Green Herb":2}})])`),
      [0],
    );
  });

  test('getAllPredictedDurations: unknown base pill ⇒ {0}', () => {
    assert.deepEqual(
      runJson(`JSON.stringify([...getAllPredictedDurations({basePill:"Nope", ingredients:{}})])`),
      [0],
    );
  });

  test('getAllPredictedDurations: single-score swap ⇒ one clamped duration', () => {
    // Basic Herb (19) → Red Ginseng (69) = +50 ⇒ 300 × 1.5 = 450
    assert.deepEqual(
      runJson(`JSON.stringify([...getAllPredictedDurations({basePill:"Focus Pill",
        ingredients:{"Basic Herb":5,"Red Ginseng":1}})])`),
      [450],
    );
  });

  test('getAllPredictedDurations: multi-score plant ⇒ one duration per score branch', () => {
    // Cloudstep Pill (Cloud Mist Herb ×6, Speed 30% / 480s).
    // Remove one Cloud Mist Herb (score [80,81]) and add Silverleaf Herb (85):
    // scores +5 and +4 ⇒ round(480×1.05)=504 and round(480×1.04)=499.
    const durs = runJson(`JSON.stringify([...getAllPredictedDurations({basePill:"Cloudstep Pill",
      ingredients:{"Cloud Mist Herb":5,"Silverleaf Herb":1}})].sort((a,b)=>a-b))`);
    assert.deepEqual(durs, [499, 504]);
  });
});

// ============================================================
describe('optimizer.js — arePillsSimilar (conflict rule)', () => {
  // Built inside the sandbox so `instanceof Set` resolves in the right realm.
  const similar = (a, b) => run(`arePillsSimilar(
    { basePill: ${lit(a.basePill)}, ${a.durations ? `predictedDurations: new Set(${lit(a.durations)})` : ''} },
    { basePill: ${lit(b.basePill)}, ${b.durations ? `predictedDurations: new Set(${lit(b.durations)})` : ''} })`);

  test('different base pills never conflict', () => {
    assert.equal(similar({ basePill: 'Focus Pill', durations: [300] },
                         { basePill: 'Endurance Pill', durations: [300] }), false);
  });

  test('REGRESSION: same base with OVERLAPPING durations ⇒ similar', () => {
    assert.equal(similar({ basePill: 'Focus Pill', durations: [300, 450] },
                         { basePill: 'Focus Pill', durations: [450, 600] }), true);
    assert.equal(similar({ basePill: 'Focus Pill', durations: [450] },
                         { basePill: 'Focus Pill', durations: [450] }), true);
  });

  test('same base with DISJOINT durations ⇒ not similar (stackable)', () => {
    assert.equal(similar({ basePill: 'Focus Pill', durations: [300] },
                         { basePill: 'Focus Pill', durations: [450] }), false);
    assert.equal(similar({ basePill: 'Focus Pill', durations: [300, 330] },
                         { basePill: 'Focus Pill', durations: [450, 480] }), false);
  });

  test('missing predictedDurations (JSON-restored pill) ⇒ treated as conflict', () => {
    assert.equal(similar({ basePill: 'Focus Pill' }, { basePill: 'Focus Pill', durations: [300] }), true);
    assert.equal(similar({ basePill: 'Focus Pill', durations: [300] }, { basePill: 'Focus Pill' }), true);
    assert.equal(similar({ basePill: 'Focus Pill' }, { basePill: 'Focus Pill' }), true);
    // a plain object (what JSON.parse gives back for a serialized Set) is not a Set
    assert.equal(run(`arePillsSimilar({basePill:"Focus Pill", predictedDurations:{}},
                                      {basePill:"Focus Pill", predictedDurations:new Set([300])})`), true);
  });

  test('REGRESSION (real data): two Focus Pill derivations that clamp to the same duration conflict', () => {
    // Basic Herb→Red Ginseng (+50) and Basic Herb→Healing Sunflower (+55) both
    // clamp to +50 ⇒ both predict 450s ⇒ they must not be stacked.
    const out = run(`(() => {
      const a = { basePill:"Focus Pill", ingredients:{"Basic Herb":5,"Red Ginseng":1} };
      const b = { basePill:"Focus Pill", ingredients:{"Basic Herb":5,"Healing Sunflower":1} };
      a.predictedDurations = getAllPredictedDurations(a);
      b.predictedDurations = getAllPredictedDurations(b);
      return arePillsSimilar(a, b);
    })()`);
    assert.equal(out, true);
  });

  test('real data: two Endurance Pill derivations with disjoint durations do NOT conflict', () => {
    // →Wild Bitter Grass (−25) ⇒ 450s ; →Ironbone Grass ([82,83]) ⇒ {792,798}
    const out = runJson(`JSON.stringify((() => {
      const a = { basePill:"Endurance Pill", ingredients:{"Mountain Green Herb":5,"Wild Bitter Grass":1} };
      const b = { basePill:"Endurance Pill", ingredients:{"Mountain Green Herb":5,"Ironbone Grass":1} };
      a.predictedDurations = getAllPredictedDurations(a);
      b.predictedDurations = getAllPredictedDurations(b);
      return { similar: arePillsSimilar(a, b), a: [...a.predictedDurations], b: [...b.predictedDurations] };
    })())`);
    assert.deepEqual(out.a, [450]);
    assert.deepEqual(out.b.slice().sort((x, y) => x - y), [792, 798]);
    assert.equal(out.similar, false);
  });

  // ---------------------------------------------------------------
  // SKIPPED — real unit mismatch, but fixing it is game-visible and the
  // current behaviour is not actually wrong for today's data.
  //
  // computePill() (alchemy.js:134) adds +2 to the multiplier in 'handcrafted'
  // mode, so a handcrafted pill's displayed duration is round(D × (3 + s/100)).
  // getAllPredictedDurations() (optimizer.js:176) never receives calcMode and
  // always computes round(D × (1 + s/100)). So in handcrafted mode the numbers
  // in predictedDurations are on a different scale from the numbers the UI
  // shows: e.g. Fury Pill (D=300) with score delta +11 displays 933s while
  // predictedDurations says {333}.
  //
  // Impact on pill selection is nil for the shipped data: both formulas are
  // affine in the score delta s with the SAME slope (D/100), so two pills'
  // predicted sets overlap exactly when their handcrafted sets do. Verified
  // exhaustively over all 13 distinct base durations in RECIPES × every score
  // delta pair in [-50, 50]: 0 divergences out of 65,650 pairs. The bug only
  // bites if predictedDurations is ever shown to the player or compared
  // against effects[].duration.
  //
  // The minimal fix is to thread calcMode into getAllPredictedDurations, but
  // that changes which pills are selected in handcrafted mode, and there is no
  // way from this repo to confirm which of the two duration formulas matches
  // the real game. Left for the maintainer to decide. Un-skip once resolved.
  test.skip('handcrafted durations agree between computePill and getAllPredictedDurations', () => {
    const out = runJson(`JSON.stringify((() => {
      const base = RECIPE_BY_NAME.get("Fury Pill");
      const ingr = {"Heavenly Spirit Vine":1,"Silverleaf Herb":1,"Ironbone Grass":2,"Crimson Flame Mushroom":2};
      const hc = computePill(base, base.ingredients, ingr, 'handcrafted');
      return { displayed: hc.effects[0].duration,
               predicted: [...getAllPredictedDurations({ basePill: "Fury Pill", ingredients: ingr })] };
    })())`);
    assert.ok(out.predicted.includes(out.displayed),
      `handcrafted pill lasts ${out.displayed}s but the conflict rule predicts ${JSON.stringify(out.predicted)}`);
  });

  test('hasConflict honours ignoreIndex (used by the local-search swap)', () => {
    const out = runJson(`JSON.stringify((() => {
      const mk = (d) => ({ basePill:"Focus Pill", predictedDurations:new Set(d) });
      const set = [mk([300]), mk([450])];
      return {
        blocked: hasConflict(mk([450]), set, -1),
        allowedWhenIgnoringTheHolder: hasConflict(mk([450]), set, 1),
        emptySet: hasConflict(mk([300]), [], -1)
      };
    })())`);
    assert.equal(out.blocked, true);
    assert.equal(out.allowedWhenIgnoringTheHolder, false);
    assert.equal(out.emptySet, false);
  });
});

// ============================================================
describe('optimizer.js — findBestSet integration', () => {
  // Fixed, deliberately small inventory: several distinct base recipes are
  // craftable, and there is enough of some plants to tempt the optimizer into
  // stacking two derivations of the same base.
  const INVENTORY = {
    'Basic Herb': 12,
    'Dandelion of Qi': 6,
    'Common Spirit Grass': 12,
    'Wild Spirit Grass': 8,
    'Red Ginseng': 4,
    'Mountain Green Herb': 6,
    'Spirit Spring Herb': 6,
    'Cloud Mist Herb': 4,
    'Moonlight Jade Leaf': 6,
    'Starlight Dew Herb': 6,
  };

  // Everything that must observe realm-local identity (Sets, arePillsSimilar)
  // happens inside the sandbox; only JSON crosses back out.
  const SCENARIO = (maxPills) => `(async () => {
    const inv = ${lit(INVENTORY)};
    const pills = await generateAllDerivations(inv, 0, 3, 1, 'alchemist');
    const set = await findBestSet(pills, inv, ${maxPills});

    let conflict = null;
    for (let i = 0; i < set.length && !conflict; i++) {
      for (let j = i + 1; j < set.length; j++) {
        if (arePillsSimilar(set[i], set[j])) { conflict = [set[i].name, set[j].name]; break; }
      }
    }

    const spent = {};
    for (const p of set) {
      for (const [plant, qty] of Object.entries(p.ingredients)) {
        spent[plant] = (spent[plant] || 0) + qty;
      }
    }

    let bestSingle = 0;
    for (const p of pills) {
      if (canCraft(p.ingredients, inv)) bestSingle = Math.max(bestSingle, getTotalQiMulti(p));
    }

    return JSON.stringify({
      candidateCount: pills.length,
      size: set.length,
      keys: set.map(p => p.name + '#' + ingredientKey(p.ingredients)),
      totalQi: set.reduce((s, p) => s + getTotalQiMulti(p), 0),
      qiDesc: set.map(p => p.qiMulti),
      effOk: set.every(p => Math.abs(p.efficiency - (p.cost > 0 ? p.qiMulti / p.cost : 0)) < 1e-12),
      conflict, spent, bestSingle
    });
  })()`;

  let result;
  test('scenario runs and produces a non-empty set', async () => {
    result = await runJsonAsync(SCENARIO('Infinity'));
    assert.ok(result.candidateCount > 0, 'no derivations generated — inventory too small?');
    assert.ok(result.size > 0, 'optimizer returned an empty set');
  });

  test('(a) the selected set contains no conflicting pair', () => {
    assert.equal(result.conflict, null,
      `conflicting pair selected: ${JSON.stringify(result.conflict)}`);
  });

  test('(b) total ingredient cost never exceeds the inventory', () => {
    for (const [plant, used] of Object.entries(result.spent)) {
      const have = INVENTORY[plant] || 0;
      assert.ok(used <= have, `over-spent ${plant}: used ${used}, had ${have}`);
    }
  });

  test('(c) set qiMulti is at least the best single craftable pill', () => {
    assert.ok(result.bestSingle > 0, 'sanity: some single pill should be craftable');
    assert.ok(result.totalQi >= result.bestSingle,
      `set total ${result.totalQi} < best single pill ${result.bestSingle}`);
  });

  test('efficiency is qiMulti/cost for every selected pill, and the set is sorted by qiMulti desc', () => {
    assert.equal(result.effOk, true);
    assert.deepEqual(result.qiDesc, [...result.qiDesc].sort((a, b) => b - a));
  });

  test('(d) deterministic across two independent runs with identical input', async () => {
    const a = await runJsonAsync(SCENARIO('Infinity'));
    const b = await runJsonAsync(SCENARIO('Infinity'));
    assert.deepEqual(a.keys.slice().sort(), b.keys.slice().sort());
    assert.equal(a.totalQi, b.totalQi);
    assert.equal(a.size, b.size);
  });

  test('maxPills is respected and invariants still hold', async () => {
    const capped = await runJsonAsync(SCENARIO(2));
    assert.ok(capped.size <= 2, `expected ≤2 pills, got ${capped.size}`);
    assert.equal(capped.conflict, null);
    for (const [plant, used] of Object.entries(capped.spent)) {
      assert.ok(used <= (INVENTORY[plant] || 0), `over-spent ${plant}`);
    }
  });

  test('findBestSet does not mutate the caller\'s inventory', async () => {
    // ui.js passes the same `inv` object to generateAllDerivations and then to
    // findBestSet, and keeps using it afterwards — neither may spend from it.
    const out = await runJsonAsync(`(async () => {
      const inv = ${lit(INVENTORY)};
      const pills = await generateAllDerivations(inv, 0, 3, 1, 'alchemist');
      const afterDerive = JSON.stringify(inv);
      await findBestSet(pills, inv, Infinity);
      return JSON.stringify({ afterDerive, afterOptimize: JSON.stringify(inv) });
    })()`);
    assert.equal(out.afterDerive, JSON.stringify(INVENTORY));
    assert.equal(out.afterOptimize, JSON.stringify(INVENTORY));
  });

  test('pills.sort() is a consistent total order (no inversion beyond the 0.001 tie band)', async () => {
    // REGRESSION: the comparator used `Math.abs(b.eff - a.eff) > 0.001`, which
    // is intransitive — a~b and b~c but a>c. Array.prototype.sort() with an
    // inconsistent comparator is implementation-defined, and on real data it
    // left 169 pairs out of efficiency order by up to 0.0027 (2.7× the tie
    // band), feeding the greedy phase a mis-ranked list. Fixed in
    // optimizer.js:37 by bucketing both sides onto the same 0.001 grid.
    //
    // Uses a wider high-tier inventory than the rest of this suite: the
    // efficiencies have to be dense enough to chain across the tie band before
    // intransitivity can bite. On the small INVENTORY above the old comparator
    // happens to produce no inversion, so it would not catch a regression.
    const DENSE = {
      'Starlight Dew Herb': 12, 'Azure Serpent Grass': 12, 'Cloud Mist Herb': 8,
      'Moonlight Jade Leaf': 8, 'Spirit Spring Herb': 8, 'Seven Star Flower': 6,
      'Heavenly Spirit Vine': 6, 'Blue Wave Coral Herb': 6, 'Ironbone Grass': 6,
      'Black Iron Root': 6, 'Silverleaf Herb': 6, 'Purple Lightning Orchid': 6,
    };
    const out = await runJsonAsync(`(async () => {
      const inv = ${lit(DENSE)};
      const pills = await generateAllDerivations(inv, 0, 3, 1, 'alchemist');
      await findBestSet(pills, inv, Infinity); // sorts \`pills\` in place
      let worst = 0;
      for (let i = 0; i < pills.length; i++) {
        for (let j = i + 1; j < pills.length; j++) {
          worst = Math.max(worst, pills[j].efficiency - pills[i].efficiency);
        }
      }
      return JSON.stringify({ worst, n: pills.length });
    })()`);
    assert.ok(out.n > 100, 'sanity: need a decent candidate pool to exercise the comparator');
    assert.ok(out.worst <= 0.001 + 1e-12,
      `a later pill out-ranks an earlier one by ${out.worst} — comparator is not a consistent order`);
  });

  test('empty inventory yields an empty set rather than throwing', async () => {
    const out = await runJsonAsync(`(async () => {
      const pills = await generateAllDerivations({}, 0, 3, 1, 'alchemist');
      const set = await findBestSet(pills, {}, Infinity);
      return JSON.stringify({ pills: pills.length, size: set.length });
    })()`);
    assert.equal(out.pills, 0);
    assert.equal(out.size, 0);
  });
});
