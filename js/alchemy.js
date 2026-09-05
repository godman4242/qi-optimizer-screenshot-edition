// ============================================================
// ALCHEMY.JS — Derivation Engine
// ============================================================

// ------------------------------------------------------------
// 1. INITIALIZATION & CONSTANTS
// ------------------------------------------------------------

// Filtered once on load: Ignore unknown effects and the Death Pill
const CANDIDATE_RECIPES = RECIPES.filter(r =>
  r.effects.length > 0 && !r.effects.some(e => e.stat === "DEATH")
);

// Plants grouped by family for fast lookup during derivation
const FAMILY_PLANTS = {};
for (const [name, data] of Object.entries(PLANTS)) {
  if (!FAMILY_PLANTS[data.family]) FAMILY_PLANTS[data.family] = [];
  FAMILY_PLANTS[data.family].push(name);
}

for (const fam of Object.values(FAMILY_PLANTS)) {
  fam.sort((a, b) => PLANTS[a].score[0] - PLANTS[b].score[0]);
}

// O(1) Lookup Map for anomalies & pre-computed family distributions
const RECIPE_BY_INGREDIENTS = new Map();

for (const r of RECIPES) {
  RECIPE_BY_INGREDIENTS.set(ingredientKey(r.ingredients), r);
  r.familyDist = getFamilyDist(r.ingredients); 
}

// ------------------------------------------------------------
// 2. MAIN ENTRY POINT
// ------------------------------------------------------------

/**
 * Orchestrates the generation, deduplication, and filtering of all pills.
 */
async function generateAllDerivations(inventory, minDuration, maxSize, minQi, calcMode) {
  const allGenerated = [];

  // 1. Generate all raw derivations
  for (const baseRecipe of CANDIDATE_RECIPES) {
    const derived = await deriveFromRecipe(baseRecipe, inventory, maxSize, calcMode);
    allGenerated.push(...derived);
  }

  // 2. Deduplicate
  const deduped = deduplicatePills(allGenerated);

  // 3. Filter using dedicated validation rules
  return deduped.filter(pill => isValidPill(pill, minDuration, minQi));
}

// ------------------------------------------------------------
// 3. GENERATION ENGINE
// ------------------------------------------------------------

async function deriveFromRecipe(baseRecipe, inventory, maxSize, calcMode) {
  const pills = [];
  const baseList = flattenIngredients(baseRecipe.ingredients);
  const indices = Array.from({ length: baseList.length }, (_, i) => i);
  
  const subsets = [];
  for (let size = 1; size <= maxSize; size++) {
    subsets.push(...getCombinations(indices, size));
  }

  const seenMaps = new Set();
  const regKey = ingredientKey(baseRecipe.ingredients);
  
  seenMaps.add(regKey);
  
  // Note: canCraft is assumed to be globally available from optimizer.js
  if (canCraft(baseRecipe.ingredients, inventory)) {
    pills.push(computePill(baseRecipe, baseRecipe.ingredients, baseRecipe.ingredients, calcMode));
  }

  let lastYieldTime = performance.now();

  for (const subset of subsets) {
    const candidatesPerSlot = subset.map(idx => {
      const plant = baseList[idx];
      const fam = PLANTS[plant].family;
      return FAMILY_PLANTS[fam].filter(p => p !== plant);
    });

    const combos = cartesian(candidatesPerSlot);

    for (const combo of combos) {      
      // Keep UI responsive during heavy combinatorial loops
      if (performance.now() - lastYieldTime > 40) { 
        await new Promise(resolve => setTimeout(resolve, 0));
        lastYieldTime = performance.now();
      }

      const newList = [...baseList];
      for (let i = 0; i < subset.length; i++) {
        newList[subset[i]] = combo[i];
      }

      // Fast O(N log N) array key generation to avoid heavy object building
      const key = newList.slice().sort().join("|");
      if (seenMaps.has(key)) continue;
      seenMaps.add(key);

      const newIngr = countIngredients(newList);

      if (canCraft(newIngr, inventory)) {
        pills.push(computePill(baseRecipe, baseRecipe.ingredients, newIngr, calcMode));
      }
    }
  }

  return pills;
}

function computePill(baseRecipe, baseIngredients, newIngredients, calcMode) {
  const swapped = getSwaps(baseIngredients, newIngredients);
  
  let sumTransform = 0;
  for (const { oldPlant, newPlant } of swapped) {
    sumTransform += PLANTS[newPlant].score[0] - PLANTS[oldPlant].score[0];
  }

  const isRegular = swapped.length === 0;
  const type = isRegular ? "Regular" : (sumTransform > 0 ? "Heavenly" : "Imperfect");
  const finalName = isRegular ? baseRecipe.name : `${type} ${baseRecipe.name}`;

  const cappedSum = Math.max(-50, Math.min(50, sumTransform));
  let mult = 1 + (cappedSum / 100);

  if (calcMode === 'handcrafted') mult += 2; 

  const newEffects = baseRecipe.effects.map(e => {
    if (calcMode === 'alchemist' && isRegular) return { ...e };
    return {
      stat: e.stat,
      pct: Math.ceil(e.pct * mult),
      duration: e.duration === 0 ? 0 : Math.round(e.duration * mult),
    };
  });

  const pill = {
    name: finalName,
    type: type,
    basePill: baseRecipe.name,
    ingredients: { ...newIngredients },
    effects: newEffects,
  };

  // Pre-compute durations if optimizer module is loaded
  if (typeof getAllPredictedDurations === 'function') {
    pill.predictedDurations = getAllPredictedDurations(pill);
  }

  return pill;
}
// ------------------------------------------------------------
// 4. VALIDATION MODULES
// ------------------------------------------------------------

function isValidPill(pill, minDuration, minQi) {
  if (!hasValidDuration(pill, minDuration)) return false;

  const totalQi = getTotalQiMulti(pill);
  
  if (totalQi <= 0 || totalQi < minQi) return false;

  if (!meetsRarityEfficiency(pill.ingredients, totalQi)) return false;
  if (hasRecipeConflict(pill)) return false;

  return true;
}

function hasValidDuration(pill, minDuration) {
  return pill.effects.some(e => e.duration >= minDuration || e.duration === 0);
}

function getTotalQiMulti(pill) {
  let totalQi = 0;
  for (const e of pill.effects) {
    if (e.stat === "QiMulti") totalQi += e.pct;
  }
  return totalQi;
}

function meetsRarityEfficiency(ingredients, totalQi) {
  let hasEpic = false;
  let hasLegendary = false;
  
  for (const plantName of Object.keys(ingredients)) {
    const rarity = PLANTS[plantName].rarity;
    if (rarity === "E") hasEpic = true;
    if (rarity === "L") hasLegendary = true;
  }

  if (hasLegendary && totalQi < 40) return false;
  if (hasEpic && totalQi < 15) return false;

  return true;
}

function hasRecipeConflict(pill) {
  const pillFamDist = getFamilyDist(pill.ingredients);

  for (const gameReg of RECIPES) {
    if (gameReg.name === pill.basePill) continue;

    const commonPlants = countCommonPlants(pill.ingredients, gameReg.ingredients);
    const regFamDist = gameReg.familyDist || getFamilyDist(gameReg.ingredients);
    const commonFamilies = countCommonFamilies(pillFamDist, regFamDist);

    if (commonPlants >= 3 && commonFamilies >= 6) return true;
  }
  return false;
}

function deduplicatePills(pills) {
  const seen = new Set();
  const deduped = [];
  
  for (const pill of pills) {
    const key = pill.name + "|" + ingredientKey(pill.ingredients);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(pill);
    }
  }
  
  return deduped;
}

// ------------------------------------------------------------
// 5. ALCHEMY UTILITIES
// ------------------------------------------------------------

function getSwaps(baseIngr, newIngr) {
  const swaps = [];
  const families = ["VITALITY", "ENDURANCE", "AGILITY", "SPIRIT"];

  for (const fam of families) {
    const oldPlants = expandFamily(baseIngr, fam);
    const newPlants = expandFamily(newIngr, fam);

    for (const basePlant of oldPlants) {
      const matchIndex = newPlants.indexOf(basePlant);
      if (matchIndex !== -1) {
        newPlants.splice(matchIndex, 1);
      } else {
        swaps.push({ oldPlant: basePlant, newPlant: newPlants.pop() });
      }
    }
  }
  return swaps;
}

function findAnomalyRecipe(baseRecipe, newIngredients) {
  const match = RECIPE_BY_INGREDIENTS.get(ingredientKey(newIngredients));
  return (match && match.name !== baseRecipe.name) ? match : null;
}

function ingredientKey(ingr) {
  return Object.entries(ingr)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, q]) => `${p}:${q}`).join("|");
}

function countCommonPlants(ingrA, ingrB) {
  let count = 0;
  for (const p in ingrA) {
    if (ingrB[p]) count += Math.min(ingrA[p], ingrB[p]);
  }
  return count;
}

function countCommonFamilies(distA, distB) {
  let count = 0;
  for (const fam of ["VITALITY", "ENDURANCE", "AGILITY", "SPIRIT"]) {
    count += Math.min(distA[fam] || 0, distB[fam] || 0);
  }
  return count;
}

function flattenIngredients(ingredients) {
  const list = [];
  for (const [plant, qty] of Object.entries(ingredients)) {
    for (let i = 0; i < qty; i++) list.push(plant);
  }
  return list;
}

function countIngredients(plantList) {
  const ingr = {};
  for (const p of plantList) {
    ingr[p] = (ingr[p] || 0) + 1;
  }
  return ingr;
}

function expandFamily(ingredients, familyTarget) {
  const list = [];
  for (const [p, q] of Object.entries(ingredients)) {
    if (PLANTS[p].family === familyTarget) {
      for (let i = 0; i < q; i++) list.push(p);
    }
  }
  return list;
}

function getFamilyDist(ingredients) {
  const dist = {};
  for (const [plant, qty] of Object.entries(ingredients)) {
    const fam = PLANTS[plant].family;
    dist[fam] = (dist[fam] || 0) + qty;
  }
  return dist;
}

function canCraft(ingredients, inventory) {
  for (const [plant, qty] of Object.entries(ingredients)) {
    if ((inventory[plant] || 0) < qty) return false;
  }
  return true;
}

// ------------------------------------------------------------
// 6. MATH UTILITIES
// ------------------------------------------------------------

function getCombinations(array, size) {
  const result = [];
  function recurse(start, current) {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < array.length; i++) {
      current.push(array[i]);
      recurse(i + 1, current);
      current.pop();
    }
  }
  recurse(0, []);
  return result;
}

function cartesian(arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesian(rest);
  const result = [];
  for (const item of first) {
    for (const combo of restProduct) {
      result.push([item, ...combo]);
    }
  }
  return result;
}