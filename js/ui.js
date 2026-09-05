// ============================================================
// UI.JS — Interface & Orchestration
// ============================================================

// ------------------------------------------------------------
// 1. STATE & DOM CACHE
// ------------------------------------------------------------

let inventoryState = {};
let uiSettings = {
  minQi: 100, minDuration: 0, maxPills: '', sortMode: 'grouped', calcMode: 'alchemist'
};

let currentBestSet = [];
let currentTotalDerivations = 0;
let currentSortMode = 'grouped';
let currentCalcMode = 'alchemist';

let cachedCards = []; 
let saveTimeout = null;

// ------------------------------------------------------------
// 2. INITIALIZATION
// ------------------------------------------------------------

async function initUI() {
  loadAllState();
  renderInventoryGrid();
  initVision();
  
  cachedCards = Array.from(document.querySelectorAll('.plant-card'));

  document.getElementById('filter-qi').value = uiSettings.minQi;
  document.getElementById('filter-duration').value = uiSettings.minDuration;
  document.getElementById('filter-max-pills').value = uiSettings.maxPills;
  document.getElementById('filter-calc-mode').value = uiSettings.calcMode;

  document.getElementById('btn-optimize').addEventListener('click', runOptimizer);
  document.getElementById('btn-clear').addEventListener('click', (e) => withConfirmation(e.target, 'Clear All', executeClearAll));
  document.getElementById('btn-clear-results').addEventListener('click', (e) => withConfirmation(e.target, 'Clear Recipes', executeClearResults));
  
  const searchInput = document.getElementById('search-plant');
  searchInput.addEventListener('input', debounce(filterPlants, 150));
  searchInput.addEventListener('focus', () => {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({'event': 'focus_search'});
  });
  
  document.getElementById('filter-calc-mode').addEventListener('change', (e) => {
    uiSettings.calcMode = e.target.value;
    currentCalcMode = e.target.value;
    saveUISettings();
  });

  ['filter-qi', 'filter-duration', 'filter-max-pills'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        updateResultsTitle();
        saveUISettings();
      });
      el.addEventListener('focus', () => {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({'event': `focus_${id}`});
      });
    }
  });

  document.getElementById('results-summary').addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'btn-toggle-sort') {
      currentSortMode = currentSortMode === 'grouped' ? 'qimulti' : 'grouped';
      saveUISettings();
      e.target.disabled = true;
      e.target.textContent = 'Sorting...';
      await renderResults();
    }
  });

  updateResultsTitle();
  await loadResultsState();
}

// ------------------------------------------------------------
// 3. CORE HANDLERS (OPTIMIZER)
// ------------------------------------------------------------

async function runOptimizer() {
  const btn = document.getElementById('btn-optimize');
  const resultsEl = document.getElementById('results');
  const summaryEl = document.getElementById('results-summary');
  
  btn.disabled = true;
  btn.textContent = '⚗️ Calculating...';

  // AUDIO INTEGRATION: Start looping sound
  if (window.AudioController) window.AudioController.startOptimizing();

  summaryEl.innerHTML = '';
  resultsEl.innerHTML = '<div class="no-results loading">⚗️ Extracting Qi...</div>';
  
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    const minDuration = parseInt(document.getElementById('filter-duration').value) || 0;
    const qiInput = document.getElementById('filter-qi').value;
    const minQi = qiInput === "" ? 100 : parseInt(qiInput);
    
    const maxPillsInput = document.getElementById('filter-max-pills').value;
    const maxPills = maxPillsInput === "" ? Infinity : parseInt(maxPillsInput);
    const maxSize = 3;

    const inv = {};
    for (const [p, q] of Object.entries(inventoryState)) { 
      if (q > 0) inv[p] = q; 
    }

    const allPills = await generateAllDerivations(inv, minDuration, maxSize, minQi, currentCalcMode);
    currentBestSet = await findBestSet(allPills, inv, maxPills);
    
    currentBestSet.forEach((p, idx) => {
      p.id = `p_${Date.now()}_${idx}`;
      p.isDone = false;
    });

    currentTotalDerivations = allPills.length;
    saveResultsState();
    
    await renderResults();

    // AUDIO INTEGRATION: Stop looping and play end sound
    if (window.AudioController) window.AudioController.playOptimizeEnd();

  } catch (err) {
    console.error(err);
    if (window.AudioController) window.AudioController.stopOptimizing(); // Stop on error
    resultsEl.innerHTML = `<div class="error-msg">❌ Error: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '⚗️ Optimize QiMulti';
  }
}

// ------------------------------------------------------------
// 4. RENDERING LOGIC
// ------------------------------------------------------------

function renderInventoryGrid() {
  const grid = document.getElementById('inventory-grid');
  const rarities = ['C', 'U', 'R', 'E', 'L'];
  const rarityLabels = { C: 'Common', U: 'Uncommon', R: 'Rare', E: 'Epic', L: 'Legendary' };
  const familyEmoji = { VITALITY: '❤️', ENDURANCE: '🛡️', AGILITY: '⚡', SPIRIT: '🔮' };

  grid.innerHTML = rarities.map(r => {
    const plants = Object.entries(PLANTS)
      .filter(([_, data]) => data.rarity === r)
      .sort((a, b) => a[1].score[0] - b[1].score[0]);

    const cards = plants.map(([name, data]) => {
      const qty = inventoryState[name] || 0;
      const hasStock = qty > 0 ? 'has-stock' : '';
      const safeNameEsc = name.replace(/'/g, "\\'");
      return `
        <div class="plant-card rarity-${r} ${hasStock}" data-plant="${name.replace(/"/g, '&quot;')}" data-family="${data.family}">
          <div class="plant-info">
            <span class="plant-score">⭐ ${data.score[0]} ~</span>
            <span class="plant-name">${name}</span>
            <span class="plant-family-tag">
              <span class="family-emoji">${familyEmoji[data.family]}</span> <i>${data.family.toLowerCase()}</i>
            </span>
          </div>
          <div class="qty-controls">
            <button class="qty-btn" onclick="adjustQty('${safeNameEsc}', -1)">−</button>
            <input class="qty-input" type="number" min="0" value="${qty}" 
                   oninput="setQty('${safeNameEsc}', this.value)">
            <button class="qty-btn" onclick="adjustQty('${safeNameEsc}', 1)">+</button>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="rarity-section">
        <div class="rarity-header header-${r}">
          <span class="rarity-symbol">${r}</span>
          <span class="rarity-text">${rarityLabels[r]}</span>
        </div>
        ${cards}
      </div>
    `;
  }).join('');
}

async function renderResults() {
  const resultsEl = document.getElementById('results');
  const summaryEl = document.getElementById('results-summary');

  if (!currentBestSet || currentBestSet.length === 0) {
    summaryEl.innerHTML = '';
    resultsEl.innerHTML = '<div class="no-results">No pills found with QiMulti > 100%. Add more plants to your inventory.</div>';
    return;
  }

  if (currentBestSet.length > 30) {
    resultsEl.innerHTML = '<div class="no-results loading">⚗️ Sorting and grouping results...</div>';
    await new Promise(r => requestAnimationFrame(r));
  }

  const sortedSet = await applySorting(currentBestSet, currentSortMode);
  const summary = computeSetSummary(sortedSet);
  const sortBtnText = currentSortMode === 'grouped' ? 'Sort by QiMulti' : 'Sort by Proximity';
  const modeText = currentCalcMode === 'handcrafted' ? 'Handcrafted' : 'Alchemist';

  let summaryHtml = `
    <div class="summary-box">
      <span class="summary-total">+${summary.totalQi}% Total QiMulti</span>
      <span class="summary-pills">${summary.pills.length} unique pill(s)</span>
      <span class="summary-derived">${currentTotalDerivations} derivations analyzed</span>
      <span class="summary-mode">${modeText}</span>
      <button id="btn-toggle-sort" class="btn sort-toggle-btn">${sortBtnText}</button>
    </div>
  `;

  if (currentSortMode === 'grouped') {
    summaryHtml += `
      <div class="summary-box hint-box">
        <span class="hint-text">
          <span class="hint-mock-tag">Plant Name</span> 
          <span>Green borders indicate plants that were swapped compared to the pill directly above it</span>
        </span>
      </div>
    `;
  }

  summaryEl.innerHTML = summaryHtml;

  let prevExpanded = null;

  resultsEl.innerHTML = sortedSet.map((p, i) => {
    const pillQi = getTotalQiMulti(p);
    const craftedClass = p.isDone ? 'crafted' : '';
    
    let expanded = [];
    for (const [plant, qty] of Object.entries(p.ingredients)) {
      for (let k = 0; k < qty; k++) expanded.push(plant);
    }

    let diffFlags = new Array(6).fill(false);
    let separatorHtml = '';

    if (currentSortMode === 'grouped') {
      if (i > 0 && sortedSet[i-1].basePill === p.basePill && prevExpanded) {
        let aligned = new Array(6).fill(null);
        let pool = [...expanded];
        
        prevExpanded.forEach((prevP, idx) => {
          const m = pool.indexOf(prevP);
          if (m !== -1) aligned[idx] = pool.splice(m, 1)[0];
        });
        
        aligned = aligned.map((v, idx) => {
          if (v === null) { 
            diffFlags[idx] = true; 
            return pool.shift(); 
          }
          return v;
        });
        expanded = aligned;
      } else {
        expanded.sort((a,b) => PLANTS[b].score[0] - PLANTS[a].score[0]);
      }
      
      if (i > 0 && sortedSet[i - 1].basePill !== p.basePill) {
        separatorHtml = `<div class="group-divider"></div>`;
      }
    } else {
      expanded.sort((a,b) => PLANTS[b].score[0] - PLANTS[a].score[0]);
    }
    
    prevExpanded = expanded;

    const ingrHtml = expanded.map((name, idx) => {
      const swapped = diffFlags[idx] ? 'swapped' : '';
      return `<span class="ingr-tag rarity-${PLANTS[name].rarity} ${swapped}">${name}</span>`;
    }).join('');

    const effectsHtml = p.effects.map(e => {
      const durStr = e.duration === 0 ? '<span class="perm-badge">♾ Permanent</span>' : `<span class="dur-badge">⏱ ${e.duration}s</span>`;
      return `<span class="effect-tag ${e.stat.toLowerCase()}">${e.stat === 'QiMulti' ? '✨' : ''}+${e.pct}% ${e.stat} ${durStr}</span>`;
    }).join('');

    const qiBadgeHtml = pillQi > 0 ? `<span class="pill-qi">+${pillQi}% QiMulti</span>` : '';
    const animDelay = Math.min(i * 30, 800);

    return `
      ${separatorHtml}
      <div class="pill-card ${p.type.toLowerCase()} ${craftedClass}" style="animation-delay:${animDelay}ms" data-pill-id="${p.id}">
        <div class="pill-header">
          <span class="pill-rank">#${i + 1}</span>
          <span class="pill-name">${p.name}</span>
          <span class="pill-type-badge ${p.type.toLowerCase()}">${p.type}</span>
          ${qiBadgeHtml}
          <label class="craft-toggle">
            <input type="checkbox" ${p.isDone ? 'checked' : ''} onchange="togglePillDone(this, '${p.id}')"> Done
          </label>
        </div>
        <div class="pill-effects">${effectsHtml}</div>
        <div class="pill-ingredients">${ingrHtml}</div>
      </div>
    `;
  }).join('');
}

// ------------------------------------------------------------
// 5. INVENTORY LOGIC
// ------------------------------------------------------------

function adjustQty(name, delta) {
  const val = Math.max(0, (inventoryState[name] || 0) + delta);
  setQty(name, val);
}

function setQty(name, val) {
  const num = Math.max(0, Math.floor(Number(val) || 0));
  inventoryState[name] = num;
  
  const safeName = name.replace(/"/g, '\\"');
  const card = document.querySelector(`.plant-card[data-plant="${safeName}"]`);
  
  if (card) {
    card.classList.toggle('has-stock', num > 0);
    const input = card.querySelector('.qty-input');
    if (input && parseInt(input.value) !== num) {
      input.value = num;
    }
  }
  
  debouncedSaveInventory();
}

function togglePillDone(checkbox, pillId) {
  const pill = currentBestSet.find(p => p.id === pillId);
  if (!pill) return;

  const isChecked = checkbox.checked;
  
  // AUDIO INTEGRATION
  if (window.AudioController) {
    if (isChecked) window.AudioController.playDone();
    else window.AudioController.decrementCraftCount();
  }

  pill.isDone = isChecked;
  checkbox.closest('.pill-card').classList.toggle('crafted', isChecked);

  for (const [name, qty] of Object.entries(pill.ingredients)) {
    const current = inventoryState[name] || 0;
    setQty(name, isChecked ? Math.max(0, current - qty) : current + qty);
  }
  saveResultsState();

  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({
    'event': 'click_recipe_done',
    'recipe_action': isChecked ? 'checked' : 'unchecked'
  });
}

// ------------------------------------------------------------
// 6. PERSISTENCE (LOCALSTORAGE)
// ------------------------------------------------------------

function saveUISettings() {
  uiSettings.minQi = document.getElementById('filter-qi').value;
  uiSettings.minDuration = document.getElementById('filter-duration').value;
  uiSettings.maxPills = document.getElementById('filter-max-pills').value;
  uiSettings.sortMode = currentSortMode;
  localStorage.setItem('alchemySettings', JSON.stringify(uiSettings));
}

function saveInventory() {
  const cleanInv = Object.fromEntries(Object.entries(inventoryState).filter(([_, v]) => v > 0));
  localStorage.setItem('alchemyInventory', JSON.stringify(cleanInv));
}

function loadAllState() {
  try {
    inventoryState = JSON.parse(localStorage.getItem('alchemyInventory')) || {};
    const savedUi = JSON.parse(localStorage.getItem('alchemySettings'));
    if (savedUi) {
      uiSettings = { ...uiSettings, ...savedUi };
      currentSortMode = uiSettings.sortMode || 'grouped';
      currentCalcMode = uiSettings.calcMode || 'alchemist';
    }
  } catch (e) { console.error("Storage corrupt", e); }
}

function saveResultsState() {
  localStorage.setItem('alchemyResults', JSON.stringify({
    bestSet: currentBestSet, 
    totalDerivations: currentTotalDerivations,
    calcMode: currentCalcMode
  }));
}

async function loadResultsState() {
  try {
    const saved = JSON.parse(localStorage.getItem('alchemyResults'));
    if (saved && saved.bestSet && saved.bestSet.length > 0) {
      currentBestSet = saved.bestSet;
      currentTotalDerivations = saved.totalDerivations || 0;
      currentCalcMode = saved.calcMode || 'alchemist';
      await renderResults();
    }
  } catch (e) { console.error("Results corrupt", e); }
}

// ------------------------------------------------------------
// 7. UTILS & UI HELPERS
// ------------------------------------------------------------

function withConfirmation(btn, originalText, callback) {
  if (btn.dataset.confirm === 'true') {
    if (window.AudioController) window.AudioController.playBin(); // AUDIO INTEGRATION (2nd click)
    callback();
    btn.dataset.confirm = 'false';
    btn.textContent = originalText;
    btn.classList.remove('btn-confirm-waiting');
  } else {
    btn.dataset.confirm = 'true';
    btn.textContent = '⚠️ CONFIRM ?';
    btn.classList.add('btn-confirm-waiting');
    setTimeout(() => {
      btn.dataset.confirm = 'false';
      btn.textContent = originalText;
      btn.classList.remove('btn-confirm-waiting');
    }, 3000);
  }
}

function executeClearAll() {
  inventoryState = {};
  saveInventory();
  renderInventoryGrid();
  cachedCards = Array.from(document.querySelectorAll('.plant-card'));
  executeClearResults();
}

function executeClearResults() {
  currentBestSet = [];
  document.getElementById('results').innerHTML = '';
  document.getElementById('results-summary').innerHTML = '';
  localStorage.removeItem('alchemyResults');
  
  // AUDIO INTEGRATION: Reset achievements and crafted count
  if (window.AudioController) window.AudioController.resetState();
}

function filterPlants(e) {
  const q = e.target.value.toLowerCase().trim();
  const sections = document.querySelectorAll('#inventory-grid > .rarity-section');
  
  cachedCards.forEach(card => {
    const match = !q || card.dataset.plant.toLowerCase().includes(q) || card.dataset.family.toLowerCase().includes(q);
    card.style.display = match ? '' : 'none';
  });

  sections.forEach(section => {
    const visibleCards = section.querySelectorAll('.plant-card:not([style*="display: none"])');
    section.style.display = visibleCards.length > 0 ? '' : 'none';
  });
}

function updateResultsTitle() {
  const qi = document.getElementById('filter-qi').value || 100;
  const dur = document.getElementById('filter-duration').value || 0;
  const title = document.getElementById('results-title-text');
  if (title) title.textContent = `✨ Best Set — QiMulti ≥ ${qi}% | Min Duration ≥ ${dur}s`;
}

function debounce(fn, delay) {
  let t; 
  return (...args) => { 
    clearTimeout(t); 
    t = setTimeout(() => fn(...args), delay); 
  };
}

function debouncedSaveInventory() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveInventory, 1000);
}

document.addEventListener('DOMContentLoaded', initUI);

// ------------------------------------------------------------
// 8. PATHING & SORTING MATH
// ------------------------------------------------------------

function ingredientDistance(ingr1, ingr2) {
  let diff = 0;
  for (const p in ingr1) {
    const q1 = ingr1[p];
    const q2 = ingr2[p] || 0;
    diff += Math.abs(q1 - q2);
  }
  for (const p in ingr2) {
    if (!(p in ingr1)) diff += ingr2[p];
  }
  return diff / 2; 
}

async function optimizePath2Opt(path) {
  if (path.length <= 2) return path;
  
  let improved = true;
  let lastYield = performance.now();

  while (improved) {
    improved = false;
    for (let i = 1; i < path.length - 2; i++) {
      for (let j = i + 1; j < path.length - 1; j++) {
        
        if (performance.now() - lastYield > 40) {
          await new Promise(r => setTimeout(r, 0));
          lastYield = performance.now();
        }

        const d1 = ingredientDistance(path[i-1].ingredients, path[i].ingredients);
        const d2 = ingredientDistance(path[j].ingredients, path[j+1].ingredients);
        const d3 = ingredientDistance(path[i-1].ingredients, path[j].ingredients);
        const d4 = ingredientDistance(path[i].ingredients, path[j+1].ingredients);

        if (d3 + d4 < d1 + d2) {
          let left = i;
          let right = j;
          while (left < right) {
            const temp = path[left];
            path[left] = path[right];
            path[right] = temp;
            left++;
            right--;
          }
          improved = true;
        }
      }
    }
  }
  return path;
}

async function applySorting(bestSet, mode) {
  if (mode === 'qimulti') {
    return [...bestSet].sort((a, b) => getTotalQiMulti(b) - getTotalQiMulti(a));
  }

  const groups = {};
  for (const pill of bestSet) {
    if (!groups[pill.basePill]) groups[pill.basePill] = [];
    groups[pill.basePill].push(pill);
  }

  const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
    const rA = typeof RECIPE_BY_NAME !== 'undefined' ? RECIPE_BY_NAME.get(a) : RECIPES.find(r => r.name === a);
    const rB = typeof RECIPE_BY_NAME !== 'undefined' ? RECIPE_BY_NAME.get(b) : RECIPES.find(r => r.name === b);
    
    const qiA = rA ? getTotalQiMulti(rA) : 0;
    const qiB = rB ? getTotalQiMulti(rB) : 0;
    
    if (qiB !== qiA) return qiB - qiA;
    
    const maxA = groups[a].reduce((m, p) => Math.max(m, getTotalQiMulti(p)), 0);
    const maxB = groups[b].reduce((m, p) => Math.max(m, getTotalQiMulti(p)), 0);
    return maxB - maxA;
  });

  const finalSorted = [];
  let lastYield = performance.now();

  for (const key of sortedGroupKeys) {
    const groupPills = groups[key];
    groupPills.sort((a, b) => getTotalQiMulti(b) - getTotalQiMulti(a));
    
    const chained = [];
    const unplaced = [...groupPills];
    
    let current = unplaced.shift();
    chained.push(current);

    while (unplaced.length > 0) {
      if (performance.now() - lastYield > 40) {
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }

      let bestIndex = -1;
      let minDistance = Infinity;

      for (let i = 0; i < unplaced.length; i++) {
        const dist = ingredientDistance(current.ingredients, unplaced[i].ingredients);
        if (dist < minDistance) {
          minDistance = dist;
          bestIndex = i;
        }
      }

      current = unplaced.splice(bestIndex, 1)[0];
      chained.push(current);
    }

    const optimizedChained = await optimizePath2Opt(chained);
    finalSorted.push(...optimizedChained);
  }

  return finalSorted;
}

// ------------------------------------------------------------
// 9. SPLASH SCREEN & BACKGROUND ANIMATIONS
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const splashScreen = document.getElementById('splash-screen');
  const enterBtn = document.getElementById('enter-btn');
  
  if (!splashScreen || !enterBtn) return;

  document.body.classList.add('locked');

  enterBtn.addEventListener('click', () => {
    splashScreen.classList.add('fade-out');
    document.body.classList.remove('locked');
    
    // AUDIO INTEGRATION: Play welcome on enter
    if (window.AudioController) window.AudioController.playWelcome();
    
    setTimeout(() => {
      splashScreen.remove();
    }, 800);
  });
});

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('bubble-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let width = window.innerWidth;
  let height = window.innerHeight;
  canvas.width = width;
  canvas.height = height;

  const bubbles = [];
  const BUBBLE_DENSITY = 0.4; 

  window.addEventListener('resize', () => {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
  });

  class Bubble {
    constructor(isInitial = false) {
      this.reset(isInitial);
    }

    reset(isInitial) {
      this.radius = Math.pow(Math.random(), 2) * 14 + 10; 
      
      this.x = Math.random() * width;
      this.y = isInitial ? Math.random() * height : height + this.radius * 2 + (Math.random() * 200);
      
      this.speedY = 0.2 + (this.radius * 0.08); 
      
      this.angle = Math.random() * Math.PI * 2;
      this.wobbleSpeed = 0.005 + (5 / (this.radius + 5)) * 0.01;
      this.wobbleAmp = this.radius * 0.03; 
    }

    update() {
      this.y -= this.speedY;
      this.angle += this.wobbleSpeed;
      this.x += Math.sin(this.angle) * this.wobbleAmp;

      if (this.y < -this.radius * 2) {
        this.reset(false);
      }
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(155, 114, 207, 0.1)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(155, 114, 207, 0.3)';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(
        this.x - (this.radius * 0.3), 
        this.y - (this.radius * 0.3), 
        this.radius * 0.12,
        0, 
        Math.PI * 2
      );
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fill();
    }
  }

  const bubbleCount = Math.floor((width * height) / 10000 * BUBBLE_DENSITY);
  for (let i = 0; i < bubbleCount; i++) {
    bubbles.push(new Bubble(true));
  }

  function animate() {
    ctx.clearRect(0, 0, width, height);
    for (let bubble of bubbles) {
      bubble.update();
      bubble.draw();
    }
    requestAnimationFrame(animate);
  }

  animate();
});