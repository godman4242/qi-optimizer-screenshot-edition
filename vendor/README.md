# Dependencies (vendored, no install step)

The OCR engine is vendored directly so the app runs fully offline:

- `vendor/tesseract.min.js` — Tesseract.js v7.0.0 main thread lib ([Apache-2.0](https://github.com/naptha/tesseract.js))
- `vendor/worker.min.js` — worker bootstrap
- `vendor/tesseract-core*.wasm.js` — emscripten core builds (tesseract.js-core v6.0.0, incl. SIMD and LSTM variants)
- `vendor/eng.traineddata` — English language model (4.0.0 best_int)

Source: https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/ and https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/

If you upgrade, re-vendor every core filename the worker can request:
`tesseract-core.wasm.js`, `tesseract-core-simd.wasm.js`,
`tesseract-core-lstm.wasm.js`, `tesseract-core-simd-lstm.wasm.js`
(and the relaxedsimd variants if you want full hardware coverage).