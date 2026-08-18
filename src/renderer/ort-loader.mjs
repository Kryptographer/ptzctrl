// Loads onnxruntime-web (the self-contained wasm bundle — the emscripten
// loader is embedded, so nothing else is fetched at runtime) and hands the
// API to the classic scripts through the promise vittrack.js set up.
// If this module fails to load, that promise simply never resolves and the
// tracker falls back to the built-in correlation filter after a timeout.
import * as ort from '../../node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';

const api = ort.InferenceSession ? ort : (ort.default ?? ort);
globalThis.__ortResolve?.(api);
