# ⚗️ Qi Optimizer — Screenshot Edition

![HTML5](https://img.shields.io/badge/html5-%23E34F26.svg?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/css3-%231572B6.svg?style=for-the-badge&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)
![Offline](https://img.shields.io/badge/works-offline-4ecdc4.svg?style=for-the-badge)

A fork-and-extend of the excellent **[QiMulti Optimizer for "Chasing Immortality"](https://github.com/Hitghul/alchemy-tool)** by **[Hitghul](https://github.com/Hitghul)** — a web app that computes the absolute best pill set for the Roblox game *Chasing Immortality*, maximising your **QiMulti (Qi Multiplier)** bonus from the plants you actually have.

## ✨ What this fork adds

### 📸 Screenshot Autofill (OCR)
No more typing 24 plant quantities by hand after every farming session.

1. Take a screenshot of your in-game plant inventory (or press **Cmd/Ctrl+V** to paste one straight into the page)
2. Click **"Autofill from Screenshot"** (or just paste)
3. The app runs OCR locally in your browser ([Tesseract.js](https://github.com/naptha/tesseract.js) — vendored, **no data leaves your machine**), fuzzy-matches each line against the plant database, and shows a review table
4. Tick/untick and correct any quantities, hit **Apply** — done

Fuzzy matching tolerates OCR noise (wrong word order, misread characters) and flags low-confidence rows for review before anything touches your inventory.

### 🧪 Craft Copilot
A sticky panel above the results that walks you through the optimal set one craft at a time:

- Shows the **next pill to craft** with its full ingredient list
- Colour-codes each ingredient green/red based on your live inventory
- One click on **"Crafted ✓"** decrements your inventory and advances to the next pill

### Everything from the original still works
Smart derivation engine (Heavenly/Imperfect paths), inventory constraints, unique-effects validation, the GRASP solver, and the crafting tracker — see the [original README](https://github.com/Hitghul/alchemy-tool#features) for details.

## 🚀 Run it

No build step, no backend, no API keys:

```bash
git clone https://github.com/godman4242/qi-optimizer-screenshot-edition.git
cd qi-optimizer-screenshot-edition
python3 -m http.server 8080
# open http://localhost:8080
```

(Any static file server works. Opening `index.html` directly also works in most browsers — the only fetches are the vendored OCR engine files.)

## 🙏 Credits

This project would not exist without:

- **[Hitghul](https://github.com/Hitghul)** — creator of the original **[alchemy-tool](https://github.com/Hitghul/alchemy-tool)**. All of the core alchemy logic, the derivation engine, the GRASP optimiser, the data, and the beautiful xianxia-styled UI are his work, released under the WTFPL.
- **[Tesseract.js](https://github.com/naptha/tesseract.js)** (Apache-2.0) by Jerome Wu & Kevin Kwok — the local OCR engine powering the screenshot autofill.
- The *Chasing Immortality* community (the "Holy Grail of Pills" contributors) for the recipe research baked into the data.

If this fork helped you, please **star the [original repo](https://github.com/Hitghul/alchemy-tool)** — the original creator deserves the credit.

## 📄 License

The original project is WTFPL; this fork carries that forward. Tesseract.js remains Apache-2.0 (see `vendor/`).