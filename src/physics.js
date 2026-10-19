/**
 * Rapier world wrapper: fixed-timestep accumulator, static collider helpers,
 * and render interpolation alpha.
 */
import RAPIER from '@dimforge/rapier3d-compat';

export class Physics {
  /** Rapier's compat build must be initialised (wasm) before use. */
  static async create(config) {
    await RAPIER.init();
    return new Physics(config);
  }

  constructor(config) {
    this.cfg = config.physics;
    this.RAPIER = RAPIER;

    this.world = new RAPIER.World({ x: 0, y: this.cfg.gravity, z: 0 });
    this.world.integrationParameters.dt = this.cfg.fixedDt;
    this.world.integrationParameters.numSolverIterations = this.cfg.solverIterations;
    this.world.integrationParameters.maxCcdSubsteps = this.cfg.ccdSubsteps;

    this.accumulator = 0;
    /** Blend factor between last and current physics state, for smooth rendering. */
    this.alpha = 0;
    /** Fixed steps in the last frame, and since startup. */
    this.stepCount = 0;
    this.totalSteps = 0;
    /** Wall-clock time spent inside world.step() last frame, ms. */
    this.stepMs = 0;
  }

  get fixedDt() {
    return this.cfg.fixedDt;
  }

  get bodyCount() {
    return this.world.bodies.len();
  }

  get colliderCount() {
    return this.world.colliders.len();
  }

  /**
   * Static box collider — the workhorse for barriers and the ground slab.
   * @param {{x:number,y:number,z:number}} halfExtents
   * @param {{x:number,y:number,z:number}} position
   */
  addStaticBox(halfExtents, position, { rotationY = 0, friction = 0.9, restitution = 0 } = {}) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(yawToQuat(rotationY)),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(friction)
        .setRestitution(restitution),
      body,
    );
    return { body, collider };
  }

  /**
   * Static triangle mesh — used for the real track surface and barriers.
   * @param {Float32Array} vertices flat xyz triples
   * @param {Uint32Array} indices
   */
  addStaticTrimesh(vertices, indices, { friction = 0.9, restitution = 0 } = {}) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices)
        .setFriction(friction)
        .setRestitution(restitution),
      body,
    );
    return { body, collider };
  }

  /**
   * Advance the simulation with a fixed timestep.
   * @param {number} frameDt seconds since last rendered frame
   * @param {(dt:number)=>void} onFixedStep run one fixed step (controls + world.step)
   * @returns {number} number of fixed steps executed
   */
  stepFrame(frameDt, onFixedStep) {
    this.accumulator += Math.min(frameDt, this.cfg.maxFrameTime);

    let steps = 0;
    while (this.accumulator >= this.cfg.fixedDt && steps < this.cfg.maxSubSteps) {
      onFixedStep(this.cfg.fixedDt);
      this.accumulator -= this.cfg.fixedDt;
      steps++;
    }

    // Hit the step ceiling: drop the backlog rather than death-spiral.
    if (steps === this.cfg.maxSubSteps) this.accumulator = 0;

    this.alpha = this.accumulator / this.cfg.fixedDt;
    /** Fixed steps executed during the most recent stepFrame() call. */
    this.stepCount = steps;
    this.totalSteps += steps;
    return steps;
  }
}

/** Build a Rapier rotation from a yaw angle in radians. */
export function yawToQuat(yaw) {
  const h = yaw * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** Extract yaw (rotation about +Y) from a quaternion. */
export function quatToYaw(q) {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}
