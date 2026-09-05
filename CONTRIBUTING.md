# Contributing

Thanks for wanting to improve the Qi Optimizer! This is a small static app — no build step, no dependencies to install.

## Setup

```bash
git clone <repo>
cd qi-optimizer-screenshot-edition
python3 -m http.server 8080
```

Open http://localhost:8080. That's it.

## Project layout

```
index.html      — single page, loads everything
css/style.css   — all styling (original + fork additions at the bottom)
js/data.js      — plant/recipe game data (static)
js/alchemy.js   — derivation engine
js/optimizer.js — GRASP solver (original)
js/ui.js        — UI orchestration (original)
js/vision.js    — FORK: screenshot OCR autofill
js/copilot.js   — FORK: craft copilot panel
vendor/         — vendored Tesseract.js 7 runtime + eng traineddata (Apache-2.0)
```

## Guidelines

- **Test OCR with real screenshots.** Fuzzy-match thresholds in `js/vision.js` (`bestScore >= 0.55` etc.) are tuned against actual inventory screenshots — if you change them, verify against a dark-theme screenshot and a bright one.
- **Don't move recipe data.** `js/data.js` mirrors the game's crafting rules; changes there must match in-game behaviour exactly.
- **Keep it dependency-free.** The app must run offline from a plain static server. No npm, no CDNs at runtime.
- **Keep the vendored OCR self-contained.** If you upgrade Tesseract.js, vendor all files the worker can request (see `worker.min.js` core filename list) and keep `langPath`/`corePath` pointing at `vendor/`.

## Reporting OCR issues

When the autofill misreads a screenshot, open an issue with: the screenshot (crop out anything personal), what was detected vs. expected. That's the main tuning input for the matcher.