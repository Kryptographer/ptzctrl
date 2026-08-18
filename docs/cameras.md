# Cameras

Everything about getting a camera into PTZ CTRL: what's supported, how to add
it, and what to do when it doesn't answer.

- [What works](#what-works)
- [Adding cameras](#adding-cameras)
- [VISCA protocols and ports](#visca-protocols-and-ports)
- [Live video](#live-video)
- [USB cameras and capture cards](#usb-cameras-and-capture-cards)
- [An Android phone as a wireless camera](#an-android-phone-as-a-wireless-camera)
- [Troubleshooting](#troubleshooting)

## What works

| Device | Pan / tilt / zoom | Live video | Notes |
| --- | :---: | :---: | --- |
| VISCA-over-IP PTZ cameras — Tongveo, Fomako, PTZOptics, Sony, most generic conference cams | ✅ | ✅ | The core use case. Presets, focus, OSD menu, home. |
| USB PTZ cameras with UVC pan/tilt/zoom | ✅ | ✅ | Driven while their video is playing; position presets supported. |
| USB webcams, HDMI/SDI capture cards (Elgato, AVerMedia…) | — | ✅ | Play in Live view and Multiview with no ffmpeg involved. |
| Any RTSP / MJPEG source — Hikvision, Dahua, NVR channels, Yi with RTSP firmware, generic ONVIF | — | ✅ | Added by stream URL, video-only. |
| Android phone running a camera-server app | — | ✅ | e.g. *IP Webcam*; discovered automatically on the same Wi-Fi. |
| Cloud-only cameras (e.g. Amazon Blink) | — | — | They expose no local stream, so no third-party app can pull them in. |

## Adding cameras

![Network scan results with Add buttons](screenshots/discovery.png)

**Scan network** (Cameras tab) finds devices for you. It uses ONVIF
WS-Discovery plus VISCA probes on UDP 1259, UDP 52381 (Sony framing) and
TCP 5678, and at the same time lists the USB cameras and capture cards
plugged into this PC. Click **Add** on anything you want to keep.

Cameras with a static IP outside your subnet won't be discovered, but can
still be added by hand:

- **Add PTZ camera by IP address (VISCA)** — name, IP, port, protocol.
- **Add any IP camera by stream URL** — for video-only sources:

  | Camera | Typical URL |
  | --- | --- |
  | Hikvision cam / NVR | `rtsp://user:pass@ip:554/Streaming/Channels/101` (NVR channel 2 = `201`…) |
  | Dahua / Amcrest | `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0` |
  | Yi (RTSP firmware) | `rtsp://ip/ch0_0.h264` |
  | Android IP Webcam | `http://phone-ip:8080/video` |

Cameras can be renamed at any time by clicking the name in the list, and the
`⌄` button on each row opens its protocol, stream URL, test and remove
controls.

## VISCA protocols and ports

| Camera family | Protocol option | Port |
| --- | --- | --- |
| Tongveo, Fomako, most generic PTZ cams | VISCA UDP | 1259 (default) |
| Same cameras, alternative transport | VISCA TCP | 5678 |
| Sony and Sony-compatible cameras | VISCA UDP Sony framing | 52381 |

The camera and the computer must be on the same subnet for discovery to work.
If a camera doesn't respond, use **Test** on its row and try switching the
protocol/port from the dropdown.

## Live video

Cameras are assumed to stream RTSP at `rtsp://<ip>:554/1` — the
Tongveo/Fomako default. If yours uses a different path, edit the **Stream
URL** field under the live view. The substream (`.../2`) usually has lower
latency, which also makes AI tracking noticeably more responsive.

If the URL is wrong, **Find stream automatically** probes the common RTSP
paths and picks one that works; failures report the actual reason (auth,
connection refused, 404…).

RTSP is relayed into the UI through a bundled ffmpeg (`ffmpeg-static`,
installed with the dependencies — no separate install needed). USB and
capture devices bypass ffmpeg entirely and play directly.

## USB cameras and capture cards

Local devices appear under **This PC — USB cameras & capture cards** on the
Cameras tab and update as you plug things in. USB PTZ cameras that implement
UVC pan/tilt/zoom can be driven from the controller and the on-screen pad
while their video is playing, including position presets.

## An Android phone as a wireless camera

1. Install a camera-server app on the phone — *IP Webcam* (free) works well.
2. Connect the phone to the **same Wi-Fi network** as this PC.
3. In the app, tap **Start server** — it shows an address like
   `http://192.168.1.23:8080`.
4. Click **Scan network** in PTZ CTRL — the phone appears under discovered
   devices; click **Add**. (Or add `http://<phone-ip>:8080/video` via the
   stream URL form.)

The same steps are built into the app under *Use an Android phone as a
wireless camera…*.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Camera not found by **Scan network** | Camera and PC on the same subnet; camera powered on; VISCA-over-IP enabled in the camera's menu. Add it by IP if it uses a static address elsewhere. |
| **Test** fails | Try the other protocol/port combinations (UDP 1259 → TCP 5678 → UDP 52381). Some cameras expose VISCA only after it is enabled in their web UI. |
| Live view says ffmpeg is missing | Re-run `npm install` (or `build.bat`) in the app folder so `ffmpeg-static` fetches the binary, then restart. |
| No video, but the camera responds to PTZ | Wrong RTSP path — click **Find stream automatically**, or check the path in the camera's web interface. RTSP may need enabling there. |
| Video stutters or lags | Switch the stream URL to the substream (`.../2`). |
| Camera moves the wrong way | *Invert pan* / *Invert tilt* in Settings → Control feel. For AI tracking there are separate invert options (mirrored/flipped camera images). |
