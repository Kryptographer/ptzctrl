'use strict';

/**
 * AI subject tracking: draw a box over a subject in the live view and the
 * camera pans/tilts automatically to keep it centered in frame.
 *
 * Two tracking engines, best-first:
 *
 *   1. VitTrack (vittrack.js) — a vision-transformer neural tracker
 *      (OpenCV Zoo's object_tracking_vittrack) running on onnxruntime-web's
 *      WASM backend, fully on-device. It learns the subject from the drawn
 *      box and re-finds it every frame with a confidence score, tracking
 *      through pose changes, scale changes (walking toward the camera,
 *      zooming) and brief occlusions that defeat classical filters.
 *   2. MOSSE (this file) — the original pure-JS adaptive correlation filter
 *      (Bolme et al. 2010), kept as an automatic fallback when the neural
 *      runtime can't load. No model, no WASM, a few ms per frame.
 *
 * The displacement measured by whichever engine is active drives VISCA/UVC
 * pan-tilt as a closed loop. Between the engine and the camera sits a
 * stability layer (AxisTracker, one per axis): a constant-velocity Kalman
 * filter that scrubs measurement jitter and estimates the subject's true
 * velocity, and a HOLD/FOLLOW gate so the camera stays perfectly still
 * while the subject is still and only starts moving once the subject
 * provably moves.
 *
 * Classes:
 *   - Mosse           the correlation filter (pure math, testable headless)
 *   - AxisTracker     per-axis Kalman filter + hold/follow gate (headless)
 *   - SubjectTracker  box drawing UI, engine selection, frame pump, control
 */

(function () {
  const PATCH = 64;         // MOSSE correlation patch size (power of two)
  const CONTEXT = 2.0;      // the patch covers CONTEXT × the drawn box
  const SIGMA = 2.0;        // sharpness of the desired correlation peak
  const LEARN_RATE = 0.125; // online filter adaptation rate
  const LAMBDA = 1e-3;      // regularization so the filter never divides by ~0
  const PSR_ACQUIRE = 6.0;  // MOSSE confidence needed to (re)gain a lock
  const PSR_DROP = 4.5;     // an existing MOSSE lock survives down to this
  const PSR_ADAPT = 6.5;    // learn appearance changes only when this confident
  const LOST_TIMEOUT_MS = 5000; // give up after being lost this long
  const STALL_GRACE_MS = 700;   // stalled/undecodable frames tolerated this long
  const MIN_BOX_PX = 16;    // minimum drawn box size in view pixels

  // Neural engine confidence thresholds. The model's windowed score sits
  // around 0.6–0.9 on a solid lock and collapses below ~0.2 when the subject
  // is gone (OpenCV's own validity cutoff is 0.20). Acquiring demands more
  // than keeping, so brief blur dips don't flap the lock. Empirical values.
  const VIT_SCORE_ACQUIRE = 0.32;
  const VIT_SCORE_DROP = 0.22;
  const VIT_SIZE_SMOOTH = 0.35; // EMA factor for per-frame box size updates
  const ORT_LOAD_TIMEOUT_MS = 8000;

  // Control loop: engine measurements carry a few pixels of frame-to-frame
  // noise even on a perfectly still subject, and the video the loop sees
  // runs a few hundred ms behind the camera (RTSP → ffmpeg → MJPEG →
  // decode). Driving raw measurements turns both into visible hunting, so
  // control runs through AxisTracker (one per axis): a constant-velocity
  // Kalman filter over the measured subject position, then a HOLD/FOLLOW
  // gate. In HOLD the camera does not move at all; FOLLOW starts only when
  // the subject provably moves and uses a lead-compensated proportional
  // drive that predicts the error LEAD_S ahead and brakes early, with
  // command magnitude ramping up over ~150 ms instead of slamming to speed.
  const LEAD_S = 0.35;      // seconds of lead (≈ typical stream latency)
  const SLEW_PER_S = 80;    // max command ramp-up, VISCA speed units / second

  // Measurement filter (source-pixel units).
  const MEAS_SIGMA_FRAC = 0.04;  // measurement noise ≈ 4% of the box size
  const MEAS_SIGMA_MIN = 2;      // …but never below 2 px
  const ACCEL_SIGMA_FRAC = 1.2;  // subject accel headroom, × frame dim, px/s²
  const FOLLOW_Q_BOOST = 4;      // extra process noise while the camera drives
  const GATE_SIGMA = 3;          // soft outlier gate on the innovation (HOLD)

  // Hold/follow gate (normalized units: 1.0 = half the frame per axis;
  // velocities are per second; frame counts are consecutive video frames).
  const VEL_START = 0.09;    // outbound speed that counts as "subject moving"
  const VEL_STILL = 0.045;   // speed below which the subject counts as still
  const MOVE_ON_FRAMES = 3;  // confident moving frames to leave HOLD
  const BREACH_FRAMES = 2;   // confident beyond-deadband frames to leave HOLD
  const STILL_FRAMES = 6;    // still-and-centred frames to re-enter HOLD
  const VEL_AVG_SMOOTH = 0.3; // EMA factor for the stillness velocity check
  const INNER_FRAC = 0.35;   // FOLLOW drives until inside deadband × this
  const SETTLE_FRAC = 0.55;  // "centred enough to hold", fraction of deadband
  const OUT_MIN = 0.05;      // FOLLOW output floor — finish the move, don't crawl
  const ONSET_CONF = 0.5;    // min confidence for a frame to count toward onset

  // Self-tuning loop gain. The px-per-VISCA-unit plant gain is unknown and
  // varies wildly (camera model, current zoom) and so does the stream
  // latency; too much loop gain over too much dead time rings or even
  // diverges. Every real overshoot (error sign flip while driving) backs an
  // internal gain scaler off; it creeps back up while holding so a one-off
  // doesn't permanently slug the response.
  const KGAIN_BACKOFF = 0.65; // multiply on each overshoot event
  const KGAIN_MIN = 0.12;     // never damp below this
  const KGAIN_RECOVER = 0.002; // per-frame creep back toward 1

  // ------------------------------------------------------------------
  // FFT — iterative radix-2, complex, in-place
  // ------------------------------------------------------------------

  function fft1d(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inv ? 2 : -2) * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }

  /** 2D FFT of an n×n row-major array; inverse includes 1/n² scaling. */
  function fft2d(re, im, n, inv) {
    const tr = new Float64Array(n), ti = new Float64Array(n);
    for (let y = 0; y < n; y++) {
      const o = y * n;
      for (let x = 0; x < n; x++) { tr[x] = re[o + x]; ti[x] = im[o + x]; }
      fft1d(tr, ti, inv);
      for (let x = 0; x < n; x++) { re[o + x] = tr[x]; im[o + x] = ti[x]; }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) { tr[y] = re[y * n + x]; ti[y] = im[y * n + x]; }
      fft1d(tr, ti, inv);
      for (let y = 0; y < n; y++) { re[y * n + x] = tr[y]; im[y * n + x] = ti[y]; }
    }
    if (inv) {
      const s = 1 / (n * n);
      for (let i = 0; i < n * n; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  // ------------------------------------------------------------------
  // MOSSE correlation filter (fallback engine)
  // ------------------------------------------------------------------

  class Mosse {
    constructor() {
      const n = PATCH, sz = n * n;
      this.n = n;
      // Hann window kills edge discontinuities before the FFT.
      this.win = new Float64Array(sz);
      for (let y = 0; y < n; y++) {
        const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (n - 1)));
        for (let x = 0; x < n; x++) {
          const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (n - 1)));
          this.win[y * n + x] = wx * wy;
        }
      }
      // Desired response: a tight gaussian peak at the patch centre. Because
      // the centre-placed gaussian is symmetric under the FFT's circular
      // flip, the correlation peak lands at centre + displacement.
      const g = new Float64Array(sz);
      const c = n / 2;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const d2 = (x - c) * (x - c) + (y - c) * (y - c);
          g[y * n + x] = Math.exp(-d2 / (2 * SIGMA * SIGMA));
        }
      }
      this.Gre = g;
      this.Gim = new Float64Array(sz);
      fft2d(this.Gre, this.Gim, n, false);
      // Filter numerator A = Σ G⊙conj(F) and denominator B = Σ |F|².
      this.Are = new Float64Array(sz);
      this.Aim = new Float64Array(sz);
      this.B = new Float64Array(sz);
    }

    /** log-normalize-window preprocessing, then FFT. patch is n² gray 0..255. */
    _fftOf(patch) {
      const n = this.n, sz = n * n;
      const re = new Float64Array(sz), im = new Float64Array(sz);
      let mean = 0;
      for (let i = 0; i < sz; i++) { re[i] = Math.log(patch[i] + 1); mean += re[i]; }
      mean /= sz;
      let norm = 0;
      for (let i = 0; i < sz; i++) { const v = re[i] - mean; re[i] = v; norm += v * v; }
      norm = Math.sqrt(norm) + 1e-5;
      for (let i = 0; i < sz; i++) re[i] = (re[i] / norm) * this.win[i];
      fft2d(re, im, n, false);
      return { re, im };
    }

    /** Accumulate a training patch (called with several jittered samples at init). */
    train(patch) {
      const { re: fr, im: fi } = this._fftOf(patch);
      const sz = this.n * this.n;
      for (let i = 0; i < sz; i++) {
        this.Are[i] += this.Gre[i] * fr[i] + this.Gim[i] * fi[i];
        this.Aim[i] += this.Gim[i] * fr[i] - this.Gre[i] * fi[i];
        this.B[i] += fr[i] * fr[i] + fi[i] * fi[i];
      }
    }

    /** Blend a fresh patch into the filter so it follows appearance changes. */
    adapt(patch, rate) {
      const { re: fr, im: fi } = this._fftOf(patch);
      const sz = this.n * this.n;
      for (let i = 0; i < sz; i++) {
        const ar = this.Gre[i] * fr[i] + this.Gim[i] * fi[i];
        const ai = this.Gim[i] * fr[i] - this.Gre[i] * fi[i];
        const b = fr[i] * fr[i] + fi[i] * fi[i];
        this.Are[i] = (1 - rate) * this.Are[i] + rate * ar;
        this.Aim[i] = (1 - rate) * this.Aim[i] + rate * ai;
        this.B[i] = (1 - rate) * this.B[i] + rate * b;
      }
    }

    /**
     * Correlate a patch against the learned filter.
     * Returns {dx, dy, psr}: peak displacement from the patch centre (in
     * patch pixels) and the peak-to-sidelobe ratio (confidence).
     */
    update(patch) {
      const n = this.n, sz = n * n;
      const { re: fr, im: fi } = this._fftOf(patch);
      const rre = new Float64Array(sz), rim = new Float64Array(sz);
      for (let i = 0; i < sz; i++) {
        const b = this.B[i] + LAMBDA;
        // A/B is already the conjugated filter H* from the MOSSE paper
        // (A = G⊙conj(F)), so the response is simply IFFT( F ⊙ A/B ).
        const hr = this.Are[i] / b, hi = this.Aim[i] / b;
        rre[i] = fr[i] * hr - fi[i] * hi;
        rim[i] = fr[i] * hi + fi[i] * hr;
      }
      fft2d(rre, rim, n, true);
      let peak = -Infinity, px = 0, py = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const v = rre[y * n + x];
          if (v > peak) { peak = v; px = x; py = y; }
        }
      }
      // PSR over the sidelobe: everything but an 11×11 window around the peak.
      let sum = 0, sum2 = 0, cnt = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (Math.abs(x - px) <= 5 && Math.abs(y - py) <= 5) continue;
          const v = rre[y * n + x];
          sum += v; sum2 += v * v; cnt++;
        }
      }
      const mean = sum / cnt;
      const sd = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
      // Sub-pixel peak via quadratic interpolation of the two neighbours
      // (circular, matching the FFT). Whole-pixel steps otherwise quantize
      // the measured position and feed jitter into the control loop.
      const at = (x, y) => rre[((y + n) % n) * n + ((x + n) % n)];
      const subpx = (m1, p0, p1) => {
        const den = 2 * p0 - m1 - p1;
        if (den <= 1e-12) return 0;
        return Math.max(-0.5, Math.min(0.5, (p1 - m1) / (2 * den)));
      };
      const fx = subpx(at(px - 1, py), peak, at(px + 1, py));
      const fy = subpx(at(px, py - 1), peak, at(px, py + 1));
      return { dx: px + fx - n / 2, dy: py + fy - n / 2, psr: (peak - mean) / sd };
    }
  }

  // ------------------------------------------------------------------
  // AxisTracker — per-axis measurement filter + hold/follow stability gate
  // ------------------------------------------------------------------

  /**
   * One axis (pan or tilt) of the stability controller.
   *
   * Filtering: a constant-velocity Kalman filter over the measured subject
   * position in source pixels. Both engines report the box centre with a
   * few pixels of noise even when the subject is perfectly still; driving
   * the camera off raw measurements turns that noise into visible hunting.
   * The filter carries position + velocity states, weights each measurement
   * by the engine's confidence (via the sigma passed to measure()), and
   * soft-gates outliers: a single glitched detection barely moves the
   * state, while a genuine take-off pulls it along within a few frames
   * because repeated consistent innovations re-open the gate.
   *
   * Stability gate: a two-state machine.
   *   HOLD    the camera does not move, at all. Left only when the subject
   *           provably moves: filtered error beyond the deadband for
   *           BREACH_FRAMES consecutive confident frames (covers slow
   *           drift), or sustained outbound velocity while already leaving
   *           the centre zone for MOVE_ON_FRAMES frames (covers walk-off,
   *           and reacts before the deadband is even crossed).
   *   FOLLOW  lead-compensated proportional drive toward centre; back to
   *           HOLD once the subject sits near centre with ~zero velocity
   *           for STILL_FRAMES consecutive frames.
   *
   * Everything here is pure math (no DOM) so it is testable headless.
   */
  class AxisTracker {
    constructor() {
      this.reset(0);
    }

    /** Start over at a known position: fresh lock or re-acquire. */
    reset(pos) {
      this.x = pos;   // filtered position, source px
      this.v = 0;     // filtered velocity, source px/s
      this.P00 = 100; // covariance: ±10 px initial position uncertainty…
      this.P01 = 0;
      this.P11 = 4e4; // …and ±200 px/s initial velocity uncertainty
      this.velAvg = 0; // smoothed normalized rate, for the stillness check
      this.kGain = 1;  // self-tuned loop-gain scaler (see KGAIN_* above)
      this.prevE = 0;  // last error, for overshoot (sign flip) detection
      this.halt();
    }

    /** Force HOLD (lock lost / drive stopped externally). */
    halt() {
      this.mode = 'hold';
      this.moveN = 0;
      this.breachN = 0;
      this.stillN = 0;
    }

    /** Time update: advance the state dt seconds. sigmaA is accel noise, px/s². */
    predict(dt, sigmaA) {
      // While following, the camera's own acceleration dominates the
      // apparent motion, so the constant-velocity model needs far more
      // process noise — with the HOLD-tuned value the velocity state lags
      // the true rate and the lead/brake term fires late (oscillation).
      // At hold the camera is still and the tight model is what scrubs
      // the measurement jitter out.
      const a = this.mode === 'follow' ? sigmaA * FOLLOW_Q_BOOST : sigmaA;
      const q = a * a;
      const dt2 = dt * dt;
      this.x += this.v * dt;
      this.P00 += 2 * dt * this.P01 + dt2 * this.P11 + (q * dt2 * dt2) / 4;
      this.P01 += dt * this.P11 + (q * dt * dt2) / 2;
      this.P11 += q * dt2;
    }

    /**
     * Measurement update. sigmaR is the measurement noise (px); pass a
     * larger value for low-confidence frames so they count for less.
     */
    measure(z, sigmaR) {
      let r = sigmaR * sigmaR;
      const y = z - this.x;
      // Soft gate: an innovation beyond the gate gets its noise inflated
      // until it sits exactly at the gate — huge one-frame jumps are nearly
      // ignored, sustained ones still pull the state over. The gate is
      // opened right up while following: large innovations are then the
      // camera's own motion, not glitches, and throttling them adds lag.
      const gs = this.mode === 'follow' ? GATE_SIGMA * 2 : GATE_SIGMA;
      const g2 = gs * gs;
      if (y * y > g2 * (this.P00 + r)) r = (y * y) / g2 - this.P00;
      const S = this.P00 + r;
      const K0 = this.P00 / S;
      const K1 = this.P01 / S;
      this.x += K0 * y;
      this.v += K1 * y;
      this.P00 *= 1 - K0;
      this.P11 -= K1 * this.P01; // uses pre-update P01
      this.P01 *= 1 - K0;
    }

    /**
     * Advance the hold/follow gate and return the drive command for this
     * frame, in -1..1 (0 = camera still). e / vel are the *filtered* error
     * and error rate in normalized units (1 = half frame; vel per second),
     * db is the user deadband, gain the response setting, conf the engine
     * confidence (0..1) of the frame that produced this call.
     */
    command(e, vel, db, gain, conf) {
      // Smoothed rate for the stillness check: the raw velocity state is
      // deliberately twitchy while following (see predict), so "has the
      // subject stopped" is judged on an EMA of it instead.
      this.velAvg += VEL_AVG_SMOOTH * (vel - this.velAvg);
      const eWas = this.prevE;
      this.prevE = e;
      // The self-tuned gain creeps back toward 1 every frame; overshoot
      // events (below) knock it down much faster than this rebuilds it, so
      // a loop that actually rings stays damped.
      this.kGain += KGAIN_RECOVER * (1 - this.kGain);
      if (this.mode === 'hold') {
        // Wake only on evidence of real subject motion. Low-confidence
        // frames (blur, marginal lock) neither confirm nor fully reset the
        // counters — jitter is worst exactly when confidence is low.
        const breach = Math.abs(e) > db;
        const moving = Math.abs(vel) > VEL_START && vel * e > 0 && Math.abs(e) > db * 0.5;
        if (conf >= ONSET_CONF) {
          this.breachN = breach ? this.breachN + 1 : 0;
          this.moveN = moving ? this.moveN + 1 : 0;
        } else {
          this.breachN = Math.max(0, this.breachN - 1);
          this.moveN = Math.max(0, this.moveN - 1);
        }
        if (this.breachN < BREACH_FRAMES && this.moveN < MOVE_ON_FRAMES) return 0;
        this.mode = 'follow';
        this.moveN = this.breachN = this.stillN = 0;
      }

      // FOLLOW: predict the error LEAD_S ahead; if current motion already
      // carries the subject across centre, coast now instead of overshooting.
      // Drive aims inside INNER_FRAC of the deadband so the settle zone
      // (SETTLE_FRAC) is reached with margin, then HOLD re-engages.
      const inner = db * INNER_FRAC;
      // A genuine overshoot — the error swept through centre and out the
      // other side while we were driving — means the loop is too hot for
      // this camera/zoom/latency; back the self-tuned gain off.
      if (eWas * e < 0 && Math.abs(e) > inner) {
        this.kGain = Math.max(KGAIN_MIN, this.kGain * KGAIN_BACKOFF);
      }
      const p = e + LEAD_S * vel;
      let out = 0;
      if (p * e > 0 && Math.abs(p) > inner) {
        out = Math.sign(p) *
          Math.min(1, (gain * this.kGain * (Math.abs(p) - inner)) / (1 - inner));
        // Floor the output so the last stretch to centre is finished at a
        // usable speed instead of an asymptotic crawl that never settles.
        if (Math.abs(out) < OUT_MIN) out = Math.sign(out) * OUT_MIN;
      }
      const settled = Math.abs(e) < db * SETTLE_FRAC && Math.abs(this.velAvg) < VEL_STILL;
      this.stillN = settled ? this.stillN + 1 : 0;
      if (this.stillN >= STILL_FRAMES) {
        this.halt();
        return 0;
      }
      return out;
    }
  }

  // ------------------------------------------------------------------
  // Neural engine loading (shared, lazy, cached)
  // ------------------------------------------------------------------

  // Resolved by ort-loader.mjs once the onnxruntime-web module is in. Set up
  // here because classic scripts run before deferred module scripts.
  globalThis.ortReady = new Promise((res) => { globalThis.__ortResolve = res; });

  let vitEnginePromise = null;

  /** Load onnxruntime + the VitTrack model. Cached; rejects on any failure. */
  function loadVitEngine() {
    if (!vitEnginePromise) {
      vitEnginePromise = (async () => {
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('onnxruntime load timeout')), ORT_LOAD_TIMEOUT_MS));
        const ortApi = await Promise.race([globalThis.ortReady, timeout]);
        const assets = await window.ptz.aiAssets();
        if (!assets || !assets.ok) {
          throw new Error((assets && assets.error) || 'AI assets unavailable');
        }
        const wasm = assets.wasm instanceof Uint8Array ? assets.wasm : new Uint8Array(assets.wasm);
        ortApi.env.wasm.numThreads = 1;
        // Hand the wasm over as bytes: the renderer runs from file:// where
        // the runtime's own fetch() of its .wasm would fail.
        ortApi.env.wasm.wasmBinary =
          wasm.byteOffset === 0 && wasm.byteLength === wasm.buffer.byteLength
            ? wasm.buffer
            : wasm.slice().buffer;
        const model = assets.model instanceof Uint8Array ? assets.model : new Uint8Array(assets.model);
        return await globalThis.VitTrack.VitTrackEngine.create(ortApi, model, assets.profile);
      })();
      vitEnginePromise.catch(() => {}); // callers handle rejection; keep console quiet
    }
    return vitEnginePromise;
  }

  // ------------------------------------------------------------------
  // SubjectTracker — UI + engine selection + frame pump + PTZ control
  // ------------------------------------------------------------------

  class SubjectTracker {
    /**
     * @param {{
     *   canvas: HTMLCanvasElement,       // overlay on top of the live view
     *   getSettings: () => object,       // live app settings (track* keys)
     *   onDrive: (pan, tilt) => void,    // send quantized VISCA-style speeds
     *   onState: (state, msg) => void,   // 'idle'|'arming'|'loading'|'tracking'|'lost'
     * }} opts
     */
    constructor({ canvas, getSettings, onDrive, onState }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.getSettings = getSettings || (() => ({}));
      this.onDrive = onDrive || (() => {});
      this.onState = onState || (() => {});
      this.source = null;      // the <img> (MJPEG) or <video> (local) element
      this.state = 'idle';     // idle | arming | loading | tracking | lost
      this.engine = null;      // VitTrackEngine when the neural path is up
      this.mosse = null;       // fallback correlation filter
      this.box = null;         // {cx, cy, w, h} in source-pixel coords
      this.drag = null;        // {x0,y0,x1,y1} in view coords while drawing
      this.timer = null;
      this.inFlight = false;   // an async neural tick is running
      this.lastFrameKey = null;
      this.lastFrameAt = 0;
      this.lostSince = 0;
      this.lastDrive = { pan: 0, tilt: 0 };
      // Stability layer: per-axis Kalman filter + hold/follow gate (the
      // filtered states also feed the search lead), plus the un-quantized
      // slew-limited command.
      this.axX = new AxisTracker();
      this.axY = new AxisTracker();
      this.cmd = { pan: 0, tilt: 0 };
      this.lastDriveAt = 0;
      this.searchOffsets = null; // MOSSE lost-subject probe pattern
      this.searchIdx = 0;
      this.vitSearchSeq = null;  // neural lost-subject probe sequence
      this.vitSearchIdx = 0;
      // Offscreen canvas the MOSSE patches are resampled through.
      this.pcan = document.createElement('canvas');
      this.pcan.width = PATCH;
      this.pcan.height = PATCH;
      this.pctx = this.pcan.getContext('2d', { willReadFrequently: true });
      // Offscreen canvas for the neural engine's square RGB crops.
      this.scan = document.createElement('canvas');
      this.scan.width = this.scan.height = 256;
      this.sctx = this.scan.getContext('2d', { willReadFrequently: true });

      canvas.addEventListener('pointerdown', (e) => this._pointerDown(e));
      canvas.addEventListener('pointermove', (e) => this._pointerMove(e));
      canvas.addEventListener('pointerup', (e) => this._pointerUp(e));
      canvas.addEventListener('pointercancel', () => { this.drag = null; this._draw(); });
    }

    /** Actively following a subject (or momentarily lost). */
    isActive() { return this.state === 'tracking' || this.state === 'lost'; }
    /** Anything other than idle (includes drawing the box / loading the model). */
    isBusy() { return this.state !== 'idle'; }

    /** Bind the element frames are read from; null when live view stops. */
    setSource(el) {
      if (el !== this.source && this.isBusy()) this.cancel();
      this.source = el || null;
    }

    /** Enter draw mode: the next drag on the canvas defines the subject box. */
    arm() {
      if (!this.source) {
        this._setState('idle', 'Start the live view first, then draw a box.');
        return;
      }
      this._stopLoop();
      this.engine = null;
      this.mosse = null;
      this.box = null;
      this.drag = null;
      this.canvas.classList.add('arming');
      this._setState('arming', 'Drag a box around the subject to follow (Esc cancels).');
      this._draw();
      // Start pulling the model in while the user draws — by the time the
      // box lands the session is usually warm. Failure is handled at use.
      loadVitEngine().catch(() => {});
    }

    /** Stop tracking / drawing. Passing no message keeps the status bar quiet. */
    cancel(msg) {
      if (this.state === 'idle') return;
      this._stopLoop();
      this._stopDrive();
      this.canvas.classList.remove('arming');
      this.engine = null;
      this.mosse = null;
      this.box = null;
      this.drag = null;
      this.vitSearchSeq = null;
      this._setState('idle', msg || null);
      this._clear();
    }

    _setState(state, msg) {
      this.state = state;
      this.onState(state, msg);
    }

    // ----------------------------- geometry -----------------------------

    _naturalSize() {
      const el = this.source;
      if (!el) return null;
      const w = el.videoWidth || el.naturalWidth || 0;
      const h = el.videoHeight || el.naturalHeight || 0;
      return w > 4 && h > 4 ? { w, h } : null;
    }

    /** Mapping between view (canvas) pixels and source pixels for object-fit: contain. */
    _viewMap() {
      const nat = this._naturalSize();
      if (!nat) return null;
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      if (cw <= 0 || ch <= 0) return null;
      const scale = Math.min(cw / nat.w, ch / nat.h);
      return {
        scale,
        offX: (cw - nat.w * scale) / 2,
        offY: (ch - nat.h * scale) / 2,
        nw: nat.w,
        nh: nat.h,
      };
    }

    // --------------------------- box drawing ----------------------------

    _pointerDown(e) {
      if (this.state !== 'arming') return;
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      this.drag = { x0: x, y0: y, x1: x, y1: y };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      e.preventDefault();
      this._draw();
    }

    _pointerMove(e) {
      if (this.state !== 'arming' || !this.drag) return;
      const r = this.canvas.getBoundingClientRect();
      this.drag.x1 = e.clientX - r.left;
      this.drag.y1 = e.clientY - r.top;
      this._draw();
    }

    _pointerUp() {
      if (this.state !== 'arming' || !this.drag) return;
      const d = this.drag;
      this.drag = null;
      const vx = Math.min(d.x0, d.x1), vy = Math.min(d.y0, d.y1);
      const vw = Math.abs(d.x1 - d.x0), vh = Math.abs(d.y1 - d.y0);
      if (vw < MIN_BOX_PX || vh < MIN_BOX_PX) {
        this._setState('arming', 'Box too small — drag a larger box around the subject.');
        this._draw();
        return;
      }
      const map = this._viewMap();
      if (!map) {
        this.cancel('No video frame yet — wait for the stream to connect, then try again.');
        return;
      }
      // view → source pixels, clamped inside the frame
      let x0 = (vx - map.offX) / map.scale;
      let y0 = (vy - map.offY) / map.scale;
      let x1 = (vx + vw - map.offX) / map.scale;
      let y1 = (vy + vh - map.offY) / map.scale;
      x0 = Math.max(0, Math.min(map.nw, x0));
      x1 = Math.max(0, Math.min(map.nw, x1));
      y0 = Math.max(0, Math.min(map.nh, y0));
      y1 = Math.max(0, Math.min(map.nh, y1));
      if (x1 - x0 < 8 || y1 - y0 < 8) {
        this._setState('arming', 'Draw the box on the video image itself.');
        this._draw();
        return;
      }
      this._startTracking({
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        w: x1 - x0,
        h: y1 - y0,
      });
    }

    // ----------------------------- tracking -----------------------------

    async _startTracking(box) {
      this.box = box;
      this.canvas.classList.remove('arming');
      this._setState('loading', 'Loading AI tracker…');
      this._draw();

      // Freeze the subject's appearance right now — if the model is still
      // loading, the subject may have moved by the time it's ready, and the
      // template must be what the user actually drew around.
      const VT = globalThis.VitTrack;
      const templateRgba = VT ? VT.VitTrackEngine.sampleTemplate(this._sampler(), box) : null;

      let engine = null;
      try {
        engine = await loadVitEngine();
      } catch { /* fall back below */ }
      if (this.state !== 'loading') return; // cancelled while loading

      if (engine && (engine.initFromRgba(templateRgba) || engine.init(this._sampler(), box))) {
        this.engine = engine;
      } else {
        // Neural path unavailable — the classical filter still works.
        this.mosse = new Mosse();
        const base = this._extractPatch();
        if (!base) {
          this.cancel('Could not read video frames — is the stream running?');
          return;
        }
        this.mosse.train(base);
        // A few jittered samples (small rotation/scale) make the filter
        // tolerant of pose changes from the very first frame.
        for (let i = 0; i < 7; i++) {
          const rot = (Math.random() - 0.5) * 0.12;
          const sc = 1 + (Math.random() - 0.5) * 0.1;
          const p = this._extractPatch(rot, sc);
          if (p) this.mosse.train(p);
        }
      }

      this.lostSince = 0;
      this.lastFrameKey = null;
      this.lastFrameAt = Date.now();
      this.axX.reset(box.cx);
      this.axY.reset(box.cy);
      this.cmd = { pan: 0, tilt: 0 };
      this.lastDriveAt = 0;
      this.vitSearchSeq = null;
      this.searchOffsets = null;
      this._setState('tracking', this.engine
        ? `AI tracking (${this.engine.profileName}) — the camera follows the box. Move the stick to take over.`
        : 'Tracking (basic engine — AI model unavailable). Move the stick to take over.');
      this._startLoop();
      this._draw();
    }

    _startLoop() {
      this._stopLoop();
      this.timer = setInterval(() => this._tick(), 33);
    }

    _stopLoop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    /** Something that changes exactly when a new frame is displayed. */
    _frameKey() {
      const el = this.source;
      if (!el) return null;
      // MJPEG <img> gets a new blob URL per frame; <video> advances currentTime.
      return el.tagName === 'IMG' ? el.src : el.currentTime;
    }

    /** The engine's window into the current frame (square RGB crops). */
    _sampler() {
      return (cx, cy, cropSz, outSize) => this._sampleSquare(cx, cy, cropSz, outSize);
    }

    async _tick() {
      if (this.inFlight) return; // neural inference from the previous tick still running
      if (!this.isActive()) return;
      const key = this._frameKey();
      const now = Date.now();
      if (key === this.lastFrameKey) {
        // No new frame. If the stream stalls, never keep the camera moving
        // on stale data — stop and go lost (auto-cancels after the timeout).
        if (now - this.lastFrameAt > STALL_GRACE_MS) {
          this._markLost();
          this._draw();
        }
        return;
      }

      const nat = this._naturalSize();
      if (!nat) {
        if (now - this.lastFrameAt > STALL_GRACE_MS) {
          this._markLost();
          this._draw();
        }
        return;
      }

      if (this.engine) {
        this.inFlight = true;
        try {
          await this._tickVit(key, now, nat);
        } catch {
          // A failed inference tick behaves like an unreadable frame: the
          // stall grace / lost timeout decide what happens next.
        } finally {
          this.inFlight = false;
        }
      } else {
        this._tickMosse(key, now, nat);
      }
      this._draw();
    }

    // ------------------------- neural engine tick -------------------------

    async _tickVit(key, now, nat) {
      const sampler = this._sampler();
      const wasTracking = this.state === 'tracking';
      const dtF = Math.min(0.25, Math.max(0.01, (now - this.lastFrameAt) / 1000));
      let res = null;
      if (wasTracking) {
        // Center the search on where the subject is *going*, not where it
        // was: a small fast target (the "follow a fly" case) can cross a
        // whole search region between frames. Prediction is capped to half
        // the region so a bad velocity estimate can't out-run the subject.
        const b = this.box;
        const maxLead = globalThis.VitTrack.vitCropSize(b.w, b.h, 4) / 2;
        const clampLead = (v) => Math.max(-maxLead, Math.min(maxLead, v));
        res = await this.engine.update(sampler, b, {
          cx: b.cx + clampLead(this.axX.v * dtF),
          cy: b.cy + clampLead(this.axY.v * dtF),
        });
      } else {
        res = await this._vitSearch(sampler);
      }
      // Tracking may have been cancelled (stick moved, Esc…) while the
      // inference was in flight — never act on a stale result.
      if (!this.isActive()) return;
      if (res === null && wasTracking) {
        // Frame not decodable yet (fresh <img> blob still decoding) — retry
        // next tick; a stream that never decodes trips the stall grace.
        if (now - this.lastFrameAt > STALL_GRACE_MS) this._markLost();
        return;
      }
      this.lastFrameKey = key;
      this.lastFrameAt = now;

      const need = wasTracking ? VIT_SCORE_DROP : VIT_SCORE_ACQUIRE;
      if (res && res.score >= need) {
        const b = this.box;
        // Frame confidence 0..1: full trust from ~0.55 upward, fading to
        // zero at the drop threshold. Weights the filter and the wake gate.
        const conf = Math.max(0, Math.min(1, (res.score - VIT_SCORE_DROP) / 0.33));
        const mx = Math.min(nat.w, Math.max(0, res.cx));
        const my = Math.min(nat.h, Math.max(0, res.cy));
        if (wasTracking) {
          // Kalman predict/update: scrubs the model's per-frame box jitter
          // out of the drive loop and yields the subject-velocity estimate
          // the hold/follow gate and the search lead run on.
          this.axX.predict(dtF, ACCEL_SIGMA_FRAC * nat.w);
          this.axY.predict(dtF, ACCEL_SIGMA_FRAC * nat.h);
          const infl = 1 + 2 * (1 - conf);
          this.axX.measure(mx, Math.max(MEAS_SIGMA_MIN, MEAS_SIGMA_FRAC * b.w) * infl);
          this.axY.measure(my, Math.max(MEAS_SIGMA_MIN, MEAS_SIGMA_FRAC * b.h) * infl);
        } else {
          this.axX.reset(mx); // fresh lock after a lost spell — start clean
          this.axY.reset(my);
        }
        b.cx = Math.min(nat.w, Math.max(0, this.axX.x));
        b.cy = Math.min(nat.h, Math.max(0, this.axY.x));
        // The model re-estimates the subject's size every frame (it tracks
        // through scale changes); blend it in proportionally to confidence
        // so marginal frames can't pump size jitter into the box.
        const sr = VIT_SIZE_SMOOTH * conf;
        b.w = Math.max(8, (1 - sr) * b.w + sr * res.w);
        b.h = Math.max(8, (1 - sr) * b.h + sr * res.h);
        if (!wasTracking) {
          this._setState('tracking', 'Subject re-acquired — tracking.');
        }
        this.vitSearchSeq = null;
        this.lostSince = 0;
        this._drive(nat, now, conf);
      } else {
        this._markLost();
      }
    }

    /**
     * Hunt for a lost subject: first re-probe the last position with
     * progressively wider search regions (the model natively looks 4× the
     * subject size around a probe; 6× and 8× trade precision for reach),
     * then sweep the whole frame with overlapping probes, nearest-first.
     * A couple of probes per tick keeps the UI and the stall logic live.
     */
    async _vitSearch(sampler) {
      const b = this.box;
      const nat = this._naturalSize();
      if (!nat) return null;
      if (!this.vitSearchSeq) {
        const seq = [
          { cx: b.cx, cy: b.cy, factor: 4 },
          { cx: b.cx, cy: b.cy, factor: 6 },
          { cx: b.cx, cy: b.cy, factor: 8 },
        ];
        // Full-frame sweep: overlapping 6× probes. 0.4-crop spacing keeps a
        // subject between probe centres well inside the confidence window.
        const crop = globalThis.VitTrack.vitCropSize(b.w, b.h, 6);
        const step = Math.max(24, crop * 0.4);
        const pts = [];
        for (let y = step / 2; y < nat.h + step / 2; y += step) {
          for (let x = step / 2; x < nat.w + step / 2; x += step) {
            const cx = Math.min(x, nat.w), cy = Math.min(y, nat.h);
            pts.push({ cx, cy, factor: 6, d: (cx - b.cx) ** 2 + (cy - b.cy) ** 2 });
          }
        }
        pts.sort((p, q) => p.d - q.d);
        this.vitSearchSeq = seq.concat(pts);
        this.vitSearchIdx = 0;
      }
      let best = null;
      const n = this.vitSearchSeq.length;
      for (let k = 0; k < 2; k++) {
        const p = this.vitSearchSeq[this.vitSearchIdx];
        this.vitSearchIdx = (this.vitSearchIdx + 1) % n;
        const r = await this.engine.update(sampler, b, p);
        if (!this.isActive()) return null;
        if (r && (!best || r.score > best.score)) best = r;
        if (best && best.score >= VIT_SCORE_ACQUIRE) break;
      }
      return best;
    }

    // ------------------------- MOSSE engine tick -------------------------

    _tickMosse(key, now, nat) {
      const patch = this._extractPatch();
      if (!patch) {
        if (now - this.lastFrameAt > STALL_GRACE_MS) {
          this._markLost();
        }
        return;
      }
      const dtF = Math.min(0.25, Math.max(0.01, (now - this.lastFrameAt) / 1000));
      const wasTracking = this.state === 'tracking';
      this.lastFrameKey = key;
      this.lastFrameAt = now;

      let res = this.mosse.update(patch);
      let ox = 0, oy = 0;
      if (this.state === 'lost' && res.psr < PSR_ACQUIRE) {
        // Widen the hunt one patch-width around the last known spot so a
        // subject that reappears off to one side is picked back up.
        const alt = this._searchAround();
        if (alt) { res = alt; ox = alt.ox; oy = alt.oy; }
      }
      // Confidence hysteresis: an established lock survives brief dips
      // (motion blur while the camera drives); gaining one back needs more.
      const locked = wasTracking ? res.psr >= PSR_DROP : res.psr >= PSR_ACQUIRE;
      if (locked) {
        const b = this.box;
        // Frame confidence 0..1 from the PSR, on the same scale the
        // adapt/drop thresholds use.
        const conf = Math.max(0, Math.min(1, (res.psr - PSR_DROP) / (PSR_ADAPT - PSR_DROP)));
        const mx = Math.min(nat.w, Math.max(0, b.cx + ox + (res.dx * (b.w * CONTEXT)) / PATCH));
        const my = Math.min(nat.h, Math.max(0, b.cy + oy + (res.dy * (b.h * CONTEXT)) / PATCH));
        if (wasTracking) {
          this.axX.predict(dtF, ACCEL_SIGMA_FRAC * nat.w);
          this.axY.predict(dtF, ACCEL_SIGMA_FRAC * nat.h);
          const infl = 1 + 2 * (1 - conf);
          this.axX.measure(mx, Math.max(MEAS_SIGMA_MIN, MEAS_SIGMA_FRAC * b.w) * infl);
          this.axY.measure(my, Math.max(MEAS_SIGMA_MIN, MEAS_SIGMA_FRAC * b.h) * infl);
        } else {
          this.axX.reset(mx); // fresh lock after a lost spell — start clean
          this.axY.reset(my);
        }
        b.cx = Math.min(nat.w, Math.max(0, this.axX.x));
        b.cy = Math.min(nat.h, Math.max(0, this.axY.x));
        // Learn only from confident frames: adapting on marginal ones makes
        // the filter absorb blur and background until it drifts off the
        // subject entirely.
        if (res.psr >= PSR_ADAPT) {
          const fresh = this._extractPatch();
          if (fresh) this.mosse.adapt(fresh, LEARN_RATE);
        }
        if (!wasTracking) {
          this._setState('tracking', 'Subject re-acquired — tracking.');
        }
        this.searchOffsets = null;
        this.lostSince = 0;
        this._drive(nat, now, conf);
      } else {
        this._markLost();
      }
    }

    /**
     * MOSSE lost-subject hunt: probe a grid of offsets around the last known
     * position (nearest first, a few per tick, rotating through the pattern
     * on successive frames) and report a probe that clears PSR_ACQUIRE.
     */
    _searchAround() {
      const b = this.box;
      if (!this.searchOffsets) {
        const sx = b.w * CONTEXT * 0.32, sy = b.h * CONTEXT * 0.32;
        const offs = [];
        for (let j = -3; j <= 3; j++) {
          for (let i = -3; i <= 3; i++) {
            if (i !== 0 || j !== 0) offs.push([i * sx, j * sy, i * i + j * j]);
          }
        }
        offs.sort((a, z) => a[2] - z[2]);
        this.searchOffsets = offs;
        this.searchIdx = 0;
      }
      let best = null;
      const n = this.searchOffsets.length;
      for (let k = 0; k < 6; k++) {
        const [ox, oy] = this.searchOffsets[(this.searchIdx + k) % n];
        const p = this._extractPatch(0, 1, b.cx + ox, b.cy + oy);
        if (!p) continue;
        const r = this.mosse.update(p);
        if (r.psr >= PSR_ACQUIRE && (!best || r.psr > best.psr)) {
          best = { dx: r.dx, dy: r.dy, psr: r.psr, ox, oy };
        }
      }
      this.searchIdx = (this.searchIdx + 6) % n;
      return best;
    }

    _markLost() {
      const now = Date.now();
      if (this.state !== 'lost') {
        this._setState('lost', 'Subject lost — searching for it…');
        this.lostSince = now;
        this._stopDrive(); // never keep moving on a guess
      } else if (now - this.lostSince > LOST_TIMEOUT_MS) {
        this.cancel('Subject lost — tracking stopped.');
      }
    }

    // --------------------------- frame sampling ---------------------------

    /**
     * Square RGB crop for the neural engine: cropSz source pixels centered
     * on (cx, cy), resampled to outSize×outSize, black outside the frame.
     * Returns RGBA bytes or null while the frame isn't decodable.
     */
    _sampleSquare(cx, cy, cropSz, outSize) {
      const nat = this._naturalSize();
      if (!nat || !this.source) return null;
      const c = this.scan, ctx = this.sctx;
      if (c.width !== outSize || c.height !== outSize) {
        c.width = c.height = outSize;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outSize, outSize);
      const rx = cx - cropSz / 2, ry = cy - cropSz / 2;
      const ix0 = Math.max(0, rx), iy0 = Math.max(0, ry);
      const ix1 = Math.min(nat.w, rx + cropSz), iy1 = Math.min(nat.h, ry + cropSz);
      if (ix1 - ix0 < 2 || iy1 - iy0 < 2) return null;
      try {
        ctx.drawImage(
          this.source,
          ix0, iy0, ix1 - ix0, iy1 - iy0,
          ((ix0 - rx) / cropSz) * outSize, ((iy0 - ry) / cropSz) * outSize,
          ((ix1 - ix0) / cropSz) * outSize, ((iy1 - iy0) / cropSz) * outSize
        );
      } catch {
        return null; // frame not decodable yet
      }
      try {
        return ctx.getImageData(0, 0, outSize, outSize).data;
      } catch {
        return null;
      }
    }

    /**
     * MOSSE patch: the region around the current box (with CONTEXT padding),
     * resampled to PATCH×PATCH grayscale. Areas outside the frame stay black
     * so the geometry never distorts at the edges.
     */
    _extractPatch(rot = 0, zoom = 1, cx = null, cy = null) {
      const nat = this._naturalSize();
      const b = this.box;
      if (!nat || !b || !this.source) return null;
      const rw = b.w * CONTEXT * zoom, rh = b.h * CONTEXT * zoom;
      const rx = (cx ?? b.cx) - rw / 2, ry = (cy ?? b.cy) - rh / 2;
      const ctx = this.pctx;
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, PATCH, PATCH);
      if (rot) {
        ctx.translate(PATCH / 2, PATCH / 2);
        ctx.rotate(rot);
        ctx.translate(-PATCH / 2, -PATCH / 2);
      }
      const ix0 = Math.max(0, rx), iy0 = Math.max(0, ry);
      const ix1 = Math.min(nat.w, rx + rw), iy1 = Math.min(nat.h, ry + rh);
      if (ix1 - ix0 < 2 || iy1 - iy0 < 2) {
        ctx.restore();
        return null;
      }
      try {
        ctx.drawImage(
          this.source,
          ix0, iy0, ix1 - ix0, iy1 - iy0,
          ((ix0 - rx) / rw) * PATCH, ((iy0 - ry) / rh) * PATCH,
          ((ix1 - ix0) / rw) * PATCH, ((iy1 - iy0) / rh) * PATCH
        );
      } catch {
        ctx.restore();
        return null; // frame not decodable yet
      }
      ctx.restore();
      let data;
      try {
        data = ctx.getImageData(0, 0, PATCH, PATCH).data;
      } catch {
        return null;
      }
      const out = new Float64Array(PATCH * PATCH);
      for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      }
      return out;
    }

    // ------------------------- closed-loop drive -------------------------

    /**
     * Closed-loop drive behind the per-axis hold/follow gate: while an axis
     * holds, it commands exactly zero — a still subject means a perfectly
     * still camera. conf (0..1) is the confidence of the frame that
     * produced this call; it gates how eagerly a wake-up is believed.
     */
    _drive(nat, now, conf) {
      const s = this.getSettings();
      const db = s.trackDeadband ?? 0.08;
      const gain = s.trackResponse ?? 1.5;
      const lim = s.trackSpeed ?? 0.5;

      // Filtered offset of the subject from frame centre (-1..1) and its
      // rate (per second), straight from the Kalman states.
      const hw = nat.w / 2, hh = nat.h / 2;
      const ux = this.axX.command((this.box.cx - hw) / hw, this.axX.v / hw, db, gain, conf);
      const uy = this.axY.command((this.box.cy - hh) / hh, this.axY.v / hh, db, gain, conf);

      // Subject right of centre → pan right (+). Subject below centre
      // (uy > 0) → tilt down (negative VISCA tilt).
      let pan = ux * 24 * lim;
      let tilt = -uy * 20 * lim;
      if (s.trackInvertPan) pan = -pan;
      if (s.trackInvertTilt) tilt = -tilt;

      // Slew-limit: ramp up gently (a slammed full-speed start overshoots
      // before the first feedback frame even arrives); slowing down or
      // stopping is always immediate, direction flips brake to zero first.
      const dt = this.lastDriveAt ? Math.min(0.2, (now - this.lastDriveAt) / 1000) : 0.033;
      this.lastDriveAt = now;
      const slew = (want, had) => {
        if (want === 0 || want * had < 0) return 0;
        const maxUp = SLEW_PER_S * dt;
        if (Math.abs(want) > Math.abs(had) + maxUp) {
          return Math.sign(want) * (Math.abs(had) + maxUp);
        }
        return want;
      };
      this.cmd.pan = slew(pan, this.cmd.pan);
      this.cmd.tilt = slew(tilt, this.cmd.tilt);

      const qz = (v) => (v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v))));
      const qp = qz(this.cmd.pan), qt = qz(this.cmd.tilt);
      if (qp !== this.lastDrive.pan || qt !== this.lastDrive.tilt) {
        this.lastDrive = { pan: qp, tilt: qt };
        this.onDrive(qp, qt);
      }
    }

    _stopDrive() {
      this.axX.halt();
      this.axY.halt();
      this.cmd = { pan: 0, tilt: 0 };
      this.lastDriveAt = 0;
      if (this.lastDrive.pan !== 0 || this.lastDrive.tilt !== 0) {
        this.lastDrive = { pan: 0, tilt: 0 };
        this.onDrive(0, 0);
      }
    }

    // ------------------------------ drawing ------------------------------

    _clear() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    _draw() {
      const c = this.canvas;
      const cw = c.clientWidth, ch = c.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const ctx = this.ctx;
      ctx.clearRect(0, 0, cw, ch);

      if (this.state === 'arming' || this.state === 'loading') {
        ctx.fillStyle = 'rgba(10, 12, 16, 0.35)';
        ctx.fillRect(0, 0, cw, ch);
        if (this.drag) {
          const d = this.drag;
          const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
          const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
          ctx.clearRect(x, y, w, h);
          ctx.strokeStyle = '#39ff14';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = '#e7eaf2';
          ctx.font = '13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(
            this.state === 'loading' ? 'Loading AI tracker…' : 'Drag a box around the subject to track',
            cw / 2, ch / 2
          );
        }
        return;
      }

      if (!this.isActive() || !this.box) return;
      const map = this._viewMap();
      if (!map) return;
      const b = this.box;
      const w = b.w * map.scale, h = b.h * map.scale;
      const x = map.offX + b.cx * map.scale - w / 2;
      const y = map.offY + b.cy * map.scale - h / 2;
      const col = this.state === 'tracking' ? '#39ff14' : '#f5b942';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(map.offX + b.cx * map.scale, map.offY + b.cy * map.scale, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(this.state === 'tracking' ? 'TRACKING' : 'LOST', x + 2, y - 5 < 10 ? y + h + 12 : y - 5);
    }
  }

  globalThis.SubjectTracker = SubjectTracker;
  globalThis.MosseFilter = Mosse; // exposed for headless testing
  globalThis.AxisTracker = AxisTracker;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Mosse, AxisTracker, SubjectTracker }; // headless tests
  }
})();
