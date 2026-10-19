/**
 * Headless smoke test — drives the game in Chrome and reports whether it
 * actually runs. Not shipped to the browser bundle; dev tooling only.
 *
 * Usage: node scripts/smoke_test.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    // Prefer the real GPU. The prepared car model is far more fill-rate heavy
    // than the placeholder boxes were, and software GL renders it several times
    // slower — slow enough that the physics accumulator can no longer keep up.
    // The swiftshader flag stays so a machine with no GPU access still boots
    // instead of failing to create a WebGL context.
    '--enable-unsafe-swiftshader',
    '--window-size=1280,720',
  ],
});

let failed = false;
const fail = (msg) => { failed = true; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`ok    ${msg}`);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') errors.push(text);
    if (m.type() === 'warning') warnings.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // ---- boot ---------------------------------------------------------
  await page.waitForFunction(() => window.__MARINA_BAY__ != null, { timeout: 45000 })
    .then(() => pass('booted: window.__MARINA_BAY__ present'))
    .catch(() => fail('game never exposed __MARINA_BAY__ (boot failure)'));

  if (errors.length) {
    console.log('\n--- console errors during boot ---');
    errors.slice(0, 10).forEach((e) => console.log(`  ${e}`));
  }

  const bootState = await page.evaluate(() => {
    const g = window.__MARINA_BAY__;
    if (!g) return null;
    return {
      bodies: g.physics.bodyCount,
      colliders: g.physics.colliderCount,
      wheels: g.car.wheels.length,
      mode: g.rig.mode,
      loadingHidden: document.getElementById('loading').classList.contains('hidden'),
      errVisible: !document.getElementById('error').classList.contains('hidden'),
    };
  });

  if (!bootState) {
    fail('no boot state');
  } else {
    console.log('      boot state:', JSON.stringify(bootState));
    bootState.errVisible ? fail('error overlay is visible') : pass('no error overlay');
    bootState.loadingHidden ? pass('loading overlay dismissed') : fail('loading overlay stuck');
    bootState.wheels === 4 ? pass('4 wheels registered') : fail(`wheels=${bootState.wheels}`);
    bootState.bodies > 0 ? pass(`physics world has ${bootState.bodies} bodies`) : fail('empty world');
  }

  // ---- keep the simulation in real time ------------------------------
  // `physics.stepFrame` caps catch-up at `maxSubSteps` so a slow frame can never
  // spiral. That is right for a game, but under a slow headless renderer it means
  // the world advances at a fraction of real time, and every timed assertion
  // below then fails for the wrong reason. Measure the frame rate and widen the
  // catch-up so the test measures the game, not the renderer.
  const headlessFps = await page.evaluate(async () => {
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames++;
        if (performance.now() - start > 1200) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return frames / ((performance.now() - start) / 1000);
  });

  const catchUp = await page.evaluate((fps) => {
    const g = window.__MARINA_BAY__;
    const before = { frame: g.physics.cfg.maxFrameTime, subSteps: g.physics.cfg.maxSubSteps };
    const frame = Math.min(1, Math.max(0.25, 1.2 / Math.max(fps, 0.5)));
    g.physics.cfg.maxFrameTime = frame;
    g.physics.cfg.maxSubSteps = Math.ceil(frame / g.physics.fixedDt) + 2;
    return { frame, maxSubSteps: g.physics.cfg.maxSubSteps, before };
  }, headlessFps);

  console.log(
    `      headless frame rate ${headlessFps.toFixed(1)} fps — physics catch-up widened to ` +
      `${catchUp.maxSubSteps} substeps / ${catchUp.frame.toFixed(2)} s so the sim still tracks real time`,
  );

  // Let the suspension settle before measuring where the car sits on the road.
  await sleep(1500);

  // ---- prepared car model -------------------------------------------
  // These cover the parts of the Stage 2 swap that are easy to get subtly
  // wrong: the wheels must be reparented onto the physics-driven groups, and the
  // body must sit on the road rather than through it or hovering above it.
  const model = await page.evaluate(() => {
    /** World-space bounds of a subtree. Conservative for rotated nodes. */
    const bounds = (obj) => {
      obj.updateWorldMatrix(true, true);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      obj.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        const m = o.matrixWorld.elements;
        for (let i = 0; i < 8; i++) {
          const px = i & 1 ? bb.max.x : bb.min.x;
          const py = i & 2 ? bb.max.y : bb.min.y;
          const pz = i & 4 ? bb.max.z : bb.min.z;
          const x = m[0] * px + m[4] * py + m[8] * pz + m[12];
          const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
          const z = m[2] * px + m[6] * py + m[10] * pz + m[14];
          if (x < min[0]) min[0] = x;
          if (y < min[1]) min[1] = y;
          if (z < min[2]) min[2] = z;
          if (x > max[0]) max[0] = x;
          if (y > max[1]) max[1] = y;
          if (z > max[2]) max[2] = z;
        }
      });
      return { min, max };
    };

    const car = window.__MARINA_BAY__.car;
    const round = (v) => +v.toFixed(3);
    const body = bounds(car.exterior);

    // The car starts facing the racing direction, not +Z, so hub offsets are
    // measured in the car's own frame: `lx` is to its left, `lz` forward.
    const origin = car.root.position;
    const yaw = car.telemetry.yaw;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);

    const hubs = car.wheelSteerGroups.map((g) => {
      const b = bounds(g);
      const x = (b.min[0] + b.max[0]) / 2 - origin.x;
      const z = (b.min[2] + b.max[2]) / 2 - origin.z;
      return {
        x: round(x),
        y: round((b.min[1] + b.max[1]) / 2),
        z: round(z),
        lx: round(x * cy - z * sy),
        lz: round(x * sy + z * cy),
        bottom: round(b.min[1]),
      };
    });

    return {
      usingRealModel: !!car.usingRealModel,
      wheelNodes: car.wheelSpinGroups.map((g) => g.children.map((c) => c.name).join('+')),
      bodyFloorY: round(body.min[1]),
      bodyTopY: round(body.max[1]),
      hubs,
    };
  });

  console.log('      car model:', JSON.stringify(model));

  model.usingRealModel
    ? pass('car.glb loaded (not the placeholder)')
    : fail('car.glb did not load — the game fell back to placeholder boxes');

  model.wheelNodes.every((n) => /^wheel_(FL|FR|RL|RR)$/.test(n))
    ? pass(`wheels reparented onto the spin groups: ${model.wheelNodes.join(' ')}`)
    : fail(`wheel nodes not in the spin groups: ${JSON.stringify(model.wheelNodes)}`);

  {
    const [fl, fr, rl, rr] = model.hubs;
    const wheelbase = Math.abs(fl.lz - rl.lz);
    const frontTrack = Math.abs(fl.lx - fr.lx);
    const rearTrack = Math.abs(rl.lx - rr.lx);
    const ySpread = Math.max(...model.hubs.map((h) => h.y)) - Math.min(...model.hubs.map((h) => h.y));

    Math.abs(wheelbase - 2.66) < 0.02
      ? pass(`visual wheelbase ${wheelbase.toFixed(3)} m matches physics (2.66)`)
      : fail(`visual wheelbase ${wheelbase.toFixed(3)} m, physics says 2.66`);

    Math.abs(frontTrack - 1.696) < 0.02 && Math.abs(rearTrack - 1.69) < 0.02
      ? pass(`visual track ${frontTrack.toFixed(3)} / ${rearTrack.toFixed(3)} m matches the hardpoints`)
      : fail(`visual track ${frontTrack.toFixed(3)}/${rearTrack.toFixed(3)} m, hardpoints say 1.696/1.690`);

    // Front and rear tyres are genuinely different sizes on the real car, but
    // the vehicle controller uses one radius, so a small spread is expected.
    ySpread < 0.03
      ? pass(`all four hubs at the same height (±${(ySpread * 1000).toFixed(0)} mm)`)
      : fail(`hub heights vary by ${(ySpread * 1000).toFixed(0)} mm — wheels are not on one plane`);
  }

  {
    const lowest = Math.min(...model.hubs.map((h) => h.bottom));
    Math.abs(lowest) < 0.03
      ? pass(`wheels touch the road (lowest tyre bottom y=${lowest.toFixed(3)})`)
      : fail(`wheels are off the road by ${(lowest * 1000).toFixed(0)} mm`);

    model.bodyFloorY > 0
      ? pass(`body sits above the road (floor y=${model.bodyFloorY})`)
      : fail(`body is ${(-model.bodyFloorY * 1000).toFixed(0)} mm into the road`);
  }

  // ---- simulate driving --------------------------------------------
  const sample = async (label) => page.evaluate((lbl) => {
    const g = window.__MARINA_BAY__;
    const t = g.car.telemetry;
    const p = g.car.root.position;
    return {
      label: lbl,
      speed: +t.speedKmh.toFixed(2),
      vmag: +t.speedMs.toFixed(2),
      rpm: +t.rpm.toFixed(0),
      gear: t.gearLabel,
      y: +p.y.toFixed(3),
      x: +p.x.toFixed(2),
      z: +p.z.toFixed(2),
      contact: t.inContact.filter(Boolean).length,
      throttle: +g.input.throttle.toFixed(3),
      brake: +g.input.brake.toFixed(3),
      keys: [...g.input.keys].join(','),
      drive: Math.round(t.driveForce),
      fBrake: +t.frontBrake.toFixed(1),
      rBrake: +t.rearBrake.toFixed(1),
      steerDeg: +((t.steerAngle * 180) / Math.PI).toFixed(1),
      yaw: +t.yaw.toFixed(4),
      steps: g.physics.stepCount,
      running: g.running,
    };
  }, label);

  const rest = await sample('rest');
  console.log('      at rest:', JSON.stringify(rest));

  if (rest.y > 0.50 && rest.y < 0.60) pass(`ride height on target (y=${rest.y}, design 0.61 minus ~0.07 squat)`);
  else fail(`ride height looks wrong (y=${rest.y}, expected ~0.55)`);

  if (rest.contact === 4) pass('all four wheels on the ground at rest');
  else fail(`only ${rest.contact}/4 wheels in contact at rest`);

  // Accelerate for 4 seconds.
  await page.keyboard.down('KeyW');
  await sleep(4000);
  const accelerating = await sample('accel');
  console.log('      after 4s throttle:', JSON.stringify(accelerating));
  await page.keyboard.up('KeyW');

  if (accelerating.speed > 60) pass(`accelerates (${accelerating.speed} km/h after 4 s)`);
  else fail(`barely accelerates: ${accelerating.speed} km/h after 4 s`);

  if (accelerating.gear !== 'N' && accelerating.gear !== '1') pass(`auto-shifted to gear ${accelerating.gear}`);
  else fail(`still in gear ${accelerating.gear} after 4 s of throttle`);

  const travelled = Math.hypot(accelerating.x - rest.x, accelerating.z - rest.z);
  if (travelled > 20) pass(`moved ${travelled.toFixed(0)} m along the road`);
  else fail(`did not travel forward (moved ${travelled.toFixed(1)} m)`);

  // ---- braking ------------------------------------------------------
  await page.keyboard.down('KeyS');
  await sleep(2500);
  const braking = await sample('brake');
  await page.keyboard.up('KeyS');
  console.log('      after 2.5s brake:', JSON.stringify(braking));
  if (braking.speed < accelerating.speed) pass(`brakes (${accelerating.speed} -> ${braking.speed} km/h)`);
  else fail('brakes had no effect');

  // ---- steering -----------------------------------------------------
  const beforeTurn = await sample('pre-turn');
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await sleep(2500);
  const turned = await sample('turn');

  // Capture the wheel rig while the car is still mid-corner: the front wheels
  // should be visibly steered and spinning, the rears spinning but straight.
  const wheelRig = await page.evaluate(() => {
    const car = window.__MARINA_BAY__.car;
    return {
      spin: car.wheelSpinGroups.map((g) => +g.rotation.x.toFixed(2)),
      steerDeg: car.wheelSteerGroups.map((g) => +((g.rotation.y * 180) / Math.PI).toFixed(1)),
    };
  });
  console.log('      wheel rig mid-corner:', JSON.stringify(wheelRig));

  wheelRig.spin.every((v) => Math.abs(v) > 1)
    ? pass('all four wheels are spinning')
    : fail(`wheels not spinning: ${wheelRig.spin.join(', ')}`);

  {
    const front = wheelRig.steerDeg.slice(0, 2);
    const rear = wheelRig.steerDeg.slice(2);
    front.every((v) => Math.abs(v) > 2) && rear.every((v) => Math.abs(v) < 0.5)
      ? pass(`front wheels steer (${front[0]}°), rears stay straight (${rear[0]}°)`)
      : fail(`steering rig wrong: front ${front.join('/')}°, rear ${rear.join('/')}°`);
  }

  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
  console.log('      after 2.5s left turn:', JSON.stringify(turned));
  {
    // The car no longer starts facing +Z, so "left" has to come from its own
    // heading rather than from the world axes.
    const cy = Math.cos(beforeTurn.yaw);
    const sy = Math.sin(beforeTurn.yaw);
    const dx = turned.x - beforeTurn.x;
    const dz = turned.z - beforeTurn.z;
    const left = dx * cy - dz * sy;
    const forward = dx * sy + dz * cy;
    left > 3
      ? pass(`steering turns left (${left.toFixed(1)} m to the car's left, ${forward.toFixed(1)} m forward)`)
      : fail(`left turn did not move the car to its left (${left.toFixed(1)} m)`);
  }

  // ---- handbrake (regression test) ----------------------------------
  // Rapier ignores wheelBrake whenever wheelEngineForce is non-zero, so a
  // non-zero engine-braking force silently disabled the entire handbrake.
  await page.keyboard.press('KeyR');
  await sleep(400);
  await page.keyboard.down('KeyW');
  await sleep(3000);
  const preHandbrake = await sample('pre-handbrake');
  console.log('      pre-handbrake:', JSON.stringify(preHandbrake));
  await page.keyboard.up('KeyW');
  await page.keyboard.down('Space');
  await sleep(1500);
  const postHandbrake = await sample('handbrake');
  console.log('      post-handbrake:', JSON.stringify(postHandbrake));
  await page.keyboard.up('Space');
  console.log(`      handbrake: ${preHandbrake.speed} -> ${postHandbrake.speed} km/h`);
  if (postHandbrake.speed < preHandbrake.speed * 0.5) {
    pass('handbrake bites (speed more than halved)');
  } else {
    fail(`handbrake ineffective (${preHandbrake.speed} -> ${postHandbrake.speed} km/h)`);
  }

  // ---- handbrake drift ----------------------------------------------
  await page.keyboard.press('KeyR');
  await sleep(400);
  await page.keyboard.down('KeyW');
  await sleep(3000);
  const preDriftYaw = await page.evaluate(() => window.__MARINA_BAY__.car.telemetry.yawRate);
  await page.keyboard.down('KeyA');
  await page.keyboard.down('Space');
  await sleep(400);
  await page.keyboard.up('Space');
  await sleep(700);
  const driftSample = await page.evaluate(() => {
    const t = window.__MARINA_BAY__.car.telemetry;
    return { slip: Math.abs(t.slipAngle) * (180 / Math.PI), yawRate: t.yawRate };
  });
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
  console.log(
    `      drift: pre-yawRate ${preDriftYaw.toFixed(2)} -> slip ${driftSample.slip.toFixed(1)} deg`,
  );
  if (driftSample.slip > 8) pass(`handbrake flick induces oversteer (${driftSample.slip.toFixed(1)} deg)`);
  else fail(`handbrake flick did not break the rear away (slip ${driftSample.slip.toFixed(1)} deg)`);

  // ---- reset --------------------------------------------------------
  await page.keyboard.press('KeyR');
  await sleep(500);
  const afterReset = await sample('reset');
  console.log('      after reset:', JSON.stringify(afterReset));
  if (afterReset.speed < 5) pass('R resets the car (speed ~0)');
  else fail(`R did not reset speed (${afterReset.speed} km/h)`);

  // ---- camera cycle -------------------------------------------------
  const modes = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('KeyC');
    await sleep(250);
    modes.push(await page.evaluate(() => window.__MARINA_BAY__.rig.mode));
  }
  console.log('      camera modes:', JSON.stringify(modes));
  new Set(modes).size === 3 ? pass('C cycles through 3 camera modes') : fail('camera cycle broken');

  // ---- frame cost ---------------------------------------------------
  // The headless frame *rate* is not a measure of performance: headless Chrome
  // paces rAF against its own compositor, so it reports ~12 fps even when a frame
  // costs 5 ms. Time the work instead, and sync the GPU so the figure is real
  // rather than just command submission.
  await page.evaluate((before) => {
    const g = window.__MARINA_BAY__;
    g.physics.cfg.maxFrameTime = before.frame;
    g.physics.cfg.maxSubSteps = before.subSteps;
  }, catchUp.before);

  const cost = await page.evaluate(() => {
    const g = window.__MARINA_BAY__;
    const cam = g.rig.camera;
    const gl = g.renderer.getContext();
    for (let i = 0; i < 5; i++) g.renderer.render(g.scene, cam); // warm caches
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      g.renderer.render(g.scene, cam);
      gl.finish();
    }
    return {
      renderMs: (performance.now() - t0) / 20,
      stepMs: g.physics.stepMs,
      calls: g.renderer.info.render.calls,
      tris: g.renderer.info.render.triangles,
    };
  });

  const frameMs = cost.renderMs + cost.stepMs;
  console.log(
    `      frame cost: render ${cost.renderMs.toFixed(2)} ms (GPU-synced) + physics ` +
      `${cost.stepMs.toFixed(2)} ms = ${frameMs.toFixed(2)} ms`,
  );
  console.log(`      draw calls ${cost.calls}, triangles ${cost.tris.toLocaleString('en-US')}`);
  frameMs < 16.7
    ? pass(`frame budget fits 60 fps with ${(16.7 - frameMs).toFixed(1)} ms spare`)
    : fail(`frame costs ${frameMs.toFixed(1)} ms — below 60 fps`);

  console.log(`      (headless rAF rate ${headlessFps.toFixed(1)} fps is compositor pacing, not perf)`);

  await page.screenshot({ path: 'dist/smoke-screenshot.png' });
  console.log('      screenshot: dist/smoke-screenshot.png');

  if (errors.length) {
    console.log('\n--- console errors ---');
    errors.slice(0, 15).forEach((e) => console.log(`  ${e}`));
    fail(`${errors.length} console error(s)`);
  } else {
    pass('no console errors');
  }
} finally {
  await browser.close();
}

console.log(failed ? '\nRESULT: FAILURES PRESENT' : '\nRESULT: ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
