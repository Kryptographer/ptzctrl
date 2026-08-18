# Architecture

PTZ CTRL is a standard Electron app: a Node main process that owns the network
and the controller, a context-isolated preload bridge, and a renderer that owns
the UI, the input engine and the tracker.

```
Xbox controller ─┬─ XInput (main process, Windows) ─┐
                 └─ Web Gamepad API (renderer) ─────┴─► GamepadEngine
                                                          │ quantized speeds
                                                          ▼
                                    IPC ──► VISCA transport (UDP / Sony UDP / TCP)
                                                          │ paced ~20 Hz
                                                          ▼
                                                    PTZ camera
RTSP ──► bundled ffmpeg ──► MJPEG relay ──► <img> ──► VitTrack ──► pan/tilt loop
```

## Source layout

| Path | Contents |
| --- | --- |
| `src/main/` | Electron main process — see below. |
| `src/preload.js` | Context-isolated bridge exposing a small `window.ptz` API. |
| `src/renderer/` | UI, the gamepad engine and the tracker. |
| `src/models/` | The bundled VitTrack ONNX model (0.7 MB, Apache-2.0, from [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack)). |
| `test/` | Headless tests (`npm test`). |
| `build/` | App icons for the installers. |

### `src/main/`

| File | Responsibility |
| --- | --- |
| `index.js` | App lifecycle, window and tray, IPC handlers. |
| `visca.js` | VISCA transports (UDP, Sony-framed UDP, TCP) and the per-camera command pacer. |
| `drivekeeper.js` | Re-sends the current drive on lossy UDP and repeats stops. |
| `discovery.js` | ONVIF WS-Discovery plus VISCA probes on UDP 1259 / UDP 52381 / TCP 5678. |
| `stream.js` | ffmpeg RTSP → MJPEG relay, stream probing and auto-find. |
| `store.js` | JSON config store (cameras, mapping, settings) in the Electron userData dir. |
| `xinput.js` | Native controller reads via `koffi` + XInput on Windows, pushed to the renderer as standard-mapping pad snapshots. |

**Command pacing matters.** A VISCA camera buffers only two commands, so
continuous pan/tilt/zoom updates are coalesced to ~20 Hz — newest value wins —
while discrete commands such as a preset recall are never merged, dropped or
reordered.

### `src/renderer/`

| File | Responsibility |
| --- | --- |
| `renderer.js` | UI: tabs, camera list, live view, Multiview, mapping and settings. |
| `gamepad.js` | The input engine: deadzone/curve shaping, smoothing, hysteresis, preset tap/hold, and quantized VISCA speed commands sent only on state changes. |
| `feeds.js`, `mjpeg.js` | MJPEG relay client and incremental multipart parser, shared by Live view and Multiview. |
| `vittrack.js` | The neural tracker — a faithful JS port of OpenCV's VitTrack pre/post-processing on onnxruntime-web's WASM backend. DOM-free, so it is testable headless. |
| `tracker.js` | Box drawing, engine selection (MOSSE correlation filter as fallback), lost-subject search, and the closed pan/tilt loop: per-axis Kalman filtering, a hold/follow stability gate and self-tuning loop gain. |
| `ort-loader.mjs` | Loads onnxruntime-web's self-contained wasm bundle and hands the API to the classic scripts. |
| `styles.css` | The whole UI's styling. |

## Tests

```bash
npm test
```

- `test/run-control-tests.js` — the control path: VISCA command pacing and
  coalescing, drive-keeper stop repeats, and the controller's post-preset drive
  hold-off (the "preset bounce" fix).
- `test/run-tests.js` — the tracker math against the OpenCV reference, the
  stability layer through closed-loop simulations (still subject → zero drive,
  glitch rejection, walk-off, slow drift, aggressive-settings convergence), and
  an end-to-end run of the real bundled model against a synthetic moving,
  scaling subject.

Both are plain Node scripts with no test framework and no Electron — they run
anywhere Node runs, which is what CI uses.

## Building

```bash
npm run pack     # unpacked app in dist/, for a quick local check
npm run dist     # NSIS installer (Windows), DMG (macOS), AppImage (Linux)
```

On Windows, `build.bat` does the whole thing: checks for Node.js, installs
dependencies, builds the installer and reports where it landed.
