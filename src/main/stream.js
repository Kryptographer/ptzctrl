'use strict';

/**
 * Live video relay.
 *
 * Chromium cannot play RTSP directly, so the main process runs a tiny local
 * HTTP server that spawns ffmpeg per viewer: ffmpeg pulls the camera's RTSP
 * stream and re-muxes it to multipart MJPEG, which renders natively in an
 * <img> tag in the renderer.
 *
 *   GET /stream/<cameraId>  ->  multipart/x-mixed-replace MJPEG
 *
 * The ffmpeg child is killed as soon as the viewer disconnects.
 */

const http = require('http');
const { spawn } = require('child_process');

function resolveFfmpeg() {
  try {
    // Bundled binary (works in production; electron-builder unpacks it).
    const p = require('ffmpeg-static');
    if (p) return p.replace('app.asar', 'app.asar.unpacked');
  } catch { /* not installed */ }
  return 'ffmpeg'; // hope it's on PATH
}

/**
 * Strip credentials out of a URL before it goes anywhere a person can see it.
 * ffmpeg echoes the input URL in its error lines, and those lines end up in
 * the live view and in bug reports — a camera password should not ride along.
 */
function redactUrl(text) {
  if (!text) return text;
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***:***@');
}

/** ffmpeg args to turn an input URL into multipart MJPEG on stdout. */
function defaultInputArgs(url) {
  const args = ['-nostdin', '-loglevel', 'error', '-nostats'];
  if (url.startsWith('rtsp://')) {
    // -timeout is the rtsp socket timeout in microseconds (ffmpeg >= 5);
    // without it a wrong IP/port hangs forever instead of failing.
    args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  }
  args.push(
    '-i', url,
    '-an',
    '-vf', "scale='min(1280,iw)':-2",
    '-q:v', '6',
    '-r', '15',
    '-f', 'mpjpeg',
    '-',
  );
  return args;
}

/** Check that the ffmpeg binary actually runs; returns {found, path, version}. */
function checkFfmpeg(ffmpegPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ found: false, path: ffmpegPath, error: err.message });
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => resolve({ found: false, path: ffmpegPath, error: err.message }));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ found: true, path: ffmpegPath, version: (out.split('\n')[0] || '').trim() });
      } else {
        resolve({ found: false, path: ffmpegPath, error: `ffmpeg exited with code ${code}` });
      }
    });
  });
}

/**
 * Try to pull one decoded frame from a URL. Resolves {ok} or {ok:false, error}
 * with the last line of ffmpeg's stderr (the actual reason: auth required,
 * connection refused, 404 on the path, etc).
 */
function probeUrl(ffmpegPath, url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const args = ['-nostdin', '-loglevel', 'error'];
    if (url.startsWith('rtsp://')) args.push('-rtsp_transport', 'tcp', '-timeout', '5000000');
    args.push('-i', url, '-frames:v', '1', '-f', 'null', '-');
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: redactUrl(err.message) });
      return;
    }
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: redactUrl(err.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { resolve({ ok: true }); return; }
      const lastLine = redactUrl(stderr.trim().split('\n').filter(Boolean).pop());
      resolve({ ok: false, error: timedOut ? 'timed out' : (lastLine || `ffmpeg exit ${code}`) });
    });
  });
}

/**
 * Common stream paths: PTZ cams (Tongveo/Fomako/PTZOptics), Hikvision &
 * Dahua cameras/NVRs, Yi cameras with RTSP firmware, and Android phone
 * camera apps (IP Webcam MJPEG on 8080, RTSP apps on 8554).
 */
function candidateUrls(ip) {
  return [
    `rtsp://${ip}:554/1`,
    `rtsp://${ip}:554/2`,
    `rtsp://${ip}:554/live/av0`,
    `rtsp://${ip}:554/live/av1`,
    `rtsp://${ip}:554/main`,
    `rtsp://${ip}:554/media/video1`,
    `rtsp://${ip}:554/h264/ch1/main/av_stream`,
    `rtsp://${ip}:554/cam/realmonitor?channel=1&subtype=0`,
    `rtsp://${ip}:554/Streaming/Channels/101`,
    `rtsp://${ip}:554/Streaming/Channels/102`,
    `rtsp://${ip}/ch0_0.h264`,
    `rtsp://${ip}:554/stream1`,
    `rtsp://${ip}:8554/live`,
    `http://${ip}:8080/video`,
    `rtsp://admin:admin@${ip}:554/1`,
    `rtsp://admin:admin@${ip}:554/2`,
  ];
}

/**
 * Probe candidate URLs (in small parallel batches, order-preserving) and
 * return the first that yields a frame: {ok, url} or {ok:false, errors}.
 */
async function findStreamUrl(ffmpegPath, ip, { onProgress } = {}) {
  const candidates = candidateUrls(ip);
  const errors = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    if (onProgress) onProgress({ tried: i, total: candidates.length });
    const results = await Promise.all(
      batch.map((url) => probeUrl(ffmpegPath, url, 8000).then((r) => ({ url, ...r })))
    );
    for (const r of results) {
      if (r.ok) return { ok: true, url: r.url };
      errors.push(`${redactUrl(r.url)} — ${r.error}`);
    }
  }
  return { ok: false, errors };
}

class StreamManager {
  /**
   * @param {(cameraId: string) => ({streamUrl?: string, ip?: string} | null)} getCamera
   * @param {{inputArgsFor?: (url: string) => string[], ffmpegPath?: string}} [opts]
   */
  constructor(getCamera, opts = {}) {
    this.getCamera = getCamera;
    this.inputArgsFor = opts.inputArgsFor || defaultInputArgs;
    this.ffmpegPath = opts.ffmpegPath || resolveFfmpeg();
    this.server = null;
    this.port = null;
    this.children = new Set();
  }

  /** Start the local HTTP server; resolves with the bound port. */
  start() {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  urlFor(cameraId) {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/stream/${encodeURIComponent(cameraId)}`;
  }

  _handle(req, res) {
    // The renderer reads this stream with fetch() from a file:// origin, so
    // every response (including errors) must be CORS-readable.
    const CORS = { 'Access-Control-Allow-Origin': '*' };
    const m = /^\/stream\/([^/?]+)/.exec(req.url || '');
    if (!m) {
      res.writeHead(404, CORS);
      res.end('not found');
      return;
    }
    const cameraId = decodeURIComponent(m[1]);
    const cam = this.getCamera(cameraId);
    if (!cam) {
      res.writeHead(404, CORS);
      res.end('unknown camera');
      return;
    }
    const url = cam.streamUrl || (cam.ip ? `rtsp://${cam.ip}:554/1` : null);
    if (!url) {
      res.writeHead(503, CORS);
      res.end('no stream url configured for this camera');
      return;
    }

    let child;
    try {
      child = spawn(this.ffmpegPath, this.inputArgsFor(url), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      res.writeHead(503, CORS);
      res.end(`ffmpeg unavailable: ${err.message}`);
      return;
    }
    this.children.add(child);

    let headersSent = false;
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      if (!headersSent) {
        headersSent = true;
        res.writeHead(200, {
          ...CORS,
          // ffmpeg's mpjpeg muxer uses the literal boundary "ffmpeg"
          'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
      }
      res.write(chunk);
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    const cleanup = () => {
      this.children.delete(child);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };
    child.on('error', () => {
      if (!headersSent) {
        res.writeHead(503, CORS);
        res.end('ffmpeg not found — rerun build.bat (or npm install) to fetch the bundled ffmpeg');
      } else {
        res.end();
      }
      cleanup();
    });
    child.on('close', (code) => {
      if (!headersSent) {
        const reason = redactUrl(stderrTail.trim().split('\n').filter(Boolean).pop()) || 'no output from ffmpeg';
        res.writeHead(502, CORS);
        res.end(`Cannot open stream: ${reason}`);
      } else {
        res.end();
      }
      cleanup();
    });
    res.on('close', cleanup);
  }

  diagnose() {
    return checkFfmpeg(this.ffmpegPath);
  }

  probe(url, timeoutMs) {
    return probeUrl(this.ffmpegPath, url, timeoutMs);
  }

  findStream(ip, opts) {
    return findStreamUrl(this.ffmpegPath, ip, opts);
  }

  stopAll() {
    for (const child of this.children) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.children.clear();
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.port = null;
    }
  }
}

module.exports = {
  StreamManager,
  defaultInputArgs,
  checkFfmpeg,
  probeUrl,
  candidateUrls,
  findStreamUrl,
  redactUrl,
};
