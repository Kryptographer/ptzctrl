'use strict';

/**
 * Incremental parser for ffmpeg's mpjpeg output
 * (multipart/x-mixed-replace: boundary + headers + JPEG per frame).
 *
 * Feed it chunks with push(); it returns complete JPEG frames as they
 * appear. Prefers the Content-length header ffmpeg emits; falls back to
 * scanning for JPEG SOI/EOI markers if headers are absent.
 *
 * Defined on globalThis so the same file works in the renderer and in
 * Node-based tests.
 */

(function () {
  const CRLF2 = [13, 10, 13, 10]; // \r\n\r\n

  class MjpegParser {
    constructor() {
      this.buf = new Uint8Array(0);
    }

    push(chunk) {
      const add = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const merged = new Uint8Array(this.buf.length + add.length);
      merged.set(this.buf);
      merged.set(add, this.buf.length);
      this.buf = merged;

      const frames = [];
      let frame;
      while ((frame = this._next()) !== null) frames.push(frame);

      // Safety valve: a stream that never matches shouldn't grow forever.
      if (this.buf.length > 4 * 1024 * 1024) {
        this.buf = this.buf.slice(-64 * 1024);
      }
      return frames;
    }

    _find(seq, from) {
      const b = this.buf;
      outer: for (let i = from; i <= b.length - seq.length; i++) {
        for (let j = 0; j < seq.length; j++) {
          if (b[i + j] !== seq[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    _next() {
      const hEnd = this._find(CRLF2, 0);
      if (hEnd !== -1) {
        const headerText = String.fromCharCode(...this.buf.slice(0, Math.min(hEnd, 512)));
        const m = /content-length:\s*(\d+)/i.exec(headerText);
        if (m) {
          const len = Number(m[1]);
          const start = hEnd + 4;
          if (this.buf.length < start + len) return null; // frame incomplete
          const frame = this.buf.slice(start, start + len);
          this.buf = this.buf.slice(start + len);
          return frame;
        }
      }
      // No parsable headers (yet): fall back to JPEG marker scanning.
      return this._nextByMarkers();
    }

    _nextByMarkers() {
      const soi = this._find([0xff, 0xd8], 0);
      if (soi === -1) return null;
      const eoi = this._find([0xff, 0xd9], soi + 2);
      if (eoi === -1) return null;
      const frame = this.buf.slice(soi, eoi + 2);
      this.buf = this.buf.slice(eoi + 2);
      return frame;
    }
  }

  globalThis.MjpegParser = MjpegParser;
})();
