// ============================================================
// PILL-PICKER.JS — visual picker for the Pill Planner
// Replaces the bare <select> with image cards: art, effect
// stats, ingredient cost, and a live "can afford" badge.
//
// The native <select>#planner-pill stays in the DOM (visually
// hidden) and is KEPT IN SYNC — clicking a card sets its value,
// so the existing add-to-plan handler, keyboard/AT semantics,
// and tests/ui-smoke.mjs keep working unchanged.
// ============================================================

const PILL_ART = {
  QiMulti:   { file: "assets/pills/qi.svg",       label: "Qi",      color: "#a78bfa" },
  Vitality:  { file: "assets/pills/vitality.svg", label: "Vitality",color: "#5ecf7a" },
  Speed:     { file: "assets/pills/speed.svg",    label: "Speed",   color: "#5ab8d4" },
  Strength:  { file: "assets/pills/strength.svg", label: "Strength",color: "#e05555" },
  Lifespan:  { file: "assets/pills/lifespan.svg", label: "Lifespan",color: "#d4a94e" },
};

function pickerStatKey(recipe) {
  const e = recipe.effects.find(e => e.stat !== "DEATH") || recipe.effects[0];
  return e ? e.stat : "QiMulti";
}

function pickerAfford(recipe) {
  if (typeof inventoryState === "undefined") return { ok: false, count: 0 };
  let min = Infinity;
  for (const [p, q] of Object.entries(recipe.ingredients)) {
    min = Math.min(min, Math.floor((inventoryState[p] || 0) / q));
  }
  return { ok: min >= 1, count: Math.max(0, min) };
}

function pillPickerCardHTML(r) {
  const art = PILL_ART[pickerStatKey(r)] || PILL_ART.QiMulti;
  const { ok, count } = pickerAfford(r);
  const effects = r.effects.map(e =>
    e.stat === "DEATH"
      ? `<li class="pk-fx death">☠️ Kills you</li>`
      : `<li class="pk-fx"><b style="color:${art.color}">+${e.pct}%</b> ${escHtml(e.stat)} <span class="pk-dur">${fmtDurCodex(e.duration)}</span></li>`
  ).join("");
  const cost = Object.entries(r.ingredients)
    .sort((a, b) => RARITY_ORDER2[PLANTS[b[0]].rarity] - RARITY_ORDER2[PLANTS[a[0]].rarity] || b[1] - a[1])
    .map(([p, q]) => {
      const d = PLANTS[p];
      const short = (typeof inventoryState !== "undefined") && (inventoryState[p] || 0) < q;
      return `<span class="pk-ing${short ? " short" : ""}" title="${escHtml(p)} · ${RARITY_LABELS[d.rarity]}">
        <span class="q">${q}×</span><span class="ico">${herbIcon(p)}</span><span class="r-${d.rarity}">${escHtml(p)}</span></span>`;
    }).join("");
  const topRarity = Object.keys(r.ingredients).reduce(
    (best, p) => RARITY_ORDER2[PLANTS[p].rarity] > RARITY_ORDER2[best] ? PLANTS[p].rarity : best, "C");

  return `<button type="button" class="pk-card rar-${topRarity}${ok ? " can" : ""}" data-pick="${escHtml(r.name)}"
      aria-pressed="false" title="${escHtml(r.name)} — ${escHtml(art.label)}">
    <span class="pk-img"><img src="${art.file}" alt="" loading="lazy" width="56" height="56"></span>
    <span class="pk-name">${escHtml(r.name)}</span>
    <span class="pk-badge b-${escHtml(pickerStatKey(r))}">${escHtml(art.label)}</span>
    <ul class="pk-effects">${effects}</ul>
    <span class="pk-cost">${cost}</span>
    <span class="pk-afford ${ok ? "ok" : "no"}">${ok ? `✓ in stock${count > 1 ? ` ×${count}` : ""}` : "✗ missing herbs"}</span>
  </button>`;
}

function renderPillPicker() {
  const grid = document.getElementById("planner-picker");
  if (!grid) return;
  grid.innerHTML = RECIPES.filter(r => !r.effects.some(e => e.stat === "DEATH"))
    .map(pillPickerCardHTML).join("");
}

// Keep the hidden native select in sync; re-render afford badges when
// inventory changes (same hook pattern planner.js uses).
(function () {
  const boot = () => {
    if (!document.getElementById("planner-pill")) return;
    renderPillPicker();

    const grid = document.getElementById("planner-picker");
    grid.addEventListener("click", ev => {
      const card = ev.target.closest("[data-pick]");
      if (!card) return;
      const sel = document.getElementById("planner-pill");
      if (sel) sel.value = card.dataset.pick;
      grid.querySelectorAll(".pk-card[aria-pressed=true]").forEach(c => c.setAttribute("aria-pressed", "false"));
      card.setAttribute("aria-pressed", "true");
      const countInput = document.getElementById("planner-count");
      if (countInput) countInput.focus();
    });

    // inventory edits → refresh afford badges (debounced, same as planner.js)
    if (typeof window.setQty === "function") {
      const orig = window.setQty;
      let t = null;
      window.setQty = function (...args) {
        const r = orig.apply(this, args);
        clearTimeout(t);
        t = setTimeout(() => {
          const panel = document.getElementById("panel-planner");
          if (panel && !panel.hidden) renderPillPicker();
        }, 400);
        return r;
      };
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();