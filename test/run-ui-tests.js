'use strict';

// Execute the actual renderer functions with controllable event/IPC shims.
// No Electron, camera or network is required to reproduce these races.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');
function section(from, to) {
  const start = renderer.indexOf(from);
  const end = renderer.indexOf(to, start);
  assert(start >= 0 && end > start);
  return renderer.slice(start, end);
}
function target() {
  const handlers = new Map();
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    addEventListener(type, cb) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(cb);
    },
    fire(type, props = {}) {
      const event = { type, button: 0, preventDefault() {}, ...props };
      for (const cb of handlers.get(type) || []) cb(event);
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function controls() {
  const window = target(), document = target(), el = target();
  const context = vm.createContext({ window, document });
  vm.runInContext(section('const onScreenReleases', '\nfunction oscSpeeds'), context);
  let starts = 0, stops = 0;
  context.holdControl(el, () => starts++, () => stops++);
  return { window, document, el, context, counts: () => [starts, stops] };
}

test('Space and Enter hold once through key repeat and stop on release', () => {
  for (const key of [' ', 'Enter']) {
    const h = controls();
    h.el.fire('keydown', { key });
    h.el.fire('keydown', { key, repeat: true });
    assert.deepEqual(h.counts(), [1, 0]);
    h.el.fire('keyup', { key });
    h.el.fire('blur');
    assert.deepEqual(h.counts(), [1, 1]);
  }
});
test('pointer motion stops on focus loss, hidden document, cancel and handoff', () => {
  for (const release of [h => h.window.fire('blur'), h => h.el.fire('pointercancel'),
    h => { h.document.hidden = true; h.document.fire('visibilitychange'); },
    h => h.context.releaseOnScreenControls()]) {
    const h = controls();
    h.el.fire('pointerdown');
    release(h);
    h.window.fire('pointerup');
    assert.deepEqual(h.counts(), [1, 1]);
  }
});
test('right click and disabled controls never start motion', () => {
  const h = controls();
  h.el.fire('pointerdown', { button: 2 });
  h.el.disabled = true;
  h.el.fire('keydown', { key: 'Enter' });
  assert.deepEqual(h.counts(), [0, 0]);
});
function liveHarness() {
  const diagnostics = [], feeds = [], overlays = [], elements = new Map();
  let cam = { id: 'a', name: 'Camera A' };
  const context = vm.createContext({
    activeCamera: () => cam,
    $: id => { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); },
    tracker: { isBusy: () => false, setSource() {} },
    liveOverlay: text => overlays.push(text),
    window: { ptz: { streamDiagnose() { const d = deferred(); diagnostics.push(d); return d.promise; } } },
    Feed: class { constructor(id) { this.id = id; feeds.push(this); } start() {} stop() {} },
  });
  vm.runInContext('let liveOn = false; let liveCamId = null;\n' +
    section('let liveFeed = null;', "$('liveToggleBtn').addEventListener"), context);
  return { context, diagnostics, feeds, overlays, select: c => { cam = c; } };
}
test('Stop invalidates a pending live-view startup', async () => {
  const h = liveHarness();
  const starting = h.context.startLive();
  h.context.stopLive();
  h.diagnostics[0].resolve({ found: true });
  await starting;
  assert.equal(h.feeds.length, 0);
  assert.match(h.overlays.at(-1), /Live view is off/);
});
test('out-of-order diagnostics cannot replace the newly selected feed', async () => {
  const h = liveHarness();
  const first = h.context.startLive();
  h.select({ id: 'b', name: 'Camera B' });
  const second = h.context.startLive();
  h.diagnostics[1].resolve({ found: true });
  await second;
  h.diagnostics[0].resolve({ found: false, error: 'old diagnostic' });
  await first;
  assert.deepEqual(h.feeds.map(f => f.id), ['b']);
  assert(!h.overlays.some(s => s.includes('old diagnostic')));
});
test('diagnostic rejection is shown without an unhandled promise', async () => {
  const h = liveHarness();
  const starting = h.context.startLive();
  h.diagnostics[0].reject(new Error('diagnostic failed'));
  await starting;
  assert.match(h.overlays.at(-1), /diagnostic failed/);
});
test('USB playback settling after Stop cannot register a stopped track', async () => {
  const playing = deferred(), callbacks = [];
  let stopped = 0;
  const track = { stop() { stopped++; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { play: () => playing.promise };
  const context = vm.createContext({ navigator: { mediaDevices: { getUserMedia: async () => stream } } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/feeds.js'), 'utf8'), context);
  const feed = new context.LocalFeed('usb', video, () => {}, t => callbacks.push(t));
  const starting = feed.start();
  await Promise.resolve();
  feed.stop();
  playing.resolve();
  await starting;
  assert.equal(stopped, 1);
  assert.deepEqual(callbacks, [null]);
  assert.equal(video.srcObject, null);
});

function selectionHarness() {
  const requests = [], stopped = [], targets = [];
  const config = { cameras: ['a', 'b', 'c'].map(id => ({ id, name: id })), activeCameraId: 'a' };
  const context = vm.createContext({
    config,
    activeCamera: () => config.cameras.find(c => c.id === config.activeCameraId),
    releaseOnScreenControls() {}, handoffDrive: cam => stopped.push(cam.id),
    engine: { rearmOutputs() {} }, renderCameras: () => targets.push(config.activeCameraId),
    updateLiveCard() {}, updateGridActive() {}, setStatus() {}, setError() {}, refreshConfig() {},
    window: { ptz: { setActiveCamera(id) { const d = deferred(); requests.push({ id, ...d }); return d.promise; } } },
  });
  vm.runInContext(section('let cameraSelectionRevision', "$('addCameraForm').addEventListener"), context);
  return { context, config, requests, stopped, targets };
}
test('camera handoff is immediate and late IPC responses cannot restore an old target', async () => {
  const h = selectionHarness();
  const first = h.context.selectCamera('b');
  assert.equal(h.config.activeCameraId, 'b', 'next controller poll must drive B before IPC resolves');
  const second = h.context.selectCamera('c');
  assert.equal(h.config.activeCameraId, 'c');
  assert.deepEqual(h.stopped, ['a', 'b']);
  h.requests[1].resolve('c'); await second;
  h.requests[0].resolve('b'); await first;
  assert.equal(h.config.activeCameraId, 'c');
  assert.deepEqual(h.targets, ['b', 'c']);
});
test('rapid next-camera presses advance from the current target, not stale saved state', async () => {
  const h = selectionHarness();
  h.context.stepCamera(1); h.context.stepCamera(1);
  assert.deepEqual(h.requests.map(r => r.id), ['b', 'c']);
  h.requests.forEach(r => r.resolve(r.id));
  await Promise.resolve();
  await h.context.selectCamera('missing');
  await h.context.selectCamera('c');
  assert.equal(h.requests.length, 2);
});

const { Store } = require('../src/main/store');
const os = require('node:os');
const path = require('node:path');
test('default camera and theme persist; missing defaults recover to a controllable camera', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-preferences-'));
  try {
    let store = new Store(dir);
    assert.equal(store.data.settings.theme, 'dark');
    const video = store.addCamera({ type: 'ip', streamUrl: 'rtsp://example/video' });
    const a = store.addCamera({ name: 'A', ip: '192.0.2.1' });
    const b = store.addCamera({ name: 'B', ip: '192.0.2.2' });
    store.setSettings({ defaultCameraId: b.id, theme: 'light' });
    store.setActiveCamera(a.id);
    store = new Store(dir);
    assert.equal(store.data.activeCameraId, b.id);
    assert.equal(store.data.settings.theme, 'light');
    store.setSettings({ defaultCameraId: video.id });
    assert.equal(store.data.settings.defaultCameraId, b.id, 'video-only default rejected');
    store.removeCamera(b.id);
    assert.equal(store.data.settings.defaultCameraId, null);
    assert.equal(store.data.activeCameraId, a.id);
    store.setActiveCamera(video.id);
    assert.equal(new Store(dir).data.activeCameraId, video.id, 'remember-last still permits viewing video');
    store.data.activeCameraId = 'deleted'; store.save();
    assert.equal(new Store(dir).data.activeCameraId, a.id);
    store.setSettings({ defaultCameraId: null });
    store.removeCamera(a.id); store.removeCamera(video.id);
    assert.equal(new Store(dir).data.activeCameraId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function inputHarness() {
  let focused = true;
  const web = { index: 0, id: 'Web', connected: true, axes: [1, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  const context = vm.createContext({ window: {}, navigator: { getGamepads: () => [web] },
    document: { hasFocus: () => focused }, performance: { now: () => 100 } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer/gamepad.js'), 'utf8'), context);
  const engine = new context.window.GamepadEngine();
  const { DEFAULTS } = require('../src/main/store');
  engine.settings = { ...DEFAULTS.settings, rampTime: 0 };
  engine.mapping = JSON.parse(JSON.stringify(DEFAULTS.mapping));
  const drives = [];
  engine.callbacks = { onPanTilt: (p, t) => drives.push([p, t]) };
  return { engine, drives, web, blur: () => { focused = false; }, focus: () => { focused = true; } };
}
test('a pinned native controller keeps driving after blur and never falls back to another device', () => {
  const h = inputHarness();
  const first = { ...h.web, native: true, id: 'Native 0', index: 0 };
  const second = { ...h.web, native: true, id: 'Native 1', index: 1 };
  h.engine.setNativePad([first, second]);
  h.engine.selectGamepad('native:1');
  h.engine._poll();
  h.blur(); h.engine._poll();
  assert.equal(h.engine._gamepad(), second);
  assert(h.drives.at(-1)[0] > 0);
  h.engine.setNativePad([first]); h.engine._poll();
  assert.equal(h.engine._gamepad(), null);
  assert.deepEqual(h.drives.at(-1), [0, 0]);
  h.engine.setNativePad([first, second]); h.engine._poll();
  assert(h.drives.at(-1)[0] > 0);
});
test('Web input stops stale motion on blur and resumes on focus', () => {
  const h = inputHarness();
  h.engine.selectGamepad(0); h.engine._poll();
  assert(h.drives.at(-1)[0] > 0);
  h.blur(); h.engine._poll();
  assert.deepEqual(h.drives.at(-1), [0, 0]);
  h.focus(); h.engine._poll();
  assert(h.drives.at(-1)[0] > 0);
});
test('native reader polls every connected slot but rate-limits absent slots', () => {
  const { XInputReader } = require('../src/main/xinput');
  const reader = new XInputReader();
  const calls = [];
  reader.available = true;
  reader._readUser = index => { calls.push(index); return [0, 2].includes(index) ? { index } : null; };
  assert.deepEqual(reader.readAll().map(p => p.index), [0, 2]);
  assert.deepEqual(calls, [0, 1, 2, 3]);
  calls.length = 0;
  reader.readAll();
  assert.deepEqual(calls, [0, 2]);
});
