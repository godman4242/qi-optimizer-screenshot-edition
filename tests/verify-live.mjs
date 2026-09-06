// ============================================================
// tests/verify-live.mjs — prove the DEPLOYED site works.
//
// Uploading files is not the same as the site working. This loads the real
// public URL in a real browser, injects the fixture screenshots as bytes
// (so there is no cross-origin fetch), runs the deployed pipeline, and
// scores it against the same ground truth the local benchmark uses.
//
//   node tests/verify-live.mjs
//   node tests/verify-live.mjs https://some-other-deploy/
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const URL_ARG = process.argv.find((a) => a.startsWith('http'))
  || 'https://godman4242.github.io/qi-optimizer-screenshot-edition/';

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('\n  verify-live needs Playwright (dev-only).');
  console.error('  npm i -g playwright && npx playwright install chromium\n');
  process.exit(2);
}

process.on('unhandledRejection', (e) => {
  console.error('\n  UNEXPECTED ERROR:', (e && e.message) || e);
  process.exit(1);
});

const gt = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ground-truth.json'), 'utf8'));
const images = Object.keys(gt.images);

console.log('════════════════════════════════════════════════════════');
console.log('  LIVE DEPLOY VERIFICATION');
console.log(`  ${URL_ARG}`);
console.log('════════════════════════════════════════════════════════\n');

const browser = await playwright.chromium.launch();
// A brand-new context every time: this must prove the site works for someone
// arriving with an empty cache, which is the opposite of the stale-cache bug
// this check exists to catch.
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

await page.goto(URL_ARG, { waitUntil: 'load', timeout: 60000 });
await page.evaluate(() => { const s = document.getElementById('splash-screen'); if (s) s.remove(); });
await page.waitForFunction(() => window.Vision && window.Vision.analyzeFiles, null, { timeout: 60000 });

const version = await page.evaluate(() => {
  const el = document.getElementById('vision-version');
  return el ? el.textContent : '(no version stamp)';
});
console.log(`  deployed build: ${version}\n`);

let totalName = 0, totalQty = 0, totalAuto = 0, totalItems = 0, totalMs = 0;
const autoAccept = await page.evaluate(() => window.Vision.CFG.autoAccept);

for (const img of images) {
  const bytes = [...fs.readFileSync(path.join(FIXTURES, img))];
  const expected = gt.images[img];
  const res = await page.evaluate(async ([name, arr]) => {
    const file = new File([new Uint8Array(arr)], name, { type: 'image/jpeg' });
    const t = performance.now();
    const out = await window.Vision.analyzeFiles([file]);
    return { ms: performance.now() - t, items: (out.perImage[0] || {}).items || [] };
  }, [img, bytes]);

  const pool = new Map();
  for (const g of res.items) {
    if (!g.name) continue;
    if (!pool.has(g.name)) pool.set(g.name, []);
    pool.get(g.name).push(g);
  }
  const used = new Map();
  let n = 0, q = 0, a = 0;
  const misses = [];
  for (const e of expected) {
    const i = used.get(e.name) || 0;
    used.set(e.name, i + 1);
    const hit = (pool.get(e.name) || [])[i];
    if (!hit) { misses.push(`MISSED "${e.name}" x${e.qty}`); continue; }
    n++;
    if (hit.qty === e.qty) { q++; if (hit.nameScore >= autoAccept) a++; else misses.push(`unticked "${e.name}" (${hit.nameScore.toFixed(2)})`); }
    else misses.push(`QTY "${e.name}" expected x${e.qty}, got x${hit.qty}`);
  }
  totalName += n; totalQty += q; totalAuto += a; totalItems += expected.length; totalMs += res.ms;
  console.log(`  ${a === expected.length ? '✓' : '✗'} ${img}  name ${n}/${expected.length}  ` +
    `qty ${q}/${expected.length}  ticked ${a}/${expected.length}  ${(res.ms / 1000).toFixed(1)}s`);
  for (const m of misses) console.log(`      ~ ${m}`);
}

await browser.close();

const pct = (x) => `${((x / totalItems) * 100).toFixed(1)}%`;
console.log('\n────────────────────────────────────────────────────────');
console.log(`  NAME  : ${totalName}/${totalItems}  ${pct(totalName)}`);
console.log(`  QTY   : ${totalQty}/${totalItems}  ${pct(totalQty)}`);
console.log(`  TICKED: ${totalAuto}/${totalItems}  ${pct(totalAuto)}`);
console.log(`  TIME  : ${(totalMs / 1000).toFixed(1)}s for ${images.length} screenshots`);
console.log('────────────────────────────────────────────────────────');

const unique = [...new Set(errors)];
if (unique.length) {
  console.log('\n  page errors:');
  for (const e of unique.slice(0, 8)) console.log(`    ! ${e.slice(0, 160)}`);
}

const ok = totalQty === totalItems && totalAuto / totalItems >= 0.9 && !unique.length;
console.log(ok ? '\n  ✓ THE LIVE SITE WORKS\n' : '\n  ✗ LIVE SITE PROBLEM\n');
process.exit(ok ? 0 : 1);
