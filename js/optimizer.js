// ============================================================
// OPTIMIZER.JS — GRASP Algorithm (Greedy + Local Search)
// ============================================================

// ------------------------------------------------------------
// 1. INITIALIZATION
// ------------------------------------------------------------

// O(1) Lookup for base recipes
const RECIPE_BY_NAME = new Map();
for (const r of RECIPES) {
  RECIPE_BY_NAME.set(r.name, r);
}

// ------------------------------------------------------------
// 2. MAIN ENTRY POINT
// ------------------------------------------------------------

/**
 * Finds the optimal set of non-conflicting pills based on inventory.
 */
async function findBestSet(pills, initialInventory, maxPills) {
  let lastYieldTime = performance.now();

  for (let i = 0; i < pills.length; i++) {
    const pill = pills[i];
    pill.cost = getCost(pill.ingredients);
    pill.qiMulti = getTotalQiMulti(pill); 
    pill.efficiency = pill.cost > 0 ? (pill.qiMulti / pill.cost) : 0;
    
    if (performance.now() - lastYieldTime > 40) {
      await new Promise(r => setTimeout(r, 0));
      lastYieldTime = performance.now();
    }
  }

  pills.sort((a, b) => {
    const diff = b.efficiency - a.efficiency;
    if (Math.abs(diff) > 0.001) return diff;
    
    const qiDiff = b.qiMulti - a.qiMulti;
    if (qiDiff !== 0) return qiDiff;
    
    return a.name.localeCompare(b.name);
  });

  const currentInv = { ...initialInventory };
  const selectedPills = [];
  const unselectedPills = [];

  await buildGreedySolution(pills, currentInv, selectedPills, unselectedPills, maxPills);
  await optimizeLocalSearch(currentInv, selectedPills, unselectedPills, maxPills);

  selectedPills.sort((a, b) => b.qiMulti - a.qiMulti);
  return selectedPills;
}

// ------------------------------------------------------------
// 3. GRASP PHASES
// ------------------------------------------------------------

async function buildGreedySolution(pills, currentInv, selectedPills, unselectedPills, maxPills) {
  let lastYieldTime = performance.now();

  for (const pill of pills) {
    if (performance.now() - lastYieldTime > 40) {
      await new Promise(r => setTimeout(r, 0));
      lastYieldTime = performance.now();
    }

    if (selectedPills.length < maxPills && canCraft(pill.ingredients, currentInv) && !hasConflict(pill, selectedPills, -1)) {
      selectedPills.push(pill);
      deductInv(currentInv, pill.ingredients);
    } else {
      unselectedPills.push(pill);
    }
  }
}

async function optimizeLocalSearch(currentInv, selectedPills, unselectedPills, maxPills) {
  let improved = true;
  let lastYieldTime = performance.now();

  while (improved) {
    improved = false;

    if (performance.now() - lastYieldTime > 40) {
      await new Promise(r => setTimeout(r, 0));
      lastYieldTime = performance.now();
    }

    for (let i = unselectedPills.length - 1; i >= 0; i--) {
      if (performance.now() - lastYieldTime > 40) {
        await new Promise(r => setTimeout(r, 0));
        lastYieldTime = performance.now();
      }

      const candidate = unselectedPills[i];
      if (selectedPills.length < maxPills && canCraft(candidate.ingredients, currentInv) && !hasConflict(candidate, selectedPills, -1)) {
        selectedPills.push(candidate);
        deductInv(currentInv, candidate.ingredients);
        unselectedPills.splice(i, 1);
        improved = true;
      }
    }

    if (improved) continue;

    improved = await attemptLocalSearchSwap(currentInv, selectedPills, unselectedPills);
  }
}

async function attemptLocalSearchSwap(currentInv, selectedPills, unselectedPills) {
  let lastYieldTime = performance.now();

  for (let i = 0; i < selectedPills.length; i++) {
    const currentSelection = selectedPills[i];
    
    for (let j = 0; j < unselectedPills.length; j++) {
      
      if (performance.now() - lastYieldTime > 40) {
        await new Promise(r => setTimeout(r, 0));
        lastYieldTime = performance.now();
      }

      const candidate = unselectedPills[j];
      
      if (candidate.qiMulti <= currentSelection.qiMulti) continue;

      restoreInv(currentInv, currentSelection.ingredients);

      const canSwap = canCraft(candidate.ingredients, currentInv) && !hasConflict(candidate, selectedPills, i);
      
      if (canSwap) {
        deductInv(currentInv, candidate.ingredients);
        unselectedPills[j] = currentSelection;
        selectedPills[i] = candidate;
        return true; 
      }
      
      deductInv(currentInv, currentSelection.ingredients);
    }
  }
  return false;
}

// ------------------------------------------------------------
// 4. CONFLICT & SIMILARITY LOGIC
// ------------------------------------------------------------

function hasConflict(newPill, currentSet, ignoreIndex) {
  for (let i = 0; i < currentSet.length; i++) {
    if (i === ignoreIndex) continue;
    if (arePillsSimilar(currentSet[i], newPill)) return true;
  }
  return false;
}

function arePillsSimilar(p1, p2) {
  if (p1.basePill !== p2.basePill) return false;
  for (const dur of p1.predictedDurations) {
    if (p2.predictedDurations.has(dur)) return true;
  }
  return false;
}

// ------------------------------------------------------------
// 5. COMBINATORIAL MATH
// ------------------------------------------------------------

function getAllPredictedDurations(pill) {
  const baseRecipe = RECIPE_BY_NAME.get(pill.basePill);
  if (!baseRecipe) return new Set([0]);

  const baseEffect = baseRecipe.effects.find(e => e.stat === "QiMulti" || e.duration > 0);
  const baseDur = baseEffect ? baseEffect.duration : 0;
  
  if (baseDur === 0) return new Set([0]); 

  const pIngr = pill.ingredients;
  const bIngr = baseRecipe.ingredients;
  const allPlantNames = new Set([...Object.keys(pIngr), ...Object.keys(bIngr)]);

  let fixedScoreSum = 0;
  let variableChoices = [];

  allPlantNames.forEach(name => {
    const delta = (pIngr[name] || 0) - (bIngr[name] || 0);
    if (delta === 0) return;

    const plantData = PLANTS[name];
    
    if (plantData.score && plantData.score.length > 1) {
      for (let i = 0; i < Math.abs(delta); i++) {
        const sign = Math.sign(delta);
        variableChoices.push(plantData.score.map(s => s * sign));
      }
    } else {
      fixedScoreSum += delta * plantData.score[0];
    }
  });

  let possibleScores = [fixedScoreSum];
  for (const choices of variableChoices) {
    const nextScores = [];
    for (const currentSum of possibleScores) {
      for (const choice of choices) {
        nextScores.push(currentSum + choice);
      }
    }
    possibleScores = nextScores;
  }
  
  const finalDurations = new Set();
  for (const score of possibleScores) {
    const clampedScore = Math.max(-50, Math.min(50, score));
    const dur = Math.round(baseDur * (1 + clampedScore / 100));
    finalDurations.add(dur);
  }

  return finalDurations;
}

// ------------------------------------------------------------
// 6. INVENTORY & COST UTILITIES
// ------------------------------------------------------------

function deductInv(inventory, ingredients) {
  for (const [plant, qty] of Object.entries(ingredients)) {
    inventory[plant] -= qty;
  }
}

function restoreInv(inventory, ingredients) {
  for (const [plant, qty] of Object.entries(ingredients)) {
    inventory[plant] = (inventory[plant] || 0) + qty;
  }
}

function getCost(ingredients) {
  let cost = 0;
  for (const [plant, qty] of Object.entries(ingredients)) {
    cost += qty * PLANTS[plant].score[0]; 
  }
  return cost;
}

// ------------------------------------------------------------
// 7. SUMMARY REPORTING
// ------------------------------------------------------------

function computeSetSummary(bestSet) {
  const qiStats = bestSet.map(p => ({
    name: p.name,
    type: p.type,
    qiMulti: getTotalQiMulti(p), 
    effects: p.effects,
    ingredients: p.ingredients,
  }));

  const totalQi = qiStats.reduce((s, p) => s + p.qiMulti, 0);
  return { pills: qiStats, totalQi };
}