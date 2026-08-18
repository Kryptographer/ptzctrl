'use strict';

/**
 * Headless tests for the control path — the parts that decide what actually
 * reaches a camera and in what order.
 *
 *   node test/run-control-tests.js
 *
 * These cover the "preset bounce": a preset recall is an absolute move, so it
 * only lands cleanly if nothing else is still driving the camera and if the
 * recall doesn't end up queued behind a stale velocity command. Part 1 tests
 * the VISCA command pacer, part 2 tests the controller's drive hold-off.
 */

const assert = require('assert');

const { VISCA, ViscaConnection, DRIVE_KEYS, MIN_SEND_GAP_MS } = require('../src/main/visca.js');
const { DEFAULTS } = require('../src/main/store.js');
const { redactUrl } = require('../src/main/stream.js');

// gamepad.js is a renderer script that publishes itself on `window`. It only
// touches `navigator` from methods these tests stub out, so a bare window shim
// is enough to load it under Node.
global.window = global.window || {};
require('../src/renderer/gamepad.js');
const GamepadEngine = global.window.GamepadEngine;

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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------- VISCA command pacing

const GAP = MIN_SEND_GAP_MS; // the pacing the app actually ships with

/** A connection that records payloads instead of opening a socket. */
function recordingConn(minGapMs = GAP) {
  const conn = new ViscaConnection(
    { ip: '127.0.0.1', port: 1259, protocol: 'udp' },
    { minGapMs }
  );
  conn.writes = [];
  conn._write = async (payload) => { conn.writes.push(Buffer.from(payload)); };
  return conn;
}

// panTiltDrive layout: 81 01 06 01 <panSpeed> <tiltSpeed> <panDir> <tiltDir> FF
const panSpeedOf = (buf) => buf[4];
const panDirOf = (buf) => buf[6];
const tiltDirOf = (buf) => buf[7];
const STOP_DIR = 0x03;

async function viscaPacing() {
  console.log('VISCA command pacing:');

  await ok('the first command after an idle connection goes out immediately', () => {
    const conn = recordingConn();
    conn.send(VISCA.presetRecall(1));
    assert.strictEqual(conn.writes.length, 1, 'no added latency when the wire is free');
    conn.close();
  });

  await ok('a burst of drive updates collapses to the newest value', async () => {
    const conn = recordingConn();
    conn.send(VISCA.panTiltDrive(5, 0), { key: DRIVE_KEYS.PAN_TILT }); // writes now
    // The smoothing ramp emits one of these per 16 ms poll. Unpaced they would
    // all hit the wire and overrun the camera's two-command buffer.
    for (let v = 6; v <= 14; v++) {
      conn.send(VISCA.panTiltDrive(v, 0), { key: DRIVE_KEYS.PAN_TILT });
    }
    assert.strictEqual(conn.queue.length, 1, 'nine updates share one queue slot');
    await delay(GAP + 30);
    assert.strictEqual(conn.writes.length, 2);
    assert.strictEqual(panSpeedOf(conn.writes[1]), 14, 'newest speed survives, not the oldest');
    conn.close();
  });

  await ok('a stop is never dropped by coalescing', async () => {
    const conn = recordingConn();
    conn.send(VISCA.panTiltDrive(20, 0), { key: DRIVE_KEYS.PAN_TILT }); // writes now
    conn.send(VISCA.panTiltDrive(18, 0), { key: DRIVE_KEYS.PAN_TILT }); // queued
    conn.send(VISCA.panTiltDrive(0, 0), { key: DRIVE_KEYS.PAN_TILT });  // supersedes it
    await delay(GAP + 30);
    assert.strictEqual(conn.writes.length, 2);
    assert.strictEqual(panDirOf(conn.writes[1]), STOP_DIR, 'pan told to stop');
    assert.strictEqual(tiltDirOf(conn.writes[1]), STOP_DIR, 'tilt told to stop');
    conn.close();
  });

  await ok('a preset recall never overtakes the stop queued ahead of it', async () => {
    // This is the bounce, at the wire level: if the recall could jump the queue
    // the camera would move to the preset and then execute the stale drive.
    const conn = recordingConn();
    conn.send(VISCA.panTiltDrive(20, 0), { key: DRIVE_KEYS.PAN_TILT }); // writes now
    conn.send(VISCA.panTiltDrive(0, 0), { key: DRIVE_KEYS.PAN_TILT });  // queued: stop
    conn.send(VISCA.presetRecall(3));                                   // queued behind
    await delay(GAP * 2 + 60);
    assert.strictEqual(conn.writes.length, 3);
    assert.strictEqual(panDirOf(conn.writes[1]), STOP_DIR, 'stop lands before the recall');
    assert.deepStrictEqual(
      [...conn.writes[2]],
      [0x81, 0x01, 0x04, 0x3f, 0x02, 3, 0xff],
      'recall lands last, intact'
    );
    conn.close();
  });

  await ok('discrete commands are never merged with each other', async () => {
    const conn = recordingConn();
    conn.send(VISCA.presetRecall(1)); // writes now
    conn.send(VISCA.presetRecall(2));
    conn.send(VISCA.presetRecall(3));
    await delay(GAP * 2 + 60);
    assert.strictEqual(conn.writes.length, 3, 'every recall reaches the camera');
    assert.deepStrictEqual(conn.writes.map((b) => b[5]), [1, 2, 3], 'in order');
    conn.close();
  });

  await ok('paced writes are spaced by at least the minimum gap', async () => {
    const conn = recordingConn();
    const stamps = [];
    conn._write = async () => { stamps.push(Date.now()); };
    for (let i = 0; i < 4; i++) {
      conn.send(VISCA.panTiltDrive(i + 1, 0)); // no key: each one is kept
    }
    await delay(GAP * 4 + 80);
    assert.strictEqual(stamps.length, 4);
    for (let i = 1; i < stamps.length; i++) {
      const gap = stamps[i] - stamps[i - 1];
      assert.ok(gap >= GAP - 5, `gap ${i} was only ${gap} ms`);
    }
    conn.close();
  });

  await ok('close() resolves commands still waiting in the queue', async () => {
    const conn = recordingConn();
    conn.send(VISCA.presetRecall(1)); // writes now
    const pending = conn.send(VISCA.presetRecall(2)); // still queued
    conn.close();
    await Promise.race([
      pending,
      delay(400).then(() => { throw new Error('queued send never settled after close()'); }),
    ]);
  });
}

// ------------------------------------------------ controller drive hold-off

const press = (pressed, value) => ({
  pressed,
  value: value == null ? (pressed ? 1 : 0) : value,
  touched: pressed,
});

function fakePad() {
  return {
    id: 'Test Pad',
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => press(false)),
  };
}

/**
 * Engine wired to a fake pad and a fake clock. Ramping defaults to instant so
 * polls are deterministic; pass settings to override (tick() advances the
 * clock 16 ms per poll, so ramps are deterministic too).
 */
function testEngine(settings = {}) {
  const engine = new GamepadEngine();
  engine.mapping = JSON.parse(JSON.stringify(DEFAULTS.mapping));
  engine.settings = { ...DEFAULTS.settings, rampTime: 0, ...settings };
  const pad = fakePad();
  engine._gamepad = () => pad;
  let clock = 0;
  engine._now = () => clock;
  const tick = () => { clock += 16; engine._poll(); };
  const drives = [];
  const zooms = [];
  const actions = [];
  engine.callbacks = {
    onPanTilt: (pan, tilt) => drives.push([pan, tilt]),
    onZoom: (z) => zooms.push(z),
    onAction: (name, arg) => actions.push([name, arg]),
  };
  return { engine, pad, drives, zooms, actions, tick };
}

async function driveHoldOff() {
  console.log('controller drive hold-off after an absolute move:');

  await ok('a deflected stick drives the camera normally', () => {
    const { engine, pad, drives } = testEngine();
    pad.axes[0] = 1; // left stick hard right
    engine._poll();
    assert.deepStrictEqual(drives.at(-1), [24, 0], 'full pan speed');
  });

  await ok('releaseDrive() stops driving while the stick is still held', () => {
    // The real sequence: the operator is framing with the stick and taps a
    // preset. Without the hold-off the latched pan drive pulls the camera off
    // the preset the moment it arrives.
    const { engine, pad, drives } = testEngine();
    pad.axes[0] = 1;
    engine._poll();
    drives.length = 0;

    engine.releaseDrive();
    assert.strictEqual(engine.driveHoldOff, true);
    engine._poll();
    engine._poll();
    assert.strictEqual(drives.length, 0, 'nothing re-issued while the stick is still over');
    assert.strictEqual(engine.driveHoldOff, true, 'still held off');
  });

  await ok('control resumes the moment the stick re-centres', () => {
    const { engine, pad, drives } = testEngine();
    pad.axes[0] = 1;
    engine._poll();
    engine.releaseDrive();
    engine._poll();
    drives.length = 0;

    pad.axes[0] = 0; // operator lets go
    engine._poll();
    assert.strictEqual(engine.driveHoldOff, false, 'gate clears on neutral');
    assert.strictEqual(drives.length, 0, 'already stopped — nothing to send');

    pad.axes[0] = -1; // and drives again straight away, no extra step
    engine._poll();
    assert.deepStrictEqual(drives.at(-1), [-24, 0]);
  });

  await ok('the hold-off covers a held zoom trigger too', () => {
    const { engine, pad, zooms } = testEngine();
    pad.buttons[7] = press(true, 1); // RT = zoom in
    engine._poll();
    assert.strictEqual(zooms.at(-1), 7, 'full zoom speed');
    zooms.length = 0;

    engine.releaseDrive();
    engine._poll();
    engine._poll();
    assert.strictEqual(zooms.length, 0, 'zoom stays off the wire while RT is held');
    assert.strictEqual(engine.driveHoldOff, true);

    pad.buttons[7] = press(false, 0);
    engine._poll();
    assert.strictEqual(engine.driveHoldOff, false);
  });

  await ok('preset buttons keep working while drive is held off', () => {
    // The gate is on movement only — the operator must be able to tap a second
    // preset without first letting go of the stick.
    const { engine, pad, drives, actions } = testEngine();
    pad.axes[0] = 1;
    engine._poll();
    engine.releaseDrive();
    drives.length = 0;

    pad.buttons[12] = press(true); // D-pad up = preset 1
    engine._poll();
    pad.buttons[12] = press(false);
    engine._poll(); // tap resolves to a recall on release (hold-to-save default)

    assert.deepStrictEqual(actions.at(-1), ['presetRecall', 1]);
    assert.strictEqual(drives.length, 0, 'and still no drive from the held stick');
  });
}

// ----------------------------------------------- stick shaping & symmetry

async function stickShaping() {
  console.log('stick shaping (left/right symmetry, diagonals, reversals):');

  await ok('left and right produce mirror-image speeds across the whole range', () => {
    const { pad, drives, tick } = testEngine();
    // settle() lets the direction-change dwell expire between samples so
    // each deflection is measured from rest, like a real reframe.
    const settle = () => { pad.axes[0] = 0; for (let i = 0; i < 6; i++) tick(); };
    for (let d = 0.2; d <= 1.0001; d += 0.05) {
      pad.axes[0] = d; tick();
      const right = drives.at(-1)[0];
      settle();
      pad.axes[0] = -d; tick();
      const left = drives.at(-1)[0];
      assert.strictEqual(right, -left, `asymmetry at deflection ${d.toFixed(2)}`);
      settle();
    }
  });

  await ok('VISCA left/right direction bytes are correct and speeds match', () => {
    const l = VISCA.panTiltDrive(-5, 0);
    const r = VISCA.panTiltDrive(5, 0);
    assert.strictEqual(l[6], 0x01, 'negative pan drives LEFT (0x01)');
    assert.strictEqual(r[6], 0x02, 'positive pan drives RIGHT (0x02)');
    assert.strictEqual(l[4], r[4], 'same speed byte in both directions');
  });

  await ok('a diagonal keeps its pan component (radial deadzone)', () => {
    // Per-axis shaping crushed the smaller component: 0.3 pan alongside 0.9
    // tilt used to come out ~9× weaker than the vector geometry says.
    const { pad, drives, tick } = testEngine();
    pad.axes[0] = 0.3;   // modest pan right…
    pad.axes[1] = -0.9;  // …during a strong tilt up
    tick();
    const [pan, tilt] = drives.at(-1);
    assert.ok(pan >= 3, `pan component preserved on a diagonal (got ${pan})`);
    assert.ok(tilt > 0, 'tilt up still drives');
  });

  await ok('drive direction is exact on a true 45° diagonal', () => {
    const { engine, pad, tick } = testEngine();
    pad.axes[0] = 0.6;
    pad.axes[1] = -0.6;
    tick();
    // maxPanSpeed 24 vs maxTiltSpeed 20 scale the axes differently on
    // purpose; undo that and the drive ratio must equal the stick ratio.
    const ratio = (engine.smooth.pan / 24) / (engine.smooth.tilt / 20);
    assert.ok(Math.abs(ratio - 1) < 1e-9, `45° warped to ${ratio}`);
  });

  await ok('near-axis deflections map to a pure pan (no cross-axis drift)', () => {
    const { pad, drives, tick } = testEngine();
    pad.axes[0] = 0.9;    // hard pan right…
    pad.axes[1] = 0.06;   // …with a few degrees of thumb wobble
    tick();
    const [pan, tilt] = drives.at(-1);
    assert.ok(pan > 0, 'pan drives');
    assert.strictEqual(tilt, 0, 'wobble does not leak into tilt');
  });

  await ok('sweeping an arc never jumps the cross-axis speed (no hitch)', () => {
    // Fixed-deflection sweep from a level pan up to 45°: the tilt component
    // must fade in smoothly and monotonically. A hard snap boundary would
    // show up as a sudden jump partway through the arc.
    const { engine, pad, tick } = testEngine();
    let prevTilt = 0;
    for (let a = 0; a <= 45.0001; a += 1) {
      const rad = (a * Math.PI) / 180;
      pad.axes[0] = 0.9 * Math.cos(rad);
      pad.axes[1] = -0.9 * Math.sin(rad);
      tick();
      const t = engine.smooth.tilt;
      assert.ok(t >= prevTilt - 1e-9, `tilt fell while steepening (${a}°)`);
      assert.ok(t - prevTilt < 1.2, `tilt jumped ${(t - prevTilt).toFixed(2)} at ${a}°`);
      prevTilt = t;
    }
    assert.ok(prevTilt > 5, 'reaches a real tilt speed at 45°');
  });

  await ok('deadzone hysteresis: hovering at the edge cannot flutter the drive', () => {
    const { pad, drives, tick } = testEngine();
    pad.axes[0] = 0.16; // just past the deadzone: live at the slowest speed
    tick();
    assert.deepStrictEqual(drives.at(-1), [1, 0]);
    const n = drives.length;
    for (let i = 0; i < 20; i++) {
      pad.axes[0] = i % 2 ? 0.145 : 0.155; // stick noise straddling the edge
      tick();
    }
    assert.strictEqual(drives.length, n, 'edge wobble sends nothing at all');
    pad.axes[0] = 0.1; // a real release, below the drop-out threshold
    tick();
    assert.deepStrictEqual(drives.at(-1), [0, 0], 'a real release still stops');
  });

  await ok('tremor across a speed rounding edge does not chatter the speed', () => {
    const { pad, drives, tick } = testEngine();
    pad.axes[0] = 0.75;
    tick();
    const stable = drives.at(-1)[0];
    const n = drives.length;
    for (let i = 0; i < 20; i++) {
      pad.axes[0] = i % 2 ? 0.76 : 0.75; // wobbles the smoothed speed ±0.2
      tick();
    }
    assert.strictEqual(drives.length, n, 'boundary wobble sends nothing');
    pad.axes[0] = 0.95;
    tick();
    assert.ok(drives.at(-1)[0] > stable + 3, 'a real push still changes speed promptly');
  });

  await ok('a full-speed reversal passes through an explicit stop', () => {
    const { pad, drives, tick } = testEngine({ rampTime: 0.2 });
    pad.axes[0] = -1;
    for (let i = 0; i < 40; i++) tick(); // settle at full left
    assert.strictEqual(drives.at(-1)[0], -24);
    const flip = drives.length;
    pad.axes[0] = 1; // slam full right
    for (let i = 0; i < 40; i++) tick();
    const pans = drives.slice(flip).map((d) => d[0]);
    const zeroAt = pans.indexOf(0);
    assert.ok(zeroAt !== -1, 'an explicit stop is sent mid-reversal');
    assert.ok(pans.slice(0, zeroAt).every((p) => p < 0), 'eases off leftward speed first');
    assert.ok(pans.slice(zeroAt + 1).every((p) => p > 0), 'then ramps up rightward');
    assert.strictEqual(pans.at(-1), 24, 'reaches full right speed');
  });

  await ok('ramped motion steps through intermediate speeds, not jumps', () => {
    const { pad, drives, tick } = testEngine({ rampTime: 0.2 });
    pad.axes[0] = 1;
    for (let i = 0; i < 40; i++) tick();
    const pans = drives.map((d) => d[0]);
    assert.strictEqual(pans.at(-1), 24, 'reaches full speed');
    for (let i = 1; i < pans.length; i++) {
      assert.ok(pans[i] - pans[i - 1] <= 6, `smooth ramp (jump of ${pans[i] - pans[i - 1]})`);
      assert.ok(pans[i] >= pans[i - 1], 'monotonic ramp-up');
    }
  });

  await ok('rearmOutputs() re-sends the held stick state on the next poll', () => {
    // The camera-switch handoff: the new active camera must hear the current
    // drive immediately, not on the next stick change.
    const { engine, pad, drives, tick } = testEngine();
    pad.axes[0] = 1;
    tick();
    assert.deepStrictEqual(drives.at(-1), [24, 0]);
    drives.length = 0;
    tick();
    assert.strictEqual(drives.length, 0, 'no re-send while nothing changed');
    engine.rearmOutputs();
    tick();
    assert.deepStrictEqual(drives.at(-1), [24, 0], 'held drive re-emitted after rearm');
  });

  await ok('the wire itself sees a stop between opposite pan directions', async () => {
    // End-to-end: engine (real clock) → pacer → wire. The engine's zero
    // dwell must outlive the pacer's coalescing window, or the stop is
    // superseded before it is ever written and the camera gets a bare
    // direction flip.
    const engine = new GamepadEngine();
    engine.mapping = JSON.parse(JSON.stringify(DEFAULTS.mapping));
    engine.settings = { ...DEFAULTS.settings }; // real ramp, real timings
    const pad = fakePad();
    engine._gamepad = () => pad;
    const conn = recordingConn();
    engine.callbacks = {
      onPanTilt: (p, t) => conn.send(VISCA.panTiltDrive(p, t), { key: DRIVE_KEYS.PAN_TILT }),
    };
    pad.axes[0] = -1;
    for (let i = 0; i < 25; i++) { engine._poll(); await delay(16); }
    pad.axes[0] = 1; // slam reversal
    for (let i = 0; i < 25; i++) { engine._poll(); await delay(16); }
    await delay(GAP * 2);
    const dirs = conn.writes.map(panDirOf);
    const firstRight = dirs.indexOf(0x02);
    assert.ok(dirs.slice(0, firstRight).includes(0x01), 'panned left first');
    assert.ok(firstRight > 0, 'then panned right');
    assert.strictEqual(dirs[firstRight - 1], STOP_DIR, 'with a stop written in between');
    conn.close();
  });

  await ok('trigger zoom ramps from the first touch and releases to a stop', () => {
    const { pad, zooms, tick } = testEngine();
    pad.buttons[7] = press(true, 0.1); // barely past the trigger deadzone
    tick();
    assert.strictEqual(zooms.at(-1), 1, 'lightest touch = slowest zoom');
    pad.buttons[7] = press(true, 1);
    tick();
    assert.strictEqual(zooms.at(-1), 7, 'full pull = full speed');
    pad.buttons[7] = press(true, 0.05); // inside the deadzone = released
    tick();
    assert.strictEqual(zooms.at(-1), 0, 'sub-deadzone value stops the zoom');
  });
}

// ------------------------------------------- binding claims (rebind UI)

async function bindingClaims() {
  console.log('binding claims (one physical input drives one action):');
  const claim = global.window.gpClaimBinding;

  await ok('rebinding steals the input from the action that held it', () => {
    const map = JSON.parse(JSON.stringify(DEFAULTS.mapping));
    // D-pad up (12) is Preset 1 by default; the user rebinds Preset 5 to it.
    const displaced = claim(map, 'button', 'preset5', 12);
    assert.deepStrictEqual(displaced, ['preset1'], 'reports where the binding moved from');
    assert.strictEqual(map.buttons.preset5, 12, 'new action owns the input');
    assert.strictEqual(map.buttons.preset1, null, 'old action is unbound, not doubled up');
  });

  await ok('rebinding an action to its current input displaces nothing', () => {
    const map = JSON.parse(JSON.stringify(DEFAULTS.mapping));
    const displaced = claim(map, 'button', 'preset1', 12);
    assert.deepStrictEqual(displaced, []);
    assert.strictEqual(map.buttons.preset1, 12);
  });

  await ok('axis claims never touch button bindings (separate index spaces)', () => {
    const map = JSON.parse(JSON.stringify(DEFAULTS.mapping));
    // Axis 1 is tilt; button 1 is Home. Claiming axis 1 for zoom must not
    // unbind Home just because the numbers collide.
    const displaced = claim(map, 'axis', 'zoom', 1);
    assert.deepStrictEqual(displaced, ['tilt']);
    assert.strictEqual(map.axes.zoom, 1);
    assert.strictEqual(map.buttons.home, 1, 'button table untouched');
  });

  await ok('after a steal the input fires only its new action', () => {
    // The pre-fix failure: preset5 rebound onto D-pad up left preset1 bound
    // too, so one press recalled two presets.
    const { engine, pad, actions } = testEngine();
    claim(engine.mapping, 'button', 'preset5', 12);
    pad.buttons[12] = press(true);
    engine._poll();
    pad.buttons[12] = press(false);
    engine._poll(); // tap resolves to a recall on release (hold-to-save default)
    assert.deepStrictEqual(actions, [['presetRecall', 5]], 'exactly one action fired');
  });
}

// ------------------------------------------- self-healing drive refresh

async function driveKeeper() {
  console.log('drive keeper (self-healing wire state over lossy UDP):');
  const { DriveKeeper } = require('../src/main/drivekeeper.js');

  await ok('forwards immediately and refreshes a moving drive', async () => {
    const sent = [];
    const k = new DriveKeeper((id, kind, a, b) => sent.push([id, kind, a, b]), { intervalMs: 25 });
    k.panTilt('c1', 10, 0);
    assert.deepStrictEqual(sent[0], ['c1', 'panTilt', 10, 0], 'no added latency');
    await delay(70);
    assert.ok(sent.length >= 3, 'kept refreshing while moving');
    assert.ok(sent.every((s) => s[2] === 10), 'refreshes carry the live value');
    k.dispose();
  });

  await ok('a stop is re-sent exactly once, then the keeper goes quiet', async () => {
    // A lost stop datagram is the worst case on air — the camera pans off
    // into the wall. The redundant stop self-heals it; going quiet after
    // keeps an idle rig off the network.
    const sent = [];
    const k = new DriveKeeper((id, kind, a, b) => sent.push([kind, a, b]), { intervalMs: 25 });
    k.panTilt('c1', 10, 0);
    k.panTilt('c1', 0, 0);
    sent.length = 0;
    await delay(120);
    assert.deepStrictEqual(sent, [['panTilt', 0, 0]], 'one redundant stop, no idle chatter');
    k.dispose();
  });

  await ok('an absolute move cancels pending stop repeats (no bounce)', async () => {
    const sent = [];
    const k = new DriveKeeper((id, kind, a, b) => sent.push([kind, a, b]), { intervalMs: 25 });
    k.panTilt('c1', 10, 0);
    k.panTilt('c1', 0, 0); // the renderer's pre-recall stop
    k.absoluteMove('c1');  // recall issued: stand down
    sent.length = 0;
    await delay(120);
    assert.deepStrictEqual(sent, [], 'no keeper traffic lands mid-recall');
    k.dispose();
  });

  await ok('zoom refreshes and stop-repeats independently of pan/tilt', async () => {
    const sent = [];
    const k = new DriveKeeper((id, kind, a) => sent.push([kind, a]), { intervalMs: 25 });
    k.zoom('c1', 5);
    await delay(60);
    assert.ok(sent.filter((s) => s[0] === 'zoom' && s[1] === 5).length >= 2, 'zoom refreshed');
    assert.ok(sent.every((s) => s[0] === 'zoom'), 'no pan/tilt traffic invented');
    k.zoom('c1', 0);
    await delay(80);
    assert.strictEqual(
      sent.filter((s) => s[0] === 'zoom' && s[1] === 0).length, 2,
      'immediate stop plus one repeat');
    k.dispose();
  });
}

// ------------------------------------- credential redaction in error text

async function credentialRedaction() {
  console.log('\nStream error redaction');

  await ok('camera credentials are stripped from ffmpeg error text', () => {
    const line = redactUrl(
      "rtsp://bob:hunter2@192.168.1.50:554/1: Server returned 401 Unauthorized");
    assert.ok(!line.includes('hunter2'), 'password removed');
    assert.ok(!line.includes('bob'), 'username removed');
    assert.ok(line.includes('192.168.1.50:554/1'), 'the useful part survives');
  });

  await ok('URLs without credentials and plain text pass through untouched', () => {
    assert.strictEqual(
      redactUrl('rtsp://192.168.1.50:554/1: Connection refused'),
      'rtsp://192.168.1.50:554/1: Connection refused');
    assert.strictEqual(
      redactUrl('[rtsp @ 0x1] method DESCRIBE failed'),
      '[rtsp @ 0x1] method DESCRIBE failed');
    assert.strictEqual(redactUrl(''), '');
    assert.strictEqual(redactUrl(undefined), undefined);
  });
}

(async () => {
  await viscaPacing();
  await driveHoldOff();
  await stickShaping();
  await bindingClaims();
  await driveKeeper();
  await credentialRedaction();
  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
