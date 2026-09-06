// ============================================================
// tests/all.mjs — one command runs every gate.
//
//   node tests/all.mjs
//
// 1. run-tests.js        alchemy/optimiser assertions            (no deps)
// 2. node --test tests/  unit tests, including the OCR matcher   (no deps)
// 3. ocr-bench.mjs       OCR accuracy + speed vs real screenshots
// 4. ui-smoke.mjs        end-to-end in a real browser
//
// 3 and 4 need Playwright, which is a DEV-only dependency — the app itself
// still ships with none. If it is missing they report SKIPPED (exit code 2)
// and the run still passes on 1 and 2, so a contributor without Playwright is
// not blocked from working on the alchemy side.
// ============================================================
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const steps = [
  ['alchemy + optimiser', 'run-tests.js', []],
  ['unit tests', null, ['--test', __dirname]],
  ['OCR benchmark', 'ocr-bench.mjs', []],
  ['UI smoke test', 'ui-smoke.mjs', []],
];

const results = [];
for (const [name, file, extra] of steps) {
  console.log(`\n──── ${name} ────`);
  const args = file ? [path.join(__dirname, file), ...extra] : extra;
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  results.push([name, r.status === null ? 1 : r.status]);
}

console.log('\n════════════════════════════════════════════════');
let failed = 0;
for (const [name, code] of results) {
  let label;
  if (code === 0) label = 'PASS';
  else if (code === 2) label = 'SKIPPED (Playwright not installed)';
  else { label = 'FAIL'; failed++; }
  console.log(`  ${label.padEnd(36)} ${name}`);
}
console.log('════════════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
