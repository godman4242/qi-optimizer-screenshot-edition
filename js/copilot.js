// ============================================================
// COPILOT.JS — Craft Copilot (guided crafting aid)
// A sticky panel above the results that walks you through the
// pill set one craft at a time: shows the next pill to craft,
// its full ingredient list, and whether your inventory covers
// it. Click "Crafted ✓" to mark done — inventory auto-decrements
// (same logic as the existing Done checkboxes) and the copilot
// advances to the next pill.
// ============================================================

let copilotEnabled = true;

function copilotNextPill() {
  if (!Array.isArray(currentBestSet)) return null;
  return currentBestSet.find(p => !p.isDone) || null;
}

function copilotCoverage(pill) {
  if (!pill) return { ok: true, missing: [] };
  const missing = [];
  for (const [name, qty] of Object.entries(pill.ingredients)) {
    const have = inventoryState[name] || 0;
    if (have < qty) missing.push({ name, need: qty, have });
  }
  return { ok: missing.length === 0, missing };
}

function renderCraftCopilot() {
  // remove existing panel
  const existing = document.getElementById('craft-copilot');
  if (existing) existing.remove();

  if (!copilotEnabled) return;
  if (!currentBestSet || currentBestSet.length === 0) return;

  const next = copilotNextPill();
  const summaryEl = document.getElementById('results-summary');
  if (!summaryEl) return;

  const panel = document.createElement('div');
  panel.id = 'craft-copilot';
  panel.className = 'craft-copilot';

  const doneCount = currentBestSet.filter(p => p.isDone).length;
  const total = currentBestSet.length;

  if (!next) {
    panel.innerHTML = `
      <div class="craft-copilot-header">
        <span class="craft-copilot-title">🧪 Craft Copilot</span>
        <span class="craft-copilot-progress">${doneCount}/${total} — all pills crafted! 🎉</span>
      </div>
    `;
  } else {
    const cov = copilotCoverage(next);
    const ingrHtml = Object.entries(next.ingredients)
      .map(([name, qty]) => {
        const have = inventoryState[name] || 0;
        const short = have < qty;
        return `<span style="color:${short ? 'var(--red)' : 'var(--green)'}">${name} ×${qty}${short ? ` (have ${have})` : ''}</span>`;
      })
      .join(' · ');

    const statusHtml = cov.ok
      ? `<span style="color:var(--green)">✅ Inventory covers this craft</span>`
      : `<span class="next-pill-missing">⚠️ Missing: ${cov.missing.map(m => `${m.name} (need ${m.need - m.have} more)`).join(', ')}</span>`;

    panel.innerHTML = `
      <div class="craft-copilot-header">
        <span class="craft-copilot-title">🧪 Craft Copilot</span>
        <span class="craft-copilot-progress">${doneCount}/${total} crafted</span>
      </div>
      <div class="craft-copilot-next">
        <div>Next up: <span class="next-pill-name">${next.name}</span></div>
        <div style="margin-top:0.25rem">${ingrHtml}</div>
        <div style="margin-top:0.4rem">${statusHtml}</div>
        <button class="btn btn-primary" id="copilot-crafted" style="margin-top:0.6rem; font-size:0.75rem;">Crafted ✓</button>
      </div>
    `;

    panel.querySelector('#copilot-crafted').onclick = () => {
      next.isDone = true;
      if (window.AudioController) window.AudioController.playDone();
      for (const [name, qty] of Object.entries(next.ingredients)) {
        const current = inventoryState[name] || 0;
        setQty(name, Math.max(0, current - qty));
      }
      saveResultsState();
      renderCraftCopilot();
      // sync the Done checkbox on the pill card itself
      const card = document.querySelector(`.pill-card[data-pill-id="${next.id}"] input[type="checkbox"]`);
      if (card) { card.checked = true; card.closest('.pill-card').classList.add('crafted'); }
    };
  }

  summaryEl.parentNode.insertBefore(panel, summaryEl.nextSibling);
}

// Re-render copilot whenever results re-render or qty changes
// (capture the original INSIDE DOMContentLoaded — copilot.js loads before
// ui.js, so at top-level parse time renderResults doesn't exist yet)
document.addEventListener('DOMContentLoaded', () => {
  if (typeof renderResults === 'function') {
    const orig = renderResults;
    window.renderResults = async function (...args) {
      const r = await orig.apply(this, args);
      renderCraftCopilot();
      return r;
    };
  }
  // hook inventory changes
  const origSetQty = window.setQty;
  if (origSetQty) {
    let t = null;
    window.setQty = function (...args) {
      const r = origSetQty.apply(this, args);
      clearTimeout(t);
      t = setTimeout(renderCraftCopilot, 300);
      return r;
    };
  }
});