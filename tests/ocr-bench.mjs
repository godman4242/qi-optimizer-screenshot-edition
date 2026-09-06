// ============================================================
// tests/ocr-bench.mjs — OCR accuracy + speed benchmark.
//
// Serves the repo over a throwaway static server, drives the REAL
// pipeline (window.Vision.analyzeFiles) in a real browser against the
// real game screenshots in tests/fixtures/, and scores the result
// against tests/fixtures/ground-truth.json.
//
// This is the gate for every OCR change: no accuracy claim without a
// number from this file.
//
//   node tests/ocr-bench.mjs             # score + timings
//   node tests/ocr-bench.mjs --diag      # also dump every raw read
//   node tests/ocr-bench.mjs --headed    # watch it run
//
// Playwright is a DEV-only dependency and is resolved from wherever it
// happens to be installed (it is not vendored, and the app itself still
// has zero runtime dependencies). If it is missing the bench exits 2
// with install instructions rather than failing like a broken test.
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const argv = process.argv.slice(2);
const DIAG = argv.includes('--diag');
const HEADED = argv.includes('--headed');
// Accuracy floors. The bench fails (exit 1) below these, so a regression
// cannot be committed. Raise them when the pipeline genuinely improves;
// never lower them to make a run go green.
const MIN_NAME_ACC = num(argv, '--min-name', 1.0);
const MIN_QTY_ACC = num(argv, '--min-qty', 1.0);
// The metric the user actually feels. A row below the auto-accept threshold
// arrives UNTICKED and has to be confirmed by hand, so a "correct" read that
// scores 0.41 is still work for them. v3 shipped 8 of 24 rows unticked.
const MIN_AUTO_ACC = num(argv, '--min-auto', 0.90);
const MAX_SECONDS = num(argv, '--max-seconds', 8);

function num(a, flag, dflt) {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] !== undefined ? Number(a[i + 1]) : dflt;
}

// ---------- static server (no deps) ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream',
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(root, url === '/' ? 'index.html' : url);
      // contain traversal
      if (!path.resolve(file).startsWith(path.resolve(root))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------- scoring ----------
// Compares detected items against ground truth as a MULTISET keyed by plant
// name, so cell ordering never matters. Every GT row is one name point and one
// qty point; a qty point is only awarded when the name was found too.
function score(expected, got, autoAccept) {
  const want = new Map();
  for (const e of expected) want.set(e.name, (want.get(e.name) || 0) + 1);

  const seen = new Map();
  const detail = [];
  let nameHits = 0, qtyHits = 0, autoHits = 0;

  const byName = new Map();
  for (const g of got) {
    if (!g.name) continue;
    if (!byName.has(g.name)) byName.set(g.name, []);
    byName.get(g.name).push(g);
  }

  for (const e of expected) {
    const pool = byName.get(e.name) || [];
    const idx = seen.get(e.name) || 0;
    const hit = pool[idx];
    seen.set(e.name, idx + 1);
    if (hit) {
      nameHits++;
      const qtyOk = hit.qty === e.qty;
      if (qtyOk) qtyHits++;
      const auto = qtyOk && hit.nameScore >= autoAccept;
      if (auto) autoHits++;
      detail.push({
        ok: qtyOk && auto, expected: e, got: hit,
        kind: !qtyOk ? 'qty' : (auto ? 'exact' : 'unticked'),
      });
    } else {
      detail.push({ ok: false, expected: e, got: null, kind: 'name' });
    }
  }

  const spurious = got.filter((g) => g.name && !want.has(g.name));
  return { nameHits, qtyHits, autoHits, total: expected.length, detail, spurious };
}

function pct(a, b) { return b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`; }

// ---------- main ----------
let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('\n  ocr-bench needs Playwright (dev-only; the app itself stays dependency-free).');
  console.error('  Install it once with:  npm i -g playwright && npx playwright install chromium\n');
  process.exit(2);
}

const gt = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ground-truth.json'), 'utf8'));
const images = Object.keys(gt.images);
const { server, port } = await serve(ROOT);
const base = `http://127.0.0.1:${port}`;

const browser = await playwright.chromium.launch({ headless: !HEADED });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
  if (DIAG) console.log(`    [page:${m.type()}] ${m.text()}`);
});

console.log('════════════════════════════════════════════════════════');
console.log('  OCR BENCHMARK — real screenshots, real pipeline');
console.log('════════════════════════════════════════════════════════');
console.log(`  fixtures: ${images.length} screenshots, ${images.reduce((n, k) => n + gt.images[k].length, 0)} items\n`);

await page.goto(`${base}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.Vision && window.Vision.analyzeFiles, null, { timeout: 30000 });

// Warm the engine first and time it separately — engine boot is a one-off
// cost the user pays once per session, not per screenshot.
const warmMs = await page.evaluate(async () => {
  const t = performance.now();
  const f = await fetch('tests/fixtures/inv-05.jpg').then((r) => r.blob());
  await window.Vision.analyzeFiles([new File([f], 'warm.jpg', { type: 'image/jpeg' })]);
  return performance.now() - t;
});
console.log(`  engine warm-up + 1st screenshot: ${(warmMs / 1000).toFixed(1)}s (one-off per session)\n`);

const autoAccept = await page.evaluate(() => window.Vision.CFG.autoAccept);
console.log(`  auto-accept threshold: ${autoAccept}\n`);
let totalName = 0, totalQty = 0, totalAuto = 0, totalItems = 0, totalMs = 0;
const failures = [];

for (const img of images) {
  const expected = gt.images[img];
  const res = await page.evaluate(async (name) => {
    const blob = await fetch(`tests/fixtures/${name}`).then((r) => r.blob());
    const file = new File([blob], name, { type: 'image/jpeg' });
    const t = performance.now();
    const out = await window.Vision.analyzeFiles([file]);
    return { ms: performance.now() - t, perImage: out.perImage, rows: out.rows };
  }, img);

  const got = (res.perImage[0] && res.perImage[0].items) || [];
  const s = score(expected, got, autoAccept);
  totalName += s.nameHits; totalQty += s.qtyHits; totalAuto += s.autoHits;
  totalItems += s.total; totalMs += res.ms;

  const cells = res.perImage[0] ? res.perImage[0].cells : 0;
  const flag = s.autoHits === s.total ? '✓' : '✗';
  console.log(
    `  ${flag} ${img}  cells ${cells}/${expected.length}  ` +
    `name ${s.nameHits}/${s.total}  qty ${s.qtyHits}/${s.total}  ` +
    `ticked ${s.autoHits}/${s.total}  ${(res.ms / 1000).toFixed(1)}s`
  );

  for (const d of s.detail) {
    if (d.ok) continue;
    failures.push({ img, ...d });
    if (d.kind === 'name') {
      console.log(`      ✗ MISSED   "${d.expected.name}" x${d.expected.qty} — not detected at all`);
    } else if (d.kind === 'qty') {
      console.log(`      ✗ QTY      "${d.expected.name}" expected x${d.expected.qty}, got x${d.got.qty}`);
    } else {
      console.log(`      ~ UNTICKED "${d.expected.name}" read correctly but scored ` +
        `${d.got.nameScore.toFixed(2)} < ${autoAccept} — user must confirm it by hand`);
    }
  }
  for (const sp of s.spurious) {
    console.log(`      ? EXTRA   "${sp.name}" x${sp.qty} (score ${(sp.nameScore || 0).toFixed(2)}) — not in ground truth`);
  }
  if (DIAG) {
    for (const it of got) {
      console.log(`      · name=${JSON.stringify(it.name)} score=${(it.nameScore || 0).toFixed(2)} ` +
        `rarity=${it.rarity} rgb=${JSON.stringify(it.tileRgb)}\n        rawName=${JSON.stringify(it.rawName)} ` +
        `rawQty=${JSON.stringify(it.rawQty)} qty=${it.qty}`);
    }
  }
}

await browser.close();
server.close();

const nameAcc = totalName / totalItems;
const qtyAcc = totalQty / totalItems;
const autoAcc = totalAuto / totalItems;
const seconds = totalMs / 1000;

console.log('\n────────────────────────────────────────────────────────');
console.log(`  NAME accuracy : ${totalName}/${totalItems}  ${pct(totalName, totalItems)}   (floor ${(MIN_NAME_ACC * 100).toFixed(0)}%)`);
console.log(`  QTY  accuracy : ${totalQty}/${totalItems}  ${pct(totalQty, totalItems)}   (floor ${(MIN_QTY_ACC * 100).toFixed(0)}%)`);
console.log(`  TICKED (zero-touch) : ${totalAuto}/${totalItems}  ${pct(totalAuto, totalItems)}   (floor ${(MIN_AUTO_ACC * 100).toFixed(0)}%)`);
console.log(`  TIME (warm)   : ${seconds.toFixed(1)}s for ${images.length} screenshots ` +
  `= ${(seconds / images.length).toFixed(1)}s each   (budget ${MAX_SECONDS}s total)`);
console.log('────────────────────────────────────────────────────────');

if (pageErrors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(pageErrors)].slice(0, 10)) console.log(`    ! ${e}`);
}

const problems = [];
if (nameAcc < MIN_NAME_ACC) problems.push(`name accuracy ${pct(totalName, totalItems)} < floor ${(MIN_NAME_ACC * 100).toFixed(0)}%`);
if (qtyAcc < MIN_QTY_ACC) problems.push(`qty accuracy ${pct(totalQty, totalItems)} < floor ${(MIN_QTY_ACC * 100).toFixed(0)}%`);
if (autoAcc < MIN_AUTO_ACC) problems.push(`auto-ticked ${pct(totalAuto, totalItems)} < floor ${(MIN_AUTO_ACC * 100).toFixed(0)}%`);
if (seconds > MAX_SECONDS) problems.push(`${seconds.toFixed(1)}s > budget ${MAX_SECONDS}s`);

if (problems.length) {
  console.log(`\n  ✗ FAIL — ${problems.join('; ')}\n`);
  process.exit(1);
}
console.log('\n  ✓ PASS\n');
