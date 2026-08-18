'use strict';

/**
 * Camera auto-discovery.
 *
 * Three parallel strategies, results merged and de-duplicated by IP:
 *
 *  1. ONVIF WS-Discovery: multicast SOAP Probe to 239.255.255.250:3702.
 *     Most network PTZ cameras (including Tongveo / Fomako) answer with
 *     their XAddrs service URL, which contains their IP.
 *
 *  2. UDP VISCA probe: broadcast + per-host CAM_VersionInq on the common
 *     raw-VISCA UDP port (1259) and the Sony VISCA-over-IP port (52381).
 *     Any host that answers speaks VISCA.
 *
 *  3. TCP port sweep: attempt connections to the common VISCA TCP port
 *     (5678) across every local /24 subnet.
 */

const dgram = require('dgram');
const net = require('net');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { VISCA, sonyWrap } = require('./visca');

const WS_DISCOVERY_ADDR = '239.255.255.250';
const WS_DISCOVERY_PORT = 3702;
const VISCA_UDP_PORT = 1259;
const VISCA_SONY_PORT = 52381;
const VISCA_TCP_PORT = 5678;

function localSubnets() {
  const nets = os.networkInterfaces();
  const subnets = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const parts = ni.address.split('.').map(Number);
      // Only sweep /24-or-smaller networks to keep the scan fast.
      subnets.push({
        base: `${parts[0]}.${parts[1]}.${parts[2]}`,
        self: ni.address,
        broadcast: `${parts[0]}.${parts[1]}.${parts[2]}.255`,
      });
    }
  }
  // De-dup by base
  const seen = new Set();
  return subnets.filter((s) => (seen.has(s.base) ? false : (seen.add(s.base), true)));
}

function wsDiscoveryProbeXml() {
  const uuid = crypto.randomUUID();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
    ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"' +
    ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    '<e:Header>' +
    `<w:MessageID>uuid:${uuid}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
    '</e:Header>' +
    '<e:Body>' +
    '<d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>' +
    '</e:Body>' +
    '</e:Envelope>'
  );
}

/** ONVIF WS-Discovery sweep. Returns Map<ip, {name}> */
function onvifDiscover(timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve(found);
      return;
    }
    const done = () => {
      try { sock.close(); } catch { /* ignore */ }
      resolve(found);
    };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/ProbeMatch/i.test(text)) return;
      // Prefer the IP embedded in XAddrs (the camera's service address),
      // fall back to the sender address.
      let ip = rinfo.address;
      const xaddr = text.match(/https?:\/\/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
      if (xaddr) ip = xaddr[1];
      let name = 'ONVIF camera';
      const scopeName = text.match(/onvif:\/\/www\.onvif\.org\/name\/([^\s<"]+)/);
      if (scopeName) name = decodeURIComponent(scopeName[1]).replace(/_/g, ' ');
      if (!found.has(ip)) {
        found.set(ip, { name, source: 'onvif' });
        if (onProgress) onProgress({ type: 'found', ip, name, source: 'onvif' });
      }
    });
    sock.bind(0, () => {
      try {
        const probe = Buffer.from(wsDiscoveryProbeXml(), 'utf8');
        // Send a couple of probes; discovery is lossy UDP.
        sock.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDR);
        setTimeout(() => {
          try { sock.send(probe, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDR); } catch { /* ignore */ }
        }, 700);
      } catch { /* ignore */ }
      setTimeout(done, timeoutMs);
    });
  });
}

/** UDP VISCA probe on a given port. Returns Map<ip, info>. */
function udpViscaProbe(port, sonyFraming, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch {
      resolve(found);
      return;
    }
    const done = () => {
      try { sock.close(); } catch { /* ignore */ }
      resolve(found);
    };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      if (msg.length === 0) return;
      const ip = rinfo.address;
      if (!found.has(ip)) {
        const info = {
          name: sonyFraming ? 'VISCA camera (Sony/UDP)' : 'VISCA camera (UDP)',
          source: sonyFraming ? 'visca-udp-sony' : 'visca-udp',
          port,
          protocol: sonyFraming ? 'udp-sony' : 'udp',
        };
        found.set(ip, info);
        if (onProgress) onProgress({ type: 'found', ip, ...info });
      }
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      let payload = VISCA.versionInquiry();
      if (sonyFraming) payload = sonyWrap(payload, 1, 0x0110);
      const targets = [];
      for (const sn of localSubnets()) {
        targets.push(sn.broadcast);
        // Broadcast is often filtered; also probe every host directly.
        for (let i = 1; i <= 254; i++) {
          const ip = `${sn.base}.${i}`;
          if (ip !== sn.self) targets.push(ip);
        }
      }
      // Stagger sends so we don't flood the interface.
      let idx = 0;
      const batch = () => {
        const end = Math.min(idx + 32, targets.length);
        for (; idx < end; idx++) {
          try { sock.send(payload, port, targets[idx]); } catch { /* ignore */ }
        }
        if (idx < targets.length) setTimeout(batch, 15);
      };
      batch();
      setTimeout(done, timeoutMs);
    });
  });
}

/** TCP sweep of the common VISCA TCP port. Returns Map<ip, info>. */
function tcpViscaSweep(port, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const found = new Map();
    const targets = [];
    for (const sn of localSubnets()) {
      for (let i = 1; i <= 254; i++) {
        const ip = `${sn.base}.${i}`;
        if (ip !== sn.self) targets.push(ip);
      }
    }
    if (targets.length === 0) {
      resolve(found);
      return;
    }
    let inFlight = 0;
    let idx = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve(found);
    };
    const overall = setTimeout(finish, timeoutMs);
    const next = () => {
      if (finished) return;
      if (idx >= targets.length && inFlight === 0) {
        clearTimeout(overall);
        finish();
        return;
      }
      while (inFlight < 64 && idx < targets.length) {
        const ip = targets[idx++];
        inFlight++;
        const sock = net.connect({ host: ip, port, timeout: 600 });
        const end = (ok) => {
          sock.destroy();
          inFlight--;
          if (ok && !found.has(ip)) {
            const info = { name: 'VISCA camera (TCP)', source: 'visca-tcp', port, protocol: 'tcp' };
            found.set(ip, info);
            if (onProgress) onProgress({ type: 'found', ip, ...info });
          }
          next();
        };
        sock.once('connect', () => end(true));
        sock.once('timeout', () => end(false));
        sock.once('error', () => end(false));
      }
    };
    next();
  });
}

/** Generic TCP sweep: which hosts on local /24 subnets have `port` open? */
function tcpOpenSweep(port, timeoutMs) {
  return new Promise((resolve) => {
    const open = new Set();
    const targets = [];
    for (const sn of localSubnets()) {
      for (let i = 1; i <= 254; i++) {
        const ip = `${sn.base}.${i}`;
        if (ip !== sn.self) targets.push(ip);
      }
    }
    if (targets.length === 0) {
      resolve(open);
      return;
    }
    let inFlight = 0;
    let idx = 0;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve(open);
      }
    };
    const overall = setTimeout(finish, timeoutMs);
    const next = () => {
      if (finished) return;
      if (idx >= targets.length && inFlight === 0) {
        clearTimeout(overall);
        finish();
        return;
      }
      while (inFlight < 64 && idx < targets.length) {
        const ip = targets[idx++];
        inFlight++;
        const sock = net.connect({ host: ip, port, timeout: 600 });
        const end = (ok) => {
          sock.destroy();
          inFlight--;
          if (ok) open.add(ip);
          next();
        };
        sock.once('connect', () => end(true));
        sock.once('timeout', () => end(false));
        sock.once('error', () => end(false));
      }
    };
    next();
  });
}

/** Does this host serve MJPEG at http://ip:port/path (e.g. Android IP Webcam)? */
function checkMjpeg(ip, port, path, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path, timeout: timeoutMs }, (res) => {
      const ct = res.headers['content-type'] || '';
      req.destroy();
      resolve(/multipart\/x-mixed-replace|image\/jpeg|video/i.test(ct));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Find Android phones / generic IP cameras serving video on the LAN:
 *  - port 8080 with an MJPEG /video endpoint (Android "IP Webcam" app)
 *  - port 8554 RTSP (common phone RTSP-server apps, some IP cams)
 * Returns Map<ip, {name, type:'ip', streamUrl, source}>.
 */
async function phoneCameraScan(timeoutMs, onProgress) {
  const found = new Map();
  const [open8080, open8554] = await Promise.all([
    tcpOpenSweep(8080, timeoutMs),
    tcpOpenSweep(8554, timeoutMs),
  ]);
  await Promise.all(
    [...open8080].map(async (ip) => {
      if (await checkMjpeg(ip, 8080, '/video')) {
        const info = {
          name: 'Android phone camera (IP Webcam)',
          type: 'ip',
          streamUrl: `http://${ip}:8080/video`,
          source: 'phone-mjpeg',
        };
        found.set(ip, info);
        if (onProgress) onProgress({ type: 'found', ip, ...info });
      }
    })
  );
  for (const ip of open8554) {
    if (found.has(ip)) continue;
    const info = {
      name: 'RTSP camera (phone / IP cam)',
      type: 'ip',
      streamUrl: `rtsp://${ip}:8554/live`,
      source: 'rtsp-8554',
    };
    found.set(ip, info);
    if (onProgress) onProgress({ type: 'found', ip, ...info });
  }
  return found;
}

/**
 * Run all discovery strategies in parallel.
 * @returns {Promise<Array<{ip, name, port, protocol, source}>>}
 */
async function discoverCameras({ timeoutMs = 6000, onProgress } = {}) {
  const [onvif, udpRaw, udpSony, tcp, phones] = await Promise.all([
    onvifDiscover(timeoutMs, onProgress),
    udpViscaProbe(VISCA_UDP_PORT, false, timeoutMs, onProgress),
    udpViscaProbe(VISCA_SONY_PORT, true, timeoutMs, onProgress),
    tcpViscaSweep(VISCA_TCP_PORT, timeoutMs, onProgress),
    phoneCameraScan(timeoutMs, onProgress),
  ]);

  // Merge: prefer entries that already know a working VISCA transport,
  // then enrich names from ONVIF.
  const merged = new Map();
  const put = (ip, info) => {
    const cur = merged.get(ip) || {};
    merged.set(ip, { ...cur, ...info, ip });
  };
  for (const [ip, info] of tcp) put(ip, info);
  for (const [ip, info] of udpSony) put(ip, info);
  for (const [ip, info] of udpRaw) put(ip, info);
  for (const [ip, info] of onvif) {
    const cur = merged.get(ip);
    if (cur) {
      // Keep transport details, take the friendlier ONVIF name.
      put(ip, { name: info.name });
    } else {
      // ONVIF device that doesn't answer VISCA: it's a video-only IP camera
      // (Hikvision/Dahua cam or NVR, Yi, etc). Find-stream can refine the URL.
      put(ip, { ...info, type: 'ip', streamUrl: `rtsp://${ip}:554/1` });
    }
  }
  for (const [ip, info] of phones) {
    if (!merged.has(ip)) put(ip, info);
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.ip.split('.').map(Number).reduce((acc, n) => acc * 256 + n, 0) -
    b.ip.split('.').map(Number).reduce((acc, n) => acc * 256 + n, 0)
  );
}

module.exports = { discoverCameras, VISCA_UDP_PORT, VISCA_SONY_PORT, VISCA_TCP_PORT };
