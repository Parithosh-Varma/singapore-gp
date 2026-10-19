/**
 * Bootstrap + main loop for the Marina Bay prototype.
 *
 * Stage 1: flat test track, placeholder box car, Rapier raycast-vehicle physics,
 * chase/hood/cockpit cameras, HUD, and a live tuning panel (F1).
 */
import * as THREE from 'three';
import GUI from 'lil-gui';

import { CONFIG } from './config.js';
import { Physics } from './physics.js';
import { Car } from './car.js';
import { buildTestTrack, createSkybox } from './track.js';
import { loadCircuit } from './circuit.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { Input, ACTION } from './input.js';

const PRESET_KEY = 'marina-bay:tuning-preset:v1';
const TUNABLE = ['suspension', 'tires', 'steering', 'brakes', 'drivetrain', 'aero', 'assists'];

const snapshotTuning = () =>
  JSON.parse(JSON.stringify(Object.fromEntries(TUNABLE.map((k) => [k, CONFIG[k]]))));

const applyTuning = (snap) => {
  for (const key of TUNABLE) {
    if (snap?.[key]) Object.assign(CONFIG[key], snap[key]);
  }
};

async function main() {
  const hud = new HUD();

  let renderer;
  try {
    renderer = createRenderer();
  } catch (err) {
    hud.showError(
      'WebGL is not available in this browser.',
      `${err?.message ?? err}\n\nTry a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.`,
    );
    return;
  }

  hud.setLoading(0.08, 'Starting physics engine…');

  let physics;
  let car;
  try {
    physics = await Physics.create(CONFIG);

    hud.setLoading(0.35, 'Building world…');
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x232a38, CONFIG.render.fogNear, CONFIG.render.fogFar);
    const sky = createSkybox({ top: 0x0a1024, bottom: 0x2c3547, exponent: 0.75 });
    scene.add(sky);

    const lights = createLights(scene, CONFIG);
    const sun = lights.sun;

    hud.setLoading(0.42, 'Reading the racing line…');
    let track;
    try {
      track = await loadCircuit(physics, CONFIG, (pct, msg) => hud.setLoading(pct, msg));
    } catch (err) {
      // A missing or unreadable track is not fatal — the flat test facility
      // still drives, so the game stays playable and the reason goes to the
      // console. Run `npm run prepare:track` to build the real one.
      console.warn(`Falling back to the flat test facility: ${err.message}`);
      hud.setLoading(0.6, 'Laying out test circuit…');
      track = buildTestTrack(physics, CONFIG);
      track.fallback = true;
    }
    scene.add(track.group);

    hud.setLoading(0.85, 'Assembling car…');
    car = new Car(physics, CONFIG);
    car.reset(track.start.position, track.start.yaw);
    scene.add(car.root);

    hud.setLoading(0.92, 'Loading Ferrari 296 GT3…');
    try {
      const info = await car.loadVisualModel('/assets/car.glb', (event) => {
        if (!event.total) return;
        const pct = 0.92 + 0.06 * (event.loaded / event.total);
        hud.setLoading(pct, 'Loading Ferrari 296 GT3…');
      });
      console.log(
        `car.glb loaded: ${info.triangles.toLocaleString('en-US')} triangles, ` +
          `body offset y = ${info.offsetY.toFixed(3)} m`,
      );
    } catch (err) {
      // A missing or unreadable model is not fatal — the placeholder car still
      // drives, so the game stays playable and the reason goes to the console.
      console.warn(`Using the placeholder car: ${err.message}`);
    }

    const rig = new CameraRig(CONFIG, window.innerWidth / window.innerHeight);
    const input = new Input(CONFIG);
    input.attach();

    hud.setLoading(1, 'Ready');
    hud.hideLoading();

    // ------------------------------------------------------------------
    // Debug + tuning panel
    // ------------------------------------------------------------------
    const gui = buildTuningGui(car, CONFIG);
    gui.hide();
    let debugVisible = false;

    // ------------------------------------------------------------------
    // Loop
    // ------------------------------------------------------------------
    const clock = { last: performance.now(), perf: performance.now() };
    let frameMsSmoothed = 16.7;
    let paused = false;

    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
      renderer.setSize(w, h, false);
      rig.resize(w / h);
    };
    window.addEventListener('resize', onResize);
    onResize();

    // A backgrounded tab produces a huge delta on return; swallow it.
    document.addEventListener('visibilitychange', () => {
      clock.last = performance.now();
    });

    const sunOffset = new THREE.Vector3(70, 130, 50);

    function frame(now) {
      requestAnimationFrame(frame);

      const dt = Math.min((now - clock.last) / 1000, CONFIG.physics.maxFrameTime);
      clock.last = now;

      // ---- one-shot actions ------------------------------------------
      if (input.consume(ACTION.PAUSE)) {
        paused = !paused;
        hud.setPaused(paused);
      }
      if (input.consume(ACTION.CAMERA)) {
        rig.cycleMode();
      }
      if (input.consume(ACTION.RESET)) {
        car.reset(track.start.position, track.start.yaw);
      }
      if (input.consume(ACTION.DEBUG)) {
        debugVisible = !debugVisible;
        if (debugVisible) gui.show();
        else gui.hide();
        if (!debugVisible) hud.setDebug(false);
      }

      // ---- simulate ---------------------------------------------------
      if (!paused) {
        const controls = input.read(dt);

        const t0 = performance.now();
        physics.stepFrame(dt, (fixedDt) => {
          car.beginStep();
          car.applyControls(fixedDt, controls);
          car.updateVehicle(fixedDt);
          physics.world.step();
          car.endStep();
        });
        physics.stepMs = physics.stepMs * 0.9 + (performance.now() - t0) * 0.1;

        car.syncVisual(physics.alpha);
      }

      // ---- present ----------------------------------------------------
      const cam = rig.camera;
      sky.position.copy(cam.position);

      if (sun.target) {
        sun.position.copy(car.root.position).add(sunOffset);
        sun.target.position.copy(car.root.position);
        sun.target.updateMatrixWorld();
      }

      rig.update(paused ? 0 : dt, car.telemetry);
      car.setExteriorVisible(!rig.isCockpit);
      hud.update(car.telemetry);

      renderer.render(scene, cam);

      // ---- debug overlay ----------------------------------------------
      if (debugVisible) {
        const frameMs = now - clock.perf;
        clock.perf = now;
        frameMsSmoothed += (frameMs - frameMsSmoothed) * 0.08;
        hud.setDebug(true, formatDebug(car, physics, rig, frameMsSmoothed));
      }
    }

    requestAnimationFrame(frame);

    // Debug/inspection hook — handy from the console and for headless smoke tests.
    window.__MARINA_BAY__ = {
      car,
      physics,
      rig,
      hud,
      input,
      scene,
      track,
      THREE,
      renderer,
      config: CONFIG,
      get running() { return !paused; },
    };
  } catch (err) {
    console.error(err);
    hud.showError(
      'Something went wrong while starting up.',
      err?.stack ?? String(err),
    );
  }
}

/* ==================================================================== */
/* Helpers                                                              */
/* ==================================================================== */

function createRenderer() {
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = CONFIG.render.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/** Returns `{ sun, hemi }` so the loop can keep the shadow frustum on the car. */
function createLights(scene, config) {
  // Stage 1 uses a neutral dusk setup; Stage 5 replaces this with the
  // Singapore night look (bloom, headlights, emissive track lighting).
  const hemi = new THREE.HemisphereLight(0x9fb6d8, 0x1a1d24, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xcfdcf5, 1.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(config.render.shadowMapSize, config.render.shadowMapSize);

  const d = 55;
  const cam = sun.shadow.camera;
  cam.left = -d;
  cam.right = d;
  cam.top = d;
  cam.bottom = -d;
  cam.near = 1;
  cam.far = 400;
  cam.updateProjectionMatrix();

  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;

  scene.add(sun);
  scene.add(sun.target);
  return { sun, hemi };
}

function buildTuningGui(car, config) {
  const gui = new GUI({ title: 'Tuning (F1)', width: 300 });
  gui.domElement.style.zIndex = '70';

  const s = gui.addFolder('Suspension');
  s.add(config.suspension, 'stiffness', 5, 60, 0.5);
  s.add(config.suspension, 'compression', 0, 2, 0.01);
  s.add(config.suspension, 'relaxation', 0, 2, 0.01);
  s.add(config.suspension, 'travel', 0.05, 0.4, 0.01);
  s.add(config.suspension, 'restLength', 0.1, 0.5, 0.01);
  s.add(config.suspension, 'maxForce', 5000, 80000, 500);
  s.onChange(() => car.reapplyTuning());

  const t = gui.addFolder('Tires');
  t.add(config.tires, 'frictionSlipFront', 1, 6, 0.05);
  t.add(config.tires, 'frictionSlipRear', 1, 6, 0.05);
  t.add(config.tires, 'sideFrictionStiffnessFront', 0.2, 2.5, 0.05);
  t.add(config.tires, 'sideFrictionStiffnessRear', 0.2, 2.5, 0.05);
  t.onChange(() => car.reapplyTuning());

  const st = gui.addFolder('Steering');
  st.add(config.steering, 'maxAngle', 0.1, 1.0, 0.01);
  st.add(config.steering, 'minAngleFactor', 0.05, 1, 0.01);
  st.add(config.steering, 'falloffSpeed', 5, 90, 1);
  st.add(config.steering, 'rate', 0.5, 15, 0.1);
  st.add(config.steering, 'returnRate', 0.5, 20, 0.1);

  const b = gui.addFolder('Brakes');
  b.add(config.brakes, 'force', 0, 200, 1);
  b.add(config.brakes, 'handbrakeForce', 0, 400, 5);
  b.add(config.brakes, 'engineBraking', 0, 40, 0.5);

  const dr = gui.addFolder('Drivetrain');
  dr.add(config.drivetrain, 'power', 50000, 700000, 5000);
  dr.add(config.drivetrain, 'maxDriveForce', 2000, 30000, 250);
  dr.add(config.drivetrain, 'reverseForce', 1000, 12000, 250);
  dr.add(config.drivetrain, 'maxReverseSpeed', 3, 40, 1);
  dr.add(config.drivetrain, 'idleRPM', 600, 3000, 50);
  dr.add(config.drivetrain, 'redlineRPM', 4000, 11000, 100);
  dr.add(config.drivetrain, 'shiftUpRPM', 3000, 11000, 100);
  dr.add(config.drivetrain, 'shiftDownRPM', 1500, 7000, 100);
  dr.add(config.drivetrain, 'shiftTime', 0, 0.6, 0.01);
  dr.add(config.drivetrain, 'finalDrive', 2, 6, 0.05);

  const a = gui.addFolder('Aero');
  a.add(config.aero, 'dragCoeff', 0, 3, 0.05);
  a.add(config.aero, 'downforceCoeff', 0, 8, 0.1);
  a.add(config.aero, 'downforceFrontBias', 0, 1, 0.01);

  gui.add(config.assists, 'counterSteer', 0, 1, 0.05).name('counter-steer assist');

  const presets = {
    save: () => {
      localStorage.setItem(PRESET_KEY, JSON.stringify(snapshotTuning()));
      console.info('[tuning] preset saved');
    },
    load: () => {
      const raw = localStorage.getItem(PRESET_KEY);
      if (!raw) return console.warn('[tuning] no saved preset');
      try {
        applyTuning(JSON.parse(raw));
        car.reapplyTuning();
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
      } catch (err) {
        console.warn('[tuning] preset corrupt', err);
      }
    },
    clear: () => {
      localStorage.removeItem(PRESET_KEY);
      console.info('[tuning] preset cleared');
    },
  };
  const p = gui.addFolder('Presets');
  p.add(presets, 'save').name('Save to localStorage');
  p.add(presets, 'load').name('Load from localStorage');
  p.add(presets, 'clear').name('Clear saved');

  return gui;
}

function formatDebug(car, physics, rig, frameMs) {
  const t = car.telemetry;
  const deg = (r) => ((r * 180) / Math.PI).toFixed(1).padStart(6);
  const yaw = ((Math.atan2(
    2 * (t.quaternion.w * t.quaternion.y + t.quaternion.x * t.quaternion.z),
    1 - 2 * (t.quaternion.y * t.quaternion.y + t.quaternion.x * t.quaternion.x),
  ) * 180) / Math.PI).toFixed(1);

  const loads = t.wheelLoad.map((l) => (l / 1000).toFixed(1).padStart(5)).join(' ');
  const temps = car.curSusp;
  const susp = [0, 1, 2, 3].map((i) => (temps[i] * 1000).toFixed(0).padStart(4)).join(' ');

  return [
    `fps        ${(1000 / Math.max(frameMs, 0.001)).toFixed(0).padStart(4)}   frame ${frameMs.toFixed(1).padStart(5)} ms`,
    `physics    ${physics.stepMs.toFixed(1).padStart(5)} ms   ${physics.stepCount} steps (${physics.totalSteps} total)`,
    `bodies     ${String(physics.bodyCount).padStart(5)}   colliders ${physics.colliderCount}`,
    `camera     ${rig.mode}   fov ${rig.camera.fov.toFixed(1)}`,
    '',
    `speed      ${t.speedKmh.toFixed(1).padStart(6)} km/h`,
    `  forward  ${t.forwardSpeed.toFixed(2).padStart(6)} m/s   lateral ${t.lateralSpeed.toFixed(2)}`,
    `  slip     ${deg(t.slipAngle)} deg    yawRate ${deg(t.yawRate)} deg/s`,
    `yaw        ${yaw.padStart(6)} deg`,
    '',
    `rpm        ${t.rpm.toFixed(0).padStart(6)}   gear ${t.gearLabel}`,
    `steer      ${deg(t.steerAngle)} deg`,
    `drive F    ${t.driveForce.toFixed(0).padStart(6)} N`,
    `brake      front ${t.frontBrake.toFixed(1)}  rear ${t.rearBrake.toFixed(1)}`,
    '',
    `wheel load kN (FL FR RL RR)  ${loads}`,
    `susp mm       (FL FR RL RR)  ${susp}`,
    `contact       (FL FR RL RR)  ${t.inContact.map((c) => (c ? '  yes' : '   no')).join(' ')}`,
    '',
    `wheels     ${car.wheelNames.join(' ')}`,
  ].join('\n');
}

main().catch((err) => {
  console.error(err);
  try {
    const hud = new HUD();
    hud.showError('Unexpected startup failure.', err?.stack ?? String(err));
  } catch {
    document.body.innerHTML = `<pre style="color:#ffb3c1;padding:24px;font:12px monospace">${String(err)}</pre>`;
  }
});
