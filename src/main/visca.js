'use strict';

/**
 * VISCA over IP transport + command builder.
 *
 * Supports the three transports found on common PTZ cameras
 * (Tongveo, Fomako, PTZOptics, Sony, etc.):
 *
 *   - 'udp'      raw VISCA bytes over UDP (typical port 1259)
 *   - 'udp-sony' Sony VISCA-over-IP framing over UDP (typical port 52381)
 *   - 'tcp'      raw VISCA bytes over TCP (typical port 5678)
 */

const dgram = require('dgram');
const net = require('net');

// ---------------------------------------------------------------------------
// VISCA payload builders (address 1, the default for IP-controlled cameras)
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const VISCA = {
  MAX_PAN_SPEED: 0x18, // 24
  MAX_TILT_SPEED: 0x14, // 20
  MAX_ZOOM_SPEED: 0x07,
  MAX_FOCUS_SPEED: 0x07,

  /**
   * Pan/tilt drive. panSpeed / tiltSpeed are signed integers:
   * negative pan = left, positive pan = right,
   * negative tilt = down, positive tilt = up, 0 = stop on that axis.
   */
  panTiltDrive(panSpeed, tiltSpeed) {
    const p = clamp(Math.round(Math.abs(panSpeed)), 0, VISCA.MAX_PAN_SPEED);
    const t = clamp(Math.round(Math.abs(tiltSpeed)), 0, VISCA.MAX_TILT_SPEED);
    let panDir = 0x03; // stop
    if (panSpeed < 0) panDir = 0x01; // left
    else if (panSpeed > 0) panDir = 0x02; // right
    let tiltDir = 0x03; // stop
    if (tiltSpeed > 0) tiltDir = 0x01; // up
    else if (tiltSpeed < 0) tiltDir = 0x02; // down
    return Buffer.from([
      0x81, 0x01, 0x06, 0x01,
      Math.max(1, p), Math.max(1, t),
      panDir, tiltDir,
      0xff,
    ]);
  },

  panTiltHome() {
    return Buffer.from([0x81, 0x01, 0x06, 0x04, 0xff]);
  },

  /**
   * Zoom. speed is a signed integer: positive = tele (zoom in),
   * negative = wide (zoom out), 0 = stop.
   */
  zoom(speed) {
    const s = clamp(Math.round(Math.abs(speed)), 0, VISCA.MAX_ZOOM_SPEED);
    let b = 0x00; // stop
    if (speed > 0) b = 0x20 | s; // tele variable
    else if (speed < 0) b = 0x30 | s; // wide variable
    return Buffer.from([0x81, 0x01, 0x04, 0x07, b, 0xff]);
  },

  /** Focus. positive = far, negative = near, 0 = stop. */
  focus(speed) {
    const s = clamp(Math.round(Math.abs(speed)), 0, VISCA.MAX_FOCUS_SPEED);
    let b = 0x00;
    if (speed > 0) b = 0x20 | s; // far
    else if (speed < 0) b = 0x30 | s; // near
    return Buffer.from([0x81, 0x01, 0x04, 0x08, b, 0xff]);
  },

  focusMode(auto) {
    return Buffer.from([0x81, 0x01, 0x04, 0x38, auto ? 0x02 : 0x03, 0xff]);
  },

  focusOnePush() {
    return Buffer.from([0x81, 0x01, 0x04, 0x18, 0x01, 0xff]);
  },

  presetSave(n) {
    return Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x01, clamp(n, 0, 0x7f), 0xff]);
  },

  presetRecall(n) {
    return Buffer.from([0x81, 0x01, 0x04, 0x3f, 0x02, clamp(n, 0, 0x7f), 0xff]);
  },

  power(on) {
    return Buffer.from([0x81, 0x01, 0x04, 0x00, on ? 0x02 : 0x03, 0xff]);
  },

  menuToggle() {
    return Buffer.from([0x81, 0x01, 0x06, 0x06, 0x10, 0xff]);
  },

  versionInquiry() {
    return Buffer.from([0x81, 0x09, 0x00, 0x02, 0xff]);
  },
};

// ---------------------------------------------------------------------------
// Sony VISCA-over-IP framing (UDP 52381)
// ---------------------------------------------------------------------------

function sonyWrap(payload, seq, type) {
  // type: 0x0100 = VISCA command, 0x0110 = VISCA inquiry, 0x0200 = control
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(seq >>> 0, 4);
  payload.copy(buf, 8);
  return buf;
}

function sonyUnwrap(msg) {
  if (msg.length > 8 && (msg[0] === 0x01 || msg[0] === 0x02)) {
    return msg.subarray(8);
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Per-camera connection
// ---------------------------------------------------------------------------

// Minimum spacing between commands on one connection. A VISCA camera holds
// only two commands in its socket buffer and the spec expects the controller
// to wait for completion, so a controller that writes every frame overruns it
// within a few hundred milliseconds. See send() for what that breaks.
const MIN_SEND_GAP_MS = 50;

// Coalescing keys for the continuous (velocity) commands. Each axis group has
// exactly one meaningful in-flight value, so a queued update is always safe to
// replace with a newer one — including a stop, which is why a stop can never be
// dropped by coalescing. Discrete commands (preset, home, power, menu, focus
// mode) pass no key and are therefore never merged or skipped.
const DRIVE_KEYS = { PAN_TILT: 'panTilt', ZOOM: 'zoom', FOCUS: 'focus' };

class ViscaConnection {
  /**
   * @param {{ip: string, port: number, protocol: 'udp'|'udp-sony'|'tcp'}} opts
   * @param {{minGapMs?: number}} [tuning] minGapMs 0 disables pacing (tests)
   */
  constructor({ ip, port, protocol }, { minGapMs = MIN_SEND_GAP_MS } = {}) {
    this.ip = ip;
    this.port = port;
    this.protocol = protocol;
    this.seq = 0;
    this.udpSocket = null;
    this.tcpSocket = null;
    this.tcpConnecting = null;
    this.closed = false;
    this.onMessage = null; // set by callers that want replies
    // Command pacing state (see send()).
    this.minGapMs = minGapMs;
    this.queue = [];
    this.lastWriteTs = 0;
    this.pumpTimer = null;
  }

  _ensureUdp() {
    if (this.udpSocket) return this.udpSocket;
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { /* keep going; UDP errors are non-fatal */ });
    sock.on('message', (msg, rinfo) => {
      if (this.onMessage) this.onMessage(sonyUnwrap(msg), rinfo);
    });
    this.udpSocket = sock;
    if (this.protocol === 'udp-sony') {
      // RESET SEQUENCE control command so the camera accepts seq starting at 1
      const reset = sonyWrap(Buffer.from([0x01]), 0, 0x0200);
      sock.send(reset, this.port, this.ip);
      this.seq = 0;
    }
    return sock;
  }

  _ensureTcp() {
    if (this.tcpSocket && !this.tcpSocket.destroyed) return Promise.resolve(this.tcpSocket);
    if (this.tcpConnecting) return this.tcpConnecting;
    this.tcpConnecting = new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.ip, port: this.port, timeout: 3000 });
      sock.on('connect', () => {
        sock.setTimeout(0);
        sock.setNoDelay(true);
        this.tcpSocket = sock;
        this.tcpConnecting = null;
        resolve(sock);
      });
      sock.on('data', (msg) => {
        if (this.onMessage) this.onMessage(msg, { address: this.ip, port: this.port });
      });
      const fail = (err) => {
        this.tcpConnecting = null;
        if (this.tcpSocket === sock) this.tcpSocket = null;
        sock.destroy();
        reject(err instanceof Error ? err : new Error('TCP connect failed'));
      };
      sock.on('timeout', () => fail(new Error('TCP connect timeout')));
      sock.on('error', fail);
      sock.on('close', () => {
        if (this.tcpSocket === sock) this.tcpSocket = null;
      });
    });
    return this.tcpConnecting;
  }

  /**
   * Send a raw VISCA payload using the configured transport.
   *
   * Commands are PACED rather than written straight to the wire. Pan/tilt and
   * zoom drives come from a 60 Hz control loop (stick smoothing ramp, AI
   * tracker), which overruns the camera's two-command buffer in a fraction of
   * a second. Once it is full the camera NAKs or defers what arrives next, so
   * a discrete command — a preset recall — can execute *behind* a drive
   * command that is already stale. The camera reaches the preset and is then
   * dragged off it: the "bounce".
   *
   * Options:
   *   key       marks this command as superseding any queued command with the
   *             same key, so a burst of drive updates collapses to the newest
   *             value instead of piling up. It keeps the superseded command's
   *             place in the queue, so ordering is never rearranged — a stop
   *             queued ahead of a preset recall still lands first.
   *   immediate bypasses the queue. Used for inquiries, which the camera
   *             answers from a separate socket and never buffers behind
   *             commands.
   */
  send(payload, { inquiry = false, key = null, immediate = false } = {}) {
    if (this.closed) return Promise.resolve();
    if (immediate || !this.minGapMs) return this._write(payload, inquiry);
    if (key) {
      const pending = this.queue.find((e) => e.key === key);
      if (pending) {
        pending.payload = payload; // latest value wins, same queue slot
        pending.inquiry = inquiry;
        return pending.done;
      }
    }
    const entry = { payload, inquiry, key, done: null, resolve: null };
    entry.done = new Promise((resolve) => { entry.resolve = resolve; });
    this.queue.push(entry);
    this._pump();
    return entry.done;
  }

  /** Write the head of the queue as soon as the minimum gap has elapsed. */
  _pump() {
    if (this.pumpTimer || this.closed || this.queue.length === 0) return;
    const wait = this.minGapMs - (Date.now() - this.lastWriteTs);
    if (wait <= 0) {
      this._drain();
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this._drain();
    }, wait);
  }

  _drain() {
    const entry = this.queue.shift();
    if (!entry) return;
    this.lastWriteTs = Date.now();
    // Movement commands are fire-and-forget; a transport failure must not
    // become an unhandled rejection or stall the rest of the queue.
    this._write(entry.payload, entry.inquiry).then(entry.resolve, entry.resolve);
    this._pump();
  }

  async _write(payload, inquiry = false) {
    if (this.closed) return;
    if (this.protocol === 'tcp') {
      const sock = await this._ensureTcp();
      sock.write(payload);
      return;
    }
    const sock = this._ensureUdp();
    let out = payload;
    if (this.protocol === 'udp-sony') {
      this.seq = (this.seq + 1) >>> 0;
      out = sonyWrap(payload, this.seq, inquiry ? 0x0110 : 0x0100);
    }
    await new Promise((resolve) => sock.send(out, this.port, this.ip, () => resolve()));
  }

  /**
   * Send an inquiry and wait for any reply (used as a reachability test).
   * Resolves true if the camera answered within timeoutMs.
   */
  async test(timeoutMs = 1500) {
    try {
      const replied = new Promise((resolve) => {
        const timer = setTimeout(() => { this.onMessage = null; resolve(false); }, timeoutMs);
        this.onMessage = () => {
          clearTimeout(timer);
          this.onMessage = null;
          resolve(true);
        };
      });
      await this.send(VISCA.versionInquiry(), { inquiry: true, immediate: true });
      return await replied;
    } catch {
      return false;
    }
  }

  close() {
    this.closed = true;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    // Never leave a caller awaiting a command this connection will never send.
    for (const entry of this.queue) entry.resolve();
    this.queue = [];
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch { /* already closed */ }
      this.udpSocket = null;
    }
    if (this.tcpSocket) {
      this.tcpSocket.destroy();
      this.tcpSocket = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Connection pool keyed by camera id
// ---------------------------------------------------------------------------

class ViscaPool {
  constructor() {
    this.conns = new Map();
  }

  get(camera) {
    const key = camera.id;
    const existing = this.conns.get(key);
    if (
      existing &&
      existing.ip === camera.ip &&
      existing.port === camera.port &&
      existing.protocol === camera.protocol
    ) {
      return existing;
    }
    if (existing) existing.close();
    const conn = new ViscaConnection(camera);
    this.conns.set(key, conn);
    return conn;
  }

  remove(cameraId) {
    const existing = this.conns.get(cameraId);
    if (existing) {
      existing.close();
      this.conns.delete(cameraId);
    }
  }

  closeAll() {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
  }
}

module.exports = {
  VISCA, ViscaConnection, ViscaPool, sonyWrap, sonyUnwrap, MIN_SEND_GAP_MS, DRIVE_KEYS,
};
