/**
 * Camera rig: chase cam with speed-based FOV, plus hood and cockpit views.
 * C cycles modes.
 */
import * as THREE from 'three';
import { quatToYaw } from './physics.js';

export const CAMERA_MODE = {
  CHASE: 'chase',
  HOOD: 'hood',
  COCKPIT: 'cockpit',
};

export const CAMERA_ORDER = [CAMERA_MODE.CHASE, CAMERA_MODE.HOOD, CAMERA_MODE.COCKPIT];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const UP = new THREE.Vector3(0, 1, 0);

/** Interpolate angles the short way round. */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Frame-rate independent smoothing factor. */
const smoothing = (rate, dt) => 1 - Math.exp(-rate * dt);

export class CameraRig {
  constructor(config, aspect) {
    this.config = config;
    this.camera = new THREE.PerspectiveCamera(
      config.camera.fovBase,
      aspect,
      config.camera.near,
      config.camera.far,
    );

    this.mode = CAMERA_MODE.CHASE;
    this.smoothYaw = 0;
    this.smoothPos = new THREE.Vector3();
    this.lateralOffset = 0;
    this.currentFov = config.camera.fovBase;
    this._initialised = false;
    this._needsSnap = true;

    this._tmpOffset = new THREE.Vector3();
    this._tmpTarget = new THREE.Vector3();
    this._cameraFlip = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this._needsSnap = true;
  }

  /** True when the camera sits inside the car, so the shell must be hidden. */
  get isCockpit() {
    return this.mode === CAMERA_MODE.COCKPIT;
  }

  cycleMode() {
    const i = CAMERA_ORDER.indexOf(this.mode);
    this.setMode(CAMERA_ORDER[(i + 1) % CAMERA_ORDER.length]);
    return this.mode;
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param {number} dt seconds
   * @param {ReturnType<import('./car.js').Car['telemetry']> extends never ? any : any} t car telemetry
   */
  update(dt, t) {
    const cfg = this.config.camera;

    // ---- speed-based FOV --------------------------------------------
    const speedRatio = clamp(t.speedMs / cfg.fovSpeedRef, 0, 1);
    const targetFov = cfg.fovBase + (cfg.fovMax - cfg.fovBase) * speedRatio;
    this.currentFov += (targetFov - this.currentFov) * smoothing(3.5, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    if (this.mode === CAMERA_MODE.CHASE) this._updateChase(dt, t);
    else this._updateOnboard(dt, t);
  }

  _updateChase(dt, t) {
    const cfg = this.config.camera.chase;

    const carYaw = quatToYaw(t.quaternion);

    if (this._needsSnap || !this._initialised) {
      this.smoothYaw = carYaw;
      this.lateralOffset = 0;
      this.smoothPos.copy(t.position).add(
        this._offsetFor(carYaw, 0, this._tmpOffset),
      );
      this._initialised = true;
      this._needsSnap = false;
    } else {
      this.smoothYaw = lerpAngle(this.smoothYaw, carYaw, smoothing(cfg.yawLerp, dt));
    }

    // Lean the camera to the outside of the corner.
    const targetLateral = -clamp(t.yawRate * 0.22, -1, 1) * cfg.lateralSwing;
    this.lateralOffset += (targetLateral - this.lateralOffset) * smoothing(4, dt);

    const desired = this._offsetFor(this.smoothYaw, this.lateralOffset, this._tmpOffset)
      .add(t.position);

    this.smoothPos.lerp(desired, smoothing(cfg.posLerp, dt));

    // Never let the camera dip below the road.
    if (this.smoothPos.y < 0.6) this.smoothPos.y = 0.6;

    this.camera.position.copy(this.smoothPos);

    this._tmpTarget
      .set(0, cfg.lookHeight, cfg.lookAhead)
      .applyAxisAngle(UP, this.smoothYaw)
      .add(t.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._tmpTarget);
  }

  /** Chase offset in world space for a given yaw. */
  _offsetFor(yaw, lateral, out) {
    const cfg = this.config.camera.chase;
    return out
      .set(lateral, cfg.height, -cfg.distance)
      .applyAxisAngle(UP, yaw);
  }

  _updateOnboard(dt, t) {
    const isCockpit = this.mode === CAMERA_MODE.COCKPIT;
    const cfg = isCockpit ? this.config.camera.cockpit : this.config.camera.hood;

    // Rigid to the car — an onboard camera should roll with the chassis.
    const local = this._tmpOffset.set(cfg.offset.x, cfg.offset.y, cfg.offset.z);

    const desired = local.clone().applyQuaternion(t.quaternion).add(t.position);

    if (this._needsSnap || !this._initialised) {
      this.smoothPos.copy(desired);
      this._initialised = true;
      this._needsSnap = false;
    } else {
      this.smoothPos.lerp(desired, smoothing(cfg.lerp, dt));
    }

    this.camera.position.copy(this.smoothPos);

    // Camera looks down -Z, the car faces +Z, so flip 180 degrees.
    this.camera.quaternion.copy(t.quaternion).multiply(this._cameraFlip);
    this.camera.up.set(0, 1, 0);
  }
}
