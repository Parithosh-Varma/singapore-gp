/**
 * Per-mesh analysis of a GLB: true world-space bounds, axis extents, repeated
 * geometry, and a height histogram.
 *
 * Every vertex is transformed rather than just the bounding-box corners, so
 * rotated meshes report their real extents. Node-only, no browser needed.
 *
 *   node tools/inspect-meshes.mjs assets/raw/track_raw.glb
 *
 * The height histogram is the quickest way to find a model's ground plane, which
 * is not necessarily y = 0 — the Marina Bay city model sits ~50 m up.
 */
import { NodeIO } from '@gltf-transform/core';
import {
  KHRMaterialsSpecular,
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
} from '@gltf-transform/extensions';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/inspect-meshes.mjs <file.glb>');
  process.exit(2);
}

const doc = await new NodeIO()
  .registerExtensions([KHRMaterialsSpecular, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength])
  .read(file);
const root = doc.getRoot();

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mulMat(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
  return out;
}

function det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2])
  );
}

const rows = [];
const yHist = new Map();
const BUCKET = Number(process.env.BUCKET ?? 5);

function walk(node, parent, path) {
  const world = mulMat(parent, Array.from(node.getMatrix()));
  const here = path ? `${path}/${node.getName() || '?'}` : node.getName() || '?';
  const mesh = node.getMesh();

  if (mesh) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const sum = [0, 0, 0];
    let count = 0;
    let tris = 0;
    const mats = new Set();

    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      const m = prim.getMaterial();
      if (m) mats.add(m.getName() || '(unnamed)');
      if (!acc) continue;
      const n = acc.getCount();
      tris += (prim.getIndices()?.getCount() ?? n) / 3;
      const v = [0, 0, 0, 1];
      for (let i = 0; i < n; i++) {
        acc.getElement(i, v);
        const x = world[0] * v[0] + world[4] * v[1] + world[8] * v[2] + world[12];
        const y = world[1] * v[0] + world[5] * v[1] + world[9] * v[2] + world[13];
        const z = world[2] * v[0] + world[6] * v[1] + world[10] * v[2] + world[14];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
        sum[0] += x;
        sum[1] += y;
        sum[2] += z;
        count++;
        const k = Math.floor(y / BUCKET) * BUCKET;
        yHist.set(k, (yHist.get(k) ?? 0) + 1);
      }
    }

    rows.push({
      node: here,
      tris: Math.round(tris),
      verts: count,
      min,
      max,
      size: max.map((v, i) => v - min[i]),
      centroid: sum.map((v) => v / Math.max(count, 1)),
      center: max.map((v, i) => (v + min[i]) / 2),
      mats: [...mats].join('|'),
      det: det3(world),
    });
  }

  for (const c of node.listChildren()) walk(c, world, here);
}

for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, IDENTITY, '');

const f = (v) => v.map((x) => x.toFixed(3)).join(', ');
const gmin = [Infinity, Infinity, Infinity];
const gmax = [-Infinity, -Infinity, -Infinity];
for (const r of rows) {
  for (let k = 0; k < 3; k++) {
    gmin[k] = Math.min(gmin[k], r.min[k]);
    gmax[k] = Math.max(gmax[k], r.max[k]);
  }
}
const gsize = gmax.map((v, i) => v - gmin[i]);
const gc = gmax.map((v, i) => (v + gmin[i]) / 2);
const AX = ['X', 'Y', 'Z'];
const order = [...gsize.keys()].sort((a, b) => gsize[b] - gsize[a]);

console.log(`\nmeshes ${rows.length}   mirrored transforms ${rows.filter((r) => r.det < 0).length}/${rows.length}`);
console.log(`total triangles ${rows.reduce((s, r) => s + r.tris, 0).toLocaleString('en-US')}`);
console.log(`true world bbox  min [${f(gmin)}]  max [${f(gmax)}]`);
console.log(`size ${gsize.map((v) => v.toFixed(3)).join(' x ')}   centre [${f(gc)}]`);
console.log(`axis extents: ${gsize.map((v, i) => `${AX[i]}=${v.toFixed(2)}`).join('  ')}`);
console.log(`  -> longest is ${AX[order[0]]}, then ${AX[order[1]]}, then ${AX[order[2]]}`);

// --- height histogram: where does the ground actually sit? ---
const hist = [...yHist].sort((a, b) => a[0] - b[0]);
const peak = Math.max(...hist.map(([, n]) => n));
console.log(`\n=== Y histogram (${BUCKET} m buckets, vertex count) ===`);
for (const [k, n] of hist) {
  if (n < peak * 0.002) continue;
  const bar = '#'.repeat(Math.max(1, Math.round((n / peak) * 50)));
  console.log(`  y ${String(k).padStart(8)}  ${String(n).padStart(9)}  ${bar}`);
}
const densest = hist.reduce((a, b) => (b[1] > a[1] ? b : a));
console.log(`  densest slice: y ${densest[0]} .. ${densest[0] + BUCKET}  (${densest[1].toLocaleString('en-US')} vertices)`);

// --- repeated geometry: instanced props, buildings, wheels ---
console.log('\n=== groups of meshes with identical vertex counts ===');
const byVerts = new Map();
for (const r of rows) {
  if (!byVerts.has(r.verts)) byVerts.set(r.verts, []);
  byVerts.get(r.verts).push(r);
}
for (const [verts, list] of [...byVerts.entries()]
  .filter(([, l]) => l.length >= 2)
  .sort((a, b) => b[1].length - a[1].length || b[0] - a[0])
  .slice(0, 8)) {
  const tris = list.reduce((s, r) => s + r.tris, 0);
  const maxDim = Math.max(...list.map((r) => Math.max(...r.size)));
  console.log(
    `\n  ${list.length} instances   verts=${verts}  tris=${tris}  material=${list[0].mats}  maxDim=${maxDim.toFixed(3)}`,
  );
  for (const r of list.slice(0, 6)) {
    const dx = r.centroid[0] - gc[0];
    const dz = r.centroid[2] - gc[2];
    console.log(
      `      [${f(r.centroid)}]  offsetFromCentre [${dx.toFixed(1)}, ${dz.toFixed(1)}]  size [${f(r.size)}]`,
    );
  }
  if (list.length > 6) console.log(`      … ${list.length - 6} more`);
}

// --- biggest contributors, and what sits lowest ---
console.log('\n=== 15 largest meshes by triangle count ===');
for (const r of [...rows].sort((a, b) => b.tris - a.tris).slice(0, 15)) {
  console.log(
    `  tris ${String(r.tris).padStart(7)}  size [${f(r.size)}]  ${r.mats}  ${r.node.slice(0, 60)}`,
  );
}

console.log('\n=== 10 meshes with the lowest geometry ===');
for (const r of [...rows].sort((a, b) => a.min[1] - b.min[1]).slice(0, 10)) {
  console.log(`  minY ${r.min[1].toFixed(3)}  size [${f(r.size)}]  tris ${String(r.tris).padStart(7)}  ${r.mats}`);
}
