'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { ViscaPool, VISCA, DRIVE_KEYS } = require('./visca');
const { discoverCameras } = require('./discovery');
const { Store } = require('./store');
const { StreamManager } = require('./stream');
const { XInputReader } = require('./xinput');
const { DriveKeeper } = require('./drivekeeper');

let win = null;
let tray = null;
let store = null;
let streams = null;
let nativePadTimer = null;
let quitting = false;      // true once the user actually chose to exit
let trayTipShown = false;  // balloon shown at most once per run
const pool = new ViscaPool();

// Velocity commands ride on lossy UDP; the keeper re-sends the current drive
// periodically and repeats stops once, so one dropped datagram can't strand a
// camera mid-pan (see drivekeeper.js). All drive traffic goes through it.
const keeper = new DriveKeeper((id, kind, a, b) => {
  const conn = connFor(id);
  if (!conn) return;
  if (kind === 'panTilt') {
    conn.send(VISCA.panTiltDrive(a, b), { key: DRIVE_KEYS.PAN_TILT }).catch(() => {});
  } else if (kind === 'zoom') {
    conn.send(VISCA.zoom(a), { key: DRIVE_KEYS.ZOOM }).catch(() => {});
  } else {
    conn.send(VISCA.focus(a), { key: DRIVE_KEYS.FOCUS }).catch(() => {});
  }
});

function getCamera(id) {
  return store.getAll().cameras.find((c) => c.id === id) || null;
}

function connFor(id) {
  const cam = getCamera(id);
  // Only VISCA cameras have a control endpoint. Local (USB/UVC) cameras are
  // driven by the renderer; 'ip' cameras are video-only. VISCA sends
  // silently no-op for both.
  if (!cam || (cam.type && cam.type !== 'visca')) return null;
  return pool.get(cam);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 680,
    minHeight: 500,
    backgroundColor: '#0f1115',
    title: 'PTZ CTRL',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep polling the controller and driving cameras when the window
      // is unfocused, minimized, or covered by other windows.
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Closing the window keeps the app alive in the system tray, so the
  // controller keeps driving cameras (background XInput) with zero windows
  // open. Actually exiting happens via the tray menu (or app quit).
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayTipShown && tray && process.platform === 'win32') {
      trayTipShown = true;
      try {
        tray.displayBalloon({
          title: 'PTZ CTRL is still running',
          content: 'The controller keeps working from the tray. Right-click the tray icon to quit.',
          iconType: 'info',
        });
      } catch { /* balloons unsupported — fine */ }
    }
  });
  win.on('closed', () => {
    if (nativePadTimer) {
      clearInterval(nativePadTimer);
      nativePadTimer = null;
    }
    win = null;
  });
  startNativeGamepad();
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function stopAllCameras() {
  if (!store) return;
  for (const cam of store.getAll().cameras) {
    if (cam.type && cam.type !== 'visca') continue; // renderer handles UVC
    keeper.panTilt(cam.id, 0, 0);
    keeper.zoom(cam.id, 0);
    keeper.focus(cam.id, 0);
  }
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  // Tray icons are tiny; hand the OS a pre-scaled image so it stays crisp.
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('PTZ CTRL');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PTZ CTRL', click: showWindow },
    { label: 'STOP ALL cameras', click: stopAllCameras },
    { type: 'separator' },
    {
      label: 'Quit PTZ CTRL',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// Poll the Xbox controller from the MAIN process via XInput and push each
// snapshot to the renderer. Unlike the renderer's Web Gamepad API, this keeps
// working when the app window is unfocused/minimized, so the controller drives
// cameras even while the user is clicking around in other apps. No-op on
// platforms where XInput isn't available; the renderer then falls back to the
// Web Gamepad API on its own.
function startNativeGamepad() {
  if (nativePadTimer) return;
  const reader = new XInputReader();
  if (!reader.available) return;
  nativePadTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('gamepad:native', reader.readFirst());
    } catch (_) {
      // window tearing down between the guard and the send — ignore
    }
  }, 16);
}

// Single instance: launching the app again (e.g. from the Start menu while
// it sits in the tray) just brings the existing window back.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  streams = new StreamManager((id) => getCamera(id));
  registerIpc();
  createTray();
  createWindow();
  app.on('activate', () => showWindow());
});

// With the tray keeping the app alive, this only fires while quitting (the
// close-to-tray handler hides the window instead of closing it).
app.on('window-all-closed', () => {
  keeper.dispose();
  pool.closeAll();
  if (streams) streams.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true; // let the window actually close instead of hiding to tray
  if (streams) streams.stopAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

function registerIpc() {
  // ------------------------- config -------------------------
  ipcMain.handle('config:get', () => store.getAll());
  ipcMain.handle('config:setMapping', (e, mapping) => store.setMapping(mapping));
  ipcMain.handle('config:resetMapping', () => store.resetMapping());
  ipcMain.handle('config:setSettings', (e, settings) => store.setSettings(settings));

  // ------------------------- cameras -------------------------
  ipcMain.handle('cameras:add', (e, cam) => store.addCamera(cam));
  ipcMain.handle('cameras:update', (e, id, patch) => {
    const cam = store.updateCamera(id, patch);
    if (cam) pool.remove(id); // force reconnect with new params
    return cam;
  });
  ipcMain.handle('cameras:remove', (e, id) => {
    keeper.remove(id);
    pool.remove(id);
    store.removeCamera(id);
    return store.getAll();
  });
  ipcMain.handle('cameras:setActive', (e, id) => store.setActiveCamera(id));
  ipcMain.handle('cameras:test', async (e, id) => {
    const cam = getCamera(id);
    if (!cam) return { ok: false, error: 'Unknown camera' };
    if (cam.type === 'local') return { ok: true, local: true }; // renderer verifies device presence
    if (cam.type === 'ip') {
      // Video-only camera: test by pulling one frame from the stream.
      if (!cam.streamUrl) return { ok: false, error: 'No stream URL' };
      const r = await streams.probe(cam.streamUrl, 8000);
      return { ok: r.ok, error: r.error };
    }
    const conn = connFor(id);
    if (!conn) return { ok: false, error: 'Unknown camera' };
    const ok = await conn.test();
    return { ok };
  });

  // ------------------------- discovery -------------------------
  let discovering = false;
  ipcMain.handle('discovery:run', async () => {
    if (discovering) return { running: true, found: [] };
    discovering = true;
    try {
      const found = await discoverCameras({
        timeoutMs: 6000,
        onProgress: (evt) => {
          if (win && !win.isDestroyed()) win.webContents.send('discovery:progress', evt);
        },
      });
      return { running: false, found };
    } finally {
      discovering = false;
    }
  });

  // ------------------------- AI tracking assets -------------------------
  // The renderer can't fetch() file:// URLs, so the ONNX runtime's wasm and
  // the tracker model are read here and handed over as bytes (once, cached
  // by the renderer). Failure is non-fatal: the renderer falls back to the
  // built-in correlation tracker.
  //
  // Model selection: the VitTrack model ships with the app; a user can drop
  // higher-accuracy models into <userData>/models/ (see README — smat.onnx
  // for SMAT, or vittrack.onnx to override the bundled file) and they take
  // priority. The profile tells the renderer which tensor layout to use.
  ipcMain.handle('ai:assets', async () => {
    const fs = require('fs');
    try {
      const userModels = path.join(app.getPath('userData'), 'models');
      const candidates = [
        { file: path.join(userModels, 'smat.onnx'), profile: 'smat' },
        { file: path.join(userModels, 'vittrack.onnx'), profile: 'vittrack' },
        {
          file: path.join(__dirname, '..', 'models', 'object_tracking_vittrack_2023sep.onnx'),
          profile: 'vittrack',
        },
      ];
      const found = candidates.find((c) => fs.existsSync(c.file));
      if (!found) return { ok: false, error: 'tracker model file missing' };
      const wasmPath = require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm');
      const [wasm, model] = await Promise.all([
        fs.promises.readFile(wasmPath),
        fs.promises.readFile(found.file),
      ]);
      return { ok: true, wasm, model, profile: found.profile };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ------------------------- live video -------------------------
  ipcMain.handle('stream:getUrl', async (e, id) => {
    const cam = getCamera(id);
    if (!cam) return { ok: false, error: 'Unknown camera' };
    try {
      await streams.start();
      // Cache-buster so a stopped viewer reconnects cleanly.
      return { ok: true, url: `${streams.urlFor(id)}?t=${Date.now()}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('stream:diagnose', () => streams.diagnose());
  ipcMain.handle('stream:find', async (e, id) => {
    const cam = getCamera(id);
    if (!cam) return { ok: false, errors: ['Unknown camera'] };
    const result = await streams.findStream(cam.ip, {
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('stream:findProgress', p);
      },
    });
    if (result.ok) store.updateCamera(id, { streamUrl: result.url });
    return result;
  });

  // ------------------------- VISCA control -------------------------
  // Movement commands are fire-and-forget; errors are swallowed so a dead
  // camera never breaks the control loop.
  const quiet = (p) => p.catch(() => {});

  // The three velocity commands go through the DriveKeeper, which forwards
  // them immediately (with the coalescing key — only the newest value per
  // axis group matters on the wire, see ViscaConnection.send()) and then
  // keeps re-sending the current state so a lost UDP packet self-heals.
  ipcMain.on('ptz:panTilt', (e, id, panSpeed, tiltSpeed) => keeper.panTilt(id, panSpeed, tiltSpeed));
  ipcMain.on('ptz:zoom', (e, id, speed) => keeper.zoom(id, speed));
  ipcMain.on('ptz:focus', (e, id, speed) => keeper.focus(id, speed));
  ipcMain.on('ptz:focusMode', (e, id, auto) => {
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.focusMode(auto)));
  });
  // Absolute moves stand the keeper down first: a drive command — even a
  // repeated stop — landing mid-recall interrupts the move on many cameras
  // (the "preset bounce" all over again).
  ipcMain.on('ptz:home', (e, id) => {
    keeper.absoluteMove(id);
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.panTiltHome()));
  });
  ipcMain.on('ptz:presetSave', (e, id, n) => {
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.presetSave(n)));
  });
  ipcMain.on('ptz:presetRecall', (e, id, n) => {
    keeper.absoluteMove(id);
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.presetRecall(n)));
  });
  ipcMain.on('ptz:power', (e, id, on) => {
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.power(on)));
  });
  ipcMain.on('ptz:menu', (e, id) => {
    const conn = connFor(id);
    if (conn) quiet(conn.send(VISCA.menuToggle()));
  });
  // Emergency stop: halt pan/tilt and zoom on every configured camera.
  // Shared with the tray's "STOP ALL cameras" menu item.
  ipcMain.on('ptz:stopAll', () => stopAllCameras());
}
