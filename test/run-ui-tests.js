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
