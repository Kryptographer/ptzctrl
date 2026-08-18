'use strict';

/**
 * Headless tests for the neural tracker (vittrack.js) and the tracking
 * stability layer (tracker.js AxisTracker).
 *
 *   node test/run-tests.js
 *
 * Part 1 checks the pure math (Hanning window, normalization, output
 * decoding, model-profile plumbing) with no ONNX involved. Part 2 runs the
 * hold/follow stability gate through closed-loop simulations (still subject,
 * glitch frames, walk-off, slow drift). Part 3 loads the real bundled model
 * through onnxruntime-web and tracks a synthetic moving, scaling subject
 * end-to-end — the same code path the app runs, minus the canvas (the test
 * uses the pure-JS bilinear sampler).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const VT = require('../src/renderer/vittrack.js');
const TR = require('../src/renderer/tracker.js');

let passed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- unit tests

async function unitTests() {
console.log('vittrack math:');

await ok('centered Hanning window matches the OpenCV formula and is symmetric', () => {
  const h2 = VT.hann2dCentered(16);
  const h0 = 0.5 * (1 - Math.cos((2 * Math.PI * 1) / 17));
  assert.ok(Math.abs(h2[0] - h0 * h0) < 1e-6);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(h2[i] - h2[15 - i]) < 1e-6, `row symmetry at ${i}`);
  }
  // centre of a 16-wide window is between cells 7 and 8, both near 1
  assert.ok(h2[7 * 16 + 7] > 0.98);
});

await ok('rgbaToVitBlob imagenet-bgr matches OpenCV normalization', () => {
  const rgba = new Uint8ClampedArray([255, 128, 0, 255]); // R,G,B,A
  const blob = VT.rgbaToVitBlob(rgba, 1, 'imagenet-bgr');
  assert.ok(Math.abs(blob[0] - (0 / 255 - 0.485) / 0.229) < 1e-6, 'B channel');
  assert.ok(Math.abs(blob[1] - (128 / 255 - 0.456) / 0.224) < 1e-6, 'G channel');
  assert.ok(Math.abs(blob[2] - (255 / 255 - 0.406) / 0.225) < 1e-6, 'R channel');
});

await ok('rgbaToVitBlob unit-rgb matches the SMAT reference (RGB / 255)', () => {
  const rgba = new Uint8ClampedArray([255, 128, 0, 255]);
  const blob = VT.rgbaToVitBlob(rgba, 1, 'unit-rgb');
  assert.ok(Math.abs(blob[0] - 1) < 1e-6, 'R channel');
  assert.ok(Math.abs(blob[1] - 128 / 255) < 1e-6, 'G channel');
  assert.ok(Math.abs(blob[2] - 0) < 1e-6, 'B channel');
});

await ok('decodeVitOutputs maps peak cell + offsets + sizes back to source pixels', () => {
  const n = 256;
  const conf = new Float32Array(n).fill(0.02);
  const size = new Float32Array(2 * n);
  const off = new Float32Array(2 * n);
  const bi = 6 * 16 + 10; // cell x=10, y=6
  conf[bi] = 1;
  off[bi] = 0.3; // x offset
  off[n + bi] = -0.2; // y offset
  size[bi] = 0.5; // w
  size[n + bi] = 0.25; // h
  const hann = VT.hann2dCentered(16);
  const r = VT.decodeVitOutputs(conf, size, off, hann, 100, 80, 200);
  // crop origin is (0, -20); peak decodes at ((10+0.3)/16, (6-0.2)/16) of 200
  assert.ok(Math.abs(r.cx - (0 + ((10 + 0.3) / 16) * 200)) < 1e-4, `cx ${r.cx}`);
  assert.ok(Math.abs(r.cy - (-20 + ((6 - 0.2) / 16) * 200)) < 1e-4, `cy ${r.cy}`);
  assert.ok(Math.abs(r.w - 100) < 1e-4);
  assert.ok(Math.abs(r.h - 50) < 1e-4);
  assert.ok(Math.abs(r.score - conf[bi] * hann[bi]) < 1e-6);
});

await ok('vitCropSize follows ceil(sqrt(w*h)*factor)', () => {
  assert.strictEqual(VT.vitCropSize(30, 40, 4), Math.ceil(Math.sqrt(1200) * 4));
  assert.strictEqual(VT.vitCropSize(1, 1, 2), 2); // floor guard
});

await ok('smat profile feeds z/x and reads outputs by position', async () => {
  const fakeOrt = {
    Tensor: class {
      constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    },
  };
  const n = 256;
  const conf = new Float32Array(n).fill(0.01);
  conf[7 * 16 + 7] = 0.9;
  let feedsSeen = null;
  const fakeSession = {
    outputNames: ['boxes', 'score_map', 'size_map', 'offset_map'],
    run: async (feeds) => {
      feedsSeen = Object.keys(feeds);
      return {
        boxes: { data: new Float32Array(4) },
        score_map: { data: conf },
        size_map: { data: new Float32Array(2 * n).fill(0.1) },
        offset_map: { data: new Float32Array(2 * n) },
      };
    },
  };
  const engine = new VT.VitTrackEngine(fakeOrt, fakeSession, 'smat');
  const frame = { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 };
  const sampler = VT.samplerForFrame(frame);
  assert.ok(engine.init(sampler, { cx: 32, cy: 32, w: 16, h: 16 }));
  const r = await engine.update(sampler, { cx: 32, cy: 32, w: 16, h: 16 });
  assert.deepStrictEqual(feedsSeen.sort(), ['x', 'z']);
  assert.ok(r.score > 0.8, `windowed centre peak survives (${r.score})`);
});

}

// -------------------------------------------------- stability control tests

/**
 * Closed-loop simulation of one drive axis (AxisTracker + a camera model):
 * a subject moves in world pixels, the camera aims at `cam`, measurements
 * are the subject's position in frame plus noise, and commands take
 * `latency` frames to reach a camera that moves at u × maxVel — mimicking
 * the real VISCA + RTSP/MJPEG delay. Returns per-frame {t, u, e}:
 * command issued and true framing error (normalized, 1 = half frame).
 */
function simulateAxis(subjectAt, frames, opts = {}) {
  const { noise = 3, latency = 8, maxVel = 900, seed = 1234, db = 0.08, gain = 1.5 } = opts;
  const FPS = 30, DT = 1 / FPS, W = 1280, HALF = W / 2;
  const DB = db, GAIN = gain, BOX_W = 180;
  const ax = new TR.AxisTracker();
  const rnd = lcg(seed);
  let cam = 0;
  const queue = new Array(latency).fill(0);
  ax.reset(subjectAt(0) - cam + HALF);
  const log = [];
  for (let i = 0; i < frames; i++) {
    const z = subjectAt(i) - cam + HALF + (rnd() * 2 - 1) * noise;
    ax.predict(DT, 1.2 * W);
    ax.measure(z, Math.max(2, 0.04 * BOX_W));
    const u = ax.command((ax.x - HALF) / HALF, ax.v / HALF, DB, GAIN, 1);
    queue.push(u);
    cam += queue.shift() * maxVel * DT;
    log.push({ t: i * DT, u, e: (subjectAt(i) - cam) / HALF });
  }
  return log;
}

async function stabilityTests() {
  console.log('tracking stability (AxisTracker hold/follow gate):');

  await ok('Kalman filter converges on the subject and shrugs off a glitch frame', () => {
    const ax = new TR.AxisTracker();
    ax.reset(100);
    for (let i = 0; i < 30; i++) {
      ax.predict(1 / 30, 1536);
      ax.measure(300, 6);
    }
    assert.ok(Math.abs(ax.x - 300) < 2, `converged (x=${ax.x.toFixed(1)})`);
    assert.ok(Math.abs(ax.v) < 20, `velocity settled (v=${ax.v.toFixed(1)})`);
    ax.predict(1 / 30, 1536);
    ax.measure(800, 6); // one wild detection 500 px away
    assert.ok(Math.abs(ax.x - 300) < 5, `outlier gated (x=${ax.x.toFixed(1)})`);
  });

  await ok('camera never moves while the subject stands still (noisy measurements)', () => {
    // Subject parked 30 px off centre — inside the deadband — with ±3 px of
    // measurement noise, for 8 seconds. Not one drive command may go out.
    const log = simulateAxis(() => 30, 240);
    assert.ok(log.every((f) => f.u === 0), 'no drive commands at all');
  });

  await ok('a single glitched detection does not move the camera', () => {
    const jump = (i) => (i === 60 ? 280 : 30); // one-frame 250 px teleport
    const log = simulateAxis(jump, 180);
    assert.ok(log.every((f) => f.u === 0), 'glitch frame produced no drive');
  });

  await ok('follows promptly when the subject walks off, then stops and holds', () => {
    // Still for 1 s → walks 350 px/s for 1.5 s → stands still again.
    const FPS = 30;
    const walk = (i) => {
      const t = i / FPS;
      if (t < 1) return 0;
      if (t < 2.5) return 350 * (t - 1);
      return 525;
    };
    const log = simulateAxis(walk, Math.round(FPS * 7.5));
    const before = log.filter((f) => f.t < 1);
    assert.ok(before.every((f) => f.u === 0), 'still before the walk starts');
    const firstMove = log.find((f) => f.u !== 0);
    assert.ok(firstMove, 'the camera does follow');
    assert.ok(firstMove.t > 1 && firstMove.t < 1.6,
      `starts following shortly after motion onset (t=${firstMove.t.toFixed(2)}s)`);
    assert.ok(firstMove.u > 0, 'follows in the subject direction');
    assert.ok(Math.max(...log.map((f) => f.u)) > 0.3, 'ramps up to a real speed');
    const tail = log.filter((f) => f.t > 5.5);
    assert.ok(tail.length > 30, 'tail long enough to judge');
    assert.ok(tail.every((f) => f.u === 0),
      'back to a full hold after the subject stops');
    const last = log[log.length - 1];
    assert.ok(Math.abs(last.e) < 0.08, `subject left near centre (e=${last.e.toFixed(3)})`);
  });

  await ok('aggressive settings on a hot camera still converge (gain auto-backoff)', () => {
    // Tightest deadband + max responsiveness + a fast camera behind 8
    // frames of latency: without the self-tuned gain backoff this loop
    // rings indefinitely. It must still end in a clean hold.
    const FPS = 30;
    const walk = (i) => {
      const t = i / FPS;
      if (t < 1) return 0;
      if (t < 2.5) return 350 * (t - 1);
      return 525;
    };
    for (const seed of [4, 44]) {
      const log = simulateAxis(walk, Math.round(FPS * 10), { seed, db: 0.03, gain: 3 });
      const tail = log.filter((f) => f.t > 8);
      assert.ok(tail.every((f) => f.u === 0), `seed ${seed}: full hold at the end`);
      const last = log[log.length - 1];
      assert.ok(Math.abs(last.e) < 0.08, `seed ${seed}: near centre (e=${last.e.toFixed(3)})`);
    }
  });

  await ok('slow drift past the deadband is still re-framed', () => {
    // 40 px/s creep — below the velocity wake threshold, so only the
    // deadband breach can (and must) wake the camera.
    const FPS = 30;
    const creep = (i) => 40 * (i / FPS);
    const log = simulateAxis(creep, Math.round(FPS * 4));
    const firstMove = log.find((f) => f.u !== 0);
    assert.ok(firstMove, 'the drift wakes the camera');
    assert.ok(firstMove.t > 0.8, `not before the deadband is crossed (t=${firstMove.t.toFixed(2)}s)`);
    assert.ok(firstMove.t < 2.5, `but soon after (t=${firstMove.t.toFixed(2)}s)`);
  });
}

// --------------------------------------------------------- integration test

const MODEL = path.join(__dirname, '..', 'src', 'models', 'object_tracking_vittrack_2023sep.onnx');

/** Deterministic PRNG so the synthetic scene is identical on every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Synthetic scene: static noise background + a high-contrast checkered
 * subject of a given size centered on (cx, cy). Rendered per frame.
 */
function makeScene() {
  const W = 320, H = 240;
  const rnd = lcg(42);
  const bg = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 40 + rnd() * 60;
    bg[i * 4] = v;
    bg[i * 4 + 1] = v * 0.9;
    bg[i * 4 + 2] = v * 1.1;
    bg[i * 4 + 3] = 255;
  }
  const frame = (cx, cy, size) => {
    const data = bg.slice();
    const half = size / 2;
    const y0 = Math.max(0, Math.round(cy - half)), y1 = Math.min(H, Math.round(cy + half));
    const x0 = Math.max(0, Math.round(cx - half)), x1 = Math.min(W, Math.round(cx + half));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const u = (x - (cx - half)) / size, v = (y - (cy - half)) / size;
        const p = (y * W + x) * 4;
        const checker = (Math.floor(u * 4) + Math.floor(v * 4)) % 2 === 0;
        data[p] = checker ? 255 : 30;
        data[p + 1] = checker ? 210 : 160;
        data[p + 2] = checker ? 40 : 220;
      }
    }
    return { data, width: W, height: H };
  };
  return { W, H, frame };
}

async function integration() {
  console.log('end-to-end with the bundled model (onnxruntime-web wasm):');
  const ort = require('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const engine = await VT.VitTrackEngine.create(ort, fs.readFileSync(MODEL));
  const scene = makeScene();

  // Subject starts at (60, 60) size 28, drifts diagonally while growing.
  const truth = (t) => ({
    cx: 60 + 3.5 * t,
    cy: 60 + 2.5 * t,
    size: 28 + (14 * t) / 40,
  });

  let box = { cx: 60, cy: 60, w: 28, h: 28 };
  const f0 = truth(0);
  assert.ok(
    engine.init(VT.samplerForFrame(scene.frame(f0.cx, f0.cy, f0.size)), box),
    'template init'
  );

  let minScore = Infinity;
  for (let t = 1; t <= 40; t++) {
    const g = truth(t);
    const sampler = VT.samplerForFrame(scene.frame(g.cx, g.cy, g.size));
    const r = await engine.update(sampler, box);
    assert.ok(r, `frame ${t} sampled`);
    minScore = Math.min(minScore, r.score);
    box = {
      cx: r.cx,
      cy: r.cy,
      w: 0.65 * box.w + 0.35 * r.w,
      h: 0.65 * box.h + 0.35 * r.h,
    };
  }
  const end = truth(40);
  const errX = Math.abs(box.cx - end.cx), errY = Math.abs(box.cy - end.cy);
  console.log(`  tracked 40 frames: final error (${errX.toFixed(1)}, ${errY.toFixed(1)}) px, ` +
    `size ${box.w.toFixed(1)} (true ${end.size}), min score ${minScore.toFixed(2)}`);
  assert.ok(errX < 6 && errY < 6, `final position error too large: ${errX}, ${errY}`);
  assert.ok(minScore > 0.3, `confidence collapsed mid-track: ${minScore}`);
  assert.ok(Math.abs(box.w - end.size) < end.size * 0.5, `scale estimate way off: ${box.w}`);
  passed++;
  console.log('  ✓ follows a moving, growing subject');

  // Subject vanishes → confidence must collapse below the acquire threshold
  // (this is what the app's lost/re-acquire logic keys off).
  const empty = VT.samplerForFrame(scene.frame(-1000, -1000, 28));
  const r = await engine.update(empty, box);
  console.log(`  score with subject gone: ${r.score.toFixed(3)}`);
  assert.ok(r.score < 0.3, `score should collapse when the subject is gone: ${r.score}`);
  passed++;
  console.log('  ✓ confidence collapses when the subject disappears');
}

(async () => {
  await unitTests();
  await stabilityTests();
  await integration();
  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
