'use strict';

/**
 * Native Xbox / XInput controller reader for the Electron MAIN process.
 *
 * WHY THIS EXISTS
 * ---------------
 * The renderer drives cameras from the Web Gamepad API, but Chromium only
 * updates gamepad state while the page is *focused* (a deliberate
 * anti-fingerprinting rule). So the moment the user clicks another app —
 * Notepad, a browser, anything — `navigator.getGamepads()` freezes and the
 * controller stops working. Polling faster or disabling background
 * throttling does NOT help: the freeze is the focus gate, not throttling.
 *
 * Reading the controller here, in the Node/main process via XInput, bypasses
 * that gate entirely — the main process is never subject to window focus — so
 * input keeps flowing no matter which app is on top. The snapshots we produce
 * use the exact same layout as the Web Gamepad API "standard" mapping, so the
 * renderer engine and the rebind UI treat them identically.
 *
 * Windows-only. On macOS/Linux, or if XInput can't be loaded (koffi missing,
 * DLL absent), this reports `available === false` and the app transparently
 * falls back to the renderer's Web Gamepad API — behaviour is never worse than
 * before.
 */

let koffi = null;
try {
  koffi = require('koffi');
} catch (_) {
  // koffi is an optional dependency; without it we simply have no native path.
  koffi = null;
}

// Tried in order; 1_4 ships on Windows 8+, 9_1_0 is present on virtually every
// Windows install, 1_3 covers older DirectX-redistributable setups.
const XINPUT_DLLS = ['xinput1_4.dll', 'xinput9_1_0.dll', 'xinput1_3.dll'];
const MAX_USERS = 4;
const STICK_MAX = 32767;
const TRIGGER_MAX = 255;
// LT/RT are exposed as analog buttons (indices 6/7). This is only the
// pressed/not-pressed threshold; the analog value is always passed through.
const TRIGGER_PRESS = 30 / TRIGGER_MAX;

// XINPUT_GAMEPAD.wButtons bit masks (Xinput.h).
const MASK = {
  DPAD_UP: 0x0001,
  DPAD_DOWN: 0x0002,
  DPAD_LEFT: 0x0004,
  DPAD_RIGHT: 0x0008,
  START: 0x0010, // "Menu"
  BACK: 0x0020, // "View"
  LEFT_THUMB: 0x0040,
  RIGHT_THUMB: 0x0080,
  LEFT_SHOULDER: 0x0100,
  RIGHT_SHOULDER: 0x0200,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
};

const clamp = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

class XInputReader {
  constructor() {
    this.available = false;
    this.dll = null;
    this._getState = null;
    this._lastIndex = null; // slot that was connected on the previous read
    this._scanTick = 0; // countdown to the next full scan for new controllers
    this._init();
  }

  _init() {
    if (!koffi || process.platform !== 'win32') return;
    let STATE;
    try {
      const GAMEPAD = koffi.struct('XINPUT_GAMEPAD', {
        wButtons: 'uint16',
        bLeftTrigger: 'uint8',
        bRightTrigger: 'uint8',
        sThumbLX: 'int16',
        sThumbLY: 'int16',
        sThumbRX: 'int16',
        sThumbRY: 'int16',
      });
      STATE = koffi.struct('XINPUT_STATE', {
        dwPacketNumber: 'uint32',
        Gamepad: GAMEPAD,
      });
    } catch (_) {
      return; // struct registration failed — give up on the native path
    }
    for (const dll of XINPUT_DLLS) {
      try {
        const lib = koffi.load(dll);
        // WINAPI == __stdcall (matters on x86; harmless on x64).
        this._getState = lib.func(
          'uint32 __stdcall XInputGetState(uint32 dwUserIndex, _Out_ XINPUT_STATE *pState)'
        );
        this.available = true;
        this.dll = dll;
        return;
      } catch (_) {
        // try the next DLL name
      }
    }
  }

  /** Read one XInput slot into a Web-Gamepad-API-shaped snapshot, or null. */
  _readUser(index) {
    const state = {};
    let res;
    try {
      res = this._getState(index, state);
    } catch (_) {
      return null;
    }
    // 0 == ERROR_SUCCESS. Anything else (1167 ERROR_DEVICE_NOT_CONNECTED, …).
    if (res !== 0 || !state.Gamepad) return null;

    const g = state.Gamepad;
    const w = g.wButtons;
    const on = (mask) => (w & mask) !== 0;
    const btn = (pressed, value) => ({
      pressed,
      value: value == null ? (pressed ? 1 : 0) : value,
      touched: pressed,
    });
    const lt = g.bLeftTrigger / TRIGGER_MAX;
    const rt = g.bRightTrigger / TRIGGER_MAX;

    // Standard-mapping button order (must match BUTTON_NAMES in gamepad.js).
    const buttons = [
      btn(on(MASK.A)), // 0  A
      btn(on(MASK.B)), // 1  B
      btn(on(MASK.X)), // 2  X
      btn(on(MASK.Y)), // 3  Y
      btn(on(MASK.LEFT_SHOULDER)), // 4  LB
      btn(on(MASK.RIGHT_SHOULDER)), // 5  RB
      btn(lt > TRIGGER_PRESS, lt), // 6  LT (analog)
      btn(rt > TRIGGER_PRESS, rt), // 7  RT (analog)
      btn(on(MASK.BACK)), // 8  View
      btn(on(MASK.START)), // 9  Menu
      btn(on(MASK.LEFT_THUMB)), // 10 LS
      btn(on(MASK.RIGHT_THUMB)), // 11 RS
      btn(on(MASK.DPAD_UP)), // 12 D-Up
      btn(on(MASK.DPAD_DOWN)), // 13 D-Down
      btn(on(MASK.DPAD_LEFT)), // 14 D-Left
      btn(on(MASK.DPAD_RIGHT)), // 15 D-Right
      btn(false), // 16 Guide (not exposed by XInput)
    ];

    // Axes normalized to the SAME sign convention as the Web Gamepad API:
    // X right = +1, Y DOWN = +1 (so pushing a stick up gives a negative Y).
    // XInput reports Y up as positive, so both Y axes are negated.
    const axes = [
      clamp(g.sThumbLX / STICK_MAX),
      clamp(-g.sThumbLY / STICK_MAX),
      clamp(g.sThumbRX / STICK_MAX),
      clamp(-g.sThumbRY / STICK_MAX),
    ];

    return {
      id: `Xbox Controller (XInput #${index})`,
      index,
      connected: true,
      mapping: 'standard',
      axes,
      buttons,
      native: true,
    };
  }

  /** The active connected controller, or null if none/unavailable. */
  readFirst() {
    if (!this.available) return null;
    // Fast path: keep polling the slot that was live last time, every frame.
    if (this._lastIndex !== null) {
      const pad = this._readUser(this._lastIndex);
      if (pad) return pad;
      this._lastIndex = null; // it went away — fall through to a rescan
    }
    // Scanning every slot each frame is wasteful, and Microsoft specifically
    // warns against polling empty XInput slots at full rate. With nothing
    // connected, only rescan for a newly plugged-in controller periodically.
    if (this._scanTick > 0) {
      this._scanTick -= 1;
      return null;
    }
    this._scanTick = 30; // ~2 rescans/sec at a 16 ms cadence
    for (let i = 0; i < MAX_USERS; i++) {
      const pad = this._readUser(i);
      if (pad) {
        this._lastIndex = i;
        return pad;
      }
    }
    return null;
  }
}

module.exports = { XInputReader };
