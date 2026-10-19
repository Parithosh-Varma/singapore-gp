/**
 * HUD: speed, gear, RPM bar, plus the loading / error / pause overlays.
 * Everything here is plain DOM — no UI framework, negligible cost.
 */

const rpmColor = (ratio) => {
  if (ratio > 0.94) return '#ff2d55';
  if (ratio > 0.82) return '#ffb020';
  return '#4dd07a';
};

export class HUD {
  constructor() {
    this.el = {
      hud: document.getElementById('hud'),
      speed: document.getElementById('hud-speed'),
      gear: document.getElementById('hud-gear'),
      rpmFill: document.getElementById('hud-rpm-fill'),
      loading: document.getElementById('loading'),
      loadingBar: document.getElementById('loading-bar-fill'),
      loadingStatus: document.getElementById('loading-status'),
      error: document.getElementById('error'),
      errorMessage: document.getElementById('error-message'),
      errorDetail: document.getElementById('error-detail'),
      paused: document.getElementById('overlay-paused'),
      debug: document.getElementById('debug'),
    };

    this._lastSpeed = -1;
    this._lastGear = null;
    this._lastRpmPct = -1;
  }

  /* ------------------------------ loading --------------------------- */

  setLoading(progress, text) {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (this.el.loadingBar) this.el.loadingBar.style.width = `${pct}%`;
    if (this.el.loadingStatus && text != null) this.el.loadingStatus.textContent = text;
  }

  hideLoading() {
    this.el.loading?.classList.add('hidden');
    this.el.hud?.classList.remove('hidden');
  }

  showError(message, detail = '') {
    this.el.loading?.classList.add('hidden');
    this.el.hud?.classList.add('hidden');
    if (this.el.errorMessage) this.el.errorMessage.textContent = message;
    if (this.el.errorDetail) this.el.errorDetail.textContent = detail;
    this.el.error?.classList.remove('hidden');
  }

  /* ------------------------------ pause ----------------------------- */

  setPaused(paused) {
    this.el.paused?.classList.toggle('hidden', !paused);
  }

  /* ------------------------------ debug ----------------------------- */

  setDebug(visible, text = '') {
    if (!this.el.debug) return;
    this.el.debug.classList.toggle('hidden', !visible);
    if (visible) this.el.debug.textContent = text;
  }

  /* ------------------------------ frame ----------------------------- */

  /** @param {any} t car telemetry */
  update(t) {
    const speed = Math.round(t.speedKmh);
    if (speed !== this._lastSpeed) {
      this.el.speed.textContent = String(speed);
      this._lastSpeed = speed;
    }

    if (t.gearLabel !== this._lastGear) {
      this.el.gear.textContent = t.gearLabel;
      this._lastGear = t.gearLabel;
    }

    const span = Math.max(1, t.redlineRPM - t.idleRPM);
    const ratio = Math.max(0, Math.min(1, (t.rpm - t.idleRPM) / span));
    const pct = Math.round(ratio * 100);
    if (pct !== this._lastRpmPct) {
      this.el.rpmFill.style.width = `${pct}%`;
      this.el.rpmFill.style.backgroundColor = rpmColor(ratio);
      this._lastRpmPct = pct;
    }
  }
}
