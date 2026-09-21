// ============================================================
// tests/ui-smoke.mjs — end-to-end smoke test in a real browser.
//
// The unit tests check pure functions and the OCR bench checks the vision
// pipeline; neither notices if the page fails to WIRE them together. This
// drives the app the way a player does — paste a screenshot, apply it,
// undo it, back it up, optimise — and fails on any console error along the
// way. It is what catches a broken <script> order or a renamed global.
//
//   node tests/ui-smoke.mjs
//   node tests/ui-smoke.mjs --headed
//
// Playwright is a dev-only dependency; exits 2 with instructions if absent.
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('\n  ui-smoke needs Playwright (dev-only; the app itself stays dependency-free).');
  console.error('  Install it once with:  npm i -g playwright && npx playwright install chromium\n');
  server.close();
  process.exit(2);
}

let passed = 0, failed = 0;
const problems = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; problems.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

console.log('════════════════════════════════════════════════');
console.log('  UI SMOKE TEST — real browser, real screenshots');
console.log('════════════════════════════════════════════════\n');

// Without this, ANY unexpected rejection leaves the http server listening and
// node never exits — a hung run looks identical to a slow one.
process.on('unhandledRejection', (e) => {
  console.error('\n  UNEXPECTED ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

const browser = await playwright.chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
await page.evaluate(() => { const s = document.getElementById('splash-screen'); if (s) s.remove(); });

check('page exposes every global the fork needs',
  await page.evaluate(() => !!(window.Tesseract && window.Vision && window.VisionMatch
    && typeof setQty === 'function' && typeof PLANTS === 'object')));

// Rarity colour: the palette existed but only recipe tags used it. These
// assert the RENDERED colour, not the class name — a class that no rule
// matches would otherwise pass silently.
const gridColours = await page.evaluate(() => {
  const pick = (r) => {
    const el = document.querySelector(`.plant-card.rarity-${r} .plant-name`);
    return el ? getComputedStyle(el).color : null;
  };
  return { C: pick('C'), U: pick('U'), R: pick('R'), E: pick('E'), L: pick('L') };
});
check('every rarity tints the herb name a different colour in the inventory',
  Object.values(gridColours).every(Boolean)
    && new Set(Object.values(gridColours)).size === 5,
  JSON.stringify(gridColours));

check('inventory grid rendered all 24 plants',
  await page.locator('.plant-card').count() === 24,
  `found ${await page.locator('.plant-card').count()}`);

check('backup button was added to the toolbar', await page.locator('#btn-backup').count() === 1);

// Read through count() first: locator.textContent() on a missing element
// auto-waits 30s and then throws, which in a top-level-await module leaves the
// http server listening and hangs the whole run instead of failing it.
const versionText = (await page.locator('#vision-version').count())
  ? await page.locator('#vision-version').textContent()
  : '(missing)';
check('the page stamps its pipeline version so a cached build is visible',
  /Screenshot autofill v\d+\.\d+/.test(versionText), versionText);

// A crash and an unreadable screenshot must not render the same sentence.
// Before v4.1 both produced "No herbs detected", which sent players hunting
// for a better screenshot when the page itself was the problem.
// Fire and forget: showVisionConfirm returns a promise that only settles when
// the dialog is closed, so returning it to page.evaluate waits forever.
await page.evaluate(() => { window.Vision.showVisionConfirm([], 'simulated engine failure'); });
await page.waitForSelector('.vision-overlay');
const crashText = await page.evaluate(() =>
  document.querySelector('.vision-overlay').textContent.replace(/\s+/g, ' '));
check('a crashed read says it crashed, and does not blame the screenshot',
  /crashed/i.test(crashText) && /simulated engine failure/.test(crashText)
    && !/No herbs detected/.test(crashText),
  crashText.slice(0, 160));
await page.keyboard.press('Escape');
await page.waitForSelector('.vision-overlay', { state: 'detached' });

// ---- screenshot import, end to end through the real UI ----
await page.waitForFunction(() => window.Vision && window.Vision.analyzeFiles, null, { timeout: 30000 });
await page.setInputFiles('#vision-file-input', [
  path.join(__dirname, 'fixtures', 'inv-01.jpg'),
  path.join(__dirname, 'fixtures', 'inv-04.jpg'),
]);
await page.waitForSelector('.vision-overlay .vision-row', { timeout: 60000 });

const rowCount = await page.locator('.vision-row').count();
check('review overlay listed 12 herbs from 2 screenshots', rowCount === 12, `got ${rowCount}`);
check('every row carries a thumbnail of the cell it was read from',
  await page.locator('.vision-row .vision-thumb').count() === rowCount);
// Rarity in the review table: colour, a colour-blind-safe letter chip, and
// rarest-first ordering so legendaries are not buried in an alphabetical list.
const reviewRarity = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.vision-row')];
  return rows.map((row) => {
    const chip = row.querySelector('.rarity-chip');
    const name = row.querySelector('.vision-name');
    return {
      chip: chip ? chip.textContent.trim() : null,
      colour: name ? getComputedStyle(name).color : null,
      text: name ? name.textContent.trim() : '',
    };
  });
});
check('every review row shows a rarity letter chip',
  reviewRarity.every((r) => /^[CUREL]$/.test(r.chip || '')),
  JSON.stringify(reviewRarity.map((r) => r.chip)));
check('review rows are tinted by rarity, not all one colour',
  new Set(reviewRarity.map((r) => r.colour)).size >= 3,
  JSON.stringify([...new Set(reviewRarity.map((r) => r.colour))]));
{
  // Rows needing a human decision deliberately jump the queue — an uncertain
  // row buried at the bottom of a long list is one you never look at. Rarity
  // order therefore applies WITHIN the confident block, which is what a player
  // is actually scanning.
  const order = ['L', 'E', 'R', 'U', 'C'];
  const confident = await page.evaluate(() =>
    [...document.querySelectorAll('.vision-row:not(.vision-uncertain)')]
      .map((row) => (row.querySelector('.rarity-chip') || {}).textContent.trim()));
  const idx = confident.map((c) => order.indexOf(c));
  check('within the confident rows, legendaries sort to the top and commons to the bottom',
    idx.length >= 5 && idx.every((v, i) => i === 0 || idx[i - 1] <= v),
    confident.join(' '));
  check('a row needing attention still jumps ahead of the rarity order',
    (await page.locator('.vision-row').first().evaluate((el) =>
      el.classList.contains('vision-uncertain'))) === true,
    'first row should be the uncertain one');
}

const tickedBefore = await page.locator('.vision-check:checked').count();
check('at least 11 of 12 rows arrive already ticked', tickedBefore >= 11, `${tickedBefore} ticked`);

await page.locator('#vision-apply').click();
await page.waitForSelector('.vision-overlay', { state: 'detached', timeout: 10000 });

const applied = await page.evaluate(() => ({
  wildBitter: inventoryState['Wild Bitter Grass'],
  dandelion: inventoryState['Dandelion of Qi'],
  redGinseng: inventoryState['Red Ginseng'],
  stored: JSON.parse(localStorage.getItem('alchemyInventory') || '{}'),
}));
check('applying wrote the right counts into the inventory',
  applied.wildBitter === 51 && applied.dandelion === 28 && applied.redGinseng === 56,
  JSON.stringify(applied));

const cardValue = await page.locator('.plant-card[data-plant="Red Ginseng"] .qty-input').inputValue();
check('the inventory card on the page shows the new count', cardValue === '56', `card shows ${cardValue}`);

// ---- undo ----
check('an undo button appeared after applying', await page.locator('.vision-undo').count() === 1);
await page.locator('.vision-undo').click();
const afterUndo = await page.evaluate(() => inventoryState['Wild Bitter Grass'] || 0);
check('undo restored the previous inventory', afterUndo === 0, `got ${afterUndo}`);

// ---- backup round trip ----
await page.evaluate(() => { setQty('Basic Herb', 27); setQty('Red Ginseng', 56); });
await page.locator('#btn-backup').click();
await page.waitForSelector('#backup-text');
const exported = await page.locator('#backup-text').inputValue();
check('backup exported the inventory as readable text',
  /Basic Herb: 27/.test(exported) && /Red Ginseng: 56/.test(exported), JSON.stringify(exported));

// A <textarea> cannot carry colour, so rarity has to be readable as STRUCTURE
// — and that structure must survive being pasted straight back in.
check('backup groups the list under rarity headings, rarest first',
  /# Uncommon/.test(exported) && /# Common/.test(exported)
    && exported.indexOf('# Uncommon') < exported.indexOf('# Common'),
  JSON.stringify(exported));

check('the coloured rarity tally shows one chip per rarity',
  await page.locator('.backup-tally-item').count() === 5,
  `${await page.locator('.backup-tally-item').count()} chips`);

// Round-trip: the exported text, headings and all, must re-import unchanged.
await page.locator('#backup-text').fill(exported);
await page.locator('#backup-load').click();
await page.waitForTimeout(300);
const roundTrip = await page.evaluate(() => ({
  basic: inventoryState['Basic Herb'], ginseng: inventoryState['Red Ginseng'],
}));
check('an exported backup re-imports unchanged, headings and all',
  roundTrip.basic === 27 && roundTrip.ginseng === 56, JSON.stringify(roundTrip));
await page.locator('#btn-backup').click();
await page.waitForSelector('#backup-text');

// Round-trip through a deliberately mangled list: different order, an OCR-ish
// typo, an equals sign, and a junk line.
await page.locator('#backup-text').fill('Red Ginseng = 12\nbasic herb, 3\nWild Bitter Gras: 9\n???nonsense');
await page.locator('#backup-load').click();
await page.waitForTimeout(300);
const restored = await page.evaluate(() => ({
  ginseng: inventoryState['Red Ginseng'],
  basic: inventoryState['Basic Herb'],
  wild: inventoryState['Wild Bitter Grass'],
}));
check('backup import is tolerant of case, separators and typos',
  restored.ginseng === 12 && restored.basic === 3 && restored.wild === 9,
  JSON.stringify(restored));
await page.keyboard.press('Escape');

// ---- optimiser still runs on an autofilled inventory ----
await page.evaluate(() => {
  for (const name of Object.keys(PLANTS)) setQty(name, 20);
});
await page.locator('#btn-optimize').click();
// runOptimizer puts a `.no-results loading` placeholder in #results the instant
// it is clicked, so waiting on "#results has content" returns immediately and
// counts zero pills. The button re-enabling is the real completion signal.
await page.waitForFunction(
  () => { const b = document.getElementById('btn-optimize'); return b && !b.disabled; },
  null, { timeout: 120000 });
await page.waitForSelector('#results .pill-card, #results .no-results:not(.loading)', { timeout: 10000 });
const pills = await page.locator('#results .pill-card').count();
check('optimiser produced a pill set from the imported inventory', pills > 0, `${pills} pills`);
check('craft copilot rendered alongside the results',
  await page.locator('#craft-copilot').count() === 1);

// ---- Pill Planner: one pool, visibly reduced (real browser) ----
await page.evaluate(() => {
  for (const name of Object.keys(PLANTS)) setQty(name, 0);
  setQty('Spirit Spring Herb', 40); setQty('Silverleaf Herb', 10);
  setQty('Cloud Mist Herb', 40); setQty('Wild Spirit Grass', 20);
  setQty('Ironbone Grass', 4); setQty('Crimson Flame Mushroom', 4);
  localStorage.removeItem('codexPlanner.v1');
  plannerPlan = []; savePlannerPlan();
});
const poolBefore = await page.evaluate(() => window.getOptimizerInventory()['Silverleaf Herb']);
check('before planning, the optimizer pool holds all 10 Silverleaf', poolBefore === 10, `got ${poolBefore}`);
await page.locator('.navtab[data-tab="planner"]').click();
await page.locator('#planner-pill').selectOption('Fury Pill');
await page.locator('#planner-count').fill('2');
await page.locator('#planner-add').click();
await page.waitForSelector('#planner-list .pl-item');
const poolAfter = await page.evaluate(() => window.getOptimizerInventory()['Silverleaf Herb']);
check('planning 2 Fury Pills reserves 4 Silverleaf out of the SAME pool (10 → 6)',
  poolAfter === 6, `got ${poolAfter}`);
const reservedNote = await page.locator('#planner-reserved').innerText();
check('the reserved-herbs note names Silverleaf with the reserved count',
  /4×\s*Silverleaf Herb/.test(reservedNote), reservedNote);
const shortage = await page.locator('#planner-note').innerText();
check('the stash covers the plan, so no shortage is flagged', /covers every planned pill/.test(shortage), shortage);

// ---- Pill Codex: the Crafted checkbox deducts exactly once ----
await page.locator('.navtab[data-tab="codex"]').click();
await page.locator('#codex-q').fill('Mistveil');
await page.waitForSelector('.cx-card[data-pill="Mistveil Focus Pill"]');
const silverBefore = await page.evaluate(() => inventoryState['Silverleaf Herb']);
await page.locator('.cx-card[data-pill="Mistveil Focus Pill"] input[data-codex-pill]').check();
const silverCrafted = await page.evaluate(() => inventoryState['Silverleaf Herb']);
check('ticking Crafted deducts the pill\'s herbs exactly once (−1 Silverleaf)',
  silverBefore - silverCrafted === 1, `${silverBefore} → ${silverCrafted}`);
await page.locator('.cx-card[data-pill="Mistveil Focus Pill"] input[data-codex-pill]').uncheck();
const silverBack = await page.evaluate(() => inventoryState['Silverleaf Herb']);
check('unticking gives the herbs back', silverBack === silverBefore, `${silverBack}`);

// ---- theme picker swaps the look and remembers it ----
await page.locator('#theme-picker').selectOption('theme-codex');
const themed = await page.evaluate(() => document.body.classList.contains('theme-codex'));
const savedTheme = await page.evaluate(() => localStorage.getItem('alchemyTheme'));
check('picking the Codex theme applies it to the body and saves the choice',
  themed && savedTheme === 'theme-codex');
await page.locator('#theme-picker').selectOption('');
check('the default xianxia theme is selectable again (no theme class left on body)',
  await page.evaluate(() => !['theme-codex', 'theme-jade', 'theme-ember', 'theme-ink']
    .some(c => document.body.classList.contains(c))));

// ---- no errors anywhere in that whole journey ----
const unique = [...new Set(errors)];
check('no console errors or failed requests during the whole flow', unique.length === 0,
  unique.slice(0, 8).join('\n      '));

await browser.close();
server.close();

console.log(`\n════════════════════════════════════════════════`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════════════\n`);
if (failed) { for (const p of problems) console.log(`  ✗ ${p}`); process.exit(1); }
