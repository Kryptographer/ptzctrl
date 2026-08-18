'use strict';

/**
 * VitTrack: neural single-object tracker (OpenCV Zoo's object_tracking_vittrack,
 * a distilled vision-transformer tracker, Apache-2.0) running on
 * onnxruntime-web. This file is a faithful JS port of OpenCV's
 * tracker_vit.cpp pre/post-processing:
 *
 *   - template: a square crop of ceil(sqrt(w*h) * 2) around the subject,
 *     resized to 128×128 — computed once when tracking starts.
 *   - search:   a square crop of ceil(sqrt(w*h) * 4) around the last known
 *     position, resized to 256×256 — computed every frame.
 *   - Both crops are normalized to (px/255 - mean) / std per channel, in
 *     OpenCV's BGR channel order (mean 0.485/0.456/0.406, std
 *     0.229/0.224/0.225 applied to B/G/R respectively — matching how the
 *     reference implementation feeds BGR Mats, which is what the published
 *     accuracy numbers were measured with).
 *   - Outputs: a 16×16 confidence map (windowed with a centered Hanning
 *     window before the argmax), a 2×16×16 size map and a 2×16×16 offset
 *     map, decoded to a box in source-pixel coordinates plus a confidence
 *     score in [0..1].
 *
 * Everything here is DOM-free so the same file loads in the renderer and in
 * Node-based tests. Frame pixels come in through a "sampler" callback:
 *   sampler(cx, cy, cropSize, outSize) -> RGBA bytes (outSize×outSize×4)
 *     — a square crop of the frame centered on (cx, cy) with black padding
 *       outside the frame, resampled to outSize. Returns null if the frame
 *       can't be read.
 */

(function () {
  const TEMPLATE_SIZE = 128;
  const SEARCH_SIZE = 256;
  const MAP = 16; // output maps are MAP×MAP
  const TEMPLATE_FACTOR = 2;
  const SEARCH_FACTOR = 4;
  const MEAN = [0.485, 0.456, 0.406]; // applied to channels B, G, R
  const STD = [0.229, 0.224, 0.225];

  /**
   * Known model families. Both use the same crop geometry and decode; they
   * differ in tensor names and normalization:
   *   - vittrack: bundled default (see file header).
   *   - smat: SMAT (github.com/goutamyg/SMAT, WACV 2024, Apache-2.0) — a
   *     markedly more accurate drop-in (LaSOT AUC 61.7 vs 48.6). Not
   *     bundled (its ONNX is only published via Google Drive); users can
   *     drop the file in as described in the README. Per the author's
   *     MVT.cpp reference: inputs z/x, RGB in 0..1 with no mean/std, and
   *     outputs identified by position (boxes, score, size, offset).
   */
  const PROFILES = {
    vittrack: {
      inputTemplate: 'template',
      inputSearch: 'search',
      normalize: 'imagenet-bgr',
      outputNames: { score: 'output1', size: 'output2', offset: 'output3' },
    },
    smat: {
      inputTemplate: 'z',
      inputSearch: 'x',
      normalize: 'unit-rgb',
      outputIndexes: { score: 1, size: 2, offset: 3 },
    },
  };

  /** Square crop edge for a box, per the reference implementation. */
  function vitCropSize(w, h, factor) {
    return Math.max(2, Math.ceil(Math.sqrt(w * h) * factor));
  }

  /** OpenCV's centered 1-D Hann window: 0.5*(1-cos(2π(i+1)/(n+1))). */
  function hann1dCentered(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * (i + 1)) / (n + 1)));
    }
    return out;
  }

  /** Centered 2-D Hann window, row-major n×n. */
  function hann2dCentered(n) {
    const h = hann1dCentered(n);
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out[y * n + x] = h[y] * h[x];
    }
    return out;
  }

  /**
   * RGBA bytes (size×size×4) → normalized CHW Float32Array (3×size×size).
   * 'imagenet-bgr' matches OpenCV's VitTrack path (see header comment);
   * 'unit-rgb' matches SMAT's reference pipeline (RGB, just /255).
   */
  function rgbaToVitBlob(rgba, size, normalize = 'imagenet-bgr') {
    const px = size * size;
    const out = new Float32Array(3 * px);
    if (normalize === 'unit-rgb') {
      for (let i = 0, j = 0; i < px; i++, j += 4) {
        out[i] = rgba[j] / 255; // R
        out[px + i] = rgba[j + 1] / 255; // G
        out[2 * px + i] = rgba[j + 2] / 255; // B
      }
    } else {
      for (let i = 0, j = 0; i < px; i++, j += 4) {
        out[i] = (rgba[j + 2] / 255 - MEAN[0]) / STD[0]; // B
        out[px + i] = (rgba[j + 1] / 255 - MEAN[1]) / STD[1]; // G
        out[2 * px + i] = (rgba[j] / 255 - MEAN[2]) / STD[2]; // R
      }
    }
    return out;
  }

  /**
   * Decode the model's three output maps into a box around the crop that was
   * centered on (cx, cy) with edge cropSz. Returns {cx, cy, w, h, score}.
   * conf: MAP² values; sizeMap/offMap: 2×MAP² (w/x plane first, then h/y).
   */
  function decodeVitOutputs(conf, sizeMap, offMap, hann, cx, cy, cropSz) {
    const n = MAP * MAP;
    let best = -Infinity, bi = 0;
    for (let i = 0; i < n; i++) {
      const v = conf[i] * hann[i];
      if (v > best) { best = v; bi = i; }
    }
    const mx = bi % MAP;
    const my = (bi / MAP) | 0;
    const cxN = (mx + offMap[bi]) / MAP;
    const cyN = (my + offMap[n + bi]) / MAP;
    const wN = sizeMap[bi];
    const hN = sizeMap[n + bi];
    const x0 = cx - cropSz / 2;
    const y0 = cy - cropSz / 2;
    return {
      cx: x0 + cxN * cropSz,
      cy: y0 + cyN * cropSz,
      w: wN * cropSz,
      h: hN * cropSz,
      score: best,
    };
  }

  /**
   * Pure-JS sampler over a raw RGBA frame ({data, width, height}) — bilinear
   * resample of the square crop, black outside the frame. The renderer uses
   * a canvas-based sampler instead; this one exists for headless tests (and
   * matches the canvas semantics closely enough for the model).
   */
  function samplerForFrame(frame) {
    const { data, width: fw, height: fh } = frame;
    return (cx, cy, cropSz, outSize) => {
      const out = new Uint8ClampedArray(outSize * outSize * 4);
      const x0 = cx - cropSz / 2;
      const y0 = cy - cropSz / 2;
      const step = cropSz / outSize;
      for (let oy = 0; oy < outSize; oy++) {
        const sy = y0 + (oy + 0.5) * step - 0.5;
        const iy = Math.floor(sy);
        const fy = sy - iy;
        for (let ox = 0; ox < outSize; ox++) {
          const sx = x0 + (ox + 0.5) * step - 0.5;
          const ix = Math.floor(sx);
          const fx = sx - ix;
          let r = 0, g = 0, b = 0;
          for (let dy = 0; dy <= 1; dy++) {
            const yy = iy + dy;
            if (yy < 0 || yy >= fh) continue;
            const wy = dy ? fy : 1 - fy;
            for (let dx = 0; dx <= 1; dx++) {
              const xx = ix + dx;
              if (xx < 0 || xx >= fw) continue;
              const w = wy * (dx ? fx : 1 - fx);
              const p = (yy * fw + xx) * 4;
              r += data[p] * w;
              g += data[p + 1] * w;
              b += data[p + 2] * w;
            }
          }
          const o = (oy * outSize + ox) * 4;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = 255;
        }
      }
      return out;
    };
  }

  /**
   * The tracker engine. Holds the ONNX session and the (fixed) template
   * tensor; the caller owns the box between frames.
   */
  class VitTrackEngine {
    constructor(ortApi, session, profileName = 'vittrack') {
      this.ort = ortApi;
      this.session = session;
      this.profileName = profileName;
      this.profile = PROFILES[profileName] || PROFILES.vittrack;
      this.template = null;
      this.hann = hann2dCentered(MAP);
    }

    /** Create the model session and run a throwaway inference to JIT-warm it. */
    static async create(ortApi, modelBytes, profileName = 'vittrack') {
      const session = await ortApi.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      const engine = new VitTrackEngine(ortApi, session, profileName);
      const p = engine.profile;
      await session.run({
        [p.inputTemplate]: new ortApi.Tensor('float32', new Float32Array(3 * TEMPLATE_SIZE * TEMPLATE_SIZE), [1, 3, TEMPLATE_SIZE, TEMPLATE_SIZE]),
        [p.inputSearch]: new ortApi.Tensor('float32', new Float32Array(3 * SEARCH_SIZE * SEARCH_SIZE), [1, 3, SEARCH_SIZE, SEARCH_SIZE]),
      });
      return engine;
    }

    /** Learn the subject: box is {cx, cy, w, h} in source pixels. */
    init(sampler, box) {
      const cropSz = vitCropSize(box.w, box.h, TEMPLATE_FACTOR);
      return this.initFromRgba(sampler(box.cx, box.cy, cropSz, TEMPLATE_SIZE));
    }

    /**
     * Learn the subject from an already-sampled template crop (lets the
     * caller freeze the pixels the moment the user finishes drawing, even
     * if the model is still loading at that point).
     */
    initFromRgba(rgba) {
      if (!rgba) return false;
      this.template = new this.ort.Tensor(
        'float32',
        rgbaToVitBlob(rgba, TEMPLATE_SIZE, this.profile.normalize),
        [1, 3, TEMPLATE_SIZE, TEMPLATE_SIZE]
      );
      return true;
    }

    /** Sample the template crop for a box (pass to initFromRgba later). */
    static sampleTemplate(sampler, box) {
      const cropSz = vitCropSize(box.w, box.h, TEMPLATE_FACTOR);
      return sampler(box.cx, box.cy, cropSz, TEMPLATE_SIZE);
    }

    /**
     * Find the subject near a box. opts.factor widens the search region
     * (default 4× — the model's native regime; larger values trade accuracy
     * for reach and are used while re-acquiring a lost subject). opts.cx/cy
     * probe a different center than the box's (lost-subject hunting).
     * Returns {cx, cy, w, h, score} in source pixels, or null if the frame
     * couldn't be sampled.
     */
    async update(sampler, box, opts = {}) {
      if (!this.template) throw new Error('VitTrackEngine: init() first');
      const factor = opts.factor ?? SEARCH_FACTOR;
      const cx = opts.cx ?? box.cx;
      const cy = opts.cy ?? box.cy;
      const cropSz = vitCropSize(box.w, box.h, factor);
      const rgba = sampler(cx, cy, cropSz, SEARCH_SIZE);
      if (!rgba) return null;
      const p = this.profile;
      const search = new this.ort.Tensor(
        'float32',
        rgbaToVitBlob(rgba, SEARCH_SIZE, p.normalize),
        [1, 3, SEARCH_SIZE, SEARCH_SIZE]
      );
      const out = await this.session.run({
        [p.inputTemplate]: this.template,
        [p.inputSearch]: search,
      });
      const pick = (key) => {
        if (p.outputNames) return out[p.outputNames[key]];
        return out[this.session.outputNames[p.outputIndexes[key]]];
      };
      return decodeVitOutputs(
        pick('score').data,
        pick('size').data,
        pick('offset').data,
        this.hann,
        cx, cy, cropSz
      );
    }
  }

  const api = {
    VitTrackEngine,
    PROFILES,
    vitCropSize,
    hann2dCentered,
    rgbaToVitBlob,
    decodeVitOutputs,
    samplerForFrame,
    TEMPLATE_SIZE,
    SEARCH_SIZE,
    SEARCH_FACTOR,
  };
  globalThis.VitTrack = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
