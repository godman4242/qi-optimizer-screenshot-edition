# ⚗️ Qi Optimizer — Screenshot Edition

![HTML5](https://img.shields.io/badge/html5-%23E34F26.svg?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/css3-%231572B6.svg?style=for-the-badge&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)
![100% local](https://img.shields.io/badge/100%25-local-4ecdc4.svg?style=for-the-badge)

A fork-and-extend of the excellent **[QiMulti Optimizer for "Chasing Immortality"](https://github.com/Hitghul/alchemy-tool)** by **[Hitghul](https://github.com/Hitghul)** — a web app that computes the absolute best pill set for the Roblox game *Chasing Immortality*, maximising your **QiMulti (Qi Multiplier)** bonus from the plants you actually have.

## ✨ What this fork adds

### 📸 Screenshot Autofill (OCR)

No more typing 24 plant quantities by hand after every farming session.

1. Screenshot your in-game plant inventory
2. **Paste it** (Cmd/Ctrl+V), **drag it onto the page**, or click **"Autofill from Screenshot"**
3. Every herb and count is read locally, in your browser, and shown in a review table with a crop of the tile it came from
4. Fix anything that looks wrong, hit **Apply**

Multiple screenshots at once are fine — scroll your inventory, grab three or four, and drop them all in together.

**Measured on five real inventory screenshots** (`node tests/ocr-bench.mjs`) — "before" is the previous pipeline re-run through the same benchmark, quoting its *fastest* observed time:

| | before (v3) | now (v4) |
|---|---|---|
| Herb names read correctly | 23 / 24 | **24 / 24** |
| Quantities read correctly | 22 / 24 | **24 / 24** |
| Rows you don't have to touch | 16 / 24 | **23 / 24** |
| Time for 5 screenshots | 15.9 s | **1.5 s** |

How it gets there, in short: the quantity badge is read with a **digits-only whitelist** (the game's font draws `1` as a seriffed `I`, so `x51` genuinely looks like `x5I` — no amount of image tuning fixes that, but a whitelist does), the **tile colour tells the game's rarity**, which narrows 24 candidate herbs to 3–6 before a single letter is compared, and each screenshot is solved as a **one-herb-per-slot assignment** rather than 24 independent guesses.

Everything runs on your machine. No API keys, no uploads, no account — the OCR engine ([Tesseract.js](https://github.com/naptha/tesseract.js)) is vendored into `vendor/`.

### 💾 Inventory backup

One button turns your inventory into a plain text list you can paste into Discord, keep as a backup, or load on another device. Paste one back in and it restores — tolerant of typos, different order, and whatever a chat client did to the formatting.

### 🧪 Craft Copilot

A sticky panel above the results that walks you through the optimal set one craft at a time:

- Shows the **next pill to craft** with its full ingredient list
- Colour-codes each ingredient green/red against your live inventory
- One click on **"Crafted ✓"** decrements your inventory and advances

### Smaller things that make it less annoying

- **Undo** after an autofill, in case it overwrote something you'd typed
- **Replace** or **Add to current** when applying a screenshot
- A note telling you which herbs *weren't* in the screenshots, so you know what's still stale
- Warns when two overlapping screenshots disagree about a count, instead of silently adding them together
- Enter to apply, Esc to cancel

### Everything from the original still works

Smart derivation engine (Heavenly/Imperfect paths), inventory constraints, unique-effects validation, the GRASP solver, and the crafting tracker — see the [original README](https://github.com/Hitghul/alchemy-tool#features).

## 🌐 Live version

**Deployed on GitHub Pages:** <https://godman4242.github.io/qi-optimizer-screenshot-edition/>

## 🚀 Run it locally

No build step, no backend, no API keys:

```bash
git clone https://github.com/godman4242/qi-optimizer-screenshot-edition.git
cd qi-optimizer-screenshot-edition
python3 -m http.server 8080
# open http://localhost:8080
```

Any static file server works.

> **Two gotchas when running locally:**
> - Open it through a server, not by double-clicking `index.html` — the OCR engine loads its WebAssembly core with `fetch`, which browsers block on `file://`.
> - `python3 -m http.server` sends **no cache headers**, so after an update your browser may still serve the old page. **Hard-refresh** (`Cmd/Ctrl+Shift+R`). The version shown at the bottom of the page tells you which build you actually have.

## ✅ Tests

```bash
node tests/all.mjs
```

That runs four gates: the alchemy/optimiser assertions, the unit tests, the **OCR benchmark against real screenshots**, and an end-to-end browser smoke test. The first two need nothing installed; the last two use Playwright as a dev-only dependency and report `SKIPPED` if it isn't there.

`node tests/verify-live.mjs` does the same accuracy check against the **deployed** site in a fresh browser, so a green local run can't be mistaken for a working deploy.

## 🙏 Credits

This project would not exist without:

- **[Hitghul](https://github.com/Hitghul)** — creator of the original **[alchemy-tool](https://github.com/Hitghul/alchemy-tool)**. All of the core alchemy logic, the derivation engine, the GRASP optimiser, the data, and the beautiful xianxia-styled UI are his work, released under the WTFPL.
- **[Tesseract.js](https://github.com/naptha/tesseract.js)** (Apache-2.0) by Jerome Wu & Kevin Kwok — the local OCR engine powering the screenshot autofill.
- The *Chasing Immortality* community (the "Holy Grail of Pills" contributors) for the recipe research baked into the data.

If this fork helped you, please **star the [original repo](https://github.com/Hitghul/alchemy-tool)** — the original creator deserves the credit.

## 📄 License

The original project is WTFPL; this fork carries that forward. Tesseract.js remains Apache-2.0 (see `vendor/`).
