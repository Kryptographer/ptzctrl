'use strict';

/* global GamepadEngine, gpButtonName, gpAxisName, gpClaimBinding */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config = null; // { cameras, activeCameraId, settings, mapping }
const engine = new GamepadEngine();

const $ = (id) => document.getElementById(id);

/**
 * Status line. Severity is spelled out in a word ("Error", "Done"…) as well
 * as coloured, so the line still reads correctly without colour vision, and
 * the whole bar is a polite live region so screen readers hear the change.
 *
 * @param {string} msg
 * @param {'info'|'ok'|'error'|'busy'} [kind]
 */
function setStatus(msg, kind = 'info') {
  const wrap = $('statusMsg');
  const LABEL = { info: '', ok: 'Done', error: 'Error', busy: 'Working' };
  wrap.dataset.kind = kind;
  wrap.querySelector('.status-kind').textContent = LABEL[kind] || '';
  wrap.querySelector('.status-text').textContent = msg;
  wrap.title = msg; // full text on hover when the bar ellipsizes
}

const setError = (msg) => setStatus(msg, 'error');
const setOk = (msg) => setStatus(msg, 'ok');
const setBusy = (msg) => setStatus(msg, 'busy');

/**
 * Turn a button into a two-step confirmation for an irreversible action.
 * Nothing happens on the first click: the button is replaced in place by a
 * "Remove? Yes / Cancel" pair that reverts on Escape, on blur, or after a
 * few seconds. Cheaper than a modal and it can't be dismissed by accident.
 */
function confirmInline(btn, question, confirmLabel, onConfirm) {
  const slot = btn.parentElement;
  if (!slot) return;
  const wrap = document.createElement('span');
  wrap.className = 'confirm-inline';

  const q = document.createElement('span');
  q.className = 'confirm-q';
  q.textContent = question;

  const yes = document.createElement('button');
  yes.className = 'btn btn-sm btn-danger-solid';
  yes.textContent = confirmLabel;

  const no = document.createElement('button');
  no.className = 'btn btn-sm';
  no.textContent = 'Cancel';

  let timer = null;
  const revert = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener('keydown', onKey, true);
    if (wrap.isConnected) wrap.replaceWith(btn);
    btn.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      revert();
    }
  };

  no.addEventListener('click', (e) => { e.stopPropagation(); revert(); });
  yes.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener('keydown', onKey, true);
    await onConfirm();
    // Put the original button back unless the action re-rendered the list it
    // lived in (then `wrap` is already gone with the rest of that subtree).
    if (wrap.isConnected) revert();
  });

  wrap.append(q, yes, no);
  btn.replaceWith(wrap);
  document.addEventListener('keydown', onKey, true);
  yes.focus({ preventScroll: true });
  timer = setTimeout(revert, 8000);
}

function activeCamera() {
  if (!config) return null;
  return config.cameras.find((c) => c.id === config.activeCameraId) || null;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let currentTab = 'cameras';
const tabButtons = [...document.querySelectorAll('.tab')];

function showTab(next, { focus = false } = {}) {
  const btn = tabButtons.find((t) => t.dataset.tab === next);
  if (!btn) return;
  if (focus) btn.focus();
  if (next === currentTab) return;
  // Roving tabindex: only the selected tab is in the tab order, arrows move
  // between them — the WAI-ARIA tabs pattern.
  for (const t of tabButtons) {
    const on = t === btn;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
  $(`tab-${next}`).classList.add('active');
  const prev = currentTab;
  currentTab = next;
  if (prev === 'grid') gridLeave();
  if (next === 'grid') gridEnter();
}

for (const tab of tabButtons) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const i = tabButtons.indexOf(tab);
    const next =
      step === 'first' ? 0
        : step === 'last' ? tabButtons.length - 1
          : (i + step + tabButtons.length) % tabButtons.length;
    showTab(tabButtons[next].dataset.tab, { focus: true });
  });
}

// Ctrl+1…4 jumps straight to a tab from anywhere in the app.
window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  const i = ['1', '2', '3', '4'].indexOf(e.key);
  if (i === -1) return;
  e.preventDefault();
  showTab(tabButtons[i].dataset.tab, { focus: true });
});

// ---------------------------------------------------------------------------
// Local (USB / capture) cameras: UVC pan/tilt/zoom control
// ---------------------------------------------------------------------------
// While a local camera's video is playing (live view or multiview), its
// MediaStreamTrack is registered here. UVC-capable cameras expose pan/tilt/
// zoom capabilities on the track; we drive them incrementally so stick input
// behaves like velocity control, same as VISCA.

const localTracks = new Map(); // camId -> MediaStreamTrack
const uvcWarned = new Set();

function registerLocalTrack(camId, track) {
  if (track) localTracks.set(camId, track);
  else localTracks.delete(camId);
}

const uvcState = {
  camId: null,
  pan: 0, tilt: 0, zoom: 0,
  timer: null,
  busy: false,        // an applyConstraints round-trip is in flight
  targets: null,      // our own position targets; device settings are only
                      // read once per gesture (they lag & jitter mid-move)
  lastSent: null,
};

function uvcSet(camId, patch) {
  if (uvcState.camId !== camId) {
    uvcState.camId = camId;
    uvcState.pan = uvcState.tilt = uvcState.zoom = 0;
    uvcState.targets = null;
  }
  Object.assign(uvcState, patch);
  const moving = uvcState.pan !== 0 || uvcState.tilt !== 0 || uvcState.zoom !== 0;
  if (moving && !uvcState.timer) {
    uvcState.targets = null; // re-sync with the device at gesture start
    uvcState.timer = setInterval(uvcTick, 50);
  }
  if (!moving && uvcState.timer) {
    clearInterval(uvcState.timer);
    uvcState.timer = null;
  }
}

function uvcStopAll() {
  uvcState.pan = uvcState.tilt = uvcState.zoom = 0;
  if (uvcState.timer) {
    clearInterval(uvcState.timer);
    uvcState.timer = null;
  }
}

function uvcWarnOnce(camId, msg) {
  if (uvcWarned.has(camId)) return;
  uvcWarned.add(camId);
  setError(msg);
}

async function uvcTick() {
  // Never queue a second constraint call behind a slow one — stacked calls
  // are what stalls the capture pipeline and freezes the preview.
  if (uvcState.busy) return;
  const camId = uvcState.camId;
  const track = localTracks.get(camId);
  if (!track) {
    uvcWarnOnce(camId, 'Start this camera’s video (Live view or Multiview) to control it.');
    return;
  }
  let caps;
  try {
    caps = track.getCapabilities();
  } catch {
    return;
  }
  if (uvcState.targets === null) {
    // One settings read per gesture; after that we integrate locally.
    let s = {};
    try { s = track.getSettings(); } catch { /* ignore */ }
    uvcState.targets = {};
    for (const name of ['pan', 'tilt', 'zoom']) {
      const c = caps[name];
      if (c && typeof c.max === 'number') {
        uvcState.targets[name] = typeof s[name] === 'number' ? s[name] : (c.min + c.max) / 2;
      }
    }
  }
  const adv = {};
  const step = (name, speed, maxSpeed) => {
    const c = caps[name];
    if (!c || typeof c.max !== 'number' || speed === 0) return;
    if (uvcState.targets[name] === undefined) return;
    const range = c.max - c.min;
    if (range <= 0) return;
    // full deflection sweeps the whole range in ~4 s (20 ticks/s)
    const delta = (speed / maxSpeed) * (range / 80);
    let v = Math.max(c.min, Math.min(c.max, uvcState.targets[name] + delta));
    uvcState.targets[name] = v;
    if (c.step) v = Math.round(v / c.step) * c.step;
    adv[name] = v;
  };
  step('pan', uvcState.pan, 24);
  step('tilt', uvcState.tilt, 20);
  step('zoom', uvcState.zoom, 7);
  if (Object.keys(adv).length === 0) {
    uvcWarnOnce(camId, 'This USB device does not expose UVC pan/tilt/zoom — video only.');
    return;
  }
  // Skip the device round-trip when quantized values haven't changed.
  const sig = JSON.stringify(adv);
  if (sig === uvcState.lastSent) return;
  uvcState.busy = true;
  try {
    await track.applyConstraints({ advanced: [adv] });
    uvcState.lastSent = sig;
  } catch {
    /* device rejected the value; keep integrating */
  } finally {
    uvcState.busy = false;
  }
}

/**
 * Drop the incremental integrator's idea of where the camera is, after an
 * absolute move (preset recall / home) has jumped it somewhere else.
 *
 * uvcTick integrates locally from `targets` and only re-reads the device at the
 * start of a gesture. Leave a stale target behind and the very next tick steps
 * from the pre-recall position — the camera snaps to the preset and is
 * immediately dragged back off it.
 */
function uvcResync() {
  uvcStopAll();
  uvcState.targets = null; // re-read the device at the next gesture
  uvcState.lastSent = null;
}

async function uvcHome(cam) {
  const track = localTracks.get(cam.id);
  if (!track) {
    setError('Start this camera’s video first (Live view or Multiview).');
    return;
  }
  try {
    const caps = track.getCapabilities();
    const adv = {};
    for (const name of ['pan', 'tilt']) {
      const c = caps[name];
      if (c && typeof c.max === 'number') adv[name] = (c.min + c.max) / 2;
    }
    if (caps.zoom && typeof caps.zoom.max === 'number') adv.zoom = caps.zoom.min;
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    uvcResync();
  } catch { /* not supported */ }
}

async function uvcPresetSave(cam, n) {
  const track = localTracks.get(cam.id);
  if (!track) {
    setError('Start this camera’s video first (Live view or Multiview) to save presets.');
    return false;
  }
  const s = track.getSettings();
  const pos = {};
  for (const k of ['pan', 'tilt', 'zoom']) {
    if (typeof s[k] === 'number') pos[k] = s[k];
  }
  if (Object.keys(pos).length === 0) {
    setError('This USB device does not expose UVC pan/tilt/zoom — there is no position to save.');
    return false;
  }
  const presets = { ...(cam.presets || {}), [n]: pos };
  await window.ptz.updateCamera(cam.id, { presets });
  cam.presets = presets;
  return true;
}

async function uvcPresetRecall(cam, n) {
  const track = localTracks.get(cam.id);
  const pos = (cam.presets || {})[n];
  if (!track) {
    setStatus('Start this camera’s video first.');
    return false;
  }
  if (!pos) {
    setError(`No preset ${n} saved for ${cam.name} yet — tick save mode, then click ${n} to store one.`);
    return false;
  }
  try {
    await track.applyConstraints({ advanced: [pos] });
    uvcResync();
    return true;
  } catch {
    return false;
  }
}

// ------------------------- unified control dispatch -------------------------
// Every control path (gamepad, on-screen pad, preset panel, camera rows)
// goes through these so VISCA, local/UVC and video-only cameras behave
// consistently.

const videoOnlyWarned = new Set();
function isVideoOnly(cam) {
  return cam.type === 'ip';
}
function warnVideoOnly(cam) {
  if (videoOnlyWarned.has(cam.id)) return;
  videoOnlyWarned.add(cam.id);
  setError(`${cam.name} is a video-only camera — it has no PTZ control channel.`);
}

// The last manual velocity command that went out, and to which camera.
// Velocity commands are continuous — a camera keeps moving until it hears a
// stop — so when the active camera changes this is what tells the handoff
// whether the *previous* camera was left moving and needs that stop.
const manualDrive = { camId: null, pan: 0, tilt: 0, zoom: 0, focus: 0 };

function noteManualDrive(cam, patch) {
  if (manualDrive.camId !== cam.id) {
    manualDrive.camId = cam.id;
    manualDrive.pan = manualDrive.tilt = manualDrive.zoom = manualDrive.focus = 0;
  }
  Object.assign(manualDrive, patch);
}

function ctlPanTilt(cam, pan, tilt, fromTracker = false) {
  // Any manual movement (stick or on-screen pad) takes over from the AI
  // tracker immediately — the operator always wins.
  if (!fromTracker && (pan || tilt) && tracker.isActive()) {
    tracker.cancel('Manual control — tracking stopped.');
  }
  if (isVideoOnly(cam)) {
    if (pan || tilt) warnVideoOnly(cam);
    return;
  }
  if (!fromTracker) noteManualDrive(cam, { pan, tilt });
  if (cam.type === 'local') uvcSet(cam.id, { pan, tilt });
  else window.ptz.panTilt(cam.id, pan, tilt);
}

function ctlZoom(cam, speed) {
  if (isVideoOnly(cam)) {
    if (speed) warnVideoOnly(cam);
    return;
  }
  noteManualDrive(cam, { zoom: speed });
  if (cam.type === 'local') uvcSet(cam.id, { zoom: speed });
  else window.ptz.zoom(cam.id, speed);
}

function ctlFocus(cam, speed) {
  if (isVideoOnly(cam) || cam.type === 'local') return; // UVC focus is auto-managed
  noteManualDrive(cam, { focus: speed });
  window.ptz.focus(cam.id, speed);
}

/**
 * Hand control over from one camera to the next when the active camera
 * changes (LB/RB, a number button, or a click) while something is driving.
 *
 * Without this the old camera never hears a stop — its last velocity command
 * latches and it pans away on its own until someone notices — and the new
 * camera hears nothing until the stick *changes*, because outputs only fire
 * on change. So: stop the old camera explicitly, then rearm the controller
 * engine so the very next poll re-sends the live stick state to the new one.
 * The AI tracker is pinned to its own camera and manages its own stops, so a
 * camera it is following is left alone.
 */
function handoffDrive(prevCam) {
  const moving =
    manualDrive.camId === prevCam.id &&
    (manualDrive.pan || manualDrive.tilt || manualDrive.zoom || manualDrive.focus);
  const trackerOwns = tracker.isActive() && trackCamId === prevCam.id;
  if (moving && !trackerOwns) {
    if (prevCam.type === 'local') {
      uvcStopAll();
    } else if (!isVideoOnly(prevCam)) {
      window.ptz.panTilt(prevCam.id, 0, 0);
      window.ptz.zoom(prevCam.id, 0);
      if (manualDrive.focus) window.ptz.focus(prevCam.id, 0);
    }
  }
  manualDrive.camId = null;
  manualDrive.pan = manualDrive.tilt = manualDrive.zoom = manualDrive.focus = 0;
  engine.rearmOutputs();
}

function ctlFocusAuto(cam) {
  if (isVideoOnly(cam)) return;
  if (cam.type === 'local') {
    const track = localTracks.get(cam.id);
    if (track) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    return;
  }
  window.ptz.focusMode(cam.id, true);
}

/**
 * Clear the way for an absolute move (preset recall / home).
 *
 * Velocity commands are continuous: a camera told to pan keeps panning until it
 * is told to stop. So whatever is driving when the absolute move begins fights
 * it, and the camera lands on the target only to be pulled straight back off —
 * the bounce. Three things can be driving at that moment:
 *
 *   - a still-held stick or trigger (framing, then tapping a preset), or the
 *     tail of the smoothing ramp, since a preset recall fires on button
 *     *release* under hold-to-save;
 *   - the AI subject tracker, which otherwise keeps steering toward its box
 *     right through the recall;
 *   - for local/UVC cameras, the incremental position integrator.
 *
 * Shut all three down and send an explicit stop, so the recall arrives at a
 * camera that isn't already moving. Ordering holds on the wire: the stop is
 * queued ahead of the recall on the same connection.
 */
function releaseDrive(cam, trackMsg) {
  if (tracker.isActive()) tracker.cancel(trackMsg);
  engine.releaseDrive();
  manualDrive.pan = manualDrive.tilt = manualDrive.zoom = manualDrive.focus = 0;
  if (cam.type === 'local') {
    uvcStopAll();
  } else {
    window.ptz.panTilt(cam.id, 0, 0);
    window.ptz.zoom(cam.id, 0);
  }
}

function ctlHome(cam) {
  if (isVideoOnly(cam)) {
    warnVideoOnly(cam);
    return;
  }
  releaseDrive(cam, 'Home recalled — tracking stopped.');
  if (cam.type === 'local') uvcHome(cam);
  else window.ptz.home(cam.id);
}

async function ctlPresetSave(cam, n) {
  if (isVideoOnly(cam)) {
    warnVideoOnly(cam);
    return false;
  }
  if (cam.type === 'local') return uvcPresetSave(cam, n);
  window.ptz.presetSave(cam.id, n);
  return true;
}

async function ctlPresetRecall(cam, n) {
  if (isVideoOnly(cam)) {
    warnVideoOnly(cam);
    return false;
  }
  releaseDrive(cam, `Preset ${n} recalled — tracking stopped.`);
  if (cam.type === 'local') return uvcPresetRecall(cam, n);
  window.ptz.presetRecall(cam.id, n);
  return true;
}

function ctlStopAll() {
  tracker.cancel('Tracking stopped.');
  uvcStopAll();
  manualDrive.pan = manualDrive.tilt = manualDrive.zoom = manualDrive.focus = 0;
  window.ptz.stopAll();
}

// ---------------------------------------------------------------------------
// AI subject tracking (draw a box in Live view; the camera follows it)
// ---------------------------------------------------------------------------

// The camera being followed — pinned when tracking starts so a camera switch
// mid-track can't send follow commands to the wrong device.
let trackCamId = null;

const tracker = new SubjectTracker({
  canvas: document.getElementById('trackCanvas'),
  getSettings: () => (config ? config.settings : {}),
  onDrive: (pan, tilt) => {
    const cam = config && config.cameras.find((c) => c.id === trackCamId);
    if (cam) ctlPanTilt(cam, pan, tilt, true);
  },
  onState: (state, msg) => {
    const btn = $('trackBtn');
    if (btn) {
      btn.classList.toggle('track-on', state !== 'idle');
      btn.setAttribute('aria-pressed', String(state !== 'idle'));
      btn.textContent =
        state === 'idle' ? '◎ Track subject'
        : state === 'arming' ? 'Cancel — draw a box on the video'
        : '■ Stop tracking';
    }
    if (state === 'idle') trackCamId = null;
    if (msg) setStatus(msg, state === 'arming' ? 'busy' : 'info');
  },
});

// Shared "save mode" state: the on-screen checkbox and the controller's
// bindable "Preset save mode" button are the same one-shot toggle. While it's
// on, the next preset press (on-screen or controller) STORES the current
// position instead of recalling it, then it clears itself.
function setSaveMode(on) {
  on = !!on;
  const cb = $('presetSaveMode');
  if (cb) cb.checked = on;
  const wrap = $('oscPresets');
  if (wrap) {
    wrap.classList.toggle('save-mode', on);
    // Save mode flips what a click does, so the buttons say so — an amber
    // border alone would leave the change invisible to a screen reader and
    // ambiguous to everyone else.
    for (const b of wrap.querySelectorAll('button[data-preset]')) {
      const n = b.dataset.preset;
      b.setAttribute('aria-label', on ? `Overwrite preset ${n} with the current position` : `Recall preset ${n}`);
      b.title = on ? `Save current position as preset ${n}` : `Preset ${n}`;
    }
  }
  const hint = $('oscPresetHint');
  if (hint) {
    hint.classList.toggle('hint-warn', on);
    hint.innerHTML = on
      ? '<strong>Save mode is on</strong> — clicking a preset overwrites it with the camera’s current position.'
      : 'Click to recall. Tick <em>save mode</em>, then click to store the current position.';
  }
  engine.setSaveMode(on);
}

// ---------------------------------------------------------------------------
// Cameras UI
// ---------------------------------------------------------------------------

const PROTO_LABELS = { udp: 'UDP', 'udp-sony': 'UDP-Sony', tcp: 'TCP' };

let expandedCamId = null;
const camHealth = new Map(); // camId -> 'testing' | 'ok' | 'fail'

async function probeCameraHealth(cam) {
  camHealth.set(cam.id, 'testing');
  updateHealthDot(cam.id);
  let ok = false;
  try {
    if (cam.type === 'local') {
      const devs = await navigator.mediaDevices.enumerateDevices();
      ok = devs.some((d) => d.kind === 'videoinput' && d.deviceId === cam.deviceId);
    } else {
      const res = await window.ptz.testCamera(cam.id);
      ok = res.ok;
    }
  } catch { ok = false; }
  camHealth.set(cam.id, ok ? 'ok' : 'fail');
  updateHealthDot(cam.id);
  return ok;
}

function updateHealthDot(camId) {
  const health = camHealth.get(camId) || '';
  const text = `Connection: ${HEALTH_TEXT[health] || 'not tested yet'}`;
  const dot = document.querySelector(`.cam-dot[data-id="${camId}"]`);
  if (dot) {
    dot.className = `cam-dot ${health}`;
    dot.title = text;
  }
  const sr = document.querySelector(`[data-health-text-id="${camId}"]`);
  if (sr) sr.textContent = text;
  const label = document.querySelector(`.cam-health-label[data-id="${camId}"]`);
  if (label) {
    const state = camHealth.get(camId);
    const cam = config.cameras.find((c) => c.id === camId);
    const isLocal = cam && cam.type === 'local';
    label.textContent =
      state === 'ok' ? (isLocal ? 'Connected' : 'Online')
      : state === 'fail' ? (isLocal ? 'Unplugged' : 'No reply')
      : state === 'testing' ? 'Checking…' : '';
    label.className = `cam-status cam-health-label ${state === 'ok' ? 'ok' : state === 'fail' ? 'fail' : ''}`;
    label.dataset.id = camId;
  }
}

function autoTestCameras() {
  for (const cam of config.cameras) {
    if (!camHealth.has(cam.id)) probeCameraHealth(cam);
  }
}

/** Plain-language health text, so the dot is never the only cue. */
const HEALTH_TEXT = { ok: 'reachable', fail: 'not responding', testing: 'testing…' };

function renderCameras() {
  const list = $('cameraList');
  list.innerHTML = '';
  if (config.cameras.length === 0) {
    list.innerHTML =
      '<div class="empty-msg"><strong>No cameras yet</strong>' +
      'Click <em>Scan network</em> below to find PTZ cameras on your network, ' +
      'or add one by IP address.</div>';
  }
  config.cameras.forEach((cam, i) => {
    const isLocal = cam.type === 'local';
    const expanded = expandedCamId === cam.id;
    const isActive = cam.id === config.activeCameraId;
    const item = document.createElement('div');
    item.className = 'camera-item' + (expanded ? ' expanded' : '');
    // Single-select list: option semantics carry the selected state, and
    // tabbing lands on the list then arrows move through it.
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isActive));
    item.tabIndex = isActive || (!config.activeCameraId && i === 0) ? 0 : -1;
    item.dataset.camId = cam.id;

    // ------- header row: number · name · address · health · expand -------
    const row = document.createElement('div');
    row.className = 'cam-row';

    const num = document.createElement('div');
    num.className = 'cam-num';
    num.textContent = String(i + 1);

    const name = document.createElement('div');
    name.className = 'cam-name';
    const nameInput = document.createElement('input');
    nameInput.value = cam.name;
    nameInput.title = 'Rename camera';
    nameInput.setAttribute('aria-label', `Name of camera ${i + 1}`);
    nameInput.addEventListener('click', (e) => e.stopPropagation());
    // Typing (and arrowing through text) inside the field must not steer the
    // list underneath it.
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    nameInput.addEventListener('change', async () => {
      await window.ptz.updateCamera(cam.id, { name: nameInput.value.trim() || cam.ip || 'Camera' });
      await refreshConfig();
    });
    name.appendChild(nameInput);

    const isIp = cam.type === 'ip';
    const addr = document.createElement('div');
    addr.className = 'cam-addr';
    addr.textContent = isLocal
      ? 'USB / capture'
      : isIp
        ? `${cam.ip || 'stream'} · video-only`
        : `${cam.ip} · ${PROTO_LABELS[cam.protocol] || cam.protocol}`;

    const health = camHealth.get(cam.id) || '';
    const dot = document.createElement('span');
    dot.className = `cam-dot ${health}`;
    dot.dataset.id = cam.id;
    dot.title = `Connection: ${HEALTH_TEXT[health] || 'not tested yet'}`;
    // The dot's meaning also exists as text for anything that can't see it.
    const dotText = document.createElement('span');
    dotText.className = 'sr-only';
    dotText.dataset.healthTextId = cam.id;
    dotText.textContent = `Connection: ${HEALTH_TEXT[health] || 'not tested yet'}`;

    const expandBtn = document.createElement('button');
    expandBtn.className = 'cam-expand';
    expandBtn.title = expanded ? 'Hide settings' : 'Camera settings';
    expandBtn.setAttribute('aria-label', `Settings for ${cam.name}`);
    expandBtn.setAttribute('aria-expanded', String(expanded));
    expandBtn.innerHTML = '<span aria-hidden="true">⌄</span>';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      expandedCamId = expanded ? null : cam.id;
      renderCameras();
    });

    row.append(num, name, addr, dot, dotText, expandBtn);
    item.appendChild(row);
    item.addEventListener('click', () => selectCamera(cam.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectCamera(cam.id);
      }
    });

    // ---------------- expandable detail: settings & actions ----------------
    if (expanded) {
      const detail = document.createElement('div');
      detail.className = 'cam-detail';
      detail.addEventListener('click', (e) => e.stopPropagation());

      const rowA = document.createElement('div');
      rowA.className = 'cam-detail-row';

      if (!isLocal && !isIp) {
        const protoSel = document.createElement('select');
        protoSel.setAttribute('aria-label', `VISCA protocol for ${cam.name}`);
        for (const [val, label] of [['udp', 'UDP 1259'], ['udp-sony', 'UDP 52381 (Sony)'], ['tcp', 'TCP 5678']]) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = label;
          if (cam.protocol === val) opt.selected = true;
          protoSel.appendChild(opt);
        }
        protoSel.addEventListener('change', async () => {
          const defaults = { udp: 1259, 'udp-sony': 52381, tcp: 5678 };
          await window.ptz.updateCamera(cam.id, { protocol: protoSel.value, port: defaults[protoSel.value] });
          camHealth.delete(cam.id);
          await refreshConfig();
        });
        rowA.appendChild(protoSel);
      }

      const healthLabel = document.createElement('span');
      healthLabel.className = 'cam-status cam-health-label';
      healthLabel.dataset.id = cam.id;

      // Every row on this tab has a Test / Home / Remove button, so the
      // visible word alone is an ambiguous name — each carries the camera.
      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn-sm';
      testBtn.textContent = 'Test';
      testBtn.setAttribute('aria-label', `Test connection to ${cam.name}`);
      testBtn.addEventListener('click', () => probeCameraHealth(cam));

      const homeBtn = document.createElement('button');
      homeBtn.className = 'btn btn-sm';
      homeBtn.textContent = 'Home';
      homeBtn.setAttribute('aria-label', `Send ${cam.name} to its home position`);
      homeBtn.addEventListener('click', () => ctlHome(cam));

      const delSlot = document.createElement('span');
      delSlot.className = 'cam-detail-end';
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-sm btn-danger';
      delBtn.textContent = 'Remove';
      delBtn.setAttribute('aria-label', `Remove ${cam.name}`);
      // Removing a camera drops its presets and stream URL with no undo, so
      // it asks first rather than firing on a stray click.
      delBtn.addEventListener('click', () => {
        confirmInline(delBtn, `Remove ${cam.name}?`, 'Remove', async () => {
          await window.ptz.removeCamera(cam.id);
          camHealth.delete(cam.id);
          if (expandedCamId === cam.id) expandedCamId = null;
          await refreshConfig();
          setOk(`Removed ${cam.name}`);
        });
      });
      delSlot.appendChild(delBtn);

      if (isIp) rowA.append(healthLabel, testBtn, delSlot);
      else rowA.append(healthLabel, testBtn, homeBtn, delSlot);

      detail.append(rowA);
      if (!isIp) {
        const rowB = document.createElement('div');
        rowB.className = 'cam-detail-row';
        const presetLabel = document.createElement('span');
        presetLabel.className = 'cam-detail-label';
        presetLabel.textContent = 'Presets (Shift-click saves)';
        const presets = document.createElement('div');
        presets.className = 'preset-chips';
        presets.setAttribute('role', 'group');
        presets.setAttribute('aria-label', `Presets for ${cam.name}`);
        for (let n = 1; n <= 8; n++) {
          const b = document.createElement('button');
          b.textContent = String(n);
          b.setAttribute('aria-label', `Recall preset ${n} on ${cam.name} — hold Shift to save`);
          b.title = `Recall preset ${n} · Shift-click to save`;
          b.addEventListener('click', async (e) => {
            if (e.shiftKey) {
              if (await ctlPresetSave(cam, n)) setOk(`Saved preset ${n} on ${cam.name}`);
            } else {
              if (await ctlPresetRecall(cam, n)) setOk(`Recalled preset ${n} on ${cam.name}`);
            }
          });
          presets.appendChild(b);
        }
        rowB.append(presetLabel, presets);
        detail.append(rowB);
      }
      item.appendChild(detail);
    }

    list.appendChild(item);
    if (expanded) updateHealthDot(cam.id); // label exists in the DOM now
  });

  const pill = $('activeCamPill');
  const cam = activeCamera();
  if (cam) {
    pill.textContent = `Active: ${cam.name}`;
    pill.className = 'pill pill-on';
  } else {
    pill.textContent = 'No active camera';
    pill.className = 'pill pill-off';
  }
}

// Arrow keys walk the camera list, matching LB/RB on the controller.
$('cameraList').addEventListener('keydown', (e) => {
  const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (dir === undefined || !config || config.cameras.length === 0) return;
  e.preventDefault();
  stepCamera(dir);
  const next = $('cameraList').querySelector('[aria-selected="true"]');
  if (next) next.focus({ preventScroll: false });
});

async function selectCamera(id) {
  const prev = activeCamera();
  if (prev && prev.id !== id) handoffDrive(prev);
  else if (!prev) engine.rearmOutputs(); // held stick reaches the first camera too
  config.activeCameraId = await window.ptz.setActiveCamera(id);
  renderCameras();
  updateLiveCard();
  updateGridActive();
  const cam = activeCamera();
  if (cam) setStatus(`Active camera: ${cam.name}`);
}

function stepCamera(dir) {
  const cams = config.cameras;
  if (cams.length === 0) return;
  const idx = cams.findIndex((c) => c.id === config.activeCameraId);
  const next = ((idx === -1 ? 0 : idx + dir) + cams.length) % cams.length;
  selectCamera(cams[next].id);
}

$('addCameraForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = $('addIp').value.trim();
  if (!ip) return;
  // The pattern attribute lets "999.1.1.1" through; say exactly what is wrong
  // and what a good value looks like rather than failing silently later.
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
    setError(`"${ip}" isn't a valid IP address — each of the four numbers must be 0–255, e.g. 192.168.1.100.`);
    $('addIp').focus();
    return;
  }
  await window.ptz.addCamera({
    name: $('addName').value.trim() || ip,
    ip,
    port: Number($('addPort').value) || 1259,
    protocol: $('addProtocol').value,
  });
  $('addCameraForm').reset();
  $('addPort').value = '1259';
  await refreshConfig();
  setOk(`Added camera ${ip} — it's now in My cameras.`);
});

$('addProtocol').addEventListener('change', () => {
  const defaults = { udp: 1259, 'udp-sony': 52381, tcp: 5678 };
  $('addPort').value = String(defaults[$('addProtocol').value]);
});

$('addStreamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('addStreamUrl').value.trim();
  if (!url) return;
  let host = null;
  try { host = new URL(url).hostname || null; } catch { /* keep null */ }
  if (!host) {
    setError(
      `"${url}" isn't a stream URL. It needs a scheme and a host, ` +
      'e.g. rtsp://192.168.1.50:554/stream1 or http://192.168.1.23:8080/video.');
    $('addStreamUrl').focus();
    return;
  }
  await window.ptz.addCamera({
    type: 'ip',
    name: $('addStreamName').value.trim() || host || 'IP camera',
    ip: host,
    streamUrl: url,
  });
  $('addStreamForm').reset();
  await refreshConfig();
  setOk(`Added video-only camera ${host || url} — it's now in My cameras.`);
});

// ---------------------------------------------------------------------------
// Live view
// ---------------------------------------------------------------------------

let liveOn = false;
let liveCamId = null;

function liveOverlay(text) {
  const ov = $('liveOverlay');
  if (text === null) {
    ov.classList.add('hidden');
  } else {
    ov.classList.remove('hidden');
    ov.textContent = text;
  }
}

function updateLiveCard() {
  const cam = activeCamera();
  const isLocal = cam && cam.type === 'local';
  $('liveCamName').textContent = cam ? cam.name : '—';
  $('liveUrlInput').value = isLocal ? '(local USB / capture device)' : (cam ? cam.streamUrl || '' : '');
  $('liveUrlInput').disabled = !cam || isLocal;
  $('liveToggleBtn').disabled = !cam;
  $('findStreamBtn').disabled = !cam || isLocal || !cam.ip;
  $('trackBtn').disabled = !cam || isVideoOnly(cam);
  if (liveOn && (!cam || cam.id !== liveCamId)) {
    // Active camera changed while watching: follow it.
    if (cam) startLive();
    else stopLive();
  }
}

let liveFeed = null;

async function ffmpegMissingMessage() {
  const diag = await window.ptz.streamDiagnose();
  if (diag.found) return null;
  return `ffmpeg is missing (${diag.error || 'not found'}). Re-run build.bat or "npm install" in the app folder to fetch the bundled ffmpeg, then restart the app.`;
}

async function startLive() {
  const cam = activeCamera();
  if (!cam) return;
  // Restarting the stream means a new camera/URL — never track across that.
  if (tracker.isBusy()) tracker.cancel();
  if (liveFeed) {
    liveFeed.stop();
    liveFeed = null;
  }
  liveOn = true;
  liveCamId = cam.id;
  const toggle = $('liveToggleBtn');
  toggle.textContent = 'Stop';
  toggle.setAttribute('aria-pressed', 'true');
  toggle.setAttribute('aria-label', `Stop the live view of ${cam.name}`);
  $('liveImg').alt = `Live video from ${cam.name}`;
  liveOverlay(`Connecting to ${cam.name}…`);

  const isLocal = cam.type === 'local';
  $('liveImg').classList.toggle('hidden', isLocal);
  $('liveVideo').classList.toggle('hidden', !isLocal);
  tracker.setSource(isLocal ? $('liveVideo') : $('liveImg'));

  if (isLocal) {
    const feed = new LocalFeed(
      cam.deviceId,
      $('liveVideo'),
      (status) => {
        if (!liveOn || liveFeed !== feed) return;
        liveOverlay(status);
      },
      (track) => registerLocalTrack(cam.id, track)
    );
    liveFeed = feed;
    feed.start();
    return;
  }

  const missing = await ffmpegMissingMessage();
  if (missing) {
    liveOverlay(missing);
    return;
  }

  const feed = new Feed(cam.id, $('liveImg'), (status) => {
    if (!liveOn || liveFeed !== feed) return;
    if (status === null) liveOverlay(null);
    else if (status === 'Connecting…') liveOverlay(`Connecting to ${cam.name}…`);
    else liveOverlay(`${status}\n\nTry "Find stream automatically" below.`);
  });
  liveFeed = feed;
  feed.start();
}

function stopLive() {
  liveOn = false;
  liveCamId = null;
  tracker.setSource(null); // cancels tracking if it was running
  if (liveFeed) {
    liveFeed.stop();
    liveFeed = null;
  }
  const toggle = $('liveToggleBtn');
  toggle.textContent = 'Start';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-label', 'Start the live view of the active camera');
  $('liveImg').alt = '';
  liveOverlay('Live view is off\nPress Start to watch the active camera.');
}

$('liveToggleBtn').addEventListener('click', () => {
  if (liveOn) stopLive();
  else startLive();
});

$('trackBtn').addEventListener('click', async () => {
  if (tracker.isBusy()) {
    tracker.cancel('Tracking stopped.');
    return;
  }
  const cam = activeCamera();
  if (!cam) {
    setError('Pick a camera in My cameras first, then try again.');
    return;
  }
  if (isVideoOnly(cam)) {
    setError(`${cam.name} is video-only — it has no PTZ motors, so it cannot follow a subject.`);
    return;
  }
  if (!liveOn) await startLive(); // tracking needs frames on screen
  trackCamId = cam.id;
  tracker.arm();
});

$('liveUrlInput').addEventListener('change', async () => {
  const cam = activeCamera();
  if (!cam) return;
  const url = $('liveUrlInput').value.trim();
  await window.ptz.updateCamera(cam.id, { streamUrl: url });
  await refreshConfig();
  if (liveOn) startLive(); // reconnect with the new URL
  setOk(`Stream URL updated for ${cam.name}`);
});

window.ptz.onFindProgress((p) => {
  liveOverlay(`Probing common stream paths… ${p.tried}/${p.total}`);
});

$('findStreamBtn').addEventListener('click', async () => {
  const cam = activeCamera();
  if (!cam) {
    setError('Pick a camera in My cameras first, then try again.');
    return;
  }
  const btn = $('findStreamBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  liveOverlay(`Probing common stream paths on ${cam.ip}… (up to a minute)`);
  setBusy(`Searching for a working RTSP stream on ${cam.ip}…`);
  try {
    const res = await window.ptz.findStream(cam.id);
    if (res.ok) {
      await refreshConfig();
      setOk(`Found working stream: ${res.url}`);
      startLive();
    } else {
      const detail = (res.errors || []).slice(0, 3).join('\n');
      liveOverlay(`No working RTSP stream found on ${cam.ip}.\n${detail}\n\nCheck that RTSP is enabled in the camera's web interface, or enter the URL manually.`);
      setError(`No working stream found on ${cam.ip} — see the live view for what was tried.`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

// ---------------------------------------------------------------------------
// Multiview grid (all cameras at once, security-wall style)
// ---------------------------------------------------------------------------

const gridFeeds = new Map(); // camId -> { feed, tile }
let gridRunning = false;

function buildGridTiles() {
  const wall = $('gridWall');
  for (const { feed } of gridFeeds.values()) feed.stop();
  gridFeeds.clear();
  wall.innerHTML = '';

  const cams = config.cameras;
  if (cams.length === 0) {
    wall.innerHTML =
      '<div class="empty-msg"><strong>Nothing to show yet</strong>' +
      'Add cameras on the Cameras tab and they all appear here at once.</div>';
    wall.style.gridTemplateColumns = '1fr';
    wall.style.gridTemplateRows = '1fr';
    return;
  }

  cams.forEach((cam, i) => {
    const isLocal = cam.type === 'local';
    // A real <button>: keyboard-reachable, Enter/Space activate it for free,
    // and aria-pressed says which tile the controller is driving.
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute('aria-pressed', String(cam.id === config.activeCameraId));
    tile.setAttribute('aria-label', `Control ${cam.name} (camera ${i + 1})`);
    tile.title = `Click to control ${cam.name}`;

    let img;
    if (isLocal) {
      img = document.createElement('video');
      img.muted = true;
      img.playsInline = true;
    } else {
      img = document.createElement('img');
      img.alt = '';
    }

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';
    overlay.textContent = 'Off';

    const bar = document.createElement('div');
    bar.className = 'tile-bar';
    const num = document.createElement('span');
    num.className = 'tile-num';
    num.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = cam.name;
    // The controlled tile says so in words as well as in its green frame.
    const ctl = document.createElement('span');
    ctl.className = 'tile-ctl';
    ctl.textContent = 'CONTROLLING';
    const live = document.createElement('span');
    live.className = 'tile-live';
    live.textContent = 'LIVE';
    bar.append(num, name, ctl, live);

    tile.append(img, overlay, bar);
    tile.addEventListener('click', () => selectCamera(cam.id));
    wall.appendChild(tile);

    const onTileStatus = (status) => {
      if (status === null) {
        overlay.classList.add('hidden');
        tile.classList.add('streaming');
      } else {
        overlay.classList.remove('hidden');
        tile.classList.remove('streaming');
        overlay.textContent = status;
      }
    };
    const feed = isLocal
      ? new LocalFeed(cam.deviceId, img, onTileStatus, (t) => registerLocalTrack(cam.id, t))
      : new Feed(cam.id, img, onTileStatus);
    gridFeeds.set(cam.id, { feed, tile, isLocal });
  });
  layoutGridWall();
}

/**
 * Size the wall so all 16:9 tiles fit the visible area with no scrolling:
 * try every column count and keep the one that yields the largest tiles.
 */
function layoutGridWall() {
  const wall = $('gridWall');
  const n = gridFeeds.size;
  if (n === 0) return;
  const gap = 8;
  const W = wall.clientWidth;
  const H = wall.clientHeight;
  if (W <= 0 || H <= 0) return;
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = (W - gap * (cols - 1)) / cols;
    const tileH = (H - gap * (rows - 1)) / rows;
    // effective video width when letterboxed to 16:9
    const effective = Math.min(tileW, tileH * (16 / 9));
    if (effective > best.size) best = { cols, size: effective };
  }
  const rows = Math.ceil(n / best.cols);
  wall.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
  wall.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
}

window.addEventListener('resize', () => {
  if (currentTab === 'grid') layoutGridWall();
});

async function gridEnter() {
  gridRunning = true;
  stopLive(); // don't double-stream the active camera
  buildGridTiles();
  const anyVisca = [...gridFeeds.values()].some((e) => !e.isLocal);
  const missing = anyVisca ? await ffmpegMissingMessage() : null;
  if (!gridRunning) return;
  for (const { feed, tile, isLocal } of gridFeeds.values()) {
    if (missing && !isLocal) {
      // Network streams need ffmpeg; local devices still play fine.
      const ov = tile.querySelector('.tile-overlay');
      if (ov) ov.textContent = missing;
    } else {
      feed.start();
    }
  }
  setStatus(`Multiview: streaming ${gridFeeds.size} camera(s). Click a tile to control it.`);
}

function gridLeave() {
  gridRunning = false;
  uvcStopAll();
  for (const { feed } of gridFeeds.values()) feed.stop();
  gridFeeds.clear();
  $('gridWall').innerHTML = '';
}

function updateGridActive() {
  for (const [id, { tile }] of gridFeeds) {
    tile.setAttribute('aria-pressed', String(id === config.activeCameraId));
  }
}

$('gridRefreshBtn').addEventListener('click', () => {
  if (currentTab === 'grid') gridEnter();
});

// ---------------------------------------------------------------------------
// On-screen control (mouse/touch PTZ for when no controller is around)
// ---------------------------------------------------------------------------

/** Wire press-and-hold behavior: start on press, stop on release/leave. */
function holdControl(el, start, stop) {
  let held = false;
  const down = (e) => {
    e.preventDefault();
    if (held) return;
    held = true;
    el.classList.add('held');
    start();
  };
  const up = () => {
    if (!held) return;
    held = false;
    el.classList.remove('held');
    stop();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
  // Releasing outside the button must still stop motion.
  window.addEventListener('pointerup', up);
}

function oscSpeeds() {
  const s = config.settings;
  const mult = s.speedMultiplier ?? 1;
  return {
    pan: Math.max(1, Math.round((s.maxPanSpeed ?? 24) * (s.panSensitivity ?? 1) * mult)),
    tilt: Math.max(1, Math.round((s.maxTiltSpeed ?? 20) * (s.tiltSensitivity ?? 1) * mult)),
    zoom: Math.max(1, Math.round((s.maxZoomSpeed ?? 7) * (s.zoomSensitivity ?? 1) * mult)),
  };
}

function initOnScreenControls() {
  // 8-way pan/tilt pad
  for (const btn of document.querySelectorAll('.osc-btn[data-pan]')) {
    const dirPan = Number(btn.dataset.pan);
    const dirTilt = Number(btn.dataset.tilt);
    holdControl(
      btn,
      () => {
        const cam = activeCamera();
        if (!cam) return;
        const sp = oscSpeeds();
        ctlPanTilt(cam, dirPan * sp.pan, dirTilt * sp.tilt);
      },
      () => {
        const cam = activeCamera();
        if (cam) ctlPanTilt(cam, 0, 0);
      }
    );
  }

  $('oscHomeBtn').addEventListener('click', () => {
    const cam = activeCamera();
    if (cam) {
      ctlHome(cam);
      setStatus(`${cam.name}: home`);
    }
  });

  const holdCam = (el, startFn, stopFn) =>
    holdControl(
      el,
      () => { const cam = activeCamera(); if (cam) startFn(cam); },
      () => { const cam = activeCamera(); if (cam) stopFn(cam); }
    );

  holdCam($('oscZoomIn'), (c) => ctlZoom(c, oscSpeeds().zoom), (c) => ctlZoom(c, 0));
  holdCam($('oscZoomOut'), (c) => ctlZoom(c, -oscSpeeds().zoom), (c) => ctlZoom(c, 0));
  holdCam($('oscFocusFar'), (c) => ctlFocus(c, 5), (c) => ctlFocus(c, 0));
  holdCam($('oscFocusNear'), (c) => ctlFocus(c, -5), (c) => ctlFocus(c, 0));

  $('oscFocusAuto').addEventListener('click', () => {
    const cam = activeCamera();
    if (cam) {
      ctlFocusAuto(cam);
      setStatus(`${cam.name}: auto focus`);
    }
  });

  // Speed slider mirrors the global speed multiplier.
  $('oscSpeed').addEventListener('input', async () => {
    const v = Number($('oscSpeed').value);
    config.settings.speedMultiplier = v;
    engine.settings = config.settings;
    $('speedMultiplier').value = String(v);
    $('speedMultVal').textContent = `${Math.round(v * 100)}%`;
    updateSpeedPill();
    await window.ptz.setSettings({ speedMultiplier: v });
  });

  // Presets 1–8 with recall / save-mode toggle
  const wrap = $('oscPresets');
  for (let n = 1; n <= 8; n++) {
    const b = document.createElement('button');
    b.textContent = String(n);
    b.title = `Preset ${n}`;
    b.dataset.preset = String(n);
    b.setAttribute('aria-label', `Recall preset ${n}`);
    b.addEventListener('click', async () => {
      const cam = activeCamera();
      if (!cam) {
        setError('Pick a camera in My cameras first, then try again.');
        return;
      }
      if ($('presetSaveMode').checked) {
        const ok = await ctlPresetSave(cam, n);
        setSaveMode(false);
        if (ok) setOk(`${cam.name}: saved the current position as preset ${n}`);
      } else {
        if (await ctlPresetRecall(cam, n)) setOk(`${cam.name}: recalled preset ${n}`);
      }
    });
    wrap.appendChild(b);
  }
  $('presetSaveMode').addEventListener('change', () => {
    setSaveMode($('presetSaveMode').checked);
  });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const discovered = new Map();

function renderDiscovered() {
  const list = $('discoveredList');
  list.innerHTML = '';
  for (const dev of discovered.values()) {
    const known = config.cameras.some((c) => c.ip === dev.ip);
    const item = document.createElement('div');
    item.className = 'camera-item static-item';

    const name = document.createElement('div');
    name.className = 'cam-name';
    name.textContent = dev.name || 'Camera';

    const isIpDev = dev.type === 'ip';
    const addr = document.createElement('div');
    addr.className = 'cam-addr';
    addr.textContent = isIpDev
      ? `${dev.ip} · video stream`
      : `${dev.ip}${dev.port ? ':' + dev.port : ''} · ${PROTO_LABELS[dev.protocol] || dev.source || ''}`;

    const actions = document.createElement('div');
    actions.className = 'cam-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = known ? 'Already added' : 'Add';
    addBtn.setAttribute('aria-label', `${known ? 'Already added: ' : 'Add '}${dev.name || dev.ip}`);
    addBtn.disabled = known;
    addBtn.addEventListener('click', async () => {
      if (isIpDev) {
        await window.ptz.addCamera({
          type: 'ip',
          name: dev.name || dev.ip,
          ip: dev.ip,
          streamUrl: dev.streamUrl || `rtsp://${dev.ip}:554/1`,
        });
      } else {
        await window.ptz.addCamera({
          name: dev.name || dev.ip,
          ip: dev.ip,
          port: dev.port || 1259,
          protocol: dev.protocol || 'udp',
        });
      }
      await refreshConfig();
      renderDiscovered();
      setOk(`Added ${dev.name || dev.ip} — it's now in My cameras.`);
    });
    actions.appendChild(addBtn);
    const row = document.createElement('div');
    row.className = 'cam-row';
    row.append(name, addr, actions);
    item.appendChild(row);
    list.appendChild(item);
  }
}

window.ptz.onDiscoveryProgress((evt) => {
  if (evt.type === 'found' && !discovered.has(evt.ip)) {
    discovered.set(evt.ip, evt);
    $('discoverStatus').textContent = `Scanning… found ${discovered.size} device(s)`;
    renderDiscovered();
  }
});

$('discoverBtn').addEventListener('click', async () => {
  const btn = $('discoverBtn');
  // The button says what it is doing rather than just greying out, so the
  // scan never looks like a dead click.
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  discovered.clear();
  renderDiscovered();
  $('discoverStatus').textContent = 'Scanning local network (about 6 seconds)…';
  setBusy('Scanning the local network for cameras…');
  try {
    const [res] = await Promise.all([window.ptz.discover(), refreshLocalDevices()]);
    for (const dev of res.found || []) discovered.set(dev.ip, dev);
    renderDiscovered();
    if (discovered.size > 0) {
      $('discoverStatus').textContent =
        `Scan complete — ${discovered.size} network device(s) found. Click Add on the ones you want.`;
      setOk(`Scan complete — ${discovered.size} device(s) found.`);
    } else {
      $('discoverStatus').textContent =
        'Scan complete — no network cameras answered. Check the camera is powered on and on ' +
        'this same network/subnet, then scan again or add it by IP address below.';
      setStatus('Scan complete — no network cameras found.');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan network';
  }
});

// ------------------------- local devices (USB / capture) -------------------------

async function listLocalDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let devs = await navigator.mediaDevices.enumerateDevices();
  let vids = devs.filter((d) => d.kind === 'videoinput');
  // Labels can be empty until a capture has been granted once; open a
  // throwaway stream to unlock them.
  if (vids.length > 0 && vids.every((d) => !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      for (const t of s.getTracks()) t.stop();
      devs = await navigator.mediaDevices.enumerateDevices();
      vids = devs.filter((d) => d.kind === 'videoinput');
    } catch { /* no device or denied; show what we have */ }
  }
  return vids;
}

async function refreshLocalDevices() {
  const list = $('localList');
  let vids = [];
  try {
    vids = await listLocalDevices();
  } catch { /* ignore */ }
  list.innerHTML = '';
  if (vids.length === 0) {
    list.innerHTML =
      '<div class="empty-msg"><strong>Nothing plugged in</strong>' +
      'No USB cameras or capture cards detected. Plug one in — the list updates by itself.</div>';
    return;
  }
  for (const dev of vids) {
    const known = config.cameras.some((c) => c.type === 'local' && c.deviceId === dev.deviceId);
    const item = document.createElement('div');
    item.className = 'camera-item static-item';

    const name = document.createElement('div');
    name.className = 'cam-name';
    name.textContent = dev.label || 'Video device';

    const addr = document.createElement('div');
    addr.className = 'cam-addr';
    addr.textContent = 'USB / capture device';

    const actions = document.createElement('div');
    actions.className = 'cam-actions';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = known ? 'Already added' : 'Add';
    addBtn.setAttribute('aria-label',
      `${known ? 'Already added: ' : 'Add '}${dev.label || 'video device'}`);
    addBtn.disabled = known;
    addBtn.addEventListener('click', async () => {
      await window.ptz.addCamera({
        type: 'local',
        name: dev.label || 'Local camera',
        deviceId: dev.deviceId,
      });
      await refreshConfig();
      await refreshLocalDevices();
      setOk(`Added ${dev.label || 'local camera'} — it's now in My cameras.`);
    });
    actions.appendChild(addBtn);
    const row = document.createElement('div');
    row.className = 'cam-row';
    row.append(name, addr, actions);
    item.appendChild(row);
    list.appendChild(item);
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  // Re-list when devices are plugged/unplugged.
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshLocalDevices().catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Mapping UI
// ---------------------------------------------------------------------------

const AXIS_ACTIONS = [
  ['pan', 'Pan (left/right)'],
  ['tilt', 'Tilt (up/down)'],
  ['zoom', 'Zoom (stick axis, optional)'],
  ['focus', 'Focus (stick axis, optional)'],
];

const BUTTON_GROUPS = [
  ['Zoom & focus', [
    ['zoomIn', 'Zoom in (analog trigger ok)'],
    ['zoomOut', 'Zoom out (analog trigger ok)'],
    ['focusAuto', 'Auto focus'],
    ['focusNear', 'Focus near'],
    ['focusFar', 'Focus far'],
  ]],
  ['Cameras', [
    ['cameraPrev', 'Previous camera'],
    ['cameraNext', 'Next camera'],
    ['camera1', 'Select camera 1'],
    ['camera2', 'Select camera 2'],
    ['camera3', 'Select camera 3'],
    ['camera4', 'Select camera 4'],
    ['camera5', 'Select camera 5'],
    ['camera6', 'Select camera 6'],
    ['camera7', 'Select camera 7'],
    ['camera8', 'Select camera 8'],
  ]],
  ['Presets', [
    ['presetShift', 'Preset shift (hold to save)'],
    ['presetSaveMode', 'Preset save mode (press to arm save)'],
    ['preset1', 'Preset 1'],
    ['preset2', 'Preset 2'],
    ['preset3', 'Preset 3'],
    ['preset4', 'Preset 4'],
    ['preset5', 'Preset 5'],
    ['preset6', 'Preset 6'],
    ['preset7', 'Preset 7'],
    ['preset8', 'Preset 8'],
  ]],
  ['Misc', [
    ['home', 'Home position'],
    ['precision', 'Precision (hold for fine control)'],
    ['speedUp', 'Speed up'],
    ['speedDown', 'Speed down'],
    ['menu', 'Camera OSD menu'],
    ['trackCancel', 'Stop AI subject tracking'],
  ]],
];

// key -> human label, for status messages about bindings moved off other actions
const ACTION_LABELS = {};
for (const [key, label] of AXIS_ACTIONS) ACTION_LABELS[key] = label;
for (const [, actions] of BUTTON_GROUPS) {
  for (const [key, label] of actions) ACTION_LABELS[key] = label;
}

/**
 * Persist the current mapping and hand the engine the stored copy. The engine
 * polls from `engine.mapping` — if it is ever left pointing at a stale object
 * (the old bug: "Reset to defaults" swapped `config.mapping` without
 * re-pointing the engine), every rebind after that looks bound in the UI and
 * saves to disk but the controller silently keeps the old bindings.
 */
async function persistMapping() {
  config.mapping = await window.ptz.setMapping(config.mapping);
  engine.mapping = config.mapping;
}

let listeningRow = null;

function makeMapRow(kind, key, label) {
  const row = document.createElement('div');
  row.className = 'map-row';

  const action = document.createElement('div');
  action.className = 'map-action';
  action.textContent = label;

  const binding = document.createElement('div');
  binding.className = 'map-binding';
  const val = kind === 'axis' ? config.mapping.axes[key] : config.mapping.buttons[key];
  binding.textContent = kind === 'axis' ? gpAxisName(val) : gpButtonName(val);
  if (val == null) binding.classList.add('unset');

  // 30-odd rows all read "Rebind"/"Clear", so the visible word is not a
  // usable name on its own — each one names the action it belongs to.
  const rebind = document.createElement('button');
  rebind.className = 'btn btn-sm';
  rebind.textContent = 'Rebind';
  rebind.setAttribute('aria-label', `Rebind ${label}`);
  rebind.addEventListener('click', () => {
    if (listeningRow) {
      listeningRow.classList.remove('listening');
      engine.cancelCapture();
    }
    listeningRow = row;
    row.classList.add('listening');
    binding.textContent = 'press input…';
    setBusy(`Press a ${kind === 'axis' ? 'stick axis' : 'button'} to bind "${label}" (Esc to cancel)`);
    engine.captureNext(async (input) => {
      row.classList.remove('listening');
      listeningRow = null;
      if (kind === 'axis' && input.kind !== 'axis') {
        setError(`"${label}" needs a stick axis, but that was a button. Binding unchanged — try moving a stick.`);
        renderMapping();
        return;
      }
      if (kind === 'button' && input.kind !== 'button') {
        setError(`"${label}" needs a button, but that was a stick axis. Binding unchanged — try pressing a button.`);
        renderMapping();
        return;
      }
      const displaced = gpClaimBinding(config.mapping, kind, key, input.index);
      await persistMapping();
      renderMapping();
      const inputName = input.kind === 'axis' ? gpAxisName(input.index) : gpButtonName(input.index);
      const movedNote = displaced.length
        ? ` — moved off ${displaced.map((k) => `"${ACTION_LABELS[k] || k}"`).join(', ')}`
        : '';
      setOk(`Bound "${label}" to ${inputName}${movedNote}`);
    });
  });

  const clear = document.createElement('button');
  clear.className = 'btn btn-sm';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', `Clear the binding for ${label}`);
  clear.disabled = val == null;
  clear.addEventListener('click', async () => {
    if (kind === 'axis') config.mapping.axes[key] = null;
    else config.mapping.buttons[key] = null;
    await persistMapping();
    renderMapping();
    setStatus(`Cleared the binding for "${label}"`);
  });

  row.append(action, binding, rebind, clear);
  return row;
}

function renderMapping() {
  const list = $('mappingList');
  list.innerHTML = '';
  const axesHead = document.createElement('div');
  axesHead.className = 'map-group';
  axesHead.textContent = 'Axes';
  list.appendChild(axesHead);
  for (const [key, label] of AXIS_ACTIONS) list.appendChild(makeMapRow('axis', key, label));
  for (const [group, actions] of BUTTON_GROUPS) {
    const head = document.createElement('div');
    head.className = 'map-group';
    head.textContent = group;
    list.appendChild(head);
    for (const [key, label] of actions) list.appendChild(makeMapRow('button', key, label));
  }
}

// Resetting throws away every custom binding, so it asks first.
{
  const resetBtn = $('resetMappingBtn');
  resetBtn.addEventListener('click', () => {
    confirmInline(resetBtn, 'Discard all custom bindings?', 'Reset', async () => {
      config.mapping = await window.ptz.resetMapping();
      // Re-point the engine at the new mapping object. Without this the engine
      // keeps polling the pre-reset object forever: the reset doesn't take, and
      // every rebind after it edits an object the engine never reads.
      engine.mapping = config.mapping;
      renderMapping();
      setOk('Mapping reset to Xbox defaults');
    });
  });
}

// Esc unwinds whatever is armed; Esc twice in quick succession is the
// keyboard equivalent of STOP ALL, so a runaway camera can be stopped
// without reaching for the mouse.
let lastEscAt = 0;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (listeningRow) {
    listeningRow.classList.remove('listening');
    listeningRow = null;
    engine.cancelCapture();
    renderMapping();
    setStatus('Rebind cancelled');
    lastEscAt = 0;
    return;
  }
  if (tracker.isBusy()) {
    tracker.cancel('Tracking cancelled.');
    lastEscAt = 0;
    return;
  }
  const now = performance.now();
  if (now - lastEscAt < 600) {
    lastEscAt = 0;
    $('stopAllBtn').click();
  } else {
    lastEscAt = now;
  }
});

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

const pctFmt = (v) => `${Math.round(v * 100)}%`;

const SETTING_SLIDERS = [
  ['deadzone', 'deadzoneVal', pctFmt],
  ['speedMultiplier', 'speedMultVal', pctFmt],
  ['speedCurve', 'curveVal', (v) => `${v.toFixed(1)}`],
  ['panSensitivity', 'panSensVal', pctFmt],
  ['tiltSensitivity', 'tiltSensVal', pctFmt],
  ['zoomSensitivity', 'zoomSensVal', pctFmt],
  ['rampTime', 'rampTimeVal', (v) => (v === 0 ? 'Off (instant)' : `${v.toFixed(2)} s`)],
  ['precisionScale', 'precisionScaleVal', pctFmt],
  ['maxPanSpeed', 'maxPanVal', (v) => `${v}`],
  ['maxTiltSpeed', 'maxTiltVal', (v) => `${v}`],
  ['maxZoomSpeed', 'maxZoomVal', (v) => `${v}`],
  ['presetHoldMs', 'presetHoldVal', (v) => `${(v / 1000).toFixed(1)} s`],
  ['trackSpeed', 'trackSpeedVal', pctFmt],
  ['trackResponse', 'trackResponseVal', (v) => `${v.toFixed(1)}×`],
  ['trackDeadband', 'trackDeadbandVal', pctFmt],
];

const SETTING_CHECKS = ['invertPan', 'invertTilt', 'presetHoldToSave', 'trackInvertPan', 'trackInvertTilt'];

/**
 * Keep the readable value and the announced value in step. Without
 * aria-valuetext a slider reads out its raw number ("0.15") while the chip
 * next to it says "15%".
 */
function setSliderValue(key, valId, fmt, v) {
  const text = fmt(v);
  $(valId).textContent = text;
  $(key).setAttribute('aria-valuetext', text);
}

function renderSettings() {
  for (const [key, valId, fmt] of SETTING_SLIDERS) {
    $(key).value = String(config.settings[key]);
    setSliderValue(key, valId, fmt, Number(config.settings[key]));
  }
  $('invertPan').checked = !!config.settings.invertPan;
  $('invertTilt').checked = !!config.settings.invertTilt;
  $('presetHoldToSave').checked = config.settings.presetHoldToSave !== false;
  $('trackInvertPan').checked = !!config.settings.trackInvertPan;
  $('trackInvertTilt').checked = !!config.settings.trackInvertTilt;
  updateSpeedPill();
}

function updateSpeedPill() {
  $('speedPill').textContent = `Speed ${Math.round(config.settings.speedMultiplier * 100)}%`;
  $('oscSpeed').value = String(config.settings.speedMultiplier);
}

for (const [key, valId, fmt] of SETTING_SLIDERS) {
  $(key).addEventListener('input', async () => {
    const v = Number($(key).value);
    config.settings[key] = v;
    setSliderValue(key, valId, fmt, v);
    engine.settings = config.settings;
    updateSpeedPill();
    await window.ptz.setSettings({ [key]: v });
  });
}
for (const key of SETTING_CHECKS) {
  $(key).addEventListener('change', async () => {
    config.settings[key] = $(key).checked;
    engine.settings = config.settings;
    await window.ptz.setSettings({ [key]: $(key).checked });
  });
}

// ---------------------------------------------------------------------------
// Live input visualization
// ---------------------------------------------------------------------------

const BTN_COUNT = 17;
const lights = [];
{
  const wrap = $('buttonLights');
  for (let i = 0; i < BTN_COUNT; i++) {
    const el = document.createElement('span');
    el.className = 'bl';
    el.textContent = gpButtonName(i);
    wrap.appendChild(el);
    lights.push(el);
  }
}

function renderFrame(pad) {
  const stickL = $('stickL');
  const stickR = $('stickR');
  if (!pad) {
    stickL.style.left = stickR.style.left = '50%';
    stickL.style.top = stickR.style.top = '50%';
    $('barLT').style.width = $('barRT').style.width = '0%';
    lights.forEach((el) => el.classList.remove('on'));
    return;
  }
  // Percentage-based so the stick pads can scale with the window.
  const place = (el, x, y) => {
    el.style.left = `${50 + x * 38}%`;
    el.style.top = `${50 + y * 38}%`;
  };
  place(stickL, pad.axes[0] || 0, pad.axes[1] || 0);
  place(stickR, pad.axes[2] || 0, pad.axes[3] || 0);
  $('barLT').style.width = `${Math.round((pad.buttons[6]?.value || 0) * 100)}%`;
  $('barRT').style.width = `${Math.round((pad.buttons[7]?.value || 0) * 100)}%`;
  for (let i = 0; i < lights.length; i++) {
    lights[i].classList.toggle('on', !!pad.buttons[i]?.pressed);
  }
}

// ---------------------------------------------------------------------------
// Gamepad engine wiring
// ---------------------------------------------------------------------------

function shortPadName(id) {
  return (id || 'Controller').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Controller';
}

function renderGamepadList(devices) {
  const sel = $('gamepadSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = devices.length
    ? `Auto (first connected)`
    : 'Auto — no controller detected';
  sel.appendChild(auto);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = String(d.index);
    opt.textContent = `#${d.index + 1} · ${shortPadName(d.id)}`;
    sel.appendChild(opt);
  }
  // keep the user's selection if that device is still present
  if (prev && devices.some((d) => String(d.index) === prev)) sel.value = prev;
}

$('gamepadSelect').addEventListener('change', () => {
  const v = $('gamepadSelect').value;
  engine.selectGamepad(v === '' ? null : Number(v));
  setStatus(v === '' ? 'Controller: auto-select' : 'Controller device pinned');
});

engine.callbacks = {
  onDevices: renderGamepadList,
  onStatus(st) {
    const pill = $('gamepadStatus');
    if (st.connected) {
      const shortId = st.id.replace(/\(.*\)/, '').trim().slice(0, 30) || 'Controller';
      pill.textContent = shortId;
      pill.className = 'pill pill-on';
    } else {
      pill.textContent = 'No controller';
      pill.className = 'pill pill-off';
    }
  },
  onFrame: renderFrame,
  onPanTilt(pan, tilt) {
    const cam = activeCamera();
    if (cam) ctlPanTilt(cam, pan, tilt);
  },
  onZoom(speed) {
    const cam = activeCamera();
    if (cam) ctlZoom(cam, speed);
  },
  onFocus(speed) {
    const cam = activeCamera();
    if (cam) ctlFocus(cam, speed);
  },
  onAction(name, arg) {
    const cam = activeCamera();
    switch (name) {
      case 'cameraNext': stepCamera(1); break;
      case 'cameraPrev': stepCamera(-1); break;
      case 'cameraSelect': {
        const target = config.cameras[arg - 1];
        if (target) selectCamera(target.id);
        break;
      }
      case 'home':
        if (cam) { ctlHome(cam); setStatus(`${cam.name}: home`); }
        break;
      case 'focusAuto':
        if (cam) { ctlFocusAuto(cam); setStatus(`${cam.name}: auto focus`); }
        break;
      case 'menu':
        if (cam && cam.type !== 'local') window.ptz.menu(cam.id);
        break;
      case 'trackCancel':
        if (tracker.isBusy()) tracker.cancel('Tracking stopped (controller).');
        break;
      case 'presetSaveModeToggle': {
        setSaveMode(!engine.saveMode);
        engine.pulse(90, 0.5, 0.3); // light tick to confirm the mode flip
        setStatus(engine.saveMode
          ? 'Save mode ON — press a preset button to STORE the current position'
          : 'Save mode off — presets recall');
        break;
      }
      case 'presetRecall':
        if (cam) { ctlPresetRecall(cam, arg).then((ok) => { if (ok) setOk(`${cam.name}: recalled preset ${arg}`); }); }
        break;
      case 'presetSave':
        if (cam) {
          // If the save was armed via save mode, it's one-shot — clear it now.
          if (engine.saveMode) setSaveMode(false);
          ctlPresetSave(cam, arg).then((ok) => {
            if (ok) {
              setOk(`${cam.name}: saved preset ${arg}`);
              engine.pulse(); // felt confirmation, no need to look at the screen
            }
          });
        }
        break;
      case 'speedUp':
      case 'speedDown': {
        const delta = name === 'speedUp' ? 0.05 : -0.05;
        const v = Math.min(1, Math.max(0.05, Math.round((config.settings.speedMultiplier + delta) * 20) / 20));
        config.settings.speedMultiplier = v;
        engine.settings = config.settings;
        $('speedMultiplier').value = String(v);
        $('speedMultVal').textContent = `${Math.round(v * 100)}%`;
        updateSpeedPill();
        window.ptz.setSettings({ speedMultiplier: v });
        setStatus(`Speed ${Math.round(v * 100)}%`);
        break;
      }
    }
  },
};

$('stopAllBtn').addEventListener('click', () => {
  ctlStopAll();
  setOk('STOP sent to every camera — all motion halted.');
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function refreshConfig() {
  config = await window.ptz.getConfig();
  engine.mapping = config.mapping;
  engine.settings = config.settings;
  renderCameras();
  autoTestCameras();
  updateLiveCard();
  if (gridRunning && currentTab === 'grid') gridEnter(); // camera set may have changed
}

(async () => {
  await refreshConfig();
  renderMapping();
  renderSettings();
  initOnScreenControls();
  // Feed the engine controller snapshots read in the main process (XInput).
  // These keep coming even when the app window is unfocused, so the controller
  // keeps driving cameras after you click into another app. Falls back to the
  // Web Gamepad API automatically when no native controller is present.
  window.ptz.onNativeGamepad((pad) => engine.setNativePad(pad));
  engine.start();
  renderGamepadList(engine.listGamepads());
  refreshLocalDevices().catch(() => {});
  setStatus('Ready. Connect an Xbox controller and press any button to activate it — or use the on-screen controls.');
})();
