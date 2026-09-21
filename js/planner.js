// ============================================================
// PLANNER.JS — Pill Planner (pick the pills YOU want, reserve
// their herbs, then optimize QiMulti with what's LEFT)
//
// Example: you hold enough for 20 Mistveil Focus pills, but you
// pick 10 Permanent-Strength pills in the planner. The optimizer
// then only sees herbs for 10 Mistveil Focus — because the
// planner's herbs are reserved out of the same stash. One pool,
// never two.
//
// Reservation is live: it recomputes from inventoryState minus
// (planned pills + already-crafted-in-copilot pills), and the
// optimizer receives the reduced inventory via
// window.getOptimizerInventory() (defined here, called by ui.js).
// ============================================================

const PLANNER_STORE_KEY = "codexPlanner.v1";

// plan: [{ name, count }] — base recipe names + how many you want
let plannerPlan = [];
try {
  const raw = localStorage.getItem(PLANNER_STORE_KEY);
  if (raw) plannerPlan = JSON.parse(raw);
} catch (e) { plannerPlan = []; }

function savePlannerPlan() {
  try { localStorage.setItem(PLANNER_STORE_KEY, JSON.stringify(plannerPlan)); } catch (e) {}
}

// Total herbs reserved by the plan: count × recipe ingredients.
function plannerReservedHerbs() {
  const reserved = {};
  for (const item of plannerPlan) {
    const recipe = RECIPES.find(r => r.name === item.name);
    if (!recipe) continue;
    const n = Math.max(0, Math.floor(item.count || 0));
    if (n === 0) continue;
    for (const [plant, qty] of Object.entries(recipe.ingredients)) {
      reserved[plant] = (reserved[plant] || 0) + qty * n;
    }
  }
  return reserved;
}

// Herbs already committed by ticking "Done"/"Crafted" on result or codex cards.
// Those herbs are spent — the plan reserves ON TOP of what's still in the stash,
// and setQty has ALREADY removed crafted herbs from inventoryState, so we only
// need to subtract the plan's reservation. (Documented overlap: unticking a
// crafted pill gives herbs back to inventoryState automatically.)
function plannerAvailableInventory() {
  const reserved = plannerReservedHerbs();
  const avail = {};
  for (const [plant, qty] of Object.entries(inventoryState)) {
    const left = qty - (reserved[plant] || 0);
    if (left > 0) avail[plant] = left;
  }
  return avail;
}

// Hook the optimizer calls (ui.js runOptimizer). Falls back to raw inventory.
window.getOptimizerInventory = function () {
  try {
    if (typeof plannerPlan !== "undefined" && plannerPlan.length > 0) {
      return plannerAvailableInventory();
    }
  } catch (e) { /* fall through */ }
  const inv = {};
  for (const [p, q] of Object.entries(inventoryState)) {
    if (q > 0) inv[p] = q;
  }
  return inv;
};

// Shortage check: can the plan actually be fulfilled from the stash?
function plannerShortages() {
  const shortages = [];
  for (const item of plannerPlan) {
    if (!item.count || item.count <= 0) continue;
    const recipe = RECIPES.find(r => r.name === item.name);
    if (!recipe) continue;
    for (const [plant, qty] of Object.entries(recipe.ingredients)) {
      const need = qty * item.count;
      const have = inventoryState[plant] || 0;
      if (have < need) shortages.push({ pill: item.name, plant, need, have, missing: need - have });
    }
  }
  return shortages;
}

// ---------- UI ----------
function plannerAddRow(name, count) {
  const existing = plannerPlan.find(i => i.name === name);
  if (existing) existing.count += count;
  else plannerPlan.push({ name, count });
  savePlannerPlan();
  renderPlanner();
}

function plannerRemove(name) {
  plannerPlan = plannerPlan.filter(i => i.name !== name);
  savePlannerPlan();
  renderPlanner();
}

function plannerSetCount(name, count) {
  const item = plannerPlan.find(i => i.name === name);
  if (!item) return;
  item.count = Math.max(0, Math.floor(Number(count) || 0));
  savePlannerPlan();
  renderPlanner();
}

function renderPlanner() {
  const listEl = document.getElementById("planner-list");
  if (!listEl) return;

  const sel = document.getElementById("planner-pill");
  if (sel && sel.options.length === 0) {
    sel.innerHTML = RECIPES.filter(r => !r.effects.some(e => e.stat === "DEATH"))
      .map(r => `<option value="${escHtml(r.name)}">${escHtml(r.name)}</option>`).join("");
  }

  if (plannerPlan.length === 0) {
    listEl.innerHTML = `<p class="cx-empty">Nothing planned yet. Pick a pill above, choose how many you want, and hit Add. Its herbs get reserved out of your stash before the optimizer runs.</p>`;
  } else {
    listEl.innerHTML = plannerPlan.map(item => {
      const recipe = RECIPES.find(r => r.name === item.name);
      if (!recipe) return "";
      const n = item.count || 0;
      const total = Object.entries(recipe.ingredients)
        .map(([p, q]) => `${q * n}× ${p}`).join(", ");
      const icon = pillIcon(item.name);
      const fx = recipe.effects.map(e =>
        e.stat === "DEATH" ? "☠️" : `+${e.pct}% ${e.stat}${e.duration === 0 ? " (permanent)" : ` · ${fmtDurCodex(e.duration)}`}`
      ).join(" & ");
      return `<div class="pl-item" data-plan="${escHtml(item.name)}">
        <div class="ico">${icon}</div>
        <div>
          <div class="name">${escHtml(item.name)} <span style="color:var(--gold-light)">× ${n}</span></div>
          <div class="sub">${escHtml(fx)}</div>
          <div class="need">${Object.entries(recipe.ingredients).map(([p, q]) => {
            const have = inventoryState[p] || 0;
            const short = have < q * n;
            return `<span class="cx-chip" style="--rc:var(--rarity-${PLANTS[p].rarity})">` +
              `<span class="qty">${q * n}×</span><span class="ico">${herbIcon(p)}</span>` +
              `<span class="r-${PLANTS[p].rarity}">${escHtml(p)}</span>` +
              (short ? `<span style="color:var(--red)">⚠ have ${have}</span>` : "") +
              `</span>`;
          }).join("")}</div>
        </div>
        <div class="actions">
          <input class="cx-count" type="number" min="0" value="${n}" data-plan-count="${escHtml(item.name)}" style="width:64px" aria-label="How many">
          <button class="cx-btn" data-plan-remove="${escHtml(item.name)}">Remove</button>
        </div>
      </div>`;
    }).join("");
  }

  // shortage banner
  const noteEl = document.getElementById("planner-note");
  if (noteEl) {
    const shortages = plannerShortages();
    if (shortages.length === 0 && plannerPlan.length > 0) {
      noteEl.className = "pl-craft-note ok";
      noteEl.innerHTML = "✓ Your stash covers every planned pill. The optimizer will use only what's LEFT after these are made.";
    } else if (shortages.length > 0) {
      noteEl.className = "pl-craft-note no";
      noteEl.innerHTML = "⚠ Not enough herbs for the plan: " +
        shortages.map(s => `${escHtml(s.plant)} (need ${s.need}, have ${s.have})`).join(", ") +
        ". The optimizer will still see the remainder — top up the missing herbs or reduce the plan.";
    } else {
      noteEl.className = "pl-craft-note";
      noteEl.innerHTML = "";
      noteEl.hidden = true;
    }
    if (plannerPlan.length > 0) noteEl.hidden = false;
  }

  // "reserved" summary
  const resEl = document.getElementById("planner-reserved");
  if (resEl) {
    const reserved = plannerReservedHerbs();
    const keys = Object.keys(reserved);
    resEl.hidden = keys.length === 0;
    if (keys.length > 0) {
      resEl.innerHTML = "🔒 Reserved for your plan: " +
        keys.sort().map(p => `${herbIcon(p)} ${reserved[p]}× ${escHtml(p)}`).join(" · ") +
        "<br>The QiMulti optimizer only sees herbs NOT in this list.";
    }
  }
}

// ---------- wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  const addBtn = document.getElementById("planner-add");
  if (!addBtn) return; // planner not present

  addBtn.addEventListener("click", () => {
    const name = document.getElementById("planner-pill").value;
    const count = parseInt(document.getElementById("planner-count").value, 10) || 0;
    if (count > 0) plannerAddRow(name, count);
  });

  const clearBtn = document.getElementById("planner-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    plannerPlan = [];
    savePlannerPlan();
    renderPlanner();
  });

  const listEl = document.getElementById("planner-list");
  listEl.addEventListener("click", ev => {
    const rm = ev.target.closest("[data-plan-remove]");
    if (rm) plannerRemove(rm.dataset.planRemove);
  });
  listEl.addEventListener("change", ev => {
    const inp = ev.target.closest("[data-plan-count]");
    if (inp) plannerSetCount(inp.dataset.planCount, inp.value);
  });

  renderPlanner();
});

// Inventory edits change what the plan can afford — re-render if visible.
document.addEventListener("DOMContentLoaded", () => {
  const origSetQty = window.setQty;
  if (typeof origSetQty === "function") {
    let t = null;
    window.setQty = function (...args) {
      const r = origSetQty.apply(this, args);
      clearTimeout(t);
      t = setTimeout(() => {
        if (document.getElementById("panel-planner") && !document.getElementById("panel-planner").hidden) renderPlanner();
      }, 400);
      return r;
    };
  }
});