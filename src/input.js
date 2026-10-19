/**
 * Keyboard + gamepad input with analog smoothing.
 *
 * Steering convention (matches Rapier + our +Z-forward car):
 *   steer > 0  -> turn LEFT  (+X)
 *   steer < 0  -> turn RIGHT (-X)
 */

/** One-shot actions the game loop polls via input.consume(). */
export const ACTION = {
  RESET: 'reset',
  CAMERA: 'camera',
  PAUSE: 'pause',
  DEBUG: 'debug',
  MUTE: 'mute',
};

const MOVE_TOWARD = (current, target, maxDelta) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

export class Input {
  constructor(config) {
    this.cfg = config.input;
    this.keys = new Set();
    this.actions = new Set();

    // Analog state, smoothed over time.
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = 0;

    this.gamepadIndex = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onGamepad = this._onGamepad.bind(this);
  }

  attach(target = window) {
    this.target = target;
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepad);
    window.addEventListener('gamepaddisconnected', this._onGamepad);
    // Stop the browser from scrolling the page with arrows/space.
    target.addEventListener('keydown', this._preventScroll, { passive: false });
  }

  detach() {
    const t = this.target;
    if (!t) return;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    t.removeEventListener('keydown', this._preventScroll);
    window.removeEventListener('gamepadconnected', this._onGamepad);
    window.removeEventListener('gamepaddisconnected', this._onGamepad);
  }

  _preventScroll(e) {
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1'].includes(e.code)
    ) {
      e.preventDefault();
    }
  }

  _onKeyDown(e) {
    // Let the browser handle devtools shortcuts.
    if (e.metaKey || e.ctrlKey) return;
    if (!this.keys.has(e.code)) this._mapAction(e.code);
    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  /** Releasing focus should not leave the throttle stuck on. */
  _onBlur() {
    this.keys.clear();
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = 0;
  }

  _onGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const found = [...pads].findIndex((p) => p && p.connected);
    this.gamepadIndex = found === -1 ? null : found;
  }

  _mapAction(code) {
    switch (code) {
      case 'KeyR': this.actions.add(ACTION.RESET); break;
      case 'KeyC': this.actions.add(ACTION.CAMERA); break;
      case 'Escape': this.actions.add(ACTION.PAUSE); break;
      case 'F1': this.actions.add(ACTION.DEBUG); break;
      case 'KeyM': this.actions.add(ACTION.MUTE); break;
      default: break;
    }
  }

  /** True once per press. Clears the flag. */
  consume(action) {
    if (!this.actions.has(action)) return false;
    this.actions.delete(action);
    return true;
  }

  _readGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    let pad = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    if (!pad || !pad.connected) {
      const found = [...pads].find((p) => p && p.connected);
      if (!found) return null;
      this.gamepadIndex = found.index;
      pad = found;
    }
    return pad;
  }

  /**
   * Advance the analog state and return the current control frame.
   * @param {number} dt seconds
   */
  read(dt) {
    const dz = this.cfg.gamepadDeadzone;
    const pad = this._readGamepad();

    // ---- raw digital axes -------------------------------------------
    let throttleTarget = 0;
    let brakeTarget = 0;
    let steerTarget = 0;
    let handbrakeTarget = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttleTarget = 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) brakeTarget = 1;
    if (this.keys.has('Space')) handbrakeTarget = 1;

    // steer > 0 = left
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steerTarget += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steerTarget -= 1;

    // ---- gamepad overrides (analog) ---------------------------------
    if (pad) {
      const axis = pad.axes[0] ?? 0;
      // Stick left (negative) should mean "turn left" (positive steer).
      if (Math.abs(axis) > dz) steerTarget = -axis;

      const rt = pad.buttons[7]?.value ?? 0;   // right trigger = throttle
      const lt = pad.buttons[6]?.value ?? 0;   // left trigger  = brake
      if (rt > 0.02) throttleTarget = rt;
      if (lt > 0.02) brakeTarget = lt;
      if (pad.buttons[0]?.pressed) handbrakeTarget = 1;

      for (const b of pad.buttons) {
        if (b.pressed && b.value > 0) { /* no-op, reserved */ }
      }
      if (pad.buttons[9]?.pressed) this.actions.add(ACTION.PAUSE);
      if (pad.buttons[3]?.pressed) this.actions.add(ACTION.CAMERA);
      if (pad.buttons[2]?.pressed) this.actions.add(ACTION.RESET);
    }

    // ---- smoothing ---------------------------------------------------
    const c = this.cfg;
    // Steering: attack faster than release so centring feels natural.
    const steerRate =
      steerTarget !== 0 && Math.sign(steerTarget) !== Math.sign(this.steer)
        ? c.steerRelease
        : steerTarget !== 0
          ? c.steerAttack
          : c.steerRelease;

    this.steer = MOVE_TOWARD(this.steer, steerTarget, steerRate * dt);
    this.throttle = MOVE_TOWARD(
      this.throttle,
      throttleTarget,
      (throttleTarget > this.throttle ? c.throttleUp : c.throttleDown) * dt,
    );
    this.brake = MOVE_TOWARD(
      this.brake,
      brakeTarget,
      (brakeTarget > this.brake ? c.brakeUp : c.brakeDown) * dt,
    );
    this.handbrake = MOVE_TOWARD(this.handbrake, handbrakeTarget, 8 * dt);

    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.handbrake,
      raw: {
        throttle: throttleTarget,
        brake: brakeTarget,
        steer: steerTarget,
        handbrake: handbrakeTarget,
      },
    };
  }
}
