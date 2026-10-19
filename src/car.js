/**
 * The car: Rapier raycast-vehicle chassis, drivetrain model, and the Three.js
 * visual — a placeholder GT3-shaped body until `loadVisualModel` swaps in the
 * real Ferrari.
 *
 * Conventions (verified numerically against Rapier — see README):
 *   - The car faces +Z.  +X is therefore the car's LEFT.
 *   - steer > 0 turns left.
 *   - `wheelRotation` increases while driving forward.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { yawToQuat, quatToYaw } from './physics.js';

export const GEAR_REVERSE = -1;
export const GEAR_NEUTRAL = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const moveToward = (current, target, maxDelta) => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/**
 * Normalised engine torque multiplier across the rev range.
 * Generous at the bottom for drivability, easing off near the limiter.
 */
function torqueFactor(rpm, idleRPM, redlineRPM) {
  const t = clamp((rpm - idleRPM) / (redlineRPM - idleRPM), 0, 1);
  return clamp(0.55 + 1.1 * t - 0.75 * t * t, 0, 1);
}

/** Wheel order throughout the codebase. */
const WHEEL_ORDER = ['FL', 'FR', 'RL', 'RR'];

/** Total triangles under an object, for reporting model budgets. */
function countTriangles(object) {
  let tris = 0;
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    tris += (geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0)) / 3;
  });
  return Math.round(tris);
}

export class Car {
  constructor(physics, config) {
    this.physics = physics;
    this.config = config;
    this.world = physics.world;

    this._buildBody();
    this._buildVehicle();
    this._buildVisual();

    // ---- drivetrain state -------------------------------------------
    /** 1..N for forward gears, GEAR_NEUTRAL, or GEAR_REVERSE. */
    this.gear = GEAR_NEUTRAL;
    this.rpm = config.drivetrain.idleRPM;
    this.shiftTimer = 0;
    this.steerAngle = 0;

    // ---- derived motion state (refreshed every fixed step) ----------
    this.forwardSpeed = 0;   // m/s along the car's nose (+ forward, - backward)
    this.lateralSpeed = 0;   // m/s along the car's left (+ left)
    this.speed = 0;          // m/s magnitude
    this.slipAngle = 0;      // rad, atan2(lateral, forward)
    this.yawRate = 0;
    this.driveForce = 0;
    this.wheelLoad = [0, 0, 0, 0];

    // ---- render interpolation ---------------------------------------
    this.prevPos = new THREE.Vector3();
    this.curPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.curQuat = new THREE.Quaternion();
    this.prevSusp = new Float32Array(4);
    this.curSusp = new Float32Array(4);
    this.curSpin = new Float32Array(4);
    this.curSteer = new Float32Array(4);

    this._syncInterpFromBody();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
  }

  /* ================================================================== */
  /* Construction                                                        */
  /* ================================================================== */

  _buildBody() {
    const c = this.config.car;
    const spawn = this.config.chassisRestHeight;

    this.body = this.world.createRigidBody(
      this.physics.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, spawn, 0)
        .setCanSleep(false)
        // Anti-tunnelling at 250+ km/h.
        .setCcdEnabled(true)
        // Tiny damping keeps the CCD solver from jittering at rest.
        .setLinearDamping(0.05)
        .setAngularDamping(0.35),
    );

    this.collider = this.world.createCollider(
      this.physics.RAPIER.ColliderDesc.cuboid(
        c.colliderHalf.x,
        c.colliderHalf.y,
        c.colliderHalf.z,
      )
        // Explicit mass rather than density so the collider box can be
        // reshaped without silently changing the car's weight.
        .setMass(c.mass)
        .setFriction(0.6)
        .setRestitution(0.15),
      this.body,
    );
  }

  _buildVehicle() {
    const c = this.config.car;
    const s = this.config.suspension;
    const t = this.config.tires;

    this.vehicle = this.world.createVehicleController(this.body);

    // Rapier defaults forward to +X; we need +Z.
    // (The typings expose this setter under the odd name `setIndexForwardAxis`.)
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;

    const halfWheelbase = c.wheelbase / 2;
    const halfFront = c.frontTrack / 2;
    const halfRear = c.rearTrack / 2;

    // +X is the car's LEFT because the car faces +Z.
    const layout = [
      { name: 'FL', x: +halfFront, z: +halfWheelbase, front: true },
      { name: 'FR', x: -halfFront, z: +halfWheelbase, front: true },
      { name: 'RL', x: +halfRear, z: -halfWheelbase, front: false },
      { name: 'RR', x: -halfRear, z: -halfWheelbase, front: false },
    ];

    this.wheels = layout.map((w, i) => {
      this.vehicle.addWheel(
        { x: w.x, y: c.hardPointY, z: w.z },   // hard point on the chassis
        { x: 0, y: -1, z: 0 },                 // suspension points down
        { x: -1, y: 0, z: 0 },                 // axle
        s.restLength,
        c.wheelRadius,
      );

      this.vehicle.setWheelSuspensionStiffness(i, s.stiffness);
      this.vehicle.setWheelMaxSuspensionTravel(i, s.travel);
      this.vehicle.setWheelSuspensionCompression(i, s.compression);
      this.vehicle.setWheelSuspensionRelaxation(i, s.relaxation);
      this.vehicle.setWheelMaxSuspensionForce(i, s.maxForce);
      this.vehicle.setWheelFrictionSlip(i, w.front ? t.frictionSlipFront : t.frictionSlipRear);
      this.vehicle.setWheelSideFrictionStiffness(
        i,
        w.front ? t.sideFrictionStiffnessFront : t.sideFrictionStiffnessRear,
      );

      return { ...w, index: i };
    });

    this.frontWheels = this.wheels.filter((w) => w.front).map((w) => w.index);
    this.rearWheels = this.wheels.filter((w) => !w.front).map((w) => w.index);

    // Ray-casts must not hit the chassis we are casting from.
    this._wheelFilter = (collider) => collider.handle !== this.collider.handle;
  }

  _buildVisual() {
    const c = this.config.car;
    this.root = new THREE.Group();
    this.root.name = 'car';

    // Everything that makes up the outside of the car lives in its own group so
    // cockpit view can hide it — otherwise the camera renders the inside of the
    // bodywork. Wheels stay on `root` so they remain visible from inside.
    this.exterior = new THREE.Group();
    this.exterior.name = 'exterior';
    this.root.add(this.exterior);

    // Wheel skeleton: a steer group (yaw) wrapping a spin group (roll), one per
    // wheel. Physics places the steer group and the mesh just follows. Built up
    // front so the placeholder and the real model share exactly the same rig.
    this.wheelSteerGroups = [];
    this.wheelSpinGroups = [];
    for (const w of this.wheels) {
      const steer = new THREE.Group();
      steer.name = `wheel-steer-${w.name}`;
      const spin = new THREE.Group();
      spin.name = `wheel-spin-${w.name}`;
      steer.add(spin);
      this.root.add(steer);
      this.wheelSteerGroups.push(steer);
      this.wheelSpinGroups.push(spin);
    }

    this._buildPlaceholder();
  }

  /**
   * Stand-in car, shown until `loadVisualModel` swaps in the real asset. Keeping
   * it means the game still runs when `public/assets/car.glb` is missing.
   */
  _buildPlaceholder() {
    const c = this.config.car;

    // -- palette ------------------------------------------------------
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xc8102e,
      metalness: 0.55,
      roughness: 0.26,
    });
    const bodyDarkMat = new THREE.MeshStandardMaterial({
      color: 0x2a0d12,
      metalness: 0.4,
      roughness: 0.5,
    });
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x14151a,
      metalness: 0.35,
      roughness: 0.55,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0d1117,
      metalness: 0.1,
      roughness: 0.08,
      transparent: true,
      opacity: 0.68,
    });
    this.headlightMat = new THREE.MeshStandardMaterial({
      color: 0xfff6dc,
      emissive: 0xfff0c8,
      emissiveIntensity: 1.6,
      roughness: 0.25,
    });
    this.taillightMat = new THREE.MeshStandardMaterial({
      color: 0x4a0007,
      emissive: 0xff1a2e,
      emissiveIntensity: 0.7,
      roughness: 0.3,
    });

    const box = (w, h, d, x, y, z, mat, name) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (name) mesh.name = name;
      this.exterior.add(mesh);
      return mesh;
    };

    // -- body ---------------------------------------------------------
    box(1.90, 0.12, 4.20, 0, -0.43, 0, carbonMat, 'floor');           // floor + diffuser
    box(2.02, 0.42, 4.40, 0, -0.20, 0, bodyMat, 'body-lower');        // main tub
    box(1.70, 0.30, 2.20, 0, 0.05, -0.60, bodyMat, 'engine-cover');   // haunches
    box(1.60, 0.20, 1.50, 0, 0.02, 1.50, bodyMat, 'bonnet');          // bonnet
    box(1.15, 0.36, 1.60, 0, 0.30, 0.00, glassMat, 'cabin');          // greenhouse
    box(1.30, 0.10, 0.55, 0, 0.44, -0.85, bodyDarkMat, 'engine-intake');
    box(2.00, 0.05, 0.50, 0, -0.44, 2.00, carbonMat, 'splitter');     // front splitter
    box(1.70, 0.18, 0.50, 0, -0.36, -2.00, carbonMat, 'diffuser');    // rear diffuser

    // -- rear wing ----------------------------------------------------
    box(1.75, 0.06, 0.42, 0, 0.42, -2.02, carbonMat, 'wing');
    box(0.07, 0.30, 0.24, -0.72, 0.27, -2.02, carbonMat, 'wing-strut-l');
    box(0.07, 0.30, 0.24, +0.72, 0.27, -2.02, carbonMat, 'wing-strut-r');

    // -- lights -------------------------------------------------------
    box(1.42, 0.12, 0.10, 0, 0.02, 2.22, this.headlightMat, 'headlights');
    box(1.42, 0.12, 0.10, 0, 0.10, -2.22, this.taillightMat, 'taillights');

    // -- wheels -------------------------------------------------------
    for (let i = 0; i < this.wheels.length; i++) {
      this.wheelSpinGroups[i].add(this._buildWheelMesh(c.wheelRadius, c.wheelWidth));
    }

    this.root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }

  /**
   * Replace the placeholder with the prepared Ferrari from `prepare_car.mjs`.
   *
   * That asset is already in car space — facing +Z, +X to its left, origin at
   * the axle midpoint with the wheels on y=0 — and every wheel is a named node
   * whose geometry is centred on its own hub. So the swap is mostly a
   * reparenting: the wheel nodes are meaningless where they are and have to be
   * moved under the physics-driven steer groups.
   *
   * Resolves with the measured geometry, or throws (caller keeps the
   * placeholder).
   */
  async loadVisualModel(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, onProgress);
    const model = gltf.scene;

    const modelRoot = model.getObjectByName('car');
    if (!modelRoot) throw new Error(`${url} has no node named "car"`);

    // Measure the hubs before touching the hierarchy.
    const hubs = this.wheels.map((w) => {
      const node = modelRoot.getObjectByName(`wheel_${w.name}`);
      if (!node) throw new Error(`${url} has no node named "wheel_${w.name}"`);
      return node.position.clone();
    });
    const meanHubY = hubs.reduce((s, h) => s + h.y, 0) / hubs.length;

    /*
     * The model is authored at its static ride height, so its hubs have to line
     * up with where the suspension *actually* holds the wheels once the car has
     * settled — rest length minus the compression caused by the car's own
     * weight. Aligning against the unloaded `restLength` instead drops the body
     * about 6 cm too far and sinks the splitter through the road.
     *
     * Static compression is just force over rate. Rapier's stiffness is scaled
     * by chassis mass, so that cancels and the drop is g / (4 x stiffness).
     *
     * Note this is an offset to the *axle plane*, not the collider centre — a
     * 0.36 m half-height collider would leave the car hovering.
     */
    const staticCompression = -this.config.physics.gravity / (4 * this.config.suspension.stiffness);
    const staticSuspLength = this.config.suspension.restLength - staticCompression;
    const offsetY = this.config.car.hardPointY - staticSuspLength - meanHubY;

    for (const group of this.wheelSpinGroups) group.clear();
    this.exterior.clear();

    for (const [i, w] of this.wheels.entries()) {
      const node = modelRoot.getObjectByName(`wheel_${w.name}`);
      node.position.set(0, 0, 0);
      node.rotation.set(0, 0, 0);
      node.scale.set(1, 1, 1);
      this.wheelSpinGroups[i].add(node);
    }

    modelRoot.position.set(0, offsetY, 0);
    this.exterior.add(modelRoot);

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = true;
      }
    });

    this.modelOffsetY = offsetY;
    this.usingRealModel = true;

    return {
      offsetY,
      hubs: hubs.map((h) => h.toArray()),
      triangles: countTriangles(modelRoot),
    };
  }

  /**
   * Cockpit view sits inside the bodywork, so the exterior shell has to be
   * hidden or the camera renders the inside of the car. Wheels stay visible.
   */
  setExteriorVisible(visible) {
    this.exterior.visible = visible;
  }

  _buildWheelMesh(radius, width) {
    const group = new THREE.Group();

    // Cylinder is Y-aligned by default; rotate so its axis runs along X.
    const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 22, 1);
    tireGeo.rotateZ(Math.PI / 2);
    const tire = new THREE.Mesh(
      tireGeo,
      new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.92 }),
    );
    group.add(tire);

    const rimGeo = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 1.02, 18, 1);
    rimGeo.rotateZ(Math.PI / 2);
    const rim = new THREE.Mesh(
      rimGeo,
      new THREE.MeshStandardMaterial({ color: 0x9aa2ad, metalness: 0.9, roughness: 0.32 }),
    );
    group.add(rim);

    // A spoke marker makes wheel rotation readable at a glance.
    const spokeGeo = new THREE.BoxGeometry(width * 1.05, radius * 1.12, 0.05);
    const spoke = new THREE.Mesh(spokeGeo, new THREE.MeshStandardMaterial({
      color: 0x4b525c,
      metalness: 0.8,
      roughness: 0.4,
    }));
    group.add(spoke);

    return group;
  }

  /* ================================================================== */
  /* Per-step simulation                                                 */
  /* ================================================================== */

  /** Snapshot the state we are about to integrate away from. */
  beginStep() {
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
    this.prevSusp.set(this.curSusp);

    // Rapier's addForce() accumulates and PERSISTS across steps until reset.
    // Without this, drag and downforce stack every step into a runaway load
    // that glues the car to the road and stops it dead.
    this.body.resetForces(false);
    this.body.resetTorques(false);
  }

  /**
   * Convert player input into steering / engine / brake commands and apply
   * the aerodynamic forces. Call once per fixed step, before updateVehicle().
   */
  applyControls(dt, input) {
    this._refreshMotionState();

    const steerInput = this._resolveSteer(dt, input);
    this._updateDrivetrain(dt, input, steerInput);
    this._applyAero();
  }

  /** Advance the raycast vehicle and integrate the world. Call right before world.step(). */
  updateVehicle(dt) {
    this.vehicle.updateVehicle(dt, undefined, undefined, this._wheelFilter);
  }

  /** Read the post-step state back out of the rigid body. */
  endStep() {
    this._syncInterpFromBody();
    for (let i = 0; i < 4; i++) {
      this.curSusp[i] = this.vehicle.wheelSuspensionLength(i) ?? this.config.suspension.restLength;
      this.curSpin[i] = this.vehicle.wheelRotation(i) ?? 0;
      this.curSteer[i] = this.vehicle.wheelSteering(i) ?? 0;
      this.wheelLoad[i] = this.vehicle.wheelSuspensionForce(i) ?? 0;
    }
  }

  _syncInterpFromBody() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Recompute speed/slip expressed in the car's own frame. */
  _refreshMotionState() {
    const v = this.body.linvel();
    const w = this.body.angvel();

    // Forward = +Z, left = +X, both rotated into world space.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.curQuat);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(this.curQuat);

    this.forwardSpeed = v.x * forward.x + v.y * forward.y + v.z * forward.z;
    this.lateralSpeed = v.x * left.x + v.y * left.y + v.z * left.z;
    this.speed = Math.hypot(v.x, v.y, v.z);
    this.yawRate = w.y;

    // Slip angle: how far the velocity vector is from the nose.
    this.slipAngle = Math.atan2(this.lateralSpeed, Math.max(Math.abs(this.forwardSpeed), 2));
  }

  /**
   * Blend the driver's steering with an optional counter-steer assist.
   * Returns the normalised steering command in [-1, 1] (+ = left).
   */
  _resolveSteer(dt, input) {
    let command = clamp(input.steer, -1, 1);

    const assist = this.config.assists.counterSteer;
    if (assist > 0 && this.speed > 4) {
      // Slip beyond a small deadzone is oversteer we can help catch.
      // Steering *toward* the velocity vector is exactly what a driver does.
      const deadzone = 0.05;
      const excess =
        Math.sign(this.slipAngle) * Math.max(0, Math.abs(this.slipAngle) - deadzone);
      const correction = clamp(excess * 3.2, -0.7, 0.7) * assist;
      command = clamp(command + correction, -1, 1);
    }

    // Less lock the faster we go.
    const st = this.config.steering;
    const falloff = clamp(Math.abs(this.forwardSpeed) / st.falloffSpeed, 0, 1);
    const maxAngle = st.maxAngle * (1 - falloff * (1 - st.minAngleFactor));

    const target = command * maxAngle;
    const rate = Math.abs(command) > 0.01 ? st.rate : st.returnRate;
    this.steerAngle = moveToward(this.steerAngle, target, rate * dt);

    for (const i of this.frontWheels) this.vehicle.setWheelSteering(i, this.steerAngle);
    for (const i of this.rearWheels) this.vehicle.setWheelSteering(i, 0);

    this._steerCommand = command;
    return command;
  }

  _updateDrivetrain(dt, input, steerCommand) {
    const tr = this.config.drivetrain;
    const gears = tr.gears;
    let frontBrake = 0;
    let rearBrake = 0;
    let driveForce = 0;

    // ---- gear selection ---------------------------------------------
    if (this.gear === GEAR_REVERSE) {
      // Leave reverse as soon as the driver asks to go forward again.
      if (input.throttle > 0.15 || this.forwardSpeed > 0.6) this.gear = 1;
    } else if (this.gear === GEAR_NEUTRAL) {
      // Neutral is only the spawn state: engage a gear as soon as the driver
      // touches a pedal, otherwise the car would sit there revving forever.
      if (input.throttle > 0.05) this.gear = 1;
      else if (input.brake > 0.2 && this.forwardSpeed < 0.8) this.gear = GEAR_REVERSE;
    } else if (
      input.brake > 0.2 &&
      input.throttle < 0.1 &&
      this.forwardSpeed < 0.8
    ) {
      this.gear = GEAR_REVERSE;
      this.shiftTimer = 0;
    }

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    // ---- RPM ---------------------------------------------------------
    const ratio =
      this.gear === GEAR_REVERSE
        ? gears[0] * tr.finalDrive
        : this.gear > 0
          ? gears[this.gear - 1] * tr.finalDrive
          : 0;

    const gearedRpm =
      (Math.abs(this.forwardSpeed) / this.config.car.wheelRadius) *
      ratio *
      (60 / (2 * Math.PI));

    // Off the line the revs sit above idle so the engine feels alive.
    const freeRev = tr.idleRPM + input.throttle * 1300 + steerCommand * 0;
    const targetRpm = clamp(Math.max(gearedRpm, freeRev), tr.idleRPM, tr.redlineRPM);
    // Smooth the needle; instant jumps look and sound wrong.
    this.rpm += (targetRpm - this.rpm) * Math.min(1, dt * 9);

    // ---- automatic shifting -----------------------------------------
    const shifting = this.shiftTimer > 0;
    if (!shifting && this.gear > 0) {
      if (this.rpm > tr.shiftUpRPM && this.gear < gears.length && input.throttle > 0.1) {
        this.gear += 1;
        this.shiftTimer = tr.shiftTime;
      } else if (this.rpm < tr.shiftDownRPM && this.gear > 1) {
        this.gear -= 1;
        this.shiftTimer = tr.shiftTime;
      }
    }

    // ---- forces ------------------------------------------------------
    const torque = torqueFactor(this.rpm, tr.idleRPM, tr.redlineRPM);

    if (this.gear === GEAR_REVERSE) {
      const vAbs = Math.abs(this.forwardSpeed);
      const fade = vAbs > tr.maxReverseSpeed ? 0 : 1;
      driveForce = -tr.reverseForce * input.brake * fade;
      frontBrake = rearBrake = 0;
    } else if (this.gear > 0 && !shifting) {
      // Power-limited: F = P / v, capped by what the tires can actually put
      // down. This gives a traction-limited launch AND a sane top speed.
      const pLimited = tr.power / Math.max(Math.abs(this.forwardSpeed), 4.0);
      // Snap tiny residual throttle to zero so the engine-force channel is
      // genuinely idle when the driver is off the pedal (see note below).
      const throttle = input.throttle < 0.03 ? 0 : input.throttle;
      driveForce = Math.min(tr.maxDriveForce, pLimited) * throttle * torque;

      const brakeInput = input.brake;
      frontBrake = brakeInput * this.config.brakes.force * 1.25;
      rearBrake = brakeInput * this.config.brakes.force * 0.75;

      // Engine braking deliberately goes through the BRAKE channel, never the
      // engine-force channel. Rapier (like Bullet's raycast vehicle) ignores
      // wheelBrake whenever wheelEngineForce is non-zero, so writing engine
      // braking as a negative engine force silently disables every rear brake
      // including the handbrake.
      if (throttle === 0) rearBrake += this.config.brakes.engineBraking;
    }

    // Handbrake locks the rears only — that is what makes it a drift tool.
    rearBrake += input.handbrake * this.config.brakes.handbrakeForce;

    // ---- apply to the wheels ----------------------------------------
    const perWheel = driveForce / this.rearWheels.length;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      this.vehicle.setWheelEngineForce(i, w.front ? 0 : perWheel);
      this.vehicle.setWheelBrake(i, w.front ? frontBrake : rearBrake);
    }

    this.driveForce = driveForce;
    this._frontBrake = frontBrake;
    this._rearBrake = rearBrake;

    // Brake lights (Stage 2 uses this on the real model too).
    if (this.taillightMat) {
      const lit = input.brake > 0.05 || input.handbrake > 0.05;
      this.taillightMat.emissiveIntensity = lit ? 4.0 : 0.7;
    }
  }

  _applyAero() {
    const a = this.config.aero;
    const v = this.body.linvel();
    const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;

    if (speedSq < 0.01) return;
    const speed = Math.sqrt(speedSq);

    // Drag opposes velocity.
    const drag = a.dragCoeff * speedSq;
    this.body.addForce(
      { x: (-v.x / speed) * drag, y: (-v.y / speed) * drag, z: (-v.z / speed) * drag },
      true,
    );

    // Downforce scales with speed and loads the suspension, which in turn
    // gives the tires more grip. Applied at a point so it also pitches the car.
    const downforce = a.downforceCoeff * speedSq;
    const bias = a.downforceFrontBias - 0.5;
    const local = new THREE.Vector3(0, 0.2, bias * this.config.car.length).applyQuaternion(
      this.curQuat,
    );
    const t = this.body.translation();
    this.body.addForceAtPoint(
      { x: 0, y: -downforce, z: 0 },
      { x: t.x + local.x, y: t.y + local.y, z: t.z + local.z },
      true,
    );
  }

  /* ================================================================== */
  /* Rendering                                                           */
  /* ================================================================== */

  /**
   * Place the visual meshes, interpolating between the previous and current
   * physics states so motion stays smooth above the fixed step rate.
   */
  syncVisual(alpha) {
    this.root.position.lerpVectors(this.prevPos, this.curPos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuat, this.curQuat, alpha);

    const c = this.config.car;
    const spinSign = c.wheelSpinSign;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const susp = this.prevSusp[i] + (this.curSusp[i] - this.prevSusp[i]) * alpha;

      // Wheel centre = hard point + suspension direction * length.
      const steerGroup = this.wheelSteerGroups[i];
      steerGroup.position.set(w.x, c.hardPointY - susp, w.z);
      steerGroup.rotation.y = this.curSteer[i];

      this.wheelSpinGroups[i].rotation.x = this.curSpin[i] * spinSign;
    }
  }

  /* ================================================================== */
  /* Utilities                                                           */
  /* ================================================================== */

  /** Teleport the car, killing all motion. Used by reset and the start grid. */
  reset(position, yaw = 0) {
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation(yawToQuat(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    this.gear = GEAR_NEUTRAL;
    this.rpm = this.config.drivetrain.idleRPM;
    this.shiftTimer = 0;
    this.steerAngle = 0;

    this._syncInterpFromBody();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);

    for (let i = 0; i < 4; i++) {
      const rest = this.config.suspension.restLength;
      this.curSusp[i] = rest;
      this.prevSusp[i] = rest;
    }
    this.syncVisual(1);
  }

  /**
   * Re-apply every setting that Rapier bakes into the vehicle controller at
   * construction time. Call after live-tuning suspension or tire values.
   */
  reapplyTuning() {
    const s = this.config.suspension;
    const t = this.config.tires;
    for (const w of this.wheels) {
      const i = w.index;
      this.vehicle.setWheelSuspensionStiffness(i, s.stiffness);
      this.vehicle.setWheelMaxSuspensionTravel(i, s.travel);
      this.vehicle.setWheelSuspensionCompression(i, s.compression);
      this.vehicle.setWheelSuspensionRelaxation(i, s.relaxation);
      this.vehicle.setWheelMaxSuspensionForce(i, s.maxForce);
      this.vehicle.setWheelSuspensionRestLength(i, s.restLength);
      this.vehicle.setWheelRadius(i, this.config.car.wheelRadius);
      this.vehicle.setWheelFrictionSlip(
        i,
        w.front ? t.frictionSlipFront : t.frictionSlipRear,
      );
      this.vehicle.setWheelSideFrictionStiffness(
        i,
        w.front ? t.sideFrictionStiffnessFront : t.sideFrictionStiffnessRear,
      );
    }
  }

  /** Human-readable gear for the HUD. */
  get gearLabel() {
    if (this.gear === GEAR_REVERSE) return 'R';
    if (this.gear === GEAR_NEUTRAL) return 'N';
    return String(this.gear);
  }

  /** Snapshot for HUD / camera / audio. */
  get telemetry() {
    return {
      speedKmh: Math.abs(this.forwardSpeed) * 3.6,
      speedMs: this.speed,
      forwardSpeed: this.forwardSpeed,
      lateralSpeed: this.lateralSpeed,
      rpm: this.rpm,
      redlineRPM: this.config.drivetrain.redlineRPM,
      idleRPM: this.config.drivetrain.idleRPM,
      gear: this.gear,
      gearLabel: this.gearLabel,
      slipAngle: this.slipAngle,
      yawRate: this.yawRate,
      /** Heading around Y. The car faces +Z when this is 0. */
      yaw: quatToYaw(this.root.quaternion),
      steerAngle: this.steerAngle,
      driveForce: this.driveForce,
      frontBrake: this._frontBrake ?? 0,
      rearBrake: this._rearBrake ?? 0,
      wheelLoad: this.wheelLoad,
      // Interpolated transform, so the camera tracks what is on screen.
      position: this.root.position,
      quaternion: this.root.quaternion,
      inContact: this.wheels.map((_, i) => this.vehicle.wheelIsInContact(i)),
      wheelSpin: this.curSpin,
      steering: this.curSteer,
    };
  }

  /** Which wheels to show as visually steering (front pair). */
  get wheelNames() {
    return WHEEL_ORDER;
  }
}
