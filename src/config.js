/**
 * Marina Bay Street Circuit — central tuning config.
 *
 * EVERY handling / gameplay value lives here so the whole feel of the car can be
 * adjusted without touching logic. Press F1 in-game for a live tuning panel.
 */

export const CONFIG = {
  /* ------------------------------------------------------------------ */
  /* Physics world                                                       */
  /* ------------------------------------------------------------------ */
  physics: {
    /** Fixed simulation timestep. 1/60 is the sweet spot for stability vs cost. */
    fixedDt: 1 / 60,
    /** Max fixed steps per rendered frame (spiral-of-death guard). */
    maxSubSteps: 5,
    /** Clamp a single frame's delta to this many seconds before accumulating. */
    maxFrameTime: 0.25,
    gravity: -9.81,
    solverIterations: 8,
    /** Rapier CCD sub-steps — this is what stops 250 km/h tunnelling. */
    ccdSubsteps: 8,
    /** Ground surface friction. The tire model does most of the work. */
    groundFriction: 1.4,
  },

  /* ------------------------------------------------------------------ */
  /* Car geometry & mass                                                 */
  /* ------------------------------------------------------------------ */
  car: {
    mass: 1250,             // kg, GT3-ish with driver
    length: 4.6,            // m, target normalised length
    width: 2.05,            // m
    wheelbase: 2.66,        // m, front axle to rear axle
    /**
     * Track widths are the measured hub positions from `car.glb` (front hubs at
     * x = ±0.848, rear at ±0.845), so the physics wheels and the model's wheels
     * land in exactly the same place.
     */
    frontTrack: 1.696,      // m, centre-to-centre
    rearTrack: 1.690,       // m
    wheelRadius: 0.34,      // m
    wheelWidth: 0.30,       // m
    /** Collision box half-extents. Physical hitbox, not the visual model. */
    colliderHalf: { x: 0.85, y: 0.36, z: 2.15 },
    /** Suspension hard-point height in chassis-local space. */
    hardPointY: -0.05,
    /**
     * Visual wheel spin direction. Verified numerically against Rapier:
     * `wheelRotation` increases while the car moves forward, and a wheel
     * rolling forward spins about +X, so this stays +1. Flip to -1 if a future
     * car model's wheel axis points the other way.
     */
    wheelSpinSign: 1,
  },

  /**
   * Ride height implied by the current suspension geometry:
   *   wheelRadius + suspension.restLength - hardPointY
   * Spawning at this height means the car never has to drop onto the road.
   */
  get chassisRestHeight() {
    return this.car.wheelRadius + this.suspension.restLength - this.car.hardPointY;
  },

  /* ------------------------------------------------------------------ */
  /* Suspension                                                          */
  /* ------------------------------------------------------------------ */
  suspension: {
    restLength: 0.22,       // m of free travel at rest
    travel: 0.18,           // m max compression/extension from rest
    stiffness: 40,          // higher = less body roll / less squat
    compression: 0.85,      // bump damping
    relaxation: 0.95,       // rebound damping (slightly higher stops bouncing)
    maxForce: 30000,        // N cap so kerbs can't launch the car
  },

  /* ------------------------------------------------------------------ */
  /* Tire grip                                                           */
  /* ------------------------------------------------------------------ */
  tires: {
    /**
     * Longitudinal traction per axle. Rapier's `frictionSlip` behaves like a
     * friction coefficient: higher = more grip before the tire breaks away.
     * The rear is deliberately LOWER than the front so the car can be rotated
     * on the throttle instead of being locked into permanent understeer.
     */
    frictionSlipFront: 2.80,
    frictionSlipRear: 2.20,
    /** Lateral grip multiplier per axle. Lower rear = easier to slide. */
    sideFrictionStiffnessFront: 1.00,
    sideFrictionStiffnessRear: 0.75,
  },

  /* ------------------------------------------------------------------ */
  /* Steering                                                            */
  /* ------------------------------------------------------------------ */
  steering: {
    maxAngle: 0.55,         // rad at standstill (~31 deg)
    minAngleFactor: 0.30,   // fraction of maxAngle at high speed
    falloffSpeed: 45,       // m/s at which minAngleFactor is reached (~160 km/h)
    /** Rate the physical wheel angle chases the input, rad/s. */
    rate: 5.0,
    /** Anti-roll / self-centring rate when the input is neutral. */
    returnRate: 8.0,
  },

  /* ------------------------------------------------------------------ */
  /* Brakes                                                              */
  /* ------------------------------------------------------------------ */
  brakes: {
    force: 60,              // Rapier brake impulse units
    handbrakeForce: 180,    // rear-only; locks the rears so a flick starts a slide
    engineBraking: 6,       // rear brake units applied when off throttle
  },

  /* ------------------------------------------------------------------ */
  /* Drivetrain                                                          */
  /* ------------------------------------------------------------------ */
  drivetrain: {
    /** Power-limited so top speed and launch feel both land in a sane place. */
    power: 340000,          // W at the wheels (~455 hp)
    maxDriveForce: 12000,   // N total, traction-limited launch clamp
    reverseForce: 4500,     // N total
    maxReverseSpeed: 12,    // m/s (~43 km/h)

    idleRPM: 1300,
    redlineRPM: 7600,
    shiftUpRPM: 7000,
    shiftDownRPM: 3300,
    shiftTime: 0.12,        // s of torque cut per shift

    finalDrive: 3.6,
    /** 6-speed sequential. Index 0 = 1st. */
    gears: [3.10, 2.19, 1.63, 1.29, 1.03, 0.84],
  },

  /* ------------------------------------------------------------------ */
  /* Aero                                                                */
  /* ------------------------------------------------------------------ */
  aero: {
    /** Quadratic drag: F = dragCoeff * v^2  (N per (m/s)^2). Tunes top speed. */
    dragCoeff: 0.80,
    /** Quadratic downforce: F = downforceCoeff * v^2. Adds grip at speed. */
    downforceCoeff: 2.0,
    downforceFrontBias: 0.45,
  },

  /* ------------------------------------------------------------------ */
  /* Driving assists                                                     */
  /* ------------------------------------------------------------------ */
  assists: {
    /**
     * 0 = raw, 1 = strong. Blends a little opposite lock in when the rear
     * steps out. Keyboard steering is binary, so without this drifting is
     * near-impossible. Set to 0 for a purist feel.
     */
    counterSteer: 0.35,
  },

  /* ------------------------------------------------------------------ */
  /* Input feel                                                          */
  /* ------------------------------------------------------------------ */
  input: {
    throttleUp: 4.0,        // units/sec toward full
    throttleDown: 8.0,      // units/sec back to zero (lift is faster)
    brakeUp: 6.0,
    brakeDown: 10.0,
    steerAttack: 5.0,       // rad/s toward full lock
    steerRelease: 9.0,      // rad/s returning to centre
    gamepadDeadzone: 0.12,
  },

  /* ------------------------------------------------------------------ */
  /* Cameras                                                             */
  /* ------------------------------------------------------------------ */
  camera: {
    fovBase: 62,
    fovMax: 82,
    fovSpeedRef: 75,        // m/s at which fovMax is reached
    near: 0.3,
    far: 6000,

    chase: {
      distance: 8.5,
      height: 3.1,
      lookAhead: 9.0,
      lookHeight: 1.0,
      /** Position smoothing rate (higher = snappier). */
      posLerp: 6.0,
      /** Camera-yaw smoothing rate (lower = more cinematic lag). */
      yawLerp: 4.0,
      /** Sideways lean into corners, m at full lateral load. */
      lateralSwing: 1.2,
    },

    cockpit: {
      /** Driver eye point in chassis-local space (car faces +Z). */
      offset: { x: 0.38, y: 0.62, z: 0.15 },
      lookAhead: 20,
      lerp: 18,
    },

    /**
     * Bonnet cam. Measured against `car.glb` rather than guessed: the car is
     * 1.45 m tall with its roof at chassis-local y 0.89, but the bodywork over
     * the front axle is only ~0.24 and the nose tip is ~-0.08. Sitting this at
     * the cockpit height left it floating ~0.3 m above the bonnet with no car in
     * frame at all.
     */
    hood: {
      offset: { x: 0, y: 0.4, z: 1.5 },
      lookAhead: 20,
      lerp: 18,
    },
  },

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  render: {
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    fogNear: 260,
    fogFar: 2600,
  },

  /* ------------------------------------------------------------------ */
  /* Race weekend                                                        */
  /* ------------------------------------------------------------------ */
  race: {
    /** Seconds shown on each of the countdown numbers before the lights go out. */
    countdownStep: 1.0,
    /** How long "GO!" stays up once the car is released. */
    goHold: 1.2,
    /** Grid slots behind the line. Slot 0 is pole. */
    gridSlots: 8,
    /** Longitudinal gap between grid rows, metres. */
    gridRowGap: 9,
    /** Lateral offset of each column from the racing line, metres. */
    gridColumn: 2.4,
  },

  /* ------------------------------------------------------------------ */
  /* Audio                                                               */
  /* ------------------------------------------------------------------ */
  audio: {
    /** Overall gain. Mute is independent of this. */
    master: 0.7,
    engine: 0.55,
    tyres: 0.40,
    wind: 0.22,
    impact: 0.80,
    /** How fast a smoothed parameter chases its target, per second. */
    smoothing: 12,
  },

  /* ------------------------------------------------------------------ */
  /* Night lighting                                                      */
  /* ------------------------------------------------------------------ */
  lighting: {
    /** The sky gradient. Night, but not so dark the circuit is unreadable. */
    sky: { top: 0x05070f, bottom: 0x141a26, exponent: 0.80 },
    /** Post-processing. `scale` below 1 renders bloom at reduced resolution. */
    bloom: { strength: 0.55, radius: 0.5, threshold: 0.85, scale: 0.5 },
    /** Environment map strength for the paint and glass. */
    environmentIntensity: 0.6,
  },

  /* ------------------------------------------------------------------ */
  /* Debug                                                               */
  /* ------------------------------------------------------------------ */
  debug: {
    showColliders: false,
    showCenterline: false,
    showCheckpoints: false,
    showTelemetry: true,
  },
};
