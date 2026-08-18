'use strict';

/**
 * Feed: one live MJPEG stream bound to an <img>.
 *
 * Fetches the local relay URL for a camera, parses multipart MJPEG chunks
 * with MjpegParser, and paints frames as blob URLs. Used by both the single
 * Live view and the Multiview grid.
 *
 * onStatus(text) is called with a human-readable state, or null once video
 * frames are flowing (meaning: hide any overlay).
 */

(function () {
  class Feed {
    constructor(camId, img, onStatus) {
      this.camId = camId;
      this.img = img;
      this.onStatus = onStatus || (() => {});
      this.ctrl = null;
      this.blobUrl = null;
      this.gotFrame = false;
      this.stopped = false;
    }

    async start() {
      this.stopped = false;
      this.gotFrame = false;
      this.onStatus('Connecting…');

      let res;
      try {
        res = await window.ptz.getStreamUrl(this.camId);
      } catch (err) {
        this.onStatus(`Stream error: ${err.message}`);
        return;
      }
      if (this.stopped) return;
      if (!res.ok) {
        this.onStatus(`Stream error: ${res.error}`);
        return;
      }

      const ctrl = new AbortController();
      this.ctrl = ctrl;
      try {
        const resp = await fetch(res.url, { signal: ctrl.signal });
        if (!resp.ok) {
          // The relay puts the real ffmpeg failure reason in the body.
          this.onStatus((await resp.text()).trim());
          return;
        }
        const reader = resp.body.getReader();
        const parser = new MjpegParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.ctrl !== ctrl) break;
          for (const frame of parser.push(value)) this._show(frame);
        }
        if (this.ctrl === ctrl && !this.stopped) {
          this.onStatus(this.gotFrame
            ? 'Stream ended — camera stopped sending video.'
            : 'Stream ended before any video arrived.');
        }
      } catch (err) {
        if (err.name !== 'AbortError' && this.ctrl === ctrl && !this.stopped) {
          this.onStatus(`Stream error: ${err.message}`);
        }
      }
    }

    _show(frame) {
      const url = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
      this.img.src = url;
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = url;
      if (!this.gotFrame) {
        this.gotFrame = true;
        this.onStatus(null);
      }
    }

    stop() {
      this.stopped = true;
      if (this.ctrl) {
        this.ctrl.abort();
        this.ctrl = null;
      }
      if (this.blobUrl) {
        URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = null;
      }
      this.img.removeAttribute('src');
    }
  }

  /**
   * LocalFeed: live video from a local device (USB camera / capture card)
   * via getUserMedia, bound to a <video> element.
   *
   * onTrack(track|null) hands the MediaStreamTrack to the caller so UVC
   * pan/tilt/zoom control can be applied while the video is running.
   */
  class LocalFeed {
    constructor(deviceId, videoEl, onStatus, onTrack) {
      this.deviceId = deviceId;
      this.videoEl = videoEl;
      this.onStatus = onStatus || (() => {});
      this.onTrack = onTrack || (() => {});
      this.stream = null;
      this.stopped = false;
    }

    async start() {
      this.stopped = false;
      this.onStatus('Starting device…');
      try {
        // 720p default: full USB bandwidth at 1080p makes some devices lag
        // and stall while UVC control commands are applied.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: this.deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
        });
        if (this.stopped) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        this.stream = stream;
        this.videoEl.srcObject = stream;
        this.videoEl.muted = true;
        try { await this.videoEl.play(); } catch { /* autoplay quirks */ }
        this.onStatus(null);
        this.onTrack(stream.getVideoTracks()[0] || null);
      } catch (err) {
        this.onStatus(`Device error: ${err.message || err.name}. Is it in use by another app?`);
      }
    }

    stop() {
      this.stopped = true;
      if (this.stream) {
        for (const t of this.stream.getTracks()) t.stop();
        this.stream = null;
      }
      if (this.videoEl) this.videoEl.srcObject = null;
      this.onTrack(null);
    }
  }

  globalThis.Feed = Feed;
  globalThis.LocalFeed = LocalFeed;
})();
