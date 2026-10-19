#!/usr/bin/env node
/**
 * Turns `assets/raw/car_raw.glb` into the game-ready `public/assets/car.glb`.
 *
 * The raw Sketchfab export needs real work before the game can use it:
 *
 *   1. It sits at an arbitrary place and heading — the car faces ~37 degrees off
 *      +Z and the ground is nowhere near y=0.
 *   2. Every one of its 83 mesh nodes carries a *mirrored* transform (negative
 *      determinant), which inverts triangle winding. Relying on the renderer to
 *      compensate is fragile, so the mirror is baked out here.
 *   3. All four wheels are anonymous meshes buried in a flat list of 255 nodes.
 *      They have to become named `wheel_FL/FR/RL/RR` nodes with pivots at the
 *      wheel centre, or they can neither spin nor steer.
 *   4. It is 411,750 triangles; the budget is 60,000.
 *
 * Nothing about the orientation is hard-coded: the wheels are located by
 * geometry, and the car's forward axis, centre and ground plane are all derived
 * from them. If the source model changes, this still works.
 *
 *   node scripts/prepare_car.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import {
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
  KHRMaterialsSpecular,
} from '@gltf-transform/extensions';
import { dedup, prune, reorder, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'assets', 'raw', 'car_raw.glb');

/**
 * `--no-optimize` writes the baked but unoptimised model to a separate file.
 * Used to bisect problems between the geometry rebake and the optimiser.
 */
const NO_OPTIMIZE = process.argv.includes('--no-optimize');
const OUT = path.join(ROOT, 'public', 'assets', NO_OPTIMIZE ? 'car-unoptimized.glb' : 'car.glb');

/** Triangle budget from the project spec. */
const TRI_BUDGET = 60_000;
/** Simplification is allowed to deviate from the silhouette by this fraction. */
const SIMPLIFY_ERROR = 0.008;

/* ------------------------------------------------------------------ */
/* Small matrix helpers (column-major, like glTF)                      */
/* ------------------------------------------------------------------ */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/** Rotation about +Y by `a` radians. */
function rotY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // x' = x cos + z sin ; z' = -x sin + z cos
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function translationMatrix(t) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

function det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function xformDir(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2],
  ];
}

/**
 * Inverse-transpose of the upper-left 3x3, returned as a full 16-element
 * column-major matrix so it can be fed straight to `xformDir`.
 *
 * The inverse-transpose is the correct transform for surface normals — using
 * the matrix itself skews them under non-uniform scale. The layout matters:
 * `xformDir` reads columns at 0/1/2, 4/5/6 and 8/9/10, so returning a bare
 * 9-element array leaves half the lookups undefined and every normal NaN.
 */
function normalMatrix(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];

  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [...IDENTITY];

  const s = 1 / det;
  return [
    A * s, B * s, C * s, 0,
    (c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s, 0,
    (b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s, 0,
    0, 0, 0, 1,
  ];
}

/* ------------------------------------------------------------------ */
/* Load and inspect                                                    */
/* ------------------------------------------------------------------ */

if (!fs.existsSync(SRC)) {
  console.error(`\n  Missing ${path.relative(ROOT, SRC)}. Run: npm run fetch-assets\n`);
  process.exit(1);
}

console.log(`\nReading ${path.relative(ROOT, SRC)} …`);
const io = new NodeIO().registerExtensions([
  KHRMaterialsSpecular,
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
]);
const doc = await io.read(SRC);
const root = doc.getRoot();

/** Flatten the node tree into `{ node, mesh, world }` records. */
const placed = [];
{
  const walk = (node, parent) => {
    const world = mul(parent, Array.from(node.getMatrix()));
    const mesh = node.getMesh();
    if (mesh) placed.push({ node, mesh, world });
    for (const c of node.listChildren()) walk(c, world);
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, IDENTITY);
}

// Meshes shared between nodes would be baked twice; split them first.
{
  const useCount = new Map();
  for (const p of placed) useCount.set(p.mesh, (useCount.get(p.mesh) ?? 0) + 1);
  const shared = [...useCount.values()].filter((n) => n > 1).length;
  if (shared) {
    console.log(`  splitting ${shared} mesh(es) referenced by more than one node`);
    for (const p of placed) {
      if (useCount.get(p.mesh) > 1) p.mesh = p.mesh.clone();
    }
  }
}

const countTris = (mesh) => {
  let t = 0;
  for (const prim of mesh.listPrimitives()) {
    t += (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0) / 3;
  }
  return t;
};

const trisBefore = placed.reduce((s, p) => s + countTris(p.mesh), 0);
console.log(`  ${placed.length} mesh nodes, ${Math.round(trisBefore).toLocaleString('en-US')} triangles`);

/* ------------------------------------------------------------------ */
/* 1. Locate the four wheels by geometry                               */
/* ------------------------------------------------------------------ */

/** Mesh centroid in world space, computed from real vertices. */
function centroidOf(record) {
  const { mesh, world } = record;
  const sum = [0, 0, 0];
  let n = 0;
  for (const prim of mesh.listPrimitives()) {
    const acc = prim.getAttribute('POSITION');
    if (!acc) continue;
    const v = [0, 0, 0];
    for (let i = 0; i < acc.getCount(); i++) {
      acc.getElement(i, v);
      const w = xformPoint(world, v);
      sum[0] += w[0];
      sum[1] += w[1];
      sum[2] += w[2];
      n++;
    }
  }
  return sum.map((s) => s / Math.max(n, 1));
}

for (const p of placed) {
  p.centroid = centroidOf(p);
  p.verts = p.mesh
    .listPrimitives()
    .reduce((s, pr) => s + (pr.getAttribute('POSITION')?.getCount() ?? 0), 0);
}

// Wheels are four meshes with identical vertex counts, sitting on a rectangle.
const byVerts = new Map();
for (const p of placed) {
  const k = p.verts;
  if (!byVerts.has(k)) byVerts.set(k, []);
  byVerts.get(k).push(p);
}

/**
 * Pick the best four-instance group to be the wheels: exactly four members,
 * roughly equal bounding spheres, and a four-corner layout (two distinct
 * positions on each of two perpendicular axes).
 */
function findWheelSet() {
  const scored = [];
  for (const [verts, list] of byVerts) {
    if (list.length !== 4) continue;

    // Radius from the centroid spread, as a cheap size proxy.
    let cx = 0, cy = 0, cz = 0;
    for (const p of list) { cx += p.centroid[0]; cy += p.centroid[1]; cz += p.centroid[2]; }
    cx /= 4; cy /= 4; cz /= 4;
    const offsets = list.map((p) => [p.centroid[0] - cx, p.centroid[1] - cy, p.centroid[2] - cz]);
    const spread = offsets.map((o) => Math.hypot(o[0], o[2]));
    const minSpread = Math.min(...spread);
    const maxSpread = Math.max(...spread);

    // All four should be at a similar distance from their common centre…
    if (minSpread < 0.5 || maxSpread / minSpread > 1.25) continue;

    // …and at a similar height (wheels are coplanar).
    const ys = list.map((p) => p.centroid[1]);
    if (Math.max(...ys) - Math.min(...ys) > 0.25) continue;

    // …and small compared to the whole model.
    const size = Math.max(...list.map((p) => Math.max(...p.centroid.map((v, i) => v))));
    scored.push({ verts, list, spread: maxSpread, size });
  }

  // Prefer the group with the largest radius that still looks like a wheel: a
  // wheel's centroid sits on a circle, so its offset from the car's centre is
  // about half the wheelbase or half the track.
  scored.sort((a, b) => b.spread - a.spread);
  return scored[0] ?? null;
}

const wheelSet = findWheelSet();
if (!wheelSet) {
  console.error(
    '\n  Could not identify four wheels geometrically.\n' +
      '  Groups of four identical meshes found:\n' +
      [...byVerts.entries()]
        .filter(([, l]) => l.length === 4)
        .map(([v]) => `    verts=${v}`)
        .join('\n') +
      '\n',
  );
  process.exit(1);
}

console.log(`\n  wheels: 4 meshes with ${wheelSet.verts} vertices each`);

/* ------------------------------------------------------------------ */
/* 2. Derive the car's frame from the wheels                           */
/* ------------------------------------------------------------------ */

const centre = [0, 0, 0];
for (const p of wheelSet.list) for (let i = 0; i < 3; i++) centre[i] += p.centroid[i] / 4;

// Split the wheels into two axles along whichever horizontal axis separates
// them more.
const rel = wheelSet.list.map((p) => [p.centroid[0] - centre[0], p.centroid[2] - centre[2]]);
let best = null;
for (const [i, j] of [[0, 1], [1, 0]]) {
  const spreadA = Math.max(...rel.map((r) => r[i])) - Math.min(...rel.map((r) => r[i]));
  const spreadB = Math.max(...rel.map((r) => r[j])) - Math.min(...rel.map((r) => r[j]));
  // Pair wheels by the axis that separates them more (that is the wheelbase).
  const half = spreadA / 2;
  const groups = [[], []];
  for (const p of wheelSet.list) {
    groups[(p.centroid[0] - centre[0]) * (i === 0 ? 1 : 0) + (p.centroid[2] - centre[2]) * (i === 0 ? 0 : 1) > 0 ? 1 : 0].push(p);
  }
  if (groups[0].length === 2 && groups[1].length === 2) {
    const mid = groups.map((g) => [
      (g[0].centroid[0] + g[1].centroid[0]) / 2,
      (g[0].centroid[1] + g[1].centroid[1]) / 2,
      (g[0].centroid[2] + g[1].centroid[2]) / 2,
    ]);
    const axis = [mid[1][0] - mid[0][0], mid[1][2] - mid[0][2]];
    const len = Math.hypot(axis[0], axis[1]);
    const track = Math.hypot(
      groups[0][0].centroid[0] - groups[0][1].centroid[0],
      groups[0][0].centroid[2] - groups[0][1].centroid[2],
    );
    if (!best || len > best.wheelbase) {
      best = {
        axleA: mid[0],
        axleB: mid[1],
        wheelbase: len,
        track,
        forward: [axis[0] / len, axis[1] / len],
        groups,
      };
    }
    void spreadB;
    void half;
  }
}

if (!best) {
  console.error('\n  Could not determine the axle axis from the wheel positions.\n');
  process.exit(1);
}

// The nose is whichever axle sits inside the larger mass of body geometry. A
// GT3 car's rear overhang is short, so the nose end has more stuff around it.
{
  const body = placed.filter((p) => !wheelSet.list.includes(p));
  const scoreOf = (axle) => {
    let s = 0;
    for (const p of body) {
      const d = Math.hypot(p.centroid[0] - axle[0], p.centroid[2] - axle[2]);
      if (d < best.wheelbase * 0.6) s += p.verts / (1 + d);
    }
    return s;
  };
  const sA = scoreOf(best.axleA);
  const sB = scoreOf(best.axleB);
  // `forward` runs axleA -> axleB; flip it if axleA is the busier end.
  if (sA > sB) {
    best.forward = [-best.forward[0], -best.forward[1]];
    [best.axleA, best.axleB] = [best.axleB, best.axleA];
  }
}

const phi = Math.atan2(best.forward[0], best.forward[1]); // angle from +Z
console.log(`  wheelbase ${best.wheelbase.toFixed(3)} m   track ${best.track.toFixed(3)} m`);
console.log(`  heading is ${((phi * 180) / Math.PI).toFixed(1)}° off +Z — correcting`);

// Ground plane: the bottom of the wheels.
let wheelBottom = Infinity;
for (const p of wheelSet.list) {
  for (const prim of p.mesh.listPrimitives()) {
    const acc = prim.getAttribute('POSITION');
    if (!acc) continue;
    const v = [0, 0, 0];
    for (let i = 0; i < acc.getCount(); i++) {
      acc.getElement(i, v);
      const y = xformPoint(p.world, v)[1];
      if (y < wheelBottom) wheelBottom = y;
    }
  }
}

const axleMid = [
  (best.axleA[0] + best.axleB[0]) / 2,
  (best.axleA[1] + best.axleB[1]) / 2,
  (best.axleA[2] + best.axleB[2]) / 2,
];

/*
 * Correction: rotate so forward is +Z, then move the axle midpoint to the
 * origin with the wheels resting on y=0.
 *   final = T(-newCentre) · R · world
 */
const R = rotY(-phi);
const rotatedCentre = xformPoint(R, axleMid);
const CORRECTION = mul(translationMatrix([-rotatedCentre[0], -wheelBottom, -rotatedCentre[2]]), R);

/* ------------------------------------------------------------------ */
/* 3. Bake every mesh into game space, with wheels on their own pivots */
/* ------------------------------------------------------------------ */

/** Bounding box of a mesh in car space, before the wheel offset is applied. */
function carSpaceBounds(record) {
  const bake = mul(CORRECTION, record.world);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const prim of record.mesh.listPrimitives()) {
    const acc = prim.getAttribute('POSITION');
    if (!acc) continue;
    for (let i = 0; i < acc.getCount(); i++) {
      acc.getElement(i, v);
      const c = xformPoint(bake, v);
      for (let k = 0; k < 3; k++) {
        if (c[k] < min[k]) min[k] = c[k];
        if (c[k] > max[k]) max[k] = c[k];
      }
    }
  }
  return { min, max, centre: max.map((x, i) => (x + min[i]) / 2) };
}

// Classify each wheel and build its pivot in car space.
const WHEEL_NAMES = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'];
const wheelRecords = new Map(); // record -> name

{
  for (const p of wheelSet.list) {
    // A wheel's rotation axis passes through its hub, which is the centre of
    // its bounding box — not the mean of its vertices, which is biased toward
    // whichever side of the rim happens to be denser.
    p.pivot = carSpaceBounds(p).centre;
    const front = p.pivot[2] > 0 ? 'F' : 'R';
    const side = p.pivot[0] > 0 ? 'L' : 'R';
    wheelRecords.set(p, `wheel_${front}${side}`);
  }
  if (new Set(wheelRecords.values()).size !== 4) {
    console.error('\n  Wheel classification is ambiguous (two wheels mapped to one corner).\n');
    process.exit(1);
  }
}

// Cache where every mesh lands in car space, while the accessors still hold the
// original coordinates. The material pass needs this: after baking, each wheel's
// geometry is re-centred on its own hub, and a material's total extent spans the
// whole car anyway, so only per-mesh bounds are meaningful. These are already
// absolute car-space positions — `carSpaceBounds` bakes the correction in.
for (const p of placed) p.bounds = carSpaceBounds(p);

/*
 * A wheel is more than its tyre. Rims, brake discs and calipers sit at the same
 * hub, and if they are not swept into the wheel node the tyre spins while the
 * rim inside it stays still — which reads as obviously broken. Adopt every
 * small mesh centred on a hub.
 */
{
  const ADOPT_RADIUS = 0.5;
  let adopted = 0;
  for (const p of placed) {
    if (wheelRecords.has(p)) continue;
    const c = p.bounds.centre;
    const span = Math.max(...p.bounds.max.map((v, i) => v - p.bounds.min[i]));
    if (span > 1.2) continue;
    for (const w of wheelSet.list) {
      if (
        Math.hypot(c[0] - w.pivot[0], c[2] - w.pivot[2]) < ADOPT_RADIUS &&
        Math.abs(c[1] - w.pivot[1]) < ADOPT_RADIUS
      ) {
        wheelRecords.set(p, wheelRecords.get(w));
        p.pivot = w.pivot;
        adopted += 1;
        break;
      }
    }
  }
  console.log(`  adopted ${adopted} extra mesh(es) into the wheels (rims, discs, calipers)`);
}

// Detach everything, then rebuild a flat, identity-transform hierarchy.
const modelRoot = doc.createNode('car');
for (const s of root.listScenes()) s.addChild(modelRoot);

const wheelNodes = new Map();
for (const name of WHEEL_NAMES) {
  const n = doc.createNode(name);
  modelRoot.addChild(n);
  wheelNodes.set(name, n);
}
// The geometry for each wheel was baked around its own hub, so the node has to
// carry the offset that puts it back on the car. Without this every wheel sits
// at the origin.
for (const [record, name] of wheelRecords) wheelNodes.get(name).setTranslation(record.pivot);

for (const p of placed) {
  const name = wheelRecords.get(p);
  const bakeFrom = name ? mul(translationMatrix(p.pivot.map((v) => -v)), CORRECTION) : CORRECTION;
  const bake = mul(bakeFrom, p.world);
  const nm = normalMatrix(bake);
  const mirrored = det3(bake) < 0;

  for (const prim of p.mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (pos) {
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        pos.setElement(i, xformPoint(bake, v));
      }
    }
    const nrm = prim.getAttribute('NORMAL');
    if (nrm) {
      const v = [0, 0, 0];
      for (let i = 0; i < nrm.getCount(); i++) {
        nrm.getElement(i, v);
        const o = xformDir(nm, v);
        const len = Math.hypot(o[0], o[1], o[2]);
        // Degenerate normals would poison the whole mesh — NaN normals render
        // as flat black — so leave the original in place instead.
        if (!Number.isFinite(len) || len < 1e-8) continue;
        nrm.setElement(i, [o[0] / len, o[1] / len, o[2] / len]);
      }
    }

    // Baking a mirror inverts winding; reverse it so faces stay outward.
    const idx = prim.getIndices();
    if (mirrored && idx) {
      const a = [0, 0, 0];
      for (let i = 0; i < idx.getCount(); i += 3) {
        idx.getElement(i + 1, a);
        const b = [0, 0, 0];
        idx.getElement(i + 2, b);
        idx.setElement(i + 1, b);
        idx.setElement(i + 2, a);
      }
    } else if (mirrored) {
      console.warn('    mirrored primitive with no indices — winding left as-is');
    }
  }

  p.node.setMatrix(IDENTITY);
  const holder = name ? wheelNodes.get(name) : modelRoot;
  holder.addChild(p.node);
}

// Every mesh node was reparented above, so the original scaffolding is now a
// pile of empty nodes. Drop them and check the hierarchy is what we expect.
{
  const keep = new Set([modelRoot, ...wheelNodes.values()]);
  for (const n of [...root.listNodes()]) {
    if (!keep.has(n) && !n.getMesh()) n.dispose();
  }

  const strayRoots = root.listScenes()[0].listChildren().filter((n) => n !== modelRoot);
  if (strayRoots.length) {
    console.error(
      `\n  expected only the car root at the top level, found: ${strayRoots.map((n) => n.getName()).join(', ')}\n`,
    );
    process.exit(1);
  }
  const wheelChildren = [...wheelNodes].map(([n, node]) => `${n}:${node.listChildren().length}`);
  console.log(`\n  hierarchy: car -> [${WHEEL_NAMES.join(', ')}, body]   wheel mesh counts ${wheelChildren.join(' ')}`);
}

/* ------------------------------------------------------------------ */
/* 4. Materials: clearcoat on paint, emissive on the lamps             */
/* ------------------------------------------------------------------ */

const clearcoatExt = doc.createExtension(KHRMaterialsClearcoat);
const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);

/*
 * Placement is read from where each *mesh* ends up in car space. A material in
 * this model is normally shared across the whole car — its total bounding box
 * spans the entire length and tells you nothing — so per-mesh bounds are the
 * only meaningful signal. This also beats name matching: the model calls its
 * grey plastic "Light_grey_metallic_plastic" and its real lamp lenses
 * "mat_50"-style codes, so a name match gets it exactly backwards.
 */
let carMinZ = Infinity;
let carMaxZ = -Infinity;
let carMinY = Infinity;
let carMaxY = -Infinity;
for (const p of placed) {
  carMinZ = Math.min(carMinZ, p.bounds.min[2]);
  carMaxZ = Math.max(carMaxZ, p.bounds.max[2]);
  carMinY = Math.min(carMinY, p.bounds.min[1]);
  carMaxY = Math.max(carMaxY, p.bounds.max[1]);
}
const length = carMaxZ - carMinZ;
const height = carMaxY - carMinY;

// Lamps only live at the two ends of the car, clear of the floor.
const endMeshes = new Set(
  placed.filter((p) => {
    if (wheelRecords.has(p)) return false;
    const inFrontBand = p.bounds.min[2] > carMaxZ - length * 0.2;
    const inRearBand = p.bounds.max[2] < carMinZ + length * 0.2;
    const aboveFloor = p.bounds.min[1] > carMinY + height * 0.2;
    return (inFrontBand || inRearBand) && aboveFloor;
  }),
);

const saturation = (m) => {
  const c = m.getBaseColorFactor();
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
};

// Tally, per material, how it is spread over the car.
const usage = new Map(); // material -> { onEnd, offEnd, tris, isWheel, reachesUp }
for (const p of placed) {
  const prims = p.mesh.listPrimitives();
  const t = countTris(p.mesh);
  for (const prim of prims) {
    const m = prim.getMaterial();
    if (!m) continue;
    let u = usage.get(m);
    if (!u) {
      u = { onEnd: 0, offEnd: 0, tris: 0, isWheel: false, reachesUp: false };
      usage.set(m, u);
    }
    if (endMeshes.has(p)) u.onEnd += 1;
    else u.offEnd += 1;
    u.tris += t / Math.max(prims.length, 1);
    u.isWheel ||= wheelRecords.has(p);
    u.reachesUp ||= p.bounds.max[1] > carMinY + height * 0.55;
  }
}

const lightMats = [];
const painted = [];
for (const [m, u] of usage) {
  const name = m.getName() || '(unnamed)';
  if (name === 'Window' || u.isWheel) continue;

  /*
   * A lamp is either a material that only ever appears at one end of the car
   * (the model's tail-light strips), or one that is strongly coloured wherever
   * it sits (the amber front lens). Requiring *both* finds nothing: the front
   * lamp assembly stretches back along the fender into the middle of the car.
   */
  const lampish = (u.onEnd > 0 && u.offEnd === 0) || saturation(m) > 0.5;
  if (lampish) lightMats.push(m);
  else if (u.tris >= 3000 && u.reachesUp) painted.push(m);
}

for (const m of painted) {
  const cc = clearcoatExt.createClearcoat();
  cc.setClearcoatFactor(1.0);
  cc.setClearcoatRoughnessFactor(0.04);
  m.setExtension('KHR_materials_clearcoat', cc);
}

for (const m of lightMats) {
  const base = m.getBaseColorFactor();
  m.setEmissiveFactor([
    Math.min(1, base[0] * 1.4 + 0.15),
    Math.min(1, base[1] * 1.4 + 0.15),
    Math.min(1, base[2] * 1.4 + 0.15),
  ]);
  const es = emissiveExt.createEmissiveStrength();
  es.setEmissiveStrength(3.0);
  m.setExtension('KHR_materials_emissive_strength', es);
  m.setDoubleSided(true);
}

console.log(
  `\n  car length ${length.toFixed(3)} m, height ${height.toFixed(3)} m, ` +
    `z ${carMinZ.toFixed(2)} .. ${carMaxZ.toFixed(2)}`,
);
console.log(`  clearcoat on ${painted.length}: ${painted.map((m) => m.getName()).join(', ')}`);
console.log(`  emissive  on ${lightMats.length}: ${lightMats.map((m) => m.getName()).join(', ') || 'none'}`);
console.log('  material usage (meshes at a car end, vs. anywhere else):');
for (const [m, u] of [...usage].sort((a, b) => b[1].tris - a[1].tris)) {
  const tag = lightMats.includes(m) ? 'LAMP' : painted.includes(m) ? 'paint' : u.isWheel ? 'wheel' : '-';
  console.log(
    `    ${tag.padEnd(6)} ${(m.getName() || '(unnamed)').padEnd(32)} ` +
      `end ${String(u.onEnd).padStart(3)}  other ${String(u.offEnd).padStart(3)}  ` +
      `tris ${Math.round(u.tris).toString().padStart(6)}  ` +
      `sat ${saturation(m).toFixed(2)}  up ${u.reachesUp ? 'y' : 'n'}`,
  );
}

/* ------------------------------------------------------------------ */
/* 5. Optimise                                                         */
/* ------------------------------------------------------------------ */

console.log('\n  optimising …');
await doc.transform(dedup(), prune());

const preWeldTris = root
  .listMeshes()
  .reduce((s, m) => s + countTris(m), 0);

if (NO_OPTIMIZE) {
  console.log('  --no-optimize: skipping weld / simplify / reorder');
} else {
  await doc.transform(weld({ tolerance: 0.0001 }));

  await MeshoptSimplifier.ready;
  const ratio = Math.min(1, TRI_BUDGET / Math.max(preWeldTris, 1));
  console.log(`  simplifying ${Math.round(preWeldTris).toLocaleString('en-US')} → target ${TRI_BUDGET.toLocaleString('en-US')} (ratio ${ratio.toFixed(3)})`);

  await doc.transform(
    simplify({ simplifier: MeshoptSimplifier, ratio, error: SIMPLIFY_ERROR, lockBorder: false }),
  );

  await doc.transform(reorder({ encoder: MeshoptEncoder }), prune());
}

const trisAfter = root.listMeshes().reduce((s, m) => s + countTris(m), 0);

/* ------------------------------------------------------------------ */
/* 6. Write                                                            */
/* ------------------------------------------------------------------ */

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await io.write(OUT, doc);
const bytes = fs.statSync(OUT).size;

const wheelReport = [...wheelNodes.entries()].map(([n, node]) => {
  const t = node.getTranslation();
  return `    ${n.padEnd(9)} pivot [${t.map((v) => v.toFixed(3)).join(', ')}]`;
});

console.log(`\n  ${path.relative(ROOT, OUT)}`);
console.log(`  triangles ${Math.round(trisBefore).toLocaleString('en-US')} → ${Math.round(trisAfter).toLocaleString('en-US')}  ` +
  `(${(100 - (trisAfter / trisBefore) * 100).toFixed(1)}% removed, budget ${TRI_BUDGET.toLocaleString('en-US')})`);
console.log(`  size      ${(fs.statSync(SRC).size / 1024 ** 2).toFixed(1)} MB → ${(bytes / 1024 ** 2).toFixed(1)} MB`);
console.log(`  nodes     ${root.listNodes().length}, meshes ${root.listMeshes().length}, materials ${root.listMaterials().length}, textures ${root.listTextures().length}`);
console.log(`\n  wheels (pivots in car space, car faces +Z, +X is its left):`);
console.log(wheelReport.join('\n'));

if (trisAfter > TRI_BUDGET) {
  console.warn(`\n  warning: still ${Math.round(trisAfter - TRI_BUDGET).toLocaleString('en-US')} triangles over budget`);
}
console.log('');
