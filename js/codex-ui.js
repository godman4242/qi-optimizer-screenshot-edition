// ============================================================
// CODEX-UI.JS — Pill Codex tab + Herb Codex tab
// A reference of every recipe in the game, written for NEW
// players: emoji pill icons, plain-English effect lines, and a
// "you can afford this" indicator that reads the same live
// inventory the optimizer uses.
//
// The "Crafted" checkbox is the SAME one-source-of-truth flow
// as the optimizer's Done checkbox: marking a pill crafted
// deducts its herbs from inventoryState (and unticking gives
// them back). Crafted pills here stay remembered (localStorage)
// and remain marked even after inventory changes.
// ============================================================

const CODEX_STORE_KEY = "codexCrafted.v1";
const PILL_ICONS = [
  "🔴", "🟢", "🔵", "🟣", "🟡", "⚪", "🟤", "⚫"
];

// Deterministic emoji per pill name (stable hash → hue family);
// DEATH gets a fixed skull. Kept simple + offline.
function pillIcon(name) {
  if (name === "Death Pill") return "☠️";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PILL_ICONS[h % PILL_ICONS.length];
}

const HERB_ICONS = {
  VITALITY: "🌿",
  ENDURANCE: "🍀",
  AGILITY: "🌾",
  SPIRIT: "🔮",
};
function herbIcon(plant) {
  const d = PLANTS[plant];
  return HERB_ICONS[d && d.family] || "🌱";
}

const RARITY_LABELS = { C: "Common", U: "Uncommon", R: "Rare", E: "Epic", L: "Legendary" };
const RARITY_ORDER2 = { C: 0, U: 1, R: 2, E: 3, L: 4 };

const STAT_PLAIN_ENGLISH = {
  QiMulti: "Qi you gain",
  Vitality: "Health / survivability",
  Speed: "Movement & attack speed",
  Strength: "Damage",
  Lifespan: "Years of life",
};

function fmtDurCodex(sec) {
  if (sec === 0) return "Permanent";
  const m = Math.round(sec / 60);
  if (m < 1) return sec + "s";
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), r = m % 60;
  return r ? h + "h " + r + " min" : h + " h";
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- crafted set (persistent memory of what you made) ----------
let codexCrafted = new Set();
try {
  const raw = localStorage.getItem(CODEX_STORE_KEY);
  if (raw) codexCrafted = new Set(JSON.parse(raw));
} catch (e) { /* private mode — tracker just won't persist */ }

function saveCodexCrafted() {
  try { localStorage.setItem(CODEX_STORE_KEY, JSON.stringify([...codexCrafted])); } catch (e) {}
}

// Mark crafted + deduct herbs (same deduction as the optimizer's Done checkbox).
function markCodexCrafted(pillName, crafted) {
  const recipe = RECIPES.find(r => r.name === pillName);
  if (!recipe) return;
  if (crafted) codexCrafted.add(pillName); else codexCrafted.delete(pillName);
  saveCodexCrafted();
  if (typeof setQty === "function" && typeof inventoryState !== "undefined") {
    for (const [plant, qty] of Object.entries(recipe.ingredients)) {
      const current = inventoryState[plant] || 0;
      setQty(plant, crafted ? Math.max(0, current - qty) : current + qty);
    }
  }
  renderPillCodex();
}

// Can the player currently afford this pill (against live inventory)?
function codexAffordable(recipe) {
  if (typeof inventoryState === "undefined") return true;
  return Object.entries(recipe.ingredients).every(([p, q]) => (inventoryState[p] || 0) >= q);
}

// How many copies could you make right now?
function codexCraftableCount(recipe) {
  if (typeof inventoryState === "undefined") return Infinity;
  let min = Infinity;
  for (const [p, q] of Object.entries(recipe.ingredients)) {
    min = Math.min(min, Math.floor((inventoryState[p] || 0) / q));
  }
  return min;
}

// ---------- pill codex ----------
function codexCardHTML(r) {
  const done = codexCrafted.has(r.name);
  const afford = codexAffordable(r);
  const count = codexCraftableCount(r);
  const primary = r.effects[0];
  const effectLines = r.effects.map(e => {
    if (e.stat === "DEATH") {
      return `<li><span class="st">☠️ Kills you.</span> <span class="du">Do not eat.</span></li>`;
    }
    return `<li><span class="st">${escHtml(e.stat)}</span> ` +
      `<span class="pc pc-${escHtml(e.stat)}">+${e.pct}%</span> ` +
      `<span class="du">· ${fmtDurCodex(e.duration)}</span></li>`;
  }).join("");

  const chips = Object.entries(r.ingredients)
    .sort((a, b) => RARITY_ORDER2[PLANTS[b[0]].rarity] - RARITY_ORDER2[PLANTS[a[0]].rarity] || b[1] - a[1])
    .map(([plant, qty]) => {
      const d = PLANTS[plant];
      const have = (typeof inventoryState !== "undefined") ? (inventoryState[plant] || 0) : 0;
      const short = have < qty;
      return `<span class="cx-chip" style="--rc:var(--rarity-${d.rarity})" title="${escHtml(plant)} · ${RARITY_LABELS[d.rarity]} · ${escHtml(d.family)}">` +
        `<span class="qty">${qty}×</span>` +
        `<span class="ico">${herbIcon(plant)}</span>` +
        `<span class="r-${d.rarity}">${escHtml(plant)}</span>` +
        `<span class="fam">${escHtml(d.family.slice(0, 3))}</span>` +
        (short ? `<span style="color:var(--red)" title="you have ${have}">⚠ ${have}</span>` : "") +
        `</span>`;
    }).join("");

  const affordLine = done
    ? `<span class="cx-afford ok">✓ crafted</span>`
    : afford
      ? `<span class="cx-afford ok">✓ Herbs in stock${count > 1 ? ` — can make ${count}` : ""}</span>`
      : `<span class="cx-afford no">✗ Missing herbs — highlighted ⚠ below</span>`;

  return `<article class="cx-card${done ? " done" : ""}" data-pill="${escHtml(r.name)}">
    <div class="cx-head">
      <span class="cx-pill-icon">${pillIcon(r.name)}</span>
      <div class="cx-titles">
        <h3>${escHtml(r.name)}</h3>
        <div class="cx-plain">${escHtml(STAT_PLAIN_ENGLISH[r.effects[0].stat] || "")}</div>
      </div>
      <span class="cx-badge b-${escHtml(r.effects[0].stat)}">${escHtml(r.effects[0].stat)}</span>
    </div>
    <div class="cx-chips">${chips}</div>
    <ul class="cx-effects">${effectLines}</ul>
    <div class="cx-meta" style="margin:0">${affordLine}</div>
    <div class="cx-done-row">
      <label><input type="checkbox" data-codex-pill="${escHtml(r.name)}"${done ? " checked" : ""}> Crafted (uses herbs)</label>
    </div>
  </article>`;
}

function renderPillCodex() {
  const grid = document.getElementById("codex-grid");
  if (!grid) return;
  const q = (document.getElementById("codex-q")?.value || "").trim().toLowerCase();
  const stat = document.getElementById("codex-stat")?.value || "";
  const rar = document.getElementById("codex-rar")?.value || "";
  const sort = document.getElementById("codex-sort")?.value || "pct";

  const topRarity = r => Object.keys(r.ingredients).reduce(
    (best, p) => RARITY_ORDER2[PLANTS[p].rarity] > RARITY_ORDER2[best] ? PLANTS[p].rarity : best, "C");

  let rows = RECIPES.filter(r => {
    const hay = (r.name + " " + Object.keys(r.ingredients).join(" ")).toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (stat && !r.effects.some(e => e.stat === stat)) return false;
    if (rar && topRarity(r) !== rar) return false;
    return true;
  });

  const maxPct = r => Math.max(...r.effects.map(e => e.pct));
  const maxDur = r => Math.max(...r.effects.map(e => e.duration === 0 ? Infinity : e.duration));
  if (sort === "pct") rows.sort((a, b) => maxPct(b) - maxPct(a) || a.name.localeCompare(b.name));
  else if (sort === "dur") rows.sort((a, b) => maxDur(b) - maxDur(a) || a.name.localeCompare(b.name));
  else rows.sort((a, b) => a.name.localeCompare(b.name));

  grid.innerHTML = rows.length
    ? rows.map(codexCardHTML).join("")
    : `<p class="cx-empty">No pill matches that. Try a herb name, or hit Reset.</p>`;

  const count = document.getElementById("codex-count");
  if (count) count.textContent = `${rows.length} of ${RECIPES.length} pills`;
  const done = document.getElementById("codex-done");
  if (done) done.textContent = `${codexCrafted.size}/${RECIPES.length}`;
}

// ---------- herb codex ----------
function renderHerbCodex() {
  const body = document.getElementById("herbcodex-body");
  if (!body) return;
  const q = (document.getElementById("herbcodex-q")?.value || "").trim().toLowerCase();

  const families = ["VITALITY", "ENDURANCE", "AGILITY", "SPIRIT"];
  const famPlants = {};
  for (const [name, d] of Object.entries(PLANTS)) {
    (famPlants[d.family] = famPlants[d.family] || []).push(name);
  }

  let shown = 0;
  let html = "";
  for (const fam of families) {
    const rows = (famPlants[fam] || [])
      .filter(p => !q || (p + " " + fam + " " + RARITY_LABELS[PLANTS[p].rarity]).toLowerCase().includes(q))
      .sort((a, b) => PLANTS[b].score[0] - PLANTS[a].score[0]);
    if (!rows.length) continue;
    shown += rows.length;

    html += `<section class="hb-block"><h3>${escHtml(fam)} <small>${rows.length} herbs</small></h3>
      <table class="hb-tbl"><thead><tr><th>Herb</th><th>Rarity</th><th>Score</th><th>Used in</th></tr></thead><tbody>` +
      rows.map(p => {
        const d = PLANTS[p];
        const usedIn = RECIPES.filter(r => r.ingredients[p]).length;
        return `<tr><td>${herbIcon(p)} ${escHtml(p)}</td>` +
          `<td class="r-${d.rarity}"><span class="hb-dot"></span>${RARITY_LABELS[d.rarity]}</td>` +
          `<td class="num">${d.score.join(" / ")}</td>` +
          `<td class="usedin">${usedIn} pill${usedIn === 1 ? "" : "s"}</td></tr>`;
      }).join("") +
      `</tbody></table></section>`;
  }

  body.innerHTML = html || `<p class="cx-empty">No herb matches that.</p>`;
  const count = document.getElementById("herbcodex-count");
  if (count) count.textContent = `${shown} of ${Object.keys(PLANTS).length} herbs — herbs with two scores were observed at both; the engine uses the first`;
}

// ---------- wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  const grid = document.getElementById("codex-grid");
  if (!grid) return; // codex UI not present

  ["codex-q", "codex-stat", "codex-rar", "codex-sort"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderPillCodex);
  });
  const reset = document.getElementById("codex-reset");
  if (reset) reset.addEventListener("click", () => {
    document.getElementById("codex-q").value = "";
    document.getElementById("codex-stat").value = "";
    document.getElementById("codex-rar").value = "";
    document.getElementById("codex-sort").value = "pct";
    renderPillCodex();
  });
  const clear = document.getElementById("codex-clear");
  if (clear) clear.addEventListener("click", () => {
    codexCrafted.clear();
    saveCodexCrafted();
    renderPillCodex();
  });

  grid.addEventListener("change", ev => {
    const box = ev.target.closest('input[type="checkbox"][data-codex-pill]');
    if (!box) return;
    markCodexCrafted(box.dataset.codexPill, box.checked);
  });

  const hbq = document.getElementById("herbcodex-q");
  if (hbq) hbq.addEventListener("input", renderHerbCodex);

  // re-render codex affordability when inventory changes (debounced via setQty hook below)
  const origSetQty = window.setQty;
  if (typeof origSetQty === "function") {
    let t = null;
    window.setQty = function (...args) {
      const r = origSetQty.apply(this, args);
      clearTimeout(t);
      t = setTimeout(() => {
        if (document.getElementById("panel-codex") && !document.getElementById("panel-codex").hidden) renderPillCodex();
        if (document.getElementById("panel-herbs") && !document.getElementById("panel-herbs").hidden) renderHerbCodex();
      }, 400);
      return r;
    };
  }

  renderPillCodex();
  renderHerbCodex();
});