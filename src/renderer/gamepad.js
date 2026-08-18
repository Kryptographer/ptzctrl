'use strict';

/**
 * Xbox controller engine.
 *
 * Polls the Gamepad API every animation frame, converts stick/trigger input
 * into quantized VISCA speeds, edge-detects buttons, and fires callbacks.
 * Commands are only emitted when the quantized value changes, so the network
 * only sees state transitions (plus explicit stops).
 */

const BUTTON_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'View', 'Menu', 'LS', 'RS',
  'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide',
];
const AXIS_NAMES = ['Left X', 'Left Y', 'Right X', 'Right Y'];

const buttonName = (i) => (i == null ? '—' : (BUTTON_NAMES[i] || `Btn ${i}`));
const axisName = (i) => (i == null ? '—' : (AXIS_NAMES[i] || `Axis ${i}`));

/**
 * One physical input, one action. Assign `index` to `key` in the mapping and
 * unbind any other action of the same kind that pointed at the same input —
 * otherwise a rebind leaves the input attached to both actions and a single
 * press fires them together (a preset recall *and* whatever held the button
 * before, e.g. Home). Returns the keys that lost the input so the UI can say
 * where the binding moved from.
 */
function claimBinding(mapping, kind, key, index) {
  const table = kind === 'axis' ? mapping.axes : mapping.buttons;
  const displaced = [];
  for (const k of Object.keys(table)) {
    if (k !== key && table[k] === index) {
      table[k] = null;
      displaced.push(k);
    }
  }
  table[key] = index;
  return displaced;
}

// How long an axis dwells at exactly 0 after its direction ends (reversal or
// release) before it may drive again. Must comfortably exceed the VISCA
// pacer's 50 ms coalescing window: a briefer zero gets superseded by the next
// ramp value before it is ever written, and the camera then sees a bare
// direction flip with no stop in between.
const REVERSE_DWELL_MS = 60;

class GamepadEngine {
  constructor() {
    this.mapping = null;   // { axes: {...}, buttons: {...} }
    this.settings = null;  // { deadzone, speedMultiplier, ... }
    this.callbacks = {};   // see renderer.js
    this.connectedIndex = null;
    this.prevButtons = [];
    this.lastSent = { pan: 0, tilt: 0, zoom: 0, focus: 0 };
    this.capture = null;   // {cb} when rebinding
    this.captureBaseline = null; // axis values when capture started
    this.running = false;
    this.pinnedIndex = null; // user-chosen device; null = auto (first active)
    // Preset save mode ("latch"): when armed, the next preset button press
    // saves instead of recalls. Kept in sync with the on-screen "save mode"
    // toggle so they are one shared concept. Set by the renderer.
    this.saveMode = false;
    // Per-preset press tracking for tap-to-recall / hold-to-save. Keyed by
    // preset number: { since, saved }.
    this.presetHold = {};
    // Snapshot pushed from the main process (XInput). When present it takes
    // priority over the Web Gamepad API, because it keeps updating even when
    // the app window is not focused. See setNativePad().
    this.nativePad = null;
    // Slew-limited (smoothed) speeds so motion ramps up/down instead of
    // jumping — see settings.rampTime and _slew().
    this.smooth = { pan: 0, tilt: 0, zoom: 0 };
    this.lastPollTs = null;
    // Per-axis timestamps until which the axis is pinned at 0 after a
    // reversal/release, so the stop provably reaches the wire (_settle).
    this.zeroHold = { pan: 0, tilt: 0, zoom: 0 };
    // Deadzone hysteresis state: whether the pan/tilt stick is currently
    // "live" (outside the deadzone). See _shapeVector.
    this.stickLive = false;
    // Set after an absolute move (preset recall / home): drive is pinned at
    // zero until every axis is back at neutral. See releaseDrive().
    this.driveHoldOff = false;
  }

  /**
   * Receive a controller snapshot read natively in the main process. This is
   * the fix for "camera freezes when I click another app": the Web Gamepad API
   * only updates while the window is focused, but the native reader does not
   * care about focus, so we prefer its data whenever a controller is present.
   * Pass null when no native controller is connected (falls back to the Web
   * Gamepad API for non-XInput pads / non-Windows platforms).
   */
  setNativePad(pad) {
    const had = !!this.nativePad;
    this.nativePad = pad || null;
    const has = !!this.nativePad;
    if (had !== has) {
      if (!has) this._stopMotion(); // controller unplugged: halt any motion
      this._notifyStatus();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener('gamepadconnected', (e) => {
      if (this.connectedIndex === null) this.connectedIndex = e.gamepad.index;
      this._notifyStatus();
      if (this.callbacks.onDevices) this.callbacks.onDevices(this.listGamepads());
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.connectedIndex === e.gamepad.index) {
        this.connectedIndex = null;
        this._stopMotion();
      }
      this._notifyStatus();
      if (this.callbacks.onDevices) this.callbacks.onDevices(this.listGamepads());
    });
    // A fixed timer, NOT requestAnimationFrame: rAF stops when the window
    // loses focus or is minimized, which would freeze camera control the
    // moment the user clicks another app. Paired with the main process's
    // backgroundThrottling: false, this keeps running at full rate always.
    setInterval(() => this._poll(), 16);
  }

  /** Begin rebind capture; cb receives {kind:'button'|'axis', index} */
  captureNext(cb) {
    this.capture = { cb };
    this.captureBaseline = null;
  }

  cancelCapture() {
    this.capture = null;
    this.captureBaseline = null;
  }

  /** All currently-connected controllers: [{index, id}]. */
  listGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out = [];
    for (const p of pads) {
      if (p && p.connected) out.push({ index: p.index, id: p.id });
    }
    return out;
  }

  /**
   * Pin a specific controller (by gamepad index) to drive the app, or pass
   * null to auto-pick the first active one. Used for adaptive rigs where the
   * XAC hub plus external joysticks/buttons enumerate as several gamepads.
   */
  selectGamepad(index) {
    this.pinnedIndex = index;
    if (index !== null) this.connectedIndex = index;
    this._stopMotion(); // don't carry motion across a device switch
    this._notifyStatus();
  }

  /** Enable/disable "save the next preset" mode (mirrors the on-screen toggle). */
  setSaveMode(on) {
    this.saveMode = !!on;
  }

  /**
   * Hand the camera over to an absolute move (preset recall, home).
   *
   * Pan/tilt/zoom drives are *continuous* — the camera keeps moving until it is
   * told to stop — so anything still driving when the absolute move starts
   * fights it, and the camera reaches the target only to be dragged back off
   * it. Two ways that happens on a preset press: the operator is still holding
   * the stick (framing, then tapping a preset), or the smoothing ramp is mid
   * ease-out, since a preset recall fires on button *release* under
   * hold-to-save and a release-and-tap lands well inside the ramp window.
   *
   * So: collapse the ramp, forget what was last sent (the caller sends the
   * matching stop), and refuse to drive again until the sticks and triggers
   * read neutral. Holding an input through a preset recall means "go to the
   * preset", not "go to the preset and then keep panning".
   */
  releaseDrive() {
    this.smooth.pan = this.smooth.tilt = this.smooth.zoom = 0;
    this.lastSent.pan = 0;
    this.lastSent.tilt = 0;
    this.lastSent.zoom = 0;
    this.lastSent.focus = 0;
    this.driveHoldOff = true;
  }

  /**
   * Forget what was last sent so the next poll re-emits the live state.
   *
   * Used for the camera-switch handoff: outputs only fire on *change*, so
   * when the active camera swaps mid-drive (LB/RB with the stick still
   * held), the new camera would otherwise hear nothing until the stick
   * moved again. After a rearm the very next poll re-sends the current
   * pan/tilt/zoom/focus to whoever is now active. The smoothing ramp is
   * left untouched, so motion carries over seamlessly.
   */
  rearmOutputs() {
    this.lastSent = { pan: 0, tilt: 0, zoom: 0, focus: 0 };
  }

  /** Monotonic clock for hold timing; falls back if performance isn't present. */
  _now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  /**
   * Best-effort haptic confirmation. Rumbles any connected pad that exposes a
   * vibration actuator so a preset save is felt, not just shown on screen —
   * useful when the operator isn't looking at the app. Fully guarded: absent
   * on the native XInput snapshot and on pads without haptics, and never
   * throws. `strong`/`weak` are 0..1 motor magnitudes.
   */
  pulse(ms = 130, strong = 0.9, weak = 0.5) {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        const act = p && p.connected && p.vibrationActuator;
        if (act && typeof act.playEffect === 'function') {
          act.playEffect('dual-rumble', {
            duration: ms,
            strongMagnitude: strong,
            weakMagnitude: weak,
          }).catch(() => {});
        }
      }
    } catch (_) {
      /* no haptics available — the on-screen status is the fallback */
    }
  }

  _gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    // An explicit device choice overrides everything (including the native
    // reader) so the picker always does what it says. Trade-off: a manually
    // picked device uses the Web Gamepad API, which only updates while the
    // window is focused. Leave it on Auto to keep background control.
    if (this.pinnedIndex !== null) {
      if (pads[this.pinnedIndex] && pads[this.pinnedIndex].connected) return pads[this.pinnedIndex];
      // chosen device is gone; fall through to auto-select
    }
    // Auto: prefer the native (main-process XInput) snapshot — it updates
    // regardless of window focus, so control survives clicking into other apps.
    if (this.nativePad) return this.nativePad;
    // Fallback: the Web Gamepad API (non-XInput pads / non-Windows platforms).
    if (this.connectedIndex !== null && pads[this.connectedIndex] && pads[this.connectedIndex].connected) {
      return pads[this.connectedIndex];
    }
    for (const p of pads) {
      if (p && p.connected) {
        this.connectedIndex = p.index;
        this._notifyStatus();
        return p;
      }
    }
    return null;
  }

  _notifyStatus() {
    if (!this.callbacks.onStatus) return;
    const pad = this._gamepad();
    this.callbacks.onStatus(pad ? { connected: true, id: pad.id } : { connected: false });
  }

  _stopMotion() {
    // A press in progress on the old input source shouldn't resolve later.
    this.presetHold = {};
    this.smooth.pan = this.smooth.tilt = this.smooth.zoom = 0;
    if (this.lastSent.pan !== 0 || this.lastSent.tilt !== 0) {
      this.lastSent.pan = 0;
      this.lastSent.tilt = 0;
      if (this.callbacks.onPanTilt) this.callbacks.onPanTilt(0, 0);
    }
    if (this.lastSent.zoom !== 0) {
      this.lastSent.zoom = 0;
      if (this.callbacks.onZoom) this.callbacks.onZoom(0);
    }
    if (this.lastSent.focus !== 0) {
      this.lastSent.focus = 0;
      if (this.callbacks.onFocus) this.callbacks.onFocus(0);
    }
  }

  /** deadzone + response curve for a single axis (zoom/focus), returns -1..1 */
  _shape(raw) {
    const dz = this.settings.deadzone ?? 0.15;
    const a = Math.abs(raw);
    if (a < dz) return 0;
    const norm = (a - dz) / (1 - dz);
    const curved = Math.pow(norm, this.settings.speedCurve ?? 2);
    return Math.sign(raw) * curved;
  }

  /**
   * Radial deadzone + response curve for the pan/tilt stick pair.
   *
   * Shaping each axis on its own (the old behaviour) has two artifacts that
   * read as "left/right doesn't respond right":
   *
   *   - a plus-shaped dead region: during a strong tilt, a modest pan
   *     deflection sits inside the pan axis's own deadzone and produces no
   *     pan at all, so gentle diagonals snap to pure vertical;
   *   - the response curve warps the stick angle: curving each component
   *     separately crushes the smaller one (0.3 pan alongside 0.9 tilt came
   *     out ~9× weaker than the same 0.3 pan alone), dragging every diagonal
   *     toward the dominant axis.
   *
   * Shaping the vector instead — deadzone and curve applied to the stick's
   * magnitude, components scaled back proportionally — keeps the camera
   * moving exactly where the stick points at every deflection.
   *
   * Two counter-artifacts are handled, both continuously (no thresholds the
   * output can jump across mid-move — jumps are what read as "jerky" on a
   * live broadcast):
   *
   *   - Axial guard: a pure radial zone would let a few degrees of thumb
   *     wobble put speed-1 drift on the other axis during a deliberate
   *     level pan. Deflections within ~10° of an axis map onto it exactly,
   *     and the cross-axis component *fades in smoothly* from there
   *     (reaching true 1:1 at 45°) — no snap boundary to hitch over while
   *     sweeping an arc.
   *   - Deadzone hysteresis: the stick goes live at the deadzone radius but
   *     only drops dead again ~20% below it, so hovering right at the edge
   *     can't flutter the camera between moving and stopped.
   */
  _shapeVector(x, y) {
    const dz = this.settings.deadzone ?? 0.15;
    const dzOff = dz * 0.8;
    const mag = Math.hypot(x, y);
    this.stickLive = mag >= (this.stickLive ? dzOff : dz);
    if (!this.stickLive) return { x: 0, y: 0 };
    const AXIAL = 0.18; // tan(~10°): the cone that maps onto the axis
    const damp = (minor, major) => {
      const t = Math.abs(minor) - AXIAL * Math.abs(major);
      return t <= 0 ? 0 : (Math.sign(minor) * t) / (1 - AXIAL);
    };
    if (Math.abs(x) < Math.abs(y)) x = damp(x, y);
    else if (Math.abs(y) < Math.abs(x)) y = damp(y, x);
    const norm = Math.min(1, (mag - dzOff) / (1 - dzOff));
    const curved = Math.pow(norm, this.settings.speedCurve ?? 2);
    const scale = curved / Math.hypot(x, y);
    return { x: x * scale, y: y * scale };
  }

  /**
   * Quantize a smoothed speed to a whole VISCA step, with hysteresis against
   * the previously sent value: hand tremor that wobbles the smoothed speed
   * across a rounding edge (4.48 ↔ 4.52) must not chatter the camera between
   * adjacent speeds — the sent step only changes once the value has really
   * moved. Stops, starts and direction changes always pass straight through.
   */
  _quantStable(v, last) {
    if (v === 0) return 0;
    const q = Math.sign(v) * Math.max(1, Math.round(Math.abs(v)));
    if (last !== 0 && Math.sign(last) === Math.sign(v) && Math.abs(v - last) < 0.75) {
      return last;
    }
    return q;
  }

  /**
   * Direction discipline for a smoothed axis. Whenever the axis's direction
   * ends — reversal or release — it is pinned at exactly 0 for
   * REVERSE_DWELL_MS before it may drive again. The dwell is what turns the
   * engine's zero-crossing into a *guaranteed* stop command on the wire: the
   * VISCA pacer coalesces same-key commands over a 50 ms window, so a zero
   * held for a single 16 ms poll would be superseded by the next ramp value
   * and never written. It also gives the pan/tilt mechanism a beat to brake
   * before spinning up the other way.
   */
  _settle(axis, next, now) {
    const cur = this.smooth[axis];
    if (cur !== 0 && next !== 0 && Math.sign(next) !== Math.sign(cur)) next = 0;
    if (cur !== 0 && next === 0) this.zeroHold[axis] = now + REVERSE_DWELL_MS;
    if (next !== 0 && now < this.zeroHold[axis]) next = 0;
    return next;
  }

  /**
   * Slew-rate limiter: move `cur` toward `target` no faster than the ramp
   * allows. rampTime is the seconds it takes to go 0 → full speed; slowing
   * down / reversing runs 3× faster so releasing the stick still stops
   * promptly. rampTime 0 (or unset) = instant, the classic behaviour.
   *
   * A direction reversal always passes through an exact 0 for one poll, so
   * the camera receives an explicit stop between "pan left" and "pan right"
   * instead of a bare direction flip mid-drive — gentler on the pan/tilt
   * gears and unambiguous for firmwares that dislike unbraked reversals.
   */
  _slew(cur, target, dt, fullScale, rampTime) {
    if (!rampTime || rampTime <= 0 || cur === target) return target;
    const easingOff =
      target === 0 ||
      (cur !== 0 && Math.sign(target) !== Math.sign(cur)) ||
      Math.abs(target) < Math.abs(cur);
    const step = (fullScale / rampTime) * (easingOff ? 3 : 1) * dt;
    const d = target - cur;
    const next = Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
    if (cur !== 0 && next !== 0 && Math.sign(next) !== Math.sign(cur)) return 0;
    return next;
  }

  _axisVal(pad, idx) {
    if (idx == null || idx >= pad.axes.length) return 0;
    return pad.axes[idx];
  }

  _btnVal(pad, idx) {
    if (idx == null || idx >= pad.buttons.length) return 0;
    return pad.buttons[idx].value;
  }

  _btnPressed(pad, idx) {
    if (idx == null || idx >= pad.buttons.length) return false;
    return pad.buttons[idx].pressed;
  }

  _poll() {
    const pad = this._gamepad();
    if (this.callbacks.onFrame) this.callbacks.onFrame(pad);
    if (!pad || !this.mapping || !this.settings) return;

    // ------------------------ rebind capture mode ------------------------
    if (this.capture) {
      if (!this.captureBaseline) {
        this.captureBaseline = pad.axes.slice();
      }
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i].pressed && !this.prevButtons[i]) {
          const cb = this.capture.cb;
          this.capture = null;
          this.captureBaseline = null;
          this._snapshotButtons(pad);
          cb({ kind: 'button', index: i });
          return;
        }
      }
      for (let i = 0; i < pad.axes.length; i++) {
        const delta = Math.abs(pad.axes[i] - (this.captureBaseline[i] ?? 0));
        if (delta > 0.6) {
          const cb = this.capture.cb;
          this.capture = null;
          this.captureBaseline = null;
          this._snapshotButtons(pad);
          cb({ kind: 'axis', index: i });
          return;
        }
      }
      this._snapshotButtons(pad);
      return; // swallow input while rebinding
    }

    const m = this.mapping;
    const s = this.settings;

    // Time since the previous poll, for the motion-smoothing ramp.
    const now = this._now();
    const dt = this.lastPollTs == null ? 0.016 : Math.min(0.1, (now - this.lastPollTs) / 1000);
    this.lastPollTs = now;
    const ramp = s.rampTime ?? 0;

    // Precision mode: while held, speeds are scaled way down for fine framing.
    const fine = this._btnPressed(pad, m.buttons.precision) ? (s.precisionScale ?? 0.25) : 1;
    const mult = (s.speedMultiplier ?? 1) * fine;

    // ------------------------- read every axis first ----------------------
    // All four drive inputs are shaped before any of them is dispatched, so
    // the hold-off gate below can see whether the *whole* controller is back
    // at neutral. Dispatch follows the gate.

    // Pan and tilt are shaped together as a 2D vector (radial deadzone +
    // curve on the magnitude) so the drive direction always matches the
    // stick direction — see _shapeVector.
    const stick = this._shapeVector(
      this._axisVal(pad, m.axes.pan), this._axisVal(pad, m.axes.tilt));
    let panIn = stick.x * (s.panSensitivity ?? 1);
    let tiltIn = -stick.y * (s.tiltSensitivity ?? 1); // stick up = tilt up
    if (s.invertPan) panIn = -panIn;
    if (s.invertTilt) tiltIn = -tiltIn;

    // Buttons (analog triggers) take priority for zoom; an assigned zoom axis
    // is the fallback for people who prefer the right stick.
    // Triggers don't always rest at exactly 0 — without a deadzone the
    // min-speed quantizer would keep zooming slowly after release instead
    // of stopping (and holding the zoom position). The live range is
    // re-normalized to 0..1 so zoom speed rises smoothly from the first
    // touch instead of stepping in at the deadzone edge.
    const TRIGGER_DEADZONE = 0.08;
    const trig = (v) =>
      v < TRIGGER_DEADZONE ? 0 : (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE);
    const zoomIn01 = trig(this._btnVal(pad, m.buttons.zoomIn));
    const zoomOut01 = trig(this._btnVal(pad, m.buttons.zoomOut));
    let zoomRaw = zoomIn01 - zoomOut01;
    if (zoomRaw === 0 && m.axes.zoom != null) {
      zoomRaw = -this._shape(this._axisVal(pad, m.axes.zoom));
    }

    let focusRaw = 0;
    if (this._btnPressed(pad, m.buttons.focusFar)) focusRaw += 1;
    if (this._btnPressed(pad, m.buttons.focusNear)) focusRaw -= 1;
    if (focusRaw === 0 && m.axes.focus != null) {
      focusRaw = -this._shape(this._axisVal(pad, m.axes.focus));
    }

    // --------------------------- hold-off gate ---------------------------
    // An absolute move (preset recall / home) just took the camera over. Stay
    // off the drive channel until the operator lets go of everything, so a
    // still-deflected stick can't pull the camera off the position it was sent
    // to. Clears itself the instant the controller reads neutral — no extra
    // step for the operator.
    if (this.driveHoldOff) {
      if (panIn === 0 && tiltIn === 0 && zoomRaw === 0 && focusRaw === 0) {
        this.driveHoldOff = false;
      } else {
        panIn = 0;
        tiltIn = 0;
        zoomRaw = 0;
        focusRaw = 0;
      }
    }

    // ---------------------------- pan / tilt -----------------------------
    this.smooth.pan = this._settle('pan', this._slew(
      this.smooth.pan, panIn * (s.maxPanSpeed ?? 24) * mult, dt, s.maxPanSpeed ?? 24, ramp), now);
    this.smooth.tilt = this._settle('tilt', this._slew(
      this.smooth.tilt, tiltIn * (s.maxTiltSpeed ?? 20) * mult, dt, s.maxTiltSpeed ?? 20, ramp), now);
    const pan = this._quantStable(this.smooth.pan, this.lastSent.pan);
    const tilt = this._quantStable(this.smooth.tilt, this.lastSent.tilt);
    if (pan !== this.lastSent.pan || tilt !== this.lastSent.tilt) {
      this.lastSent.pan = pan;
      this.lastSent.tilt = tilt;
      if (this.callbacks.onPanTilt) this.callbacks.onPanTilt(pan, tilt);
    }

    // ------------------------------- zoom --------------------------------
    this.smooth.zoom = this._settle('zoom', this._slew(
      this.smooth.zoom,
      zoomRaw * (s.maxZoomSpeed ?? 7) * (s.zoomSensitivity ?? 1) * mult,
      dt, s.maxZoomSpeed ?? 7, ramp), now);
    const zoom = this._quantStable(this.smooth.zoom, this.lastSent.zoom);
    if (zoom !== this.lastSent.zoom) {
      this.lastSent.zoom = zoom;
      if (this.callbacks.onZoom) this.callbacks.onZoom(zoom);
    }

    // ------------------------------- focus -------------------------------
    const focus = Math.round(focusRaw * 5);
    if (focus !== this.lastSent.focus) {
      this.lastSent.focus = focus;
      if (this.callbacks.onFocus) this.callbacks.onFocus(focus);
    }

    // --------------------------- button actions --------------------------
    const pressedNow = (idx) => this._btnPressed(pad, idx);
    const justPressed = (idx) =>
      idx != null && pressedNow(idx) && !this.prevButtons[idx];

    const shiftHeld = pressedNow(m.buttons.presetShift);
    const fire = (name, arg) => {
      if (this.callbacks.onAction) this.callbacks.onAction(name, arg);
    };

    if (justPressed(m.buttons.cameraNext)) fire('cameraNext');
    if (justPressed(m.buttons.cameraPrev)) fire('cameraPrev');
    if (justPressed(m.buttons.home)) fire('home');
    if (justPressed(m.buttons.focusAuto)) fire('focusAuto');
    if (justPressed(m.buttons.speedUp)) fire('speedUp');
    if (justPressed(m.buttons.speedDown)) fire('speedDown');
    if (justPressed(m.buttons.menu)) fire('menu');
    if (justPressed(m.buttons.trackCancel)) fire('trackCancel');

    // Save-mode latch button: toggles "save the next preset" on/off. Lets an
    // adaptive user arm saving with a single spare button instead of a chord.
    if (justPressed(m.buttons.presetSaveMode)) fire('presetSaveModeToggle');

    // Presets: recall on a quick tap, save on a long hold — no shift chord
    // needed. A save also fires immediately if save mode is armed or the
    // Preset shift button is held (classic behaviour, kept for compatibility).
    const holdToSave = s.presetHoldToSave !== false; // default on
    const holdMs = s.presetHoldMs ?? 800;
    for (let n = 1; n <= 8; n++) {
      const idx = m.buttons[`preset${n}`];
      if (idx != null) {
        const down = pressedNow(idx);
        const was = !!this.prevButtons[idx];
        if (down && !was) {
          // Just pressed.
          if (this.saveMode || shiftHeld) {
            fire('presetSave', n);          // explicit save intent
            this.presetHold[n] = null;      // don't also recall on release
          } else if (holdToSave) {
            this.presetHold[n] = { since: now, saved: false }; // resolve later
          } else {
            fire('presetRecall', n);        // classic: recall on press
            this.presetHold[n] = null;
          }
        } else if (down && was) {
          // Held: once past the threshold, save once.
          const h = this.presetHold[n];
          if (h && !h.saved && (now - h.since) >= holdMs) {
            h.saved = true;
            fire('presetSave', n);
          }
        } else if (!down && was) {
          // Released: a short tap that never crossed the hold threshold recalls.
          const h = this.presetHold[n];
          if (h && !h.saved) fire('presetRecall', n);
          this.presetHold[n] = null;
        }
      }
      if (justPressed(m.buttons[`camera${n}`])) fire('cameraSelect', n);
    }

    this._snapshotButtons(pad);
  }

  _snapshotButtons(pad) {
    this.prevButtons = pad.buttons.map((b) => b.pressed);
  }
}

window.GamepadEngine = GamepadEngine;
window.gpButtonName = buttonName;
window.gpAxisName = axisName;
window.gpClaimBinding = claimBinding;
