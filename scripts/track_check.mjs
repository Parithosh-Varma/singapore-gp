/**
 * Circuit alignment check — the collision surface is swept along the centreline
 * rather than cut from the model, so the one thing that can go wrong is the two
 * drifting apart: a car that floats or sinks, wheels biting the tarmac instead
 * of the dirt, or a wall in the middle of the track.
 *
 * This walks the lap and, at every sample, casts a ray straight down at the
 * racing line through both the visual model and the physics world and compares.
 * It then drops the car onto the surface and checks the wheels make contact and
 * the tyres sit on the paint rather than in it.
 *
 * Usage: node scripts/track_check.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://localhost:5173/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const STATIONS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
});

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`ok    ${msg}`);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => window.__MARINA_BAY__ != null, { timeout: 90000 });

  const usingCircuit = await page.evaluate(() => Boolean(window.__MARINA_BAY__.track?.path));
  if (!usingCircuit) {
    console.log('The game is running the flat test facility, not the circuit.');
    console.log('Run `npm run prepare:track` first.');
    process.exit(2);
  }

  // ---- 1. visual vs collision height every few metres ------------------
  console.log(`\n=== surface alignment (${STATIONS} stations around the lap) ===`);

  const probes = await page.evaluate(async (stations) => {
    const g = window.__MARINA_BAY__;
    const THREE = g.THREE;
    const path = g.track.path;

    // Park the car well out of the way: a ray dropped on the start line would
    // otherwise land on its roof and report the collision as a metre high. The
    // move only reaches the broad phase on the next step, so let a few frames
    // go by before probing.
    g.car.reset({ x: 0, y: 600, z: 0 }, 0);
    await new Promise((r) => setTimeout(r, 200));

    const raycaster = new THREE.Raycaster();
    raycaster.far = 400;
    const target = g.track.model;

    const down = new THREE.Vector3(0, -1, 0);
    const out = [];

    for (let k = 0; k < stations; k++) {
      const p = path.at((k / stations) * path.length);
      const from = new THREE.Vector3(p.x, p.y + 40, p.z);

      // Visual: first surface the ray meets, ignoring anything not in the model.
      raycaster.set(from, down);
      const hits = raycaster.intersectObject(target, true);
      const visual = hits.length ? hits[0].point.y : null;

      // Collision: the same ray, against the physics world.
      const ray = new g.physics.RAPIER.Ray({ x: p.x, y: p.y + 40, z: p.z }, { x: 0, y: -1, z: 0 });
      const hit = g.physics.world.castRay(ray, 400, true);
      const toi = hit ? (hit.timeOfImpact ?? hit.toi) : null;
      const collision = hit ? p.y + 40 - toi : null;

      out.push({
        k,
        s: (k / stations) * path.length,
        x: p.x,
        z: p.z,
        visual,
        collision,
        name: hits.length ? hits[0].object.name || '(unnamed)' : null,
        mat: hits.length ? hits[0].object.material?.name ?? null : null,
      });
    }
    return out;
  }, STATIONS);

  const missingVisual = probes.filter((p) => p.visual === null);
  const missingCollision = probes.filter((p) => p.collision === null);
  const gaps = probes
    .filter((p) => p.visual !== null && p.collision !== null)
    .map((p) => ({ ...p, gap: p.collision - p.visual }));

  if (missingVisual.length) {
    fail(`${missingVisual.length}/${STATIONS} stations have no visual road under the racing line`);
    missingVisual.slice(0, 5).forEach((p) => console.log(`        no road at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`));
  } else {
    pass(`every station has road under the racing line`);
  }

  if (missingCollision.length) {
    fail(`${missingCollision.length}/${STATIONS} stations have no collision under the racing line`);
  } else {
    pass(`every station has collision under the racing line`);
  }

  const sorted = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const worst = gaps.reduce((a, b) => (Math.abs(b.gap) > Math.abs(a.gap) ? b : a));
  console.log(
    `      collision minus visual: p10 ${q(0.1).toFixed(3)} m, median ${q(0.5).toFixed(3)} m, ` +
      `p90 ${q(0.9).toFixed(3)} m`,
  );

  const bad = gaps.filter((g) => Math.abs(g.gap) > 0.05).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  console.log(`      ${bad.length} station(s) off by more than 5 cm:`);
  for (const b of bad.slice(0, 8)) {
    console.log(
      `        at ${b.s.toFixed(0).padStart(5)} m into the lap (${b.x.toFixed(1)}, ${b.z.toFixed(1)})  ` +
        `visual ${b.visual.toFixed(3)}  collision ${b.collision.toFixed(3)}  gap ${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(3)}  ` +
        `on ${b.name}`,
    );
  }

  if (Math.abs(worst.gap) > 0.1) {
    fail(
      `collision and visual drift apart by ${worst.gap.toFixed(3)} m at ${worst.s.toFixed(0)} m ` +
        `(${worst.x.toFixed(0)}, ${worst.z.toFixed(0)}) — the car will float or sink`,
    );
  } else {
    pass(`collision tracks the visual road within ${Math.abs(worst.gap).toFixed(3)} m everywhere`);
  }

  // ---- 2. drop the car on and see if the wheels find the ground ---------
  console.log(`\n=== the car on the road (24 stations) ===`);

  const drops = await page.evaluate(async () => {
    const g = window.__MARINA_BAY__;
    const path = g.track.path;
    const out = [];

    for (let k = 0; k < 24; k++) {
      const p = path.at((k / 24) * path.length);
      g.car.reset(
        { x: p.x, y: p.y + g.config.chassisRestHeight + 0.05, z: p.z },
        p.yaw,
      );
      // Let the suspension settle, then read the wheels.
      await new Promise((r) => setTimeout(r, 350));
      const t = g.car.telemetry;
      out.push({
        k,
        contact: t.inContact.filter(Boolean).length,
        y: g.car.root.position.y,
        road: p.y,
        speed: t.speedKmh,
      });
    }
    return out;
  });

  const noContact = drops.filter((d) => d.contact < 4);
  if (noContact.length) {
    fail(`${noContact.length}/24 stations only put ${noContact.map((d) => d.contact).join('/')} wheels on the ground`);
  } else {
    pass('all four wheels touch the ground at every station');
  }

  const restYs = drops.map((d) => d.y - d.road);
  const ranked = [...restYs].sort((a, b) => a - b);
  console.log(
    `      ride height above the racing line: ${ranked[0].toFixed(3)} .. ${ranked[ranked.length - 1].toFixed(3)} m`,
  );
  if (ranked[0] < 0.35 || ranked[ranked.length - 1] > 0.75) {
    fail(`ride height swings too far (${ranked[0].toFixed(2)}..${ranked[ranked.length - 1].toFixed(2)} m)`);
  } else {
    pass('ride height stays in range all the way round');
  }

  const stuck = drops.filter((d) => d.speed > 1);
  if (stuck.length) {
    fail(`the car slides away at ${stuck.length}/24 stations (up to ${Math.max(...stuck.map((d) => d.speed)).toFixed(1)} km/h)`);
  } else {
    pass('the car sits still where it is put, so nothing is pushing it sideways');
  }

  // ---- 3. can it actually lap? -----------------------------------------
  console.log(`\n=== a lap under throttle ===`);
  await page.evaluate(() => {
    const g = window.__MARINA_BAY__;
    const p = g.track.path.at(0);
    g.car.reset({ x: p.x, y: p.y + g.config.chassisRestHeight + 0.05, z: p.z }, p.yaw);
  });
  await sleep(400);
  await page.keyboard.down('KeyW');
  await sleep(6000);
  const run = await page.evaluate(() => {
    const g = window.__MARINA_BAY__;
    const pos = g.car.root.position;
    const near = g.track.path.nearest(pos.x, pos.z);
    const t = g.car.telemetry;
    return {
      s: near.s,
      off: near.distance,
      speed: t.speedKmh,
      contact: t.inContact.filter(Boolean).length,
      y: pos.y,
      road: g.track.path.points[near.index][1],
      bounds: g.track.path.points[near.index][3],
    };
  });
  await page.keyboard.up('KeyW');
  console.log(
    `      after 6 s: ${run.speed.toFixed(0)} km/h, ${run.s.toFixed(0)} m into the lap, ` +
      `${run.off.toFixed(1)} m off the racing line (half-width ${run.bounds.toFixed(1)} m)`,
  );

  if (run.off < run.bounds + 6) pass('still on the road after 6 s of throttle');
  else fail(`ran off the road (${run.off.toFixed(1)} m from the racing line)`);
  if (run.contact >= 2) pass(`${run.contact}/4 wheels still on the ground`);
  else fail(`airborne or stuck — ${run.contact}/4 wheels in contact`);

  console.log('');
  if (errors.length) {
    console.log('--- console errors ---');
    errors.slice(0, 10).forEach((e) => console.log(`  ${e}`));
    failures += 1;
  }

  console.log(failures === 0 ? 'RESULT: ALL CHECKS PASSED' : `RESULT: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
