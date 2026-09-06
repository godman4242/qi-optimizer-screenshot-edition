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
