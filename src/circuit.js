/**
 * Shanghai International Circuit.
 *
 * Two things are loaded. The visual model comes from `public/assets/track.glb`,
 * built by `scripts/prepare_track.mjs`. The collision surface does *not* come
 * from the model: it is swept along `public/assets/centerline.json`, the same
 * line the lap is measured against.
 *
 * That matters more than it sounds. The source asphalt is made of long, thin
 * triangles at wildly varying heights, and a raycast vehicle driving over it
 * rattles. A ribbon of quads swept along the centreline is smooth, costs a few
 * thousand triangles instead of a million, and can never disagree with the line
 * the lap time is taken against.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const CENTRELINE_URL = '/assets/centerline.json';
const MODEL_URL = '/assets/track.glb';

/** How tall the collision walls are, metres, relative to the road surface. */
const WALL_BOTTOM = -1.5;
const WALL_TOP = 1.3;
/** Spacing of the wall boxes along the lap. They overlap, so no gaps. */
const WALL_STEP = 14;

/**
 * The racing line, with arc-length lookups.
 *
 * `points` is `[x, y, z, halfWidth]` in the frame `prepare_track.mjs` writes:
 * the start/finish line sits at the origin and the surface under it is y = 0.
 */
export class CircuitPath {
  constructor(data) {
    this.name = data.name;
    this.layout = data.layout;
    this.direction = data.direction;
    this.points = data.points;
    this.wall = data.wall;
    this.n = this.points.length;

    this.cum = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) {
      const a = this.points[i];
      const b = this.points[(i + 1) % this.n];
      this.cum[i + 1] = this.cum[i] + Math.hypot(b[0] - a[0], b[2] - a[2]);
    }
    this.length = this.cum[this.n];
    this.spacing = this.length / this.n;
  }

  /**
   * Point `s` metres along the lap (wrapping), pushed `lateral` metres to the
   * left of the racing direction. Positive lateral is left.
   */
  at(s, lateral = 0) {
    const t = ((s % this.length) + this.length) % this.length;
    let lo = 0;
    let hi = this.n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= t) lo = mid;
      else hi = mid;
    }
    const a = this.points[lo];
    const b = this.points[(lo + 1) % this.n];
    const seg = this.cum[lo + 1] - this.cum[lo] || 1;
    const u = (t - this.cum[lo]) / seg;

    const heading = Math.atan2(b[2] - a[2], b[0] - a[0]);
    const nx = -Math.sin(heading);
    const nz = Math.cos(heading);
    const wall = this.wall[lo] + (this.wall[(lo + 1) % this.n] - this.wall[lo]) * u;

    return {
      x: a[0] + (b[0] - a[0]) * u + nx * lateral,
      y: a[1] + (b[1] - a[1]) * u,
      z: a[2] + (b[2] - a[2]) * u + nz * lateral,
      half: a[3] + (b[3] - a[3]) * u,
      wall,
      heading,
      /** Chassis yaw for this heading. The car faces +Z when yaw is 0. */
      yaw: Math.PI / 2 - heading,
    };
  }

  /** Nearest centreline sample to a world position, and how far off it is. */
  nearest(x, z) {
    let best = Infinity;
    let index = 0;
    for (let i = 0; i < this.n; i++) {
      const p = this.points[i];
      const d = (p[0] - x) ** 2 + (p[2] - z) ** 2;
      if (d < best) {
        best = d;
        index = i;
      }
    }
    return { index, distance: Math.sqrt(best), s: this.cum[index] };
  }

  /**
   * A starting grid: `count` slots in two staggered columns behind the line.
   * The pole slot is closest to the line, on the racing line's right.
   */
  grid(count = 8, rowGap = 9, lateral = 2.4) {
    const slots = [];
    for (let k = 0; k < count; k++) {
      const row = Math.floor(k / 2);
      const side = k % 2 === 0 ? -1 : 1;
      const s = -(row + 1) * rowGap - (k % 2 === 0 ? 0 : rowGap * 0.4);
      const p = this.at(s, side * lateral);
      slots.push({ position: { x: p.x, y: p.y, z: p.z }, yaw: p.yaw, index: k });
    }
    return slots;
  }
}

/**
 * Load the circuit and register its collision with the physics world.
 *
 * Throws if either asset is missing, which lets the caller fall back to the
 * flat test facility rather than starting up with nothing to drive on.
 */
export async function loadCircuit(physics, config, onProgress = () => {}) {
  onProgress(0.42, 'Reading the racing line…');

  const response = await fetch(CENTRELINE_URL);
  if (!response.ok) throw new Error(`${CENTRELINE_URL} — HTTP ${response.status}`);
  const path = new CircuitPath(await response.json());

  onProgress(0.5, 'Building track collision…');
  const collisions = registerCollision(physics, path, config);

  onProgress(0.58, 'Loading Shanghai International Circuit…');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL, (event) => {
    if (!event.total) return;
    onProgress(0.58 + 0.34 * (event.loaded / event.total), 'Loading Shanghai International Circuit…');
  });

  const group = new THREE.Group();
  group.name = 'circuit';
  const model = gltf.scene;
  model.traverse((node) => {
    if (!node.isMesh) return;
    // Half a million triangles do not need to cast shadows on each other, and
    // the track never leaves the frustum in a way that culling helps much.
    node.castShadow = false;
    node.receiveShadow = true;
    if (node.material) node.material.envMapIntensity = 0.35;
  });
  group.add(model);

  const debug = buildDebugOverlay(path);
  debug.visible = Boolean(config?.debug?.showCenterline);
  group.add(debug);

  const start = path.at(0);
  const stats = countTriangles(model);
  console.log(
    `${path.name} (${path.layout}): ${path.length.toFixed(0)} m ${path.direction}, ` +
      `${path.n} centreline points, ${stats.toLocaleString('en-US')} visible triangles, ` +
      `${collisions.roadTriangles.toLocaleString('en-US')} collision triangles, ` +
      `${collisions.walls} wall boxes`,
  );

  return {
    group,
    path,
    model,
    debug,
    start: {
      position: {
        x: start.x,
        y: start.y + (config?.chassisRestHeight ?? 0.6) + 0.02,
        z: start.z,
      },
      yaw: start.yaw,
    },
    grid: path.grid(8),
    collisions,
  };
}

/* ====================================================================== */
/* Collision                                                              */
/* ====================================================================== */

/**
 * Sweep a strip of road between two signed lateral offsets. Positive is left
 * of the racing direction. One quad per centreline sample, so the strip
 * follows the surface height exactly.
 */
function sweepBand(points, aAt, bAt) {
  const n = points.length;
  const vertices = new Float32Array(n * 2 * 3);
  const indices = new Uint32Array(n * 6);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let tx = next[0] - prev[0];
    let tz = next[2] - prev[2];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;

    const a = aAt(i);
    const b = bAt(i);
    vertices[i * 6 + 0] = p[0] + nx * a;
    vertices[i * 6 + 1] = p[1];
    vertices[i * 6 + 2] = p[2] + nz * a;
    vertices[i * 6 + 3] = p[0] + nx * b;
    vertices[i * 6 + 4] = p[1];
    vertices[i * 6 + 5] = p[2] + nz * b;

    const j = (i + 1) % n;
    indices[i * 6 + 0] = i * 2;
    indices[i * 6 + 1] = j * 2;
    indices[i * 6 + 2] = i * 2 + 1;
    indices[i * 6 + 3] = i * 2 + 1;
    indices[i * 6 + 4] = j * 2;
    indices[i * 6 + 5] = j * 2 + 1;
  }

  return { vertices, indices };
}

function registerCollision(physics, path, config) {
  const { points, wall } = path;
  const half = (i) => points[i][3];
  const tarmac = config?.physics?.groundFriction ?? 1.4;

  // Tarmac, then the run-off either side. The run-off reaches all the way out
  // to the barrier so the car can never reach an edge and fall off the world.
  const road = sweepBand(points, (i) => -half(i), half);
  const left = sweepBand(points, (i) => -wall[i], (i) => -half(i));
  const right = sweepBand(points, (i) => half(i), (i) => wall[i]);

  const roadBody = physics.addStaticTrimesh(road.vertices, road.indices, { friction: tarmac });
  physics.addStaticTrimesh(left.vertices, left.indices, { friction: tarmac * 0.55 });
  physics.addStaticTrimesh(right.vertices, right.indices, { friction: tarmac * 0.55 });

  // Walls are boxes rather than a thin trimesh: a 69 m/s car steps half a metre
  // per fixed step, and a zero-thickness wall is exactly the sort of thing that
  // gets missed even with CCD switched on.
  let walls = 0;
  const height = WALL_TOP - WALL_BOTTOM;
  for (let s = 0; s < path.length; s += WALL_STEP) {
    const p = path.at(s);
    for (const side of [-1, 1]) {
      physics.addStaticBox(
        { x: WALL_STEP / 2 + 1, y: height / 2, z: 0.5 },
        {
          x: p.x - Math.sin(p.heading) * side * p.wall,
          y: p.y + WALL_BOTTOM + height / 2,
          z: p.z + Math.cos(p.heading) * side * p.wall,
        },
        { rotationY: -p.heading, friction: 0.35, restitution: 0.15 },
      );
      walls += 1;
    }
  }

  return {
    body: roadBody.body,
    collider: roadBody.collider,
    roadTriangles: road.indices.length / 3,
    runoffTriangles: (left.indices.length + right.indices.length) / 3,
    walls,
  };
}

/* ====================================================================== */
/* Debug + helpers                                                        */
/* ====================================================================== */

/** Centreline ribbon plus wall markers, hidden unless F1 asks for them. */
function buildDebugOverlay(path) {
  const group = new THREE.Group();
  group.name = 'circuit-debug';

  const line = [];
  const wallLine = [[], []];
  for (let i = 0; i < path.n; i++) {
    const p = path.points[i];
    line.push(new THREE.Vector3(p[0], p[1] + 0.08, p[2]));
    const next = path.points[(i + 1) % path.n];
    const heading = Math.atan2(next[2] - p[2], next[0] - p[0]);
    const nx = -Math.sin(heading);
    const nz = Math.cos(heading);
    wallLine[0].push(new THREE.Vector3(p[0] + nx * path.wall[i], p[1] + 0.3, p[2] + nz * path.wall[i]));
    wallLine[1].push(new THREE.Vector3(p[0] - nx * path.wall[i], p[1] + 0.3, p[2] - nz * path.wall[i]));
  }

  const add = (pts, color) => {
    const loop = pts.concat([pts[0]]);
    const geo = new THREE.BufferGeometry().setFromPoints(loop);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
    const mesh = new THREE.Line(geo, mat);
    mesh.renderOrder = 900;
    group.add(mesh);
  };

  add(line, 0x38ff88);
  add(wallLine[0], 0xff4d4d);
  add(wallLine[1], 0xff4d4d);
  group.visible = false;
  return group;
}

function countTriangles(root) {
  let tris = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const geo = node.geometry;
    tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  });
  return Math.round(tris);
}
