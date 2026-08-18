# Third-party notices

PTZ CTRL's own source code is [MIT licensed](LICENSE). The installers built
from this repository (`npm run dist`, `build.bat`) also redistribute the
third-party software listed below, some of it under different terms. Nothing
here changes the licence of PTZ CTRL's own code.

If you only *use* the app, this file is informational. If you *redistribute* a
build of it, these are the obligations that come with it.

## FFmpeg — GPL-3.0-or-later

**What.** The `ffmpeg` executable supplied by the
[`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) npm package
(FFmpeg 6.1.1 static builds). It is used only to pull RTSP and other network
camera streams and re-encode them to MJPEG for the live view.

**How PTZ CTRL uses it.** As a separate program, not as a library. Nothing in
this repository links against FFmpeg or includes its headers:
[`src/main/stream.js`](src/main/stream.js) spawns the binary as a child
process, passes it command-line arguments and reads its stdout. If no bundled
binary is present the app falls back to whatever `ffmpeg` is on your `PATH`,
so the bundled copy is a convenience, not a component.

**Licence.** GNU General Public License v3 or later — full text in
[`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt). These are GPL-configured
builds (they include GPL-only components such as libx264), which is why the
stricter of FFmpeg's two licences applies rather than the LGPL.

**Corresponding source.** FFmpeg's source is at
<https://git.ffmpeg.org/ffmpeg.git> and <https://ffmpeg.org/download.html>.
`ffmpeg-static` does not build the binaries itself; it downloads them from the
build maintainers below, whose sites carry the build configuration and the
exact source revision for each build:

| Platform | Build maintainer |
| --- | --- |
| Windows x64 | <https://www.gyan.dev/ffmpeg/builds/> |
| Windows x86 | <https://github.com/sudo-nautilus/FFmpeg-Builds-Win32/> |
| Linux x64/x86/ARM/ARM64 | <https://johnvansickle.com/ffmpeg/> |
| macOS x64 | <https://evermeet.cx/pub/ffmpeg/> |
| macOS ARM64 | <https://osxexperts.net/> |

**If you redistribute a PTZ CTRL build containing this binary**, you take on
the GPL's obligations for that binary: ship this notice and the licence text
with it, and be able to provide the corresponding source to anyone you gave
the binary to.

**Shipping without it.** Drop `ffmpeg-static` from `dependencies` in
`package.json` and remove its `asarUnpack` entry. The app then uses a system
`ffmpeg` — including an LGPL build, if you want to avoid GPL terms entirely —
and everything except network-stream video works with no ffmpeg at all.

## Electron, Chromium and Node.js — MIT and others

The app ships as an [Electron](https://www.electronjs.org/) application, so
packages contain the Electron runtime (MIT), Chromium (BSD-3-Clause plus many
third-party licences) and Node.js (MIT). `electron-builder` copies Electron's
`LICENSE` and `LICENSES.chromium.html` into the packaged output; those files
are the authoritative notices for this part.

## ONNX Runtime Web — MIT

[`onnxruntime-web`](https://github.com/microsoft/onnxruntime) 1.27.0,
Copyright (c) Microsoft Corporation. Runs the AI tracker's model in the
renderer. The prebuilt bundle that ships in the installer
(`ort.wasm.bundle.min.mjs` and its `.wasm`) inlines further components under
Apache-2.0 (FlatBuffers, `long`) and BSD-3-Clause (protobuf.js).

## Koffi — MIT

[Koffi](https://koffi.dev/) 3.x, Copyright (c) Niels Martignène. An optional
dependency, bundled when present; used only on Windows to read the controller
through XInput so cameras keep moving while the app is unfocused
([`src/main/xinput.js`](src/main/xinput.js)).

## VitTrack tracking model — Apache-2.0

`src/models/object_tracking_vittrack_2023sep.onnx`, from the
[OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/object_tracking_vittrack)
(upstream [lpylpy0514/VitTracker](https://github.com/lpylpy0514/VitTracker)).
Licence text in [`src/models/LICENSE`](src/models/LICENSE), provenance and
checksum in [`src/models/README.md`](src/models/README.md).

## Trademarks

Xbox, Xbox Adaptive Controller and Windows are trademarks of Microsoft
Corporation. Sony and VISCA are trademarks of Sony Corporation. PTZOptics,
Fomako, Tongveo, Hikvision, Dahua, macOS and Linux are trademarks of their
respective owners.

PTZ CTRL is an independent project. It is not affiliated with, sponsored by or
endorsed by any of these companies. Their names appear here and in the
documentation only to describe which hardware and protocols the app works
with.

## Warranty and liability

PTZ CTRL is provided **as is**, without warranty of any kind — see the
disclaimer in [`LICENSE`](LICENSE), which is part of the terms you receive the
software under. The bundled third-party components carry their own equivalent
disclaimers.
