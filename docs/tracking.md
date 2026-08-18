# AI subject tracking

Click **◎ Track subject** under the live view, drag a box around a person or
object, and the camera pans and tilts on its own to keep them centred.

![Tracking a subject in the live view](screenshots/tracking.png)

- [How it works](#how-it-works)
- [Behaviour](#behaviour)
- [Settings](#settings)
- [Optional higher-accuracy model](#optional-higher-accuracy-model)
- [Tips](#tips)

## How it works

Tracking is driven by a **neural vision-transformer tracker** — OpenCV Zoo's
[VitTrack](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack)
running on onnxruntime-web. The 0.7 MB model ships with the app, so tracking
is **fully on-device**: no internet, no GPU, nothing uploaded anywhere.

It follows subjects through pose changes, scale changes and brief occlusions,
re-estimates the subject's size every frame (so the lock survives someone
walking toward the camera, or you zooming), re-finds a lost subject anywhere in
the frame, and leads fast-moving targets with a velocity prediction.

On top of the detector sits a per-axis stability layer: Kalman-filtered
measurements plus a hold/follow gate. While the subject stands still the camera
sends **no movement commands at all** — box jitter, blur dips, even a one-frame
mis-detection can't nudge it. It starts following only on real motion (a
sustained walk-off, or drift past the centre deadzone), re-centres, and locks
still again once the subject stops.

The control loop also compensates for stream latency: it estimates how fast the
subject is drifting, brakes before crossing centre, and ramps speed up smoothly,
so following feels damped rather than oscillating. The loop gain **self-tunes** —
if a correction overshoots (fast camera, long latency, zoomed-in view) the
tracker backs its gain off automatically and settles instead of hunting.

If the neural runtime can't load, tracking falls back automatically to a
built-in MOSSE correlation filter.

## Behaviour

- Tracking follows whatever is inside the box you draw — it learns that patch's
  appearance and re-finds it every frame, so it works on people, pets, podiums,
  anything with some visual texture.
- The first time you start tracking after launching the app, the model loads for
  a moment (*"Loading AI tracker…"*); after that it's instant.
- If the subject disappears, the box turns amber (**LOST**), motion stops, and
  the tracker hunts for it — first near the last position with widening search
  regions, then across the whole frame — for a few seconds before giving up.
- The tracker drives **pan/tilt only**. Zoom and focus stay on the controller.
- Moving the stick, pressing <kbd>Esc</kbd>, or STOP ALL instantly hands control
  back. A *Stop AI tracking* controller button can also be bound.
- Works with VISCA cameras and UVC PTZ cameras.

## Settings

Under **Settings → AI subject tracking**:

| Setting | What it does |
| --- | --- |
| Tracking speed limit | Top speed the tracker may use, as a fraction of the camera's maximum. |
| Responsiveness | How hard an off-centre subject is corrected. |
| Centre deadzone | No movement while the subject is this close to the centre. |
| Invert tracking pan / tilt | For cameras whose image is mirrored or flipped in their OSD settings. |

## Optional higher-accuracy model

The tracker also supports [SMAT](https://github.com/goutamyg/SMAT)
(Apache-2.0), a heavier model that is markedly more accurate on hard subjects.
Download its ONNX file (linked from the
[MVT.cpp README](https://github.com/goutamyg/MVT.cpp)), rename it to
`smat.onnx`, and drop it into the app's data folder under `models/`:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\PTZ CTRL\models\smat.onnx` |
| Linux | `~/.config/PTZ CTRL/models/smat.onnx` |
| macOS | `~/Library/Application Support/PTZ CTRL/models/smat.onnx` |

Restart tracking and the status line reports `AI tracking (smat)`. Placing a
`vittrack.onnx` there instead overrides the bundled model.

> This path is wired and unit-tested but has not been verified against the
> actual SMAT release file. If it misbehaves, delete the file to return to the
> bundled model.

## Tips

- The lower-latency substream (`rtsp://<ip>:554/2`) makes tracking noticeably
  more responsive, since the control loop sees frames sooner.
- If the camera's image is mirrored or flipped in its OSD settings, the follow
  direction will be wrong — disable the flip on the camera, or tick *Invert
  tracking pan / tilt*.
- A subject with some texture (patterned clothing, clear edges) locks harder
  than a flat silhouette against a flat wall.
