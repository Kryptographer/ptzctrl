'use strict';

/**
 * Tiny JSON config store persisted in the Electron userData directory.
 * Holds the camera list, controller mapping, and general settings.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  cameras: [],
  activeCameraId: null,
  settings: {
    theme: 'dark',
    defaultCameraId: null, // null = remember the last selected camera
    deadzone: 0.15,
    speedMultiplier: 1.0,
    invertPan: false,
    invertTilt: false,
    maxPanSpeed: 24,
    maxTiltSpeed: 20,
    maxZoomSpeed: 7,
    speedCurve: 2.0, // exponent applied to stick deflection for fine control
    // Per-axis sensitivity scalers (0.1–1). Applied on top of the max speeds
    // so each movement can be tamed independently without losing the others.
    panSensitivity: 1.0,
    tiltSensitivity: 1.0,
    zoomSensitivity: 1.0,
    // Motion smoothing: seconds to ramp 0 → full speed (0 = instant). Slowing
    // down / stopping always runs 3× faster so releases still stop promptly.
    rampTime: 0.2,
    // How much precision mode (hold LS by default) scales speeds down.
    precisionScale: 0.25,
    // AI subject tracking (draw a box in Live view, camera follows).
    trackSpeed: 0.5,     // top speed while tracking, as a fraction of camera max
    trackResponse: 1.5,  // how aggressively off-centre error maps to speed
    trackDeadband: 0.08, // no movement while the subject is this close to centre
    // Flip the tracker's drive direction for mirrored / flipped camera images
    // (independent of the stick invert settings, which are operator feel).
    trackInvertPan: false,
    trackInvertTilt: false,
    // Preset saving from the controller without a two-button chord: tap a
    // preset button to recall, hold it to save. Designed for the Xbox
    // Adaptive Controller / adaptive joystick, where holding a "shift" button
    // and pressing a preset at the same time is hard or impossible.
    presetHoldToSave: true,
    presetHoldMs: 800, // how long to hold a preset button before it saves
  },
  // Controller mapping. Axes are gamepad axis indexes, buttons are gamepad
  // button indexes (standard mapping: triggers are buttons 6/7 with analog
  // values). Any action can be set to null (unassigned).
  mapping: {
    axes: {
      pan: 0,          // left stick X
      tilt: 1,         // left stick Y
      zoom: null,      // optionally a stick axis (e.g. 3 = right stick Y)
      focus: null,
    },
    buttons: {
      zoomIn: 7,       // RT (analog)
      zoomOut: 6,      // LT (analog)
      cameraPrev: 4,   // LB
      cameraNext: 5,   // RB
      focusAuto: 0,    // A
      home: 1,         // B
      presetShift: 2,  // X (hold + preset button = save preset)
      presetSaveMode: null, // press once to arm "save the next preset" (latch)
      focusNear: null,
      focusFar: null,
      speedDown: 8,    // Back / View
      speedUp: 9,      // Start / Menu
      precision: 10,   // LS click (hold for fine control)
      menu: null,
      trackCancel: null, // stop AI subject tracking from the controller
      preset1: 12,     // D-pad up
      preset2: 13,     // D-pad down
      preset3: 14,     // D-pad left
      preset4: 15,     // D-pad right
      preset5: null,
      preset6: null,
      preset7: null,
      preset8: null,
      camera1: null,
      camera2: null,
      camera3: null,
      camera4: null,
      camera5: null,
      camera6: null,
      camera7: null,
      camera8: null,
    },
  },
};

const SETTINGS_RANGES = {
  deadzone: [0, 0.5, 0.01],
  speedMultiplier: [0.05, 1, 0.05],
  maxPanSpeed: [1, 24, 1],
  maxTiltSpeed: [1, 20, 1],
  maxZoomSpeed: [1, 7, 1],
  speedCurve: [1, 4, 0.1],
  panSensitivity: [0.1, 1, 0.05],
  tiltSensitivity: [0.1, 1, 0.05],
  zoomSensitivity: [0.1, 1, 0.05],
  rampTime: [0, 1.5, 0.05],
  precisionScale: [0.05, 0.5, 0.05],
  trackSpeed: [0.1, 1, 0.05],
  trackResponse: [0.5, 3, 0.1],
  trackDeadband: [0.02, 0.25, 0.01],
  presetHoldMs: [400, 2000, 100],
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validBinding = (value) => value === null || (Number.isInteger(value) && value >= 0);

function validSetting(key, value, cameras) {
  if (key === 'theme') return value === 'dark' || value === 'light';
  if (key === 'defaultCameraId') {
    return value === null || cameras.some((c) => c.id === value && c.type !== 'ip');
  }
  if (SETTINGS_RANGES[key]) {
    const [min, max, step] = SETTINGS_RANGES[key];
    const steps = (value - min) / step;
    return Number.isFinite(value) && value >= min && value <= max &&
      Math.abs(steps - Math.round(steps)) < 1e-8;
  }
  return typeof DEFAULTS.settings[key] === 'boolean' && typeof value === 'boolean';
}

class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'ptzctrl-config.json');
    this.warnings = [];
    this.data = this._load();
  }

  _load() {
    let loaded = {};
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Could not read configuration (${err.code}). Check file permissions.`, { cause: err });
      }
    }
    const warn = (message) => this.warnings.push(message);
    if (text !== undefined) {
      try {
        loaded = JSON.parse(text);
        if (!isRecord(loaded)) throw new TypeError('Configuration must be an object');
      } catch {
        warn('The configuration file was invalid. Default settings have been restored.');
        loaded = {};
      }
    }
    // Deep-merge defaults so new keys appear after upgrades.
    const cameras = [];
    if (loaded.cameras !== undefined && !Array.isArray(loaded.cameras)) {
      warn('The saved camera list was invalid.');
    }
    for (const cam of Array.isArray(loaded.cameras) ? loaded.cameras : []) {
      if (!isRecord(cam) || typeof cam.id !== 'string' || !cam.id ||
          cameras.some((c) => c.id === cam.id)) {
        warn('An invalid or duplicate camera entry was skipped.');
        continue;
      }
      cameras.push(cam);
    }
    for (const cam of cameras) {
      if (!cam.type) cam.type = cam.deviceId ? 'local' : 'visca';
      if (cam.type === 'local' && !cam.presets) cam.presets = {};
      if (cam.type === 'visca' && !cam.streamUrl && cam.ip) cam.streamUrl = `rtsp://${cam.ip}:554/1`;
    }
    if (loaded.settings !== undefined && !isRecord(loaded.settings)) {
      warn('The saved settings were invalid. Default settings have been restored.');
    }
    const settings = { ...DEFAULTS.settings, ...(isRecord(loaded.settings) ? loaded.settings : {}) };
    for (const key of Object.keys(DEFAULTS.settings)) {
      if (!validSetting(key, settings[key], cameras)) {
        settings[key] = DEFAULTS.settings[key];
        warn(`Invalid setting "${key}" was restored to its default.`);
      }
    }
    const mapping = {};
    if (loaded.mapping !== undefined && !isRecord(loaded.mapping)) warn('The saved controller mapping was invalid.');
    for (const group of ['axes', 'buttons']) {
      const saved = loaded.mapping?.[group];
      if (saved !== undefined && !isRecord(saved)) warn(`The saved ${group} mapping was invalid.`);
      mapping[group] = { ...DEFAULTS.mapping[group], ...(isRecord(saved) ? saved : {}) };
      for (const key of Object.keys(mapping[group])) {
        if (!validBinding(mapping[group][key])) {
          mapping[group][key] = DEFAULTS.mapping[group][key] ?? null;
          warn(`Invalid ${group} binding "${key}" was restored to its default.`);
        }
      }
    }
    if (this.warnings.length && text !== undefined) {
      // Preserve the original, including camera details, before a later save
      // replaces recovered data. Never log the file contents.
      const backup = `${this.file}.recovery-${crypto.randomUUID()}`;
      fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
      warn(`The original configuration is backed up as ${path.basename(backup)} in the app data folder.`);
      console.warn('Configuration recovery:', this.warnings.join(' '));
    }
    const activeCameraId = settings.defaultCameraId ||
      (cameras.some((c) => c.id === loaded.activeCameraId) ? loaded.activeCameraId :
        (cameras.find((c) => c.type !== 'ip') || cameras[0])?.id || null);
    return {
      cameras,
      activeCameraId,
      settings,
      mapping,
    };
  }

  save(data = this.data) {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    let created = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } catch (err) {
      if (created) {
        try { fs.unlinkSync(temporary); }
        catch (cleanupError) { console.error('Could not remove temporary config:', cleanupError.code); }
      }
      console.error('Failed to save config:', err.code);
      throw new Error(`Could not save configuration (${err.code}). Check free disk space and file permissions.`, { cause: err });
    }
    this.data = data;
  }

  getAll() {
    return { ...this.data, warnings: [...this.warnings] };
  }

  addCamera({ type, name, ip, port, protocol, streamUrl, deviceId }) {
    let cam;
    if (type === 'local') {
      cam = {
        id: crypto.randomUUID(),
        type: 'local',
        name: name || 'Local camera',
        deviceId,
        presets: {},
      };
    } else if (type === 'ip') {
      // Video-only IP camera: NVR channel, Yi, Android phone app, any
      // RTSP/MJPEG source. No PTZ control channel.
      cam = {
        id: crypto.randomUUID(),
        type: 'ip',
        name: name || 'IP camera',
        ip: ip || null,
        streamUrl,
      };
    } else {
      cam = {
        id: crypto.randomUUID(),
        type: 'visca',
        name: name || ip,
        ip,
        port: Number(port) || 1259,
        protocol: protocol || 'udp',
        streamUrl: streamUrl || `rtsp://${ip}:554/1`,
      };
    }
    this.save({
      ...this.data,
      cameras: [...this.data.cameras, cam],
      activeCameraId: this.data.activeCameraId || cam.id,
    });
    return cam;
  }

  updateCamera(id, patch) {
    const existing = this.data.cameras.find((c) => c.id === id);
    if (!existing) return null;
    const cam = { ...existing };
    if (patch.name !== undefined) cam.name = patch.name;
    if (patch.ip !== undefined) cam.ip = patch.ip;
    if (patch.port !== undefined) cam.port = Number(patch.port);
    if (patch.protocol !== undefined) cam.protocol = patch.protocol;
    if (patch.streamUrl !== undefined) cam.streamUrl = patch.streamUrl;
    if (patch.presets !== undefined) cam.presets = patch.presets;
    if (patch.deviceId !== undefined) cam.deviceId = patch.deviceId;
    this.save({ ...this.data, cameras: this.data.cameras.map((c) => c.id === id ? cam : c) });
    return cam;
  }

  removeCamera(id) {
    const cameras = this.data.cameras.filter((c) => c.id !== id);
    const settings = { ...this.data.settings };
    if (settings.defaultCameraId === id) settings.defaultCameraId = null;
    let activeCameraId = this.data.activeCameraId;
    if (activeCameraId === id) {
      activeCameraId = settings.defaultCameraId ||
        (cameras.find((c) => c.type !== 'ip') || cameras[0])?.id || null;
    }
    this.save({ ...this.data, cameras, settings, activeCameraId });
  }

  setActiveCamera(id) {
    if (id === null || this.data.cameras.some((c) => c.id === id)) {
      this.save({ ...this.data, activeCameraId: id });
    }
    return this.data.activeCameraId;
  }

  setMapping(mapping) {
    if (!isRecord(mapping)) throw new Error('Controller mapping must be an object.');
    for (const group of ['axes', 'buttons']) {
      if (mapping[group] !== undefined && (!isRecord(mapping[group]) ||
          !Object.values(mapping[group]).every(validBinding))) {
        throw new Error(`Invalid controller ${group} mapping.`);
      }
    }
    const next = {
      axes: { ...DEFAULTS.mapping.axes, ...(mapping.axes || {}) },
      buttons: { ...DEFAULTS.mapping.buttons, ...(mapping.buttons || {}) },
    };
    this.save({ ...this.data, mapping: next });
    return this.data.mapping;
  }

  resetMapping() {
    this.save({ ...this.data, mapping: JSON.parse(JSON.stringify(DEFAULTS.mapping)) });
    return this.data.mapping;
  }

  setSettings(settings) {
    if (!isRecord(settings)) throw new Error('Settings must be an object.');
    for (const [key, value] of Object.entries(settings)) {
      if (!Object.hasOwn(DEFAULTS.settings, key) || !validSetting(key, value, this.data.cameras)) {
        throw new Error(key === 'defaultCameraId'
          ? 'Default camera must be a controllable camera or "Remember last selected camera".'
          : `Invalid setting "${key}".`);
      }
    }
    this.save({ ...this.data, settings: { ...this.data.settings, ...settings } });
    return this.data.settings;
  }
}

module.exports = { Store, DEFAULTS, SETTINGS_RANGES };
