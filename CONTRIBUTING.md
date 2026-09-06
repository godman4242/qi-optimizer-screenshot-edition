# Contributing

Thanks for wanting to improve the Qi Optimizer! This is a small static app — no build step, no runtime dependencies.

## Setup

```bash
git clone <repo>
cd qi-optimizer-screenshot-edition
python3 -m http.server 8080
```

Open http://localhost:8080. That's it.

Serve it rather than opening `index.html` directly: the OCR engine fetches its WebAssembly core, which browsers block on `file://`.

## Project layout

```
index.html          — single page, loads everything
css/style.css       — all styling (original + fork additions at the bottom)
js/data.js          — plant/recipe game data (static)
js/alchemy.js       — derivation engine
js/optimizer.js     — GRASP solver (original)
js/ui.js            — UI orchestration (original)
js/vision.js        — FORK: screenshot OCR. Part 1 is pure matching logic (no
                      DOM: name similarity, rarity, assignment); Part 2 is the
                      image pipeline, OCR worker pool and review overlay.
js/copilot.js       — FORK: craft copilot panel
js/backup.js        — FORK: inventory backup / restore
vendor/             — vendored Tesseract.js 7 runtime + eng traineddata (Apache-2.0)
tests/fixtures/     — five real inventory screenshots + hand-checked ground truth
```

## Tests

```bash
node tests/all.mjs
```

Four gates:

| gate | needs | what it protects |
|---|---|---|
| `tests/run-tests.js` | nothing | alchemy + optimiser invariants |
| `node --test tests/` | nothing | unit tests, incl. the OCR name matcher |
| `tests/ocr-bench.mjs` | Playwright | **OCR accuracy and speed on real screenshots** |
| `tests/ui-smoke.mjs` | Playwright | the page actually wires together, end to end |

Plus, after deploying:

```bash
node tests/verify-live.mjs
```

which loads the **public URL** in a fresh browser with an empty cache and runs the real screenshots through the deployed build. Uploading files is not the same as the site working — this is what proves it.

Playwright is dev-only — install once with `npm i -g playwright && npx playwright install chromium`. Without it the last two report `SKIPPED` and the run still passes on the first two.

## Changing the OCR

**Never tune a threshold by eye. Run the benchmark.**

`tests/ocr-bench.mjs` scores the real pipeline against five real screenshots and 24 hand-checked herbs, and fails below its floors (currently 100% names, 100% quantities, 90% rows auto-ticked, 8 s). Every constant in the pipeline lives in `VISION_CFG` at the top of `js/vision.js` and every one of them was picked by sweeping it against that benchmark.

```bash
node tests/ocr-bench.mjs            # score + timing
node tests/ocr-bench.mjs --diag     # every raw read, tile colour and rarity per cell
node tests/ocr-bench.mjs --headed   # watch it run
```

Two things worth knowing before you touch the image code, both learned the hard way:

- **The badge is solid BLACK glyphs with a WHITE outline**, not white-on-dark. The v3 pipeline inverted the crop on the wrong assumption and then spent twelve OCR passes and a table of `I→1` / `O→6` guesses undoing its own damage. Look at a crop before you trust a description of one — including this one.
- **The tile/name boundary cannot be found from row intensity.** The median is dragged up by a wide name line, the 25th percentile is dragged down by dark icon art, and the bracket band is indistinguishable from the first name line's anti-aliased edge. The name band is found from the bottom up, by its own ink, requiring ink in the *middle* of the row — corner brackets never have that.

If the autofill misreads a screenshot of yours, the most useful thing you can send is **the screenshot itself** plus what it should have said. Add it to `tests/fixtures/`, extend `ground-truth.json`, and the benchmark will tell you whether a change actually helped.

## Guidelines

- **Don't move recipe data.** `js/data.js` mirrors the game's crafting rules; changes there must match in-game behaviour exactly.
- **Keep the app dependency-free at runtime.** It must run offline from a plain static server. No npm, no CDNs at runtime. Dev-only tooling (Playwright) is fine.
- **Keep the vendored OCR self-contained.** If you upgrade Tesseract.js, vendor every file the worker can request (see `vendor/README.md`) and keep `langPath`/`corePath` pointing at `vendor/`.
- **Pure logic goes in Part 1 of `vision.js`.** Anything that doesn't need a canvas belongs above the `PART 2` banner, where `tests/vision-match.test.mjs` exercises it in a `node:vm` with no browser. It used to be a separate `js/vision-match.js`; a stale browser cache proved that a second file is a second thing that can go missing, and the app died on `ReferenceError: VisionMatch is not defined` while telling the player "No herbs detected".
- **A crash must never be reported as a bad screenshot.** The empty state distinguishes the two, and `tests/ui-smoke.mjs` fails if that regresses.
