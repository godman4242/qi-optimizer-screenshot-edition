# Dependencies (vendored, no install step)

The OCR engine is vendored directly so the app runs fully offline:

- `vendor/tesseract.min.js` — Tesseract.js v7.0.0 main thread lib ([Apache-2.0](https://github.com/naptha/tesseract.js))
- `vendor/worker.min.js` — Tesseract.js v7.0.0 worker bootstrap (requests tesseract.js-core `^7.0.0`)
- `vendor/tesseract-core*.wasm.js` — emscripten core builds (tesseract.js-core v7.0.0, all 6 variants)
- `vendor/eng.traineddata` — English language model (4.0.0 best_int)

Core variants (all 6 from tesseract.js-core@7.0.0):
- `tesseract-core.wasm.js`
- `tesseract-core-simd.wasm.js`
- `tesseract-core-lstm.wasm.js`
- `tesseract-core-simd-lstm.wasm.js`
- `tesseract-core-relaxedsimd.wasm.js`
- `tesseract-core-relaxedsimd-lstm.wasm.js`

Source: https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/ and https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/

License: Apache-2.0 (tesseract.js and tesseract.js-core).

If you upgrade, re-vendor every core filename the worker can request —
all 6 variants listed above, including both relaxedsimd builds.