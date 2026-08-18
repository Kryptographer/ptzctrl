'use strict';

/**
 * Self-healing continuous drives.
 *
 * Pan/tilt, zoom and focus are *velocity* commands riding (usually) on UDP:
 * the camera keeps doing whatever it last heard until told otherwise. One
 * lost packet therefore has outsized consequences — a lost stop leaves the
 * camera panning off into the wall on live air; a lost speed update leaves
 * it moving at the wrong rate. The renderer only emits on *change*, so
 * nothing would ever correct the drift.
 *
 * The keeper sits between the IPC handlers and the VISCA connections and
 * makes the wire converge on the intended state:
 *
 *   - every drive command is forwarded immediately, exactly as before;
 *   - while a drive is non-zero, the current value is re-sent every
 *     `intervalMs` (the standard joystick-controller pattern — cameras treat
 *     repeated identical drives as a no-op);
 *   - when a drive returns to zero, the stop is re-sent once more on the
 *     next refresh tick, so a single lost datagram can't strand a moving
 *     camera. After that the keeper goes quiet (no idle traffic).
 *
 * Absolute moves (preset recall, home) are the exception: a pan/tilt drive
 * command — even a stop — arriving *during* a recall interrupts it on many
 * cameras, which is exactly the "preset bounce" this app already fixed once.
 * `absoluteMove()` is called when a recall/home is issued and cancels any
 * still-pending stop repeats so the keeper stays silent while the camera
 * flies to its target.
 */
class DriveKeeper {
  /**
   * @param {(id: string, kind: 'panTilt'|'zoom'|'focus', a: number, b?: number) => void} send
   * @param {{intervalMs?: number, stopRepeats?: number}} [opts]
   */
  constructor(send, { intervalMs = 300, stopRepeats = 1 } = {}) {
    this.sendFn = send;
    this.intervalMs = intervalMs;
    this.stopRepeats = stopRepeats;
    this.state = new Map(); // camId -> {pan,tilt,zoom,focus,ptStops,zStops,fStops,timer}
  }

  _st(id) {
    let st = this.state.get(id);
    if (!st) {
      st = {
        pan: 0, tilt: 0, zoom: 0, focus: 0,
        // Start "already repeated": there is nothing to re-stop before the
        // first drive ever goes out.
        ptStops: this.stopRepeats,
        zStops: this.stopRepeats,
        fStops: this.stopRepeats,
        timer: null,
      };
      this.state.set(id, st);
    }
    return st;
  }

  _arm(id, st) {
    if (!st.timer) {
      st.timer = setInterval(() => this._tick(id, st), this.intervalMs);
      // Never keep the process alive just to babysit an idle camera.
      if (st.timer.unref) st.timer.unref();
    }
  }

  panTilt(id, pan, tilt) {
    const st = this._st(id);
    st.pan = pan;
    st.tilt = tilt;
    st.ptStops = 0;
    this.sendFn(id, 'panTilt', pan, tilt);
    this._arm(id, st);
  }

  zoom(id, speed) {
    const st = this._st(id);
    st.zoom = speed;
    st.zStops = 0;
    this.sendFn(id, 'zoom', speed);
    this._arm(id, st);
  }

  focus(id, speed) {
    const st = this._st(id);
    st.focus = speed;
    st.fStops = 0;
    this.sendFn(id, 'focus', speed);
    this._arm(id, st);
  }

  /**
   * An absolute move (preset recall / home) is taking the camera over: stand
   * down. Zero the remembered drives and cancel pending stop repeats so no
   * keeper traffic lands mid-recall and drags the camera off its target.
   */
  absoluteMove(id) {
    const st = this.state.get(id);
    if (!st) return;
    st.pan = st.tilt = st.zoom = st.focus = 0;
    st.ptStops = this.stopRepeats;
    st.zStops = this.stopRepeats;
    st.fStops = this.stopRepeats;
  }

  _tick(id, s) {
    let live = false;
    if (s.pan || s.tilt) {
      this.sendFn(id, 'panTilt', s.pan, s.tilt);
      live = true;
    } else if (s.ptStops < this.stopRepeats) {
      s.ptStops++;
      this.sendFn(id, 'panTilt', 0, 0);
      live = true;
    }
    if (s.zoom) {
      this.sendFn(id, 'zoom', s.zoom);
      live = true;
    } else if (s.zStops < this.stopRepeats) {
      s.zStops++;
      this.sendFn(id, 'zoom', 0);
      live = true;
    }
    if (s.focus) {
      this.sendFn(id, 'focus', s.focus);
      live = true;
    } else if (s.fStops < this.stopRepeats) {
      s.fStops++;
      this.sendFn(id, 'focus', 0);
      live = true;
    }
    if (!live && s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }

  /** Forget a camera (removed / reconfigured). */
  remove(id) {
    const st = this.state.get(id);
    if (st && st.timer) clearInterval(st.timer);
    this.state.delete(id);
  }

  dispose() {
    for (const st of this.state.values()) {
      if (st.timer) clearInterval(st.timer);
    }
    this.state.clear();
  }
}

module.exports = { DriveKeeper };
