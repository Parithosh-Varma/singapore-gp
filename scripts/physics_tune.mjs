/**
 * Headless physics harness — runs the real Car + Physics modules in Node with
 * no browser, so handling can be measured and tuned numerically.
 *
 * Usage:
 *   node scripts/physics_tune.mjs accel      full throttle from rest, table
 *   node scripts/physics_tune.mjs brake      accelerate then brake, table
 *   node scripts/physics_tune.mjs turn       full lock + throttle, table
 *   node scripts/physics_tune.mjs drift      handbrake flick, table
 *   node scripts/physics_tune.mjs roll       no input, table
 *   node scripts/physics_tune.mjs all        every table scenario
 *   node scripts/physics_tune.mjs sweep      parameter sweep -> drift summary
 */
import { CONFIG } from '../src/config.js';
import { Physics } from '../src/physics.js';
import { Car } from '../src/car.js';

const scenario = process.argv[2] ?? 'accel';
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ */
/* Reusable harness: one physics world, resettable car                 */
/* ------------------------------------------------------------------ */

class Harness {
  static async create() {
    const physics = await Physics.create(CONFIG);
    physics.addStaticBox(
      { x: 1200, y: 0.5, z: 1200 },
      { x: 0, y: -0.5, z: 0 },
      { friction: CONFIG.physics.groundFriction },
    );
    return new Harness(physics, new Car(physics, CONFIG));
  }

  constructor(physics, car) {
    this.physics = physics;
    this.car = car;
    this.dt = CONFIG.physics.fixedDt;
  }

  /** Re-read CONFIG.tires / .suspension into the Rapier vehicle controller. */
  reapply() {
    this.car.reapplyTuning();
  }

  settle(seconds = 1.5, input = NEUTRAL) {
    for (let i = 0; i < Math.round(seconds / this.dt); i++) this.step(input);
  }

  reset() {
    this.car.reset({ x: 0, y: CONFIG.chassisRestHeight + 0.02, z: 0 }, 0);
  }

  step(input) {
    this.car.beginStep();
    this.car.applyControls(this.dt, input);
    this.car.updateVehicle(this.dt);
    this.physics.world.step();
    this.car.endStep();
  }

  /** Run for `seconds`, sampling every `every` seconds; returns rows. */
  run(seconds, input, every = 0.25) {
    const rows = [];
    const total = Math.round(seconds / this.dt);
    const stride = Math.max(1, Math.round(every / this.dt));
    for (let i = 0; i < total; i++) {
      this.step(typeof input === 'function' ? input(i * this.dt) : input);
      if (i % stride === 0) {
        const t = this.car.body.translation();
        const r = this.car.body.rotation();
        rows.push({
          t: i * this.dt,
          x: t.x,
          z: t.z,
          y: t.y,
          yaw: Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)) * DEG,
          kmh: Math.abs(this.car.forwardSpeed) * 3.6,
          latG: (this.car.forwardSpeed * this.car.yawRate) / 9.81,
          lat: this.car.lateralSpeed,
          slip: this.car.slipAngle * DEG,
          steer: this.car.steerAngle * DEG,
          rpm: this.car.rpm,
          gear: this.car.gearLabel,
          drive: this.car.driveForce,
          susp: [0, 1, 2, 3].map((k) => this.car.curSusp[k] * 1000),
          loads: [0, 1, 2, 3].map((k) => this.car.wheelLoad[k] / 1000),
          contact: [0, 1, 2, 3].map((k) => this.car.vehicle.wheelIsInContact(k)),
        });
      }
    }
    return rows;
  }
}

const f = (n, w = 7, p = 2) => Number(n).toFixed(p).padStart(w);

function printTable(name, rows) {
  console.log(`\n=== ${name} ===`);
  console.log(
    '   t     y      x      z   yaw°    km/h    rpm  gr   latG  lat  slip    steer   driveN  ' +
      'susp(mm) FL/FR/RL/RR        load(kN) FL/FR/RL/RR   contact',
  );
  for (const r of rows) {
    console.log(
      `${f(r.t, 5, 2)} ${f(r.y, 6, 3)} ${f(r.x, 6, 1)} ${f(r.z, 6, 1)} ${f(r.yaw, 6, 1)} ` +
        `${f(r.kmh, 6, 1)} ${f(r.rpm, 6, 0)} ${String(r.gear).padStart(2)} ` +
        `${f(r.latG, 5, 2)} ${f(r.lat, 6, 2)} ${f(r.slip, 5, 1)} ${f(r.steer, 7, 1)} ${f(r.drive, 7, 0)}  ` +
        `${r.susp.map((s) => f(s, 4, 0)).join('/')}   ` +
        `${r.loads.map((l) => f(l, 5, 2)).join('/')}   ` +
        `${r.contact.map((c) => (c ? 'Y' : '.')).join('')}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Table scenarios                                                     */
/* ------------------------------------------------------------------ */

async function tables(which) {
  const h = await Harness.create();

  if (which === 'accel' || which === 'all') {
    h.reset(); h.settle();
    printTable('full throttle from rest', h.run(12, { ...NEUTRAL, throttle: 1 }));
  }
  if (which === 'brake' || which === 'all') {
    h.reset(); h.settle();
    printTable(
      'accelerate 6 s then full brake',
      h.run(10, (t) => ({ ...NEUTRAL, throttle: t < 6 ? 1 : 0, brake: t < 6 ? 0 : 1 })),
    );
  }
  if (which === 'turn' || which === 'all') {
    h.reset(); h.settle();
    printTable('throttle + full left lock', h.run(8, { ...NEUTRAL, throttle: 1, steer: 1 }));
  }
  if (which === 'drift' || which === 'all') {
    h.reset(); h.settle();
    printTable(
      'build speed, then handbrake + steering',
      h.run(7, (t) => ({
        ...NEUTRAL,
        throttle: t < 2.6 ? 1 : 0.35,
        steer: t < 2.6 ? 0 : 0.8,
        handbrake: t >= 2.6 ? 1 : 0,
      })),
    );
  }
  if (which === 'roll' || which === 'all') {
    h.reset(); h.settle();
    printTable('no input (should sit still)', h.run(4, NEUTRAL));
  }
}

/* ------------------------------------------------------------------ */
/* Reset regression                                                    */
/* ------------------------------------------------------------------ */

async function resetRegression() {
  const h = await Harness.create();

  h.reset(); h.settle();
  printTable('A: fresh spawn, then 3 s throttle', h.run(3, { ...NEUTRAL, throttle: 1 }));

  h.reset();
  printTable('B: reset (no settle), then 3 s throttle', h.run(3, { ...NEUTRAL, throttle: 1 }));

  h.reset(); h.settle();
  printTable('C: reset + settle, then 3 s throttle', h.run(3, { ...NEUTRAL, throttle: 1 }));

  // Reset while moving, which is what the R key actually does in play.
  h.reset(); h.settle();
  h.run(3, { ...NEUTRAL, throttle: 1 });
  const before = Math.abs(h.car.forwardSpeed) * 3.6;
  h.reset();
  console.log(`\n  [reset while moving at ${before.toFixed(1)} km/h]`);
  printTable('D: reset while moving, then 3 s throttle', h.run(3, { ...NEUTRAL, throttle: 1 }));

  // Reset while the car is ROTATED. Regression: reset used to restore position
  // but not rotation, leaving the car pointing at the wall after an R press.
  h.reset(); h.settle();
  h.run(4, { ...NEUTRAL, throttle: 0.7, steer: 0.8 });
  const yawDeg = (() => {
    const r = h.car.body.rotation();
    return (Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)) * 180) / Math.PI;
  })();
  h.reset();
  const r0 = h.car.body.rotation();
  const yawAfter = (Math.atan2(2 * (r0.w * r0.y + r0.x * r0.z), 1 - 2 * (r0.y * r0.y + r0.x * r0.x)) * 180) / Math.PI;
  const t0 = h.car.body.translation();
  console.log(`\n  [reset while rotated: yaw ${yawDeg.toFixed(1)} deg -> ${yawAfter.toFixed(2)} deg]`);
  console.log(`  [position after reset: x=${t0.x.toFixed(2)} y=${t0.y.toFixed(3)} z=${t0.z.toFixed(2)}]`);
  if (Math.abs(yawAfter) > 0.01) {
    console.log('  *** FAIL: reset did not restore heading (car will drive sideways) ***');
  } else {
    console.log('  OK: heading restored to 0');
  }
  printTable('E: reset while rotated, then 3 s throttle', h.run(3, { ...NEUTRAL, throttle: 1 }));
}

/* ------------------------------------------------------------------ */
/* Drift sweep                                                         */
/* ------------------------------------------------------------------ */

/**
 * Realistic drift initiation: build speed, flick the handbrake to break the
 * rear away, then release it and hold the slide on the throttle.
 *
 * `steadySlip` is the mean slip angle over the last 1.2 s. A good drift keeps
 * a real angle while still carrying speed; a spin kills the exit speed.
 */
function driftProbe(h, overrides) {
  Object.assign(CONFIG.tires, overrides.tires ?? {});
  Object.assign(CONFIG.brakes, overrides.brakes ?? {});
  Object.assign(CONFIG.assists, overrides.assists ?? {});
  h.reapply();
  h.reset();
  h.settle();

  // Build speed.
  h.run(2.6, { ...NEUTRAL, throttle: 1 });
  const entry = Math.abs(h.car.forwardSpeed) * 3.6;

  // Initiate: brief handbrake flick with steering.
  h.run(overrides.flick ?? 0.3, {
    ...NEUTRAL,
    steer: 0.8,
    handbrake: overrides.flickHandbrake ?? 1,
    throttle: 0,
  });

  // Sustain: handbrake released, back on the power, lock still held.
  const rows = h.run(2.4, {
    ...NEUTRAL,
    steer: overrides.steer ?? 0.55,
    throttle: overrides.throttle ?? 1,
    handbrake: 0,
  }, 0.1);

  const tail = rows.filter((r) => r.t > 1.2);
  const mean = (k) => tail.reduce((s, r) => s + Math.abs(r[k]), 0) / Math.max(tail.length, 1);
  const peak = (k) => Math.max(...rows.map((r) => Math.abs(r[k])));

  return {
    entryKmh: entry,
    exitKmh: Math.abs(h.car.forwardSpeed) * 3.6,
    peakSlip: peak('slip'),
    steadySlip: mean('slip'),
    peakLatG: peak('latG'),
    yawTravel: Math.abs(rows[rows.length - 1].yaw - rows[0].yaw),
  };
}

/** A drift is "good" when it holds angle AND still carries speed. */
const driftVerdict = (r) => {
  if (r.steadySlip > 12 && r.exitKmh > 30) return '  <-- GOOD DRIFT';
  if (r.steadySlip > 12) return '  <-- spins out';
  if (r.steadySlip > 6) return '  <-- loose';
  return '  <-- grips (no drift)';
};

async function sweep() {
  const defaults = {
    tires: { ...CONFIG.tires },
    brakes: { ...CONFIG.brakes },
    assists: { ...CONFIG.assists },
  };
  const restore = () => {
    Object.assign(CONFIG.tires, defaults.tires);
    Object.assign(CONFIG.brakes, defaults.brakes);
    Object.assign(CONFIG.assists, defaults.assists);
  };

  const h = await Harness.create();
  const printRow = (label, r) =>
    console.log(
      `  ${label.padEnd(28)} ${f(r.entryKmh, 6, 1)} ${f(r.exitKmh, 6, 1)} ${f(r.peakSlip, 9, 1)} ` +
        `${f(r.steadySlip, 11, 1)} ${f(r.peakLatG, 9, 2)}${driftVerdict(r)}`,
    );
  const header = () =>
    console.log('  variant                         entry   exit  peakSlip  steadySlip  peakLatG');

  console.log('\n=== rear longitudinal grip (handbrake flick, then full power) ===');
  header();
  for (const slipR of [2.6, 2.35, 2.2, 2.1, 2.0, 1.9]) {
    printRow(`frictionSlipRear=${slipR}`, driftProbe(h, { tires: { frictionSlipRear: slipR } }));
  }
  restore();

  console.log('\n=== rear lateral grip ===');
  header();
  for (const sideR of [1.0, 0.75, 0.55, 0.4]) {
    printRow(
      `sideStiffRear=${sideR}`,
      driftProbe(h, { tires: { sideFrictionStiffnessRear: sideR } }),
    );
  }
  restore();

  console.log('\n=== handbrake force ===');
  header();
  for (const hb of [0, 60, 100, 160, 260]) {
    printRow(`handbrakeForce=${hb}`, driftProbe(h, { brakes: { handbrakeForce: hb } }));
  }
  restore();

  console.log('\n=== counter-steer assist (help or fight?) ===');
  header();
  for (const cs of [0, 0.2, 0.35, 0.6]) {
    printRow(`counterSteer=${cs}`, driftProbe(h, { assists: { counterSteer: cs } }));
  }
  restore();

  console.log('\n=== handbrake authority (straight line, held 2 s) ===');
  for (const hb of [0, 60, 100, 160, 260]) {
    Object.assign(CONFIG.brakes, defaults.brakes, { handbrakeForce: hb });
    h.reapply();
    h.reset();
    h.settle();
    h.run(2.6, { ...NEUTRAL, throttle: 1 });
    const before = Math.abs(h.car.forwardSpeed) * 3.6;
    h.run(2.0, { ...NEUTRAL, handbrake: 1 });
    const after = Math.abs(h.car.forwardSpeed) * 3.6;
    console.log(
      `  handbrakeForce=${String(hb).padStart(3)}  ${before.toFixed(1)} -> ${after.toFixed(1)} km/h`,
    );
  }
  restore();
}

/* ------------------------------------------------------------------ */

if (scenario === 'sweep') await sweep();
else if (scenario === 'reset') await resetRegression();
else await tables(scenario);
