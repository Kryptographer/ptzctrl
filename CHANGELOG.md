# Changelog

Notable changes, newest first, grouped by the date the work landed. The current
version is **1.9.0**; earlier entries predate per-release version tagging, so
they are listed by date rather than version.

## Unreleased

- Camera credentials embedded in a stream URL are now stripped from error
  messages before they reach the live view, so a password can't ride along
  into a screenshot or a bug report.

## 1.9.0 — 2026-08-17

- **UI pass** — flatter, more legible layout with AA-contrast text, full
  keyboard operability, proper tab/listbox/pressed semantics, inline
  confirmation on destructive actions, and status spelled out in words rather
  than signalled by colour alone.

## 2026-07-26

- **Broadcast-grade drive discipline** — stops are guaranteed on the wire,
  deadzone and speed-step hysteresis stop stick noise chattering the camera,
  and drive commands are re-sent every 300 ms so a lost UDP packet can't leave
  a camera panning on air.
- **True-to-the-stick pan/tilt** — radial deadzone and vector-shaped response
  so the camera goes exactly where the stick points; braked reversals and clean
  handoff when switching cameras mid-move.
- Fixed controller preset bindings: stale engine mapping and doubled-up inputs.
- Fixed the bounce when recalling a camera preset.

## 2026-07-22 → 2026-07-23

- **Neural AI subject tracking** — OpenCV Zoo's VitTrack vision transformer
  running on-device via onnxruntime-web, with a MOSSE correlation filter as
  fallback.
- **Rock-steady tracking** — per-axis Kalman filtering, a hold/follow gate that
  keeps the camera still while the subject is still, and self-tuning loop gain
  that settles instead of hunting.
- Latency-compensated drive, more robust lock, and lost-subject recovery search.
- Close to system tray: the app keeps running (and the controller keeps
  driving) with the window closed.
- Finer movement sensitivity controls: per-axis pan/tilt/zoom sensitivity and
  motion smoothing.
- UI polish: dynamic sizing and responsive layouts.

## 2026-07-21

- Save presets from the controller with a single button (tap to recall, hold to
  save) — built for the Xbox Adaptive Controller and adaptive joysticks.

## 2026-07-19

- Native controller reads via XInput, so control keeps working while the app
  window is unfocused (Windows).
- Xbox Adaptive Controller support, with a controller device picker.
- Generic IP camera support (NVR / Yi / any RTSP or MJPEG source) and Android
  phones as wireless cameras.
- USB camera and capture-card support, plus precision control mode.
- Multiview tab: a live grid of every camera; click a tile to control it.
- Live video with stream auto-find and on-screen PTZ controls.
- App icon, Windows build script (`build.bat`), and the PTZ CTRL rebrand.
- First working version: an Electron app driving VISCA-over-IP PTZ cameras with
  an Xbox controller.
