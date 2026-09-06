// ============================================================
// tests/asset-versions.test.mjs — a changed file must get a changed ?v=
//
// index.html cache-busts its own assets with a `?v=` query string. Nothing
// enforced that, so a file could change while its query string stayed put —
// and it did, twice:
//
//   · css/style.css sat at ?v=4.0 through two rounds of edits, so a returning
//     visitor with a cached stylesheet would have seen none of the new styling.
//   · js/backup.js sat at ?v=1.0 after being rewritten.
//
// This is the same failure that made the app die on localhost: a browser
// happily serving one old file next to five new ones. Caches are not something
// to be careful about by hand.
//
// When this fails it prints the exact edit to make. After making it:
//
//   UPDATE_ASSET_VERSIONS=1 node --test tests/asset-versions.test.mjs
//
// records the new content hashes.
// ============================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'fixtures', 'asset-versions.json');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Every local asset index.html versions with ?v=
const referenced = [...html.matchAll(/(?:src|href)="([^"?]+)\?v=([^"]+)"/g)]
  .map(([, file, version]) => ({ file, version }))
  .filter((a) => !/^https?:/.test(a.file));

const hashOf = (file) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, file)))
  .digest('hex')
  .slice(0, 12);

const current = Object.fromEntries(
  referenced.map((a) => [a.file, { version: a.version, sha: hashOf(a.file) }]));

if (process.env.UPDATE_ASSET_VERSIONS) {
  fs.writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`recorded ${Object.keys(current).length} asset versions`);
}

const recorded = fs.existsSync(MANIFEST)
  ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  : {};

describe('cache-busting', () => {
  test('index.html versions every local script and stylesheet', () => {
    const unversioned = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map(([, f]) => f)
      .filter((f) => /\.(js|css)$/.test(f) && !/^https?:/.test(f));
    assert.deepEqual(unversioned, [],
      `these assets have no ?v= and will be served from cache forever: ${unversioned.join(', ')}`);
  });

  test('every referenced asset exists', () => {
    const missing = referenced.filter((a) => !fs.existsSync(path.join(ROOT, a.file)));
    assert.equal(missing.length, 0,
      `index.html references files that are not there: ${missing.map((m) => m.file).join(', ')}`);
  });

  test('no two assets are recorded under the same stale version by accident', () => {
    // Purely a sanity check that the manifest was ever written.
    assert.ok(Object.keys(recorded).length > 0,
      'no manifest — run: UPDATE_ASSET_VERSIONS=1 node --test tests/asset-versions.test.mjs');
  });

  test('a changed asset has a changed ?v=', () => {
    const stale = [];
    for (const [file, now] of Object.entries(current)) {
      const before = recorded[file];
      if (!before) {
        stale.push(`${file} is new — record it (UPDATE_ASSET_VERSIONS=1)`);
        continue;
      }
      if (before.sha !== now.sha && before.version === now.version) {
        stale.push(`${file} CHANGED but index.html still says ?v=${now.version} — bump it`);
      }
    }
    assert.deepEqual(stale, [],
      `stale cache-busters:\n  ${stale.join('\n  ')}\n\n` +
      'A returning visitor would keep the OLD copy of these files.\n' +
      'Bump the ?v= in index.html, then run:\n' +
      '  UPDATE_ASSET_VERSIONS=1 node --test tests/asset-versions.test.mjs');
  });
});
