# Marina Bay Street Circuit — driving prototype

A browser-based driving prototype: a Ferrari 296 GT3 around the Marina Bay Street
Circuit (Singapore GP). Built with **Three.js** for rendering and **Rapier** for
physics, bundled by **Vite**. Personal, **non-commercial** project.

> **Status: Stage 1 of 5 complete.** A placeholder car with a full raycast-vehicle
> drivetrain drives around a test facility. The real car and track models arrive in
> Stages 2 and 3.

---

## ⚠️ Licensing — read before you do anything

This repository's code is a personal prototype, but the **assets it is designed to
load are not free to redistribute**.

| Asset | Author | Source | Licence |
| --- | --- | --- | --- |
| "Marina Bay Street Circuit" | Dave Love (`@Tyler_Dave`) | [Sketchfab](https://sketchfab.com/) | **CC BY 4.0** |
| "Ferrari 296 GT3" | vecarz (`@heynic`) | [Sketchfab](https://sketchfab.com/) | **CC BY-NC 4.0** |

**Non-commercial only.** The car model's CC BY-NC 4.0 licence forbids commercial
use of any kind. Separately, the track model appears to be extracted from
Assetto Corsa, so it is almost certainly not the uploader's to license — treat it
as fan-made content of unresolved provenance.

Accordingly:

- **Do not redistribute** the raw or processed models.
- **Do not monetise** this project or anything derived from it.
- **Do not commit** `assets/raw/` or `public/assets/` to a public repository — both
  are already in `.gitignore`.

Attribution for the car must also credit **MattDoesBlender**, who is credited by
the model's author. Credits are shown on the start screen from Stage 5.

---

## Requirements

- **Node 18+** (Node 20.12+ recommended — the asset scripts use `process.loadEnvFile`)
- A GPU capable of WebGL 2

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually <http://localhost:5173>).

The car model is **not** committed — it is derived from a CC BY-NC licensed asset, so
it lives in gitignored directories. To build it from scratch, put a Sketchfab API
token in `.env` (see `.env.example`) and run:

```bash
npm run fetch-assets     # -> assets/raw/{car,track}_raw.glb   (gitignored)
npm run prepare-car      # -> public/assets/car.glb            (gitignored)
```

Without it the game still runs — `car.js` falls back to placeholder boxes — and says
why on the console.

Other commands:

```bash
npm run build            # production bundle into dist/
npm run preview          # serve the production bundle locally
npm run test:physics     # headless Node physics harness (no browser needed)
npm run test:smoke       # headless Chrome end-to-end smoke test
```

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake, then reverse once stopped |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake (flick it to start a slide, then get back on the power) |
| `C` | Cycle camera: chase → hood → cockpit |
| `R` | Reset to the start line |
| `Esc` | Pause |
| `F1` | Toggle the live tuning panel **and** the debug overlay |
| `M` | Mute audio (wired up in Stage 5) |

A gamepad is picked up automatically if one is connected — left stick steers,
triggers drive, and the face buttons map to handbrake / camera / reset.

---

## Tuning

Every handling number lives in **`src/config.js`** and nothing else reads magic
values. Edit the file and Vite hot-reloads, or press **`F1`** in-game to drag the
sliders live. Anything you change in the panel takes effect immediately.

The knobs that matter most, in rough order of how much they change the feel:

| Setting | Effect |
| --- | --- |
| `tires.frictionSlipRear` | **The single biggest handling knob.** Lower = the rear breaks away sooner. This is the drift control. |
| `tires.frictionSlipFront` | Front bite. Raising it relative to the rear adds turn-in; too high causes understeer. |
| `brakes.handbrakeForce` | Above ~100 the rears lock outright, which is what you want for a flick. |
| `aero.downforceCoeff` | Grip that scales with speed² — the car gets planted as it goes faster. |
| `suspension.stiffness` | Body roll and squat. High values feel like a go-kart, low values wallow. |
| `assists.counterSteer` | Blends opposite lock in when the rear steps out. Set to `0` for a purist car. |
| `drivetrain.power` | Watts at the wheels. Sets both launch aggression and top speed. |

`chassisRestHeight` is a derived getter (`wheelRadius + restLength - hardPointY`),
not a hand-typed number, so changing suspension geometry keeps the spawn height
correct automatically.

---

## Architecture

```
src/
  main.js        bootstrap, render loop, F1 tuning panel, __MARINA_BAY__ debug hook
  config.js      every tuning value, in one object
  physics.js     Rapier world wrapper, fixed-timestep accumulator, quaternion helpers
  car.js         chassis, raycast vehicle, drivetrain model, visual sync
  track.js       Stage 1 test facility (and the real circuit from Stage 3)
  camera.js      chase / hood / cockpit rigs
  input.js       keyboard + gamepad, analog smoothing
  hud.js         speed, gear, RPM, overlays
scripts/
  fetch_assets.mjs   Sketchfab Download API -> assets/raw/ (gitignored)
  prepare_car.mjs    rebakes the raw Ferrari into public/assets/car.glb
  physics_tune.mjs   headless physics harness — measures the car numerically
  smoke_test.mjs     headless Chrome end-to-end test
```

### Why Rapier

Rapier's `DynamicRayCastVehicleController` is a maintained port of Bullet's
raycast vehicle, which is the same model most browser driving demos use. It gives
suspension, per-wheel engine force and brakes, and slip-based friction without
writing a tire solver. The `cannon-es` `RaycastVehicle` is the documented fallback
and is closely related, but Rapier was the better choice here because it also
provides CCD (see below) and is significantly faster.

The vehicle controller is wrapped behind a small abstraction in `car.js` so the
friction model can be replaced later without touching the rest of the game.

### Anti-tunnelling

At 250 km/h the car covers 1.16 m per 1/60 s step, which is enough to pass clean
through a thin wall. Two things prevent that: the chassis collider has
`setCcdEnabled(true)`, and all barriers are thick boxes rather than planes.

### Rapier quirks worth knowing

These cost real debugging time and are easy to reintroduce:

1. **Forces persist.** `addForce` / `addForceAtPoint` accumulate and keep applying
   across steps until cleared. `car.beginStep()` calls `resetForces(false)` and
   `resetTorques(false)` every step — without it, aero downforce stacks into tens
   of kilonewtons and glues the car to the road.
2. **Brakes are ignored while engine force is applied.** The vehicle controller
   skips `wheelBrake` entirely whenever `wheelEngineForce` is non-zero. Writing
   engine braking as a negative engine force therefore silently disables *all*
   rear braking, handbrake included. Engine braking is applied through the brake
   channel instead.
3. **Axis setters differ.** `vehicle.indexUpAxis = 1` is a plain property, but the
   forward axis needs the setter: `vehicle.setIndexForwardAxis = 2`.
4. **Step order matters.** The required order is `beginStep()` → `applyControls()` →
   `updateVehicle(dt)` → `world.step()` → `endStep()`, and `updateVehicle` needs a
   filter predicate that excludes the chassis collider so it doesn't raycast
   against itself.

### Orientation convention

The car faces **+Z**, which makes **+X the car's left**. Wheel order is
`FL(+x,+z)`, `FR(-x,+z)`, `RL(+x,-z)`, `RR(-x,-z)`. Both sign conventions were
verified numerically against Rapier rather than assumed.

### Car model preparation

`scripts/prepare_car.mjs` rewrites the raw Sketchfab Ferrari into
`public/assets/car.glb`. The raw file is 411,750 triangles in 83 meshes whose node
names carry no meaning, so every step is derived from geometry rather than hardcoded:

| Step | What it does |
| --- | --- |
| Wheel detection | the four meshes with identical vertex counts (2627) are grouped onto a 4-corner layout |
| Wheel adoption | rims, discs and calipers within 0.5 m of a hub join that wheel, otherwise the tyre spins while the rim inside it stands still |
| Orientation | heading is measured from the axle-to-axle vector; the raw file sits 37.2° off +Z |
| Scale | already 1:1 metres, so no scaling is applied |
| Mirroring | all 83 nodes carry negative-determinant transforms — the mirror is baked into the vertices and the triangle winding reversed to compensate |
| Simplification | 411,750 → 74,829 triangles, 36.9 MB → 11.2 MB |
| Lamps | emissive on the materials used only at the car's ends, plus the strongly-coloured amber lens |

Measured geometry of the output, which `config.car` is set from:

```
wheelbase 2.660 m    track 1.696 / 1.690 m    length 4.736 m    height 1.452 m
wheel radius 0.338 front / 0.351 rear   (real 296 GT3: 30/68-18 front, 31/71-18 rear)
```

The file is already in car space — facing +Z, +X to its left, origin at the axle
midpoint with the wheels on y=0, and each wheel a named node centred on its own hub.
So `car.js` only has to reparent the four named wheel nodes onto the physics-driven
steer groups.

Four things here were not obvious and are worth not rediscovering:

1. **A wheel pivot is not a vertex centroid.** A tyre's vertex centroid sits at its
   centre only if the tread is sampled evenly; the bounding-box centre is the hub.
   The centroid put every wheel slightly off its corner.
2. **A material's bounding box says nothing about where it is.** Materials here are
   shared across the whole car — `mat_57` spans z −1.65 .. 1.66 — so classifying lamps
   and paint per material false-positived on both. It has to be per mesh.
3. **Normal transforms need the inverse-transpose, in the right layout.** Returning a
   9-element array where a 16-element column-major matrix was expected left every
   index past 8 `undefined`, and `NaN || 1` is `1` — so every normal silently became
   `NaN` and the car rendered as a flat black silhouette.
4. **The body offset must use the settled suspension length, not `restLength`.** The
   car squats about 6 cm on its springs, and the model is authored at that settled
   attitude. Aligning against the unloaded `restLength` drops the body 6 cm and sinks
   the splitter through the road.

One known cosmetic detail: the vehicle controller takes a single wheel radius, so the
larger rear tyres (0.351 m against 0.340 m) sit 1 cm below the road surface.

---

## Testing

The car is measured numerically, because "it feels good" is not something a test
can assert and "it does 0–100 in 4 s" is.

```bash
npm run test:physics              # all scenarios as tables
node scripts/physics_tune.mjs accel   # 0-100, gearing, top speed, weight transfer
node scripts/physics_tune.mjs brake   # stopping distance, dive, lockup
node scripts/physics_tune.mjs turn    # sustained lateral g, balance
node scripts/physics_tune.mjs drift   # handbrake and power oversteer
node scripts/physics_tune.mjs reset   # reset behaviour, including while rotated
node scripts/physics_tune.mjs sweep   # parameter sweeps for the grip knobs
```

The harness runs in plain Node — `car.js` and `physics.js` have no DOM
dependencies — so it iterates in milliseconds without a browser.

`npm run test:smoke` drives the real page in headless Chrome and asserts that the
car boots, accelerates, shifts, brakes, steers, drifts on the handbrake, resets,
and cycles cameras, with no console errors. It also checks the prepared car model:
that `car.glb` loaded rather than the placeholder, that its wheels are reparented
onto the physics-driven steer groups, and that its geometry lines up with the
physics (wheelbase, track, tyre contact, body clearance).

Two caveats on the browser test. Headless Chrome paces `requestAnimationFrame`
against its own compositor, so its reported frame *rate* (~13 fps here) is a pacing
artifact rather than a performance measurement — the test therefore times the work
directly with a GPU sync and asserts against a 16.7 ms budget instead. And because
a slow renderer would otherwise advance the world in slow motion, the test measures
the frame rate first and widens the physics catch-up so the simulation still tracks
real time. Set `CHROME_PATH` if Chrome is not at the default macOS location.

### Debug overlay

`F1` shows collider wireframes, the centerline, checkpoints, frame time, FPS, and
live physics telemetry. `window.__MARINA_BAY__` exposes `{ car, physics, rig, hud,
input, scene, renderer, config }` for poking at from the console.

---

## Credits

- **Track** — "Marina Bay Street Circuit" by Dave Love (`@Tyler_Dave`), CC BY 4.0
- **Car** — "Ferrari 296 GT3" by vecarz (`@heynic`), CC BY-NC 4.0, with credit to
  MattDoesBlender

Both are unofficial fan works and are not affiliated with Ferrari, the Singapore
GP, or Formula 1.
