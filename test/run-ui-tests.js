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
  const attributes = new Map();
  return {
    dataset: {}, value: '', textContent: '', hidden: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    appendChild() {},
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

test('the app logo uses the current dark theme palette', () => {
  const svg = fs.readFileSync(require.resolve('../build/icon.svg'), 'utf8');
  const css = fs.readFileSync(require.resolve('../src/renderer/styles.css'), 'utf8');
  const darkRule = css.match(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]+)\}/);
  assert(darkRule, 'the dark theme must be defined');
  const colors = new Set(darkRule[1].match(/#[0-9a-f]{6}/gi));
  for (const color of svg.match(/#[0-9a-f]{6}/gi)) {
    assert(colors.has(color), `logo color ${color} must come from the dark theme`);
  }
  for (const token of ['bg-0', 'accent', 'text-1']) {
    const color = darkRule[1].match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`))[1];
    assert(svg.includes(`"${color}"`), `the logo must use --${token}`);
  }
});

test('desktop and runtime icons use identical full-resolution PNG artwork', () => {
  const desktop = fs.readFileSync(require.resolve('../build/icon.png'));
  const runtime = fs.readFileSync(require.resolve('../src/assets/icon.png'));
  assert(runtime.equals(desktop), 'window/tray and packaged icons must not drift');
  assert.equal(desktop.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(desktop.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(desktop.readUInt32BE(16), 1024);
  assert.equal(desktop.readUInt32BE(20), 1024);
  for (const platform of ['win', 'mac', 'linux']) {
    assert.equal(require('../package.json').build[platform].icon, 'build/icon.png');
  }
});

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
    assert.throws(() => store.setSettings({ defaultCameraId: video.id }), /Default camera/);
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

test('new stores do not share camera lists or mutate defaults', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-store-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-store-second-'));
  try {
    const a = new Store(first);
    a.addCamera({ name: 'Fixture', ip: '192.0.2.1' });
    assert.equal(new Store(second).data.cameras.length, 0);
    assert.equal(require('../src/main/store').DEFAULTS.cameras.length, 0);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('invalid persisted settings recover individually without replacing a saved theme or cameras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-invalid-settings-'));
  try {
    fs.writeFileSync(path.join(dir, 'ptzctrl-config.json'), JSON.stringify({
      cameras: [{ id: 'fixture', name: 'Fixture', ip: '192.0.2.1' }],
      settings: { theme: 'light', deadzone: 1, speedMultiplier: -1, invertPan: 'false', rampTime: 0 },
    }));
    const store = new Store(dir);
    assert.equal(store.data.settings.theme, 'light');
    assert.equal(store.data.settings.deadzone, 0.15);
    assert.equal(store.data.settings.speedMultiplier, 1);
    assert.equal(store.data.settings.invertPan, false);
    assert.equal(store.data.settings.rampTime, 0);
    assert.equal(store.data.cameras[0].id, 'fixture');
    assert(store.getAll().warnings.length > 0, 'recovery must be visible, not silent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid JSON and null roots recover explicitly and preserve the original file', () => {
  for (const text of ['null', '{"settings":']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-invalid-config-'));
    try {
      const file = path.join(dir, 'ptzctrl-config.json');
      fs.writeFileSync(file, text);
      const store = new Store(dir);
      assert.equal(store.data.settings.theme, 'dark');
      assert.equal(store.data.cameras.length, 0);
      assert(store.getAll().warnings.length > 0);
      store.setSettings({ theme: 'light' });
      const backup = fs.readdirSync(dir).find(name => name.startsWith('ptzctrl-config.json.recovery-'));
      assert(backup, 'recovery must retain a backup before any save replaces the invalid file');
      assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), text);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('failed settings writes reject and leave the stored and in-memory preferences unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-save-failure-'));
  try {
    const store = new Store(dir);
    store.setSettings({ theme: 'dark' });
    const file = store.file;
    const before = fs.readFileSync(file, 'utf8');
    store.file = dir; // a directory cannot be replaced by a config file on any supported OS
    assert.throws(() => store.setSettings({ theme: 'light' }), /save/i);
    assert.equal(store.data.settings.theme, 'dark');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setting ranges match the UI and reject invalid values without writing them', () => {
  const { SETTINGS_RANGES, DEFAULTS } = require('../src/main/store');
  const html = fs.readFileSync(require.resolve('../src/renderer/index.html'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-setting-ranges-'));
  try {
    const store = new Store(dir);
    for (const [key, [min, max, step]] of Object.entries(SETTINGS_RANGES)) {
      const input = html.match(new RegExp(`<input[^>]+id="${key}"[^>]*>`))?.[0];
      assert(input, `${key} exists in the UI`);
      for (const [name, value] of Object.entries({ min, max, step })) {
        assert(input.includes(`${name}="${value}"`), `${key} ${name} agrees with the store`);
      }
      for (const value of [NaN, Infinity, null, 'invalid', min - step, max + step, min + step / 2]) {
        assert.throws(() => store.setSettings({ [key]: value }), /Invalid setting/);
        assert.equal(store.data.settings[key], DEFAULTS.settings[key]);
      }
    }
    for (const theme of [null, '', 'system']) {
      assert.throws(() => store.setSettings({ theme }), /Invalid setting/);
    }
    assert(!fs.existsSync(store.file), 'rejected changes never create a config');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomic replacement failure preserves every config mutation and cleans its temporary file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-atomic-save-'));
  try {
    const store = new Store(dir);
    const cam = store.addCamera({ name: 'Original', ip: '192.0.2.1' });
    const other = store.addCamera({ name: 'Other', ip: '192.0.2.2' });
    store.setMapping({ axes: { pan: 2 } });
    const before = JSON.stringify(store.data);
    const bytes = fs.readFileSync(store.file, 'utf8');
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Simulated write failure'), { code: 'EACCES' }); });
    for (const change of [
      () => store.setSettings({ theme: 'light' }),
      () => store.addCamera({ ip: '192.0.2.3' }),
      () => store.updateCamera(cam.id, { name: 'Unsaved' }),
      () => store.removeCamera(cam.id),
      () => store.setActiveCamera(other.id),
      () => store.setMapping({ axes: { pan: 3 } }),
      () => store.resetMapping(),
    ]) {
      assert.throws(change, /Could not save configuration/);
      assert.equal(JSON.stringify(store.data), before, 'failed mutations must not change in-memory config');
      assert.equal(fs.readFileSync(store.file, 'utf8'), bytes, 'failed replacement must not truncate the original');
      assert.deepEqual(fs.readdirSync(dir), ['ptzctrl-config.json'], 'temporary write must be cleaned');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable config fails explicitly rather than replacing data with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-unreadable-config-'));
  try {
    const file = path.join(dir, 'ptzctrl-config.json');
    fs.mkdirSync(file);
    assert.throws(() => new Store(dir), /Could not read configuration/);
    assert(fs.statSync(file).isDirectory());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing and invalid saved themes use dark, while explicit light survives upgrades', () => {
  for (const [saved, expected] of [[{}, 'dark'], [{ theme: 'system' }, 'dark'], [{ theme: 'light' }, 'light']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptz-theme-upgrade-'));
    try {
      fs.writeFileSync(path.join(dir, 'ptzctrl-config.json'), JSON.stringify({ settings: saved }));
      assert.equal(new Store(dir).data.settings.theme, expected);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('theme bootstrap applies the saved appearance before the stylesheet, with a dark fallback', () => {
  const script = fs.readFileSync(require.resolve('../src/renderer/theme.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../src/renderer/index.html'), 'utf8');
  assert(html.indexOf('src="theme.js"') < html.indexOf('rel="stylesheet"'));
  for (const initialTheme of ['dark', 'light', undefined, 'invalid']) {
    const document = { documentElement: { dataset: {} } };
    vm.runInNewContext(script, { document, window: { ptz: { initialTheme } } });
    assert.equal(document.documentElement.dataset.theme, initialTheme === 'light' ? 'light' : 'dark');
  }
});

function settingsHarness() {
  const requests = [], errors = [], successes = [], elements = new Map();
  const config = { cameras: [], settings: { ...require('../src/main/store').DEFAULTS.settings } };
  const get = id => {
    if (!elements.has(id)) elements.set(id, target());
    return elements.get(id);
  };
  const context = vm.createContext({
    config, engine: {}, $: get,
    document: { documentElement: { dataset: {} }, createElement: target },
    window: { ptz: {
      setSettings(patch) {
        const d = deferred();
        requests.push({ patch: { ...patch }, ...d });
        return d.promise;
      },
      getConfig: async () => ({ cameras: [], settings: { ...require('../src/main/store').DEFAULTS.settings } }),
    } },
    isVideoOnly: cam => cam.type === 'ip',
    setError: message => errors.push(message), setOk: message => successes.push(message),
    setTimeout: () => 1, clearTimeout() {},
    cameraSelectionRevision: 0, mappingRevision: 0, activeCamera: () => null,
    renderCameras() {}, autoTestCameras() {}, updateLiveCard() {}, gridRunning: false,
  });
  vm.runInContext(section('const pctFmt =', '// Live input visualization'), context);
  vm.runInContext(section('async function refreshConfig()', '\n(async () =>'), context);
  context.renderSettings();
  return { context, requests, errors, successes, get };
}

test('rapid settings edits serialize saves and do not restore an older theme on completion', async () => {
  const h = settingsHarness();
  const first = h.context.updateSettings({ theme: 'light' }, true);
  h.context.updateSettings({ theme: 'dark', speedMultiplier: 0.6 }, true);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ ...h.context.config.settings, theme: 'light' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.config.settings.theme, 'dark');
  assert.equal(h.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].patch, { theme: 'dark', speedMultiplier: 0.6 });
  h.requests[1].resolve({ ...h.context.config.settings });
  await first;
  assert.equal(h.get('settingsSaveStatus').dataset.kind, 'ok');
  assert.equal(h.get('oscSpeed').getAttribute('aria-valuetext'), '60%');
  assert.equal(h.get('speedMultiplier').getAttribute('aria-valuetext'), '60%');
});

test('failed settings saves retain the latest edits, show an error, and retry successfully', async () => {
  const h = settingsHarness();
  const first = h.context.updateSettings({ speedMultiplier: 0.8 }, true);
  h.context.updateSettings({ speedMultiplier: 0.5, theme: 'light' });
  h.requests[0].reject(new Error('disk full'));
  await first;
  assert.equal(h.context.config.settings.speedMultiplier, 0.5);
  assert.equal(h.get('settingsSaveStatus').dataset.kind, 'error');
  assert.equal(h.get('retrySettingsBtn').hidden, false);
  assert.match(h.errors.at(-1), /disk full/);
  await h.context.refreshConfig();
  assert.equal(h.context.config.settings.theme, 'light', 'camera/config refresh must preserve unsaved edits');
  const retry = h.context.savePendingSettings();
  assert.deepEqual(h.requests[1].patch, { speedMultiplier: 0.5, theme: 'light' });
  h.requests[1].resolve({ ...h.context.config.settings });
  await retry;
  assert.equal(h.get('settingsSaveStatus').dataset.kind, 'ok');
  assert.equal(h.get('retrySettingsBtn').hidden, true);
  assert.equal(h.successes.at(-1), 'Settings saved.');
});

test('a late config refresh cannot revert a successfully saved theme', async () => {
  const h = settingsHarness();
  const reading = deferred();
  h.context.window.ptz.getConfig = () => reading.promise;
  const refresh = h.context.refreshConfig();
  const save = h.context.updateSettings({ theme: 'light' }, true);
  h.requests[0].resolve({ ...h.context.config.settings });
  await save;
  reading.resolve({ cameras: [], settings: { ...require('../src/main/store').DEFAULTS.settings } });
  await refresh;
  assert.equal(h.context.config.settings.theme, 'light');
  assert.equal(h.context.document.documentElement.dataset.theme, 'light');
});

test('rapid mapping edits serialize against the latest committed mapping, including after a failure', async () => {
  const mapping = structuredClone(require('../src/main/store').DEFAULTS.mapping);
  const config = { mapping };
  const context = vm.createContext({ config, engine: { mapping }, structuredClone });
  vm.runInContext(section('let mappingSave =', 'let listeningRow ='), context);
  const firstReply = deferred();
  const first = context.persistMapping(async next => {
    next.axes.pan = null;
    await firstReply.promise;
    return next;
  });
  const second = context.persistMapping(async next => {
    assert.equal(next.axes.pan, null, 'the second edit must include the first edit');
    next.axes.tilt = null;
    return next;
  });
  firstReply.resolve();
  await Promise.all([first, second]);
  assert.equal(config.mapping.axes.pan, null);
  assert.equal(config.mapping.axes.tilt, null);
  const committed = config.mapping;
  const failed = context.persistMapping(async next => {
    next.axes.zoom = 3;
    throw new Error('Simulated mapping save failure');
  });
  await assert.rejects(failed, /Simulated mapping save failure/);
  assert.equal(config.mapping, committed);
  await context.persistMapping(async next => {
    assert.equal(next.axes.zoom, null, 'a failed edit must not leak into the next save');
    next.buttons.home = null;
    return next;
  });
  assert.equal(config.mapping.buttons.home, null);
  assert.equal(context.engine.mapping, config.mapping);
});

test('hold-to-save time disables without changing the saved time when hold-to-save is off', () => {
  const h = settingsHarness();
  h.context.updateSettings({ presetHoldToSave: false });
  assert.equal(h.get('presetHoldMs').disabled, true);
  assert.equal(h.context.config.settings.presetHoldMs, 800);
  h.context.updateSettings({ presetHoldToSave: true });
  assert.equal(h.get('presetHoldMs').disabled, false);
  assert.equal(h.get('presetHoldMs').value, '800');
});

test('removing a camera during a default-camera save cannot restore the removed default', async () => {
  const h = settingsHarness();
  h.context.config.cameras = [{ id: 'removed', type: 'visca', name: 'Fixture' }];
  const first = h.context.updateSettings({ defaultCameraId: 'removed' }, true);
  await h.context.refreshConfig(); // the camera list is now empty
  assert.equal(h.context.config.settings.defaultCameraId, null);
  h.requests[0].resolve({ ...h.context.config.settings, defaultCameraId: 'removed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests[1].patch, { defaultCameraId: null });
  h.requests[1].resolve({ ...h.context.config.settings });
  await first;
  assert.equal(h.context.config.settings.defaultCameraId, null);
});

test('trigger meters reflect live values and reset without changing layout width', () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { ...target(), style: {} });
    return elements.get(id);
  };
  const context = vm.createContext({ $: get, lights: [] });
  vm.runInContext(section('function renderFrame(pad)', '// Gamepad engine wiring'), context);
  const buttons = Array.from({ length: 8 }, () => ({ value: 0 }));
  buttons[6].value = 0.5;
  buttons[7].value = 1;
  context.renderFrame({ axes: [0, 0, 0, 0], buttons });
  assert.equal(get('barLT').style.transform, 'scaleX(0.5)');
  assert.equal(get('barRT').style.transform, 'scaleX(1)');
  assert.equal(get('barLT').style.width, undefined);
  context.renderFrame(null);
  assert.equal(get('barLT').style.transform, 'scaleX(0)');
  assert.equal(get('barRT').style.transform, 'scaleX(0)');
});

test('PTZ controls disable for no camera and video-only sources, but not VISCA cameras', () => {
  const controls = [target(), target()];
  const elements = new Map();
  let cam = null;
  const context = vm.createContext({
    activeCamera: () => cam, isVideoOnly: c => c.type === 'ip',
    document: { querySelectorAll: () => controls },
    $: id => { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); },
  });
  vm.runInContext(section('function updateControlAvailability()', 'let liveFeed'), context);
  for (const type of [null, 'ip', 'visca', 'local']) {
    cam = type ? { type } : null;
    context.updateControlAvailability();
    assert(controls.every(c => c.disabled === (type === null || type === 'ip')));
    assert.equal(elements.get('oscFocusFar').disabled, type !== 'visca');
  }
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
test('STOP ALL cancels a smoothing ramp until the held stick returns to neutral', () => {
  const h = inputHarness();
  let now = 0;
  h.engine._now = () => (now += 16);
  h.engine.settings.rampTime = 0.2;
  h.engine._poll();
  const context = vm.createContext({
    engine: h.engine, releaseOnScreenControls() {}, tracker: { cancel() {} },
    uvcStopAll() {}, manualDrive: {}, setSaveMode() {},
    window: { ptz: { stopAll: () => h.drives.push([0, 0]) } },
  });
  vm.runInContext(section('function haltLocalControl()', '// AI subject tracking'), context);
  context.ctlStopAll();
  h.engine._poll();
  h.engine._poll();
  assert.deepEqual(h.drives.at(-1), [0, 0], 'a ramp must not restart motion after STOP ALL');
  h.web.axes[0] = 0;
  h.engine._poll();
  h.web.axes[0] = 1;
  h.engine._poll();
  assert(h.drives.at(-1)[0] > 0, 'fresh input still works after neutral');
});
test('tray STOP ALL also notifies the renderer to halt tracking and USB/controller motion', () => {
  const main = fs.readFileSync(require.resolve('../src/main/index.js'), 'utf8');
  const sent = [], stopped = [];
  const context = vm.createContext({
    store: { getAll: () => ({ cameras: [{ id: 'a', type: 'visca' }, { id: 'usb', type: 'local' }] }) },
    keeper: {
      panTilt: (...args) => stopped.push(['panTilt', ...args]),
      zoom: (...args) => stopped.push(['zoom', ...args]),
      focus: (...args) => stopped.push(['focus', ...args]),
    },
    win: { isDestroyed: () => false, webContents: { send: name => sent.push(name) } },
  });
  vm.runInContext(main.slice(main.indexOf('function stopAllCameras()'), main.indexOf('function createTray()')), context);
  context.stopAllCameras();
  assert.deepEqual(stopped, [['panTilt', 'a', 0, 0], ['zoom', 'a', 0], ['focus', 'a', 0]]);
  assert.deepEqual(sent, ['ptz:stopped']);
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
