// ============================================================
// BACKUP.JS — FORK: inventory backup / restore / share.
//
// The inventory lives only in this browser's localStorage. Clearing site data,
// switching to a phone, or a mis-click on "Clear All" loses it with no way
// back — and re-entering 24 counts by hand is exactly the chore the screenshot
// autofill exists to remove.
//
// One dialog does both directions, because the text IS the format: a plain
// "Name: count" list a player can read, edit, paste into a Discord message, or
// paste back in. No file picker, no download that a mobile browser might
// block, nothing to learn.
// ============================================================

// Grouped by rarity, strongest first, under "# Legendary" style headers.
//
// A <textarea> cannot carry colour — that is a browser limitation, not an
// oversight — so the thing that actually makes rarity readable at a glance
// here is STRUCTURE, not colour. Grouping also survives the trip this text is
// built for: pasted into a Discord message, colour would be lost anyway but
// the headers still tell you where your legendaries are.
//
// The '#' lines are comments and inventoryFromText skips them, so an exported
// list re-imports unchanged.
function inventoryToText() {
  const out = [];
  for (const rarity of VisionMatch.RARITY_ORDER) {
    const names = Object.keys(PLANTS)
      .filter((n) => PLANTS[n].rarity === rarity && (inventoryState[n] || 0) > 0)
      .sort();
    if (!names.length) continue;
    if (out.length) out.push('');
    out.push(`# ${VisionMatch.RARITY_LABEL[rarity]}`);
    for (const n of names) out.push(`${n}: ${inventoryState[n]}`);
  }
  return out.join('\n');
}

// Count of held herbs per rarity, strongest first.
function inventoryTally() {
  return VisionMatch.RARITY_ORDER.map((rarity) => ({
    rarity,
    label: VisionMatch.RARITY_LABEL[rarity],
    count: Object.keys(PLANTS)
      .filter((n) => PLANTS[n].rarity === rarity && (inventoryState[n] || 0) > 0).length,
  }));
}

// Tolerant parser: accepts "Name: 12", "Name 12", "Name = 12", "Name,12", any
// case, any order, and quietly fuzzy-matches a name the player retyped or that
// arrived mangled from a chat client. Returns { counts, unknown }.
function inventoryFromText(text) {
  const counts = {};
  const unknown = [];
  for (const rawLine of String(text || '').split(/[\n\r]+/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.*?)[\s:=,]+(\d{1,4})\s*$/);
    if (!m) { unknown.push(line); continue; }
    const [, rawName, rawQty] = m;
    const qty = parseInt(rawQty, 10);
    if (!Number.isFinite(qty) || qty < 0 || qty > 9999) { unknown.push(line); continue; }

    let best = null, bestScore = 0;
    for (const name of Object.keys(PLANTS)) {
      const s = window.VisionMatch
        ? window.VisionMatch.similarity(rawName, name)
        : (rawName.trim().toLowerCase() === name.toLowerCase() ? 1 : 0);
      if (s > bestScore) { bestScore = s; best = name; }
    }
    if (best && bestScore >= 0.75) counts[best] = qty;
    else unknown.push(line);
  }
  return { counts, unknown };
}

function showBackupDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'vision-overlay';
  const text = inventoryToText();
  const total = Object.keys(PLANTS).filter((n) => (inventoryState[n] || 0) > 0).length;
  const tallyHtml = inventoryTally().map((t) => `
    <span class="backup-tally-item rarity-${t.rarity} ${t.count ? '' : 'is-empty'}"
          title="${t.count} ${t.label} herb${t.count === 1 ? '' : 's'} in stock">
      <b>${t.count}</b> ${t.label}
    </span>`).join('');

  overlay.innerHTML = `
    <div class="vision-modal" role="dialog" aria-modal="true" aria-label="Backup or restore inventory">
      <div class="vision-modal-header">
        <span>💾 Inventory backup — ${total} herb${total === 1 ? '' : 's'}</span>
        <button class="btn vision-close" aria-label="Close">×</button>
      </div>
      <div class="backup-body">
        <div class="backup-tally">${tallyHtml}</div>
        <p class="backup-hint">
          Grouped by rarity, rarest first. Copy it somewhere safe, or paste
          someone else's list in and press <b>Load</b>. Editing the numbers
          here works too, and the <code>#</code> headings are ignored on load.
        </p>
        <textarea id="backup-text" class="backup-text" spellcheck="false"
          placeholder="Wild Bitter Grass: 51&#10;Silverleaf Herb: 29">${text.replace(/</g, '&lt;')}</textarea>
        <div class="backup-status" id="backup-status"></div>
      </div>
      <div class="vision-modal-actions">
        <button class="btn" id="backup-copy" type="button">📋 Copy</button>
        <button class="btn" id="backup-cancel" type="button">Close</button>
        <button class="btn btn-primary" id="backup-load" type="button">Load into inventory</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const ta = overlay.querySelector('#backup-text');
  const status = overlay.querySelector('#backup-status');
  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.vision-close').onclick = close;
  overlay.querySelector('#backup-cancel').onclick = close;

  overlay.querySelector('#backup-copy').onclick = async () => {
    ta.select();
    let ok = false;
    try {
      // navigator.clipboard needs a secure context; file:// and plain http do
      // not have one, and this app is meant to run from a bare static server.
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(ta.value);
        ok = true;
      } else {
        ok = document.execCommand('copy');
      }
    } catch (e) { ok = false; }
    status.textContent = ok
      ? '✅ Copied to clipboard.'
      : 'Could not copy automatically — the text is selected, press Cmd/Ctrl+C.';
  };

  overlay.querySelector('#backup-load').onclick = () => {
    const { counts, unknown } = inventoryFromText(ta.value);
    const names = Object.keys(counts);
    if (!names.length) {
      status.textContent = '⚠️ Nothing recognisable in there — expected lines like "Basic Herb: 27".';
      return;
    }
    // Replace wholesale: a backup is a snapshot of the whole inventory, so
    // herbs absent from the list are absent from the inventory. Anything else
    // would silently merge two different points in time.
    for (const name of Object.keys(PLANTS)) setQty(name, counts[name] || 0);
    status.textContent = `✅ Loaded ${names.length} herb(s).` +
      (unknown.length ? ` ${unknown.length} line(s) were not recognised and were skipped.` : '');
    setTimeout(close, 1200);
  };

  ta.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  const toolbar = document.querySelector('.toolbar');
  const clearBtn = document.getElementById('btn-clear');
  if (!toolbar || !clearBtn) return;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.id = 'btn-backup';
  btn.type = 'button';
  btn.textContent = '💾 Backup';
  btn.title = 'Copy your inventory out as text, or paste one back in';
  btn.addEventListener('click', showBackupDialog);
  toolbar.insertBefore(btn, clearBtn);
});
