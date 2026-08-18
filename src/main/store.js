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

class Store {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'ptzctrl-config.json');
    this.data = this._load();
  }

  _load() {
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      loaded = {};
    }
    // Deep-merge defaults so new keys appear after upgrades.
    const cameras = Array.isArray(loaded.cameras) ? loaded.cameras : DEFAULTS.cameras;
    for (const cam of cameras) {
      if (!cam.type) cam.type = cam.deviceId ? 'local' : 'visca';
      if (cam.type === 'local' && !cam.presets) cam.presets = {};
      if (cam.type === 'visca' && !cam.streamUrl && cam.ip) cam.streamUrl = `rtsp://${cam.ip}:554/1`;
    }
    return {
      cameras,
      activeCameraId: loaded.activeCameraId ?? DEFAULTS.activeCameraId,
      settings: { ...DEFAULTS.settings, ...(loaded.settings || {}) },
      mapping: {
        axes: { ...DEFAULTS.mapping.axes, ...((loaded.mapping || {}).axes || {}) },
        buttons: { ...DEFAULTS.mapping.buttons, ...((loaded.mapping || {}).buttons || {}) },
      },
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('Failed to save config:', err.message);
    }
  }

  getAll() {
    return this.data;
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
    this.data.cameras.push(cam);
    if (!this.data.activeCameraId) this.data.activeCameraId = cam.id;
    this.save();
    return cam;
  }

  updateCamera(id, patch) {
    const cam = this.data.cameras.find((c) => c.id === id);
    if (!cam) return null;
    if (patch.name !== undefined) cam.name = patch.name;
    if (patch.ip !== undefined) cam.ip = patch.ip;
    if (patch.port !== undefined) cam.port = Number(patch.port);
    if (patch.protocol !== undefined) cam.protocol = patch.protocol;
    if (patch.streamUrl !== undefined) cam.streamUrl = patch.streamUrl;
    if (patch.presets !== undefined) cam.presets = patch.presets;
    if (patch.deviceId !== undefined) cam.deviceId = patch.deviceId;
    this.save();
    return cam;
  }

  removeCamera(id) {
    this.data.cameras = this.data.cameras.filter((c) => c.id !== id);
    if (this.data.activeCameraId === id) {
      this.data.activeCameraId = this.data.cameras[0] ? this.data.cameras[0].id : null;
    }
    this.save();
  }

  setActiveCamera(id) {
    if (id === null || this.data.cameras.some((c) => c.id === id)) {
      this.data.activeCameraId = id;
      this.save();
    }
    return this.data.activeCameraId;
  }

  setMapping(mapping) {
    this.data.mapping = {
      axes: { ...DEFAULTS.mapping.axes, ...(mapping.axes || {}) },
      buttons: { ...DEFAULTS.mapping.buttons, ...(mapping.buttons || {}) },
    };
    this.save();
    return this.data.mapping;
  }

  resetMapping() {
    this.data.mapping = JSON.parse(JSON.stringify(DEFAULTS.mapping));
    this.save();
    return this.data.mapping;
  }

  setSettings(settings) {
    this.data.settings = { ...this.data.settings, ...settings };
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store, DEFAULTS };
