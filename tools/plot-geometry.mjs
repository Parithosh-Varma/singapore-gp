/**
 * Top-down ASCII plot of a GLB's geometry, for reading a model's layout without
 * a renderer. Row = Z, column = X, so the plot is directly comparable to the
 * grid axes in tools/model-preview.html.
 *
 * Usage:
 *   node tools/plot-geometry.mjs <file.glb> [options]
 *
 *   --mesh <substring>   only nodes whose path matches (repeatable, comma-split)
 *   --material <substr>  only primitives whose material name matches
 *   --list               print every mesh node and exit (no plot)
 *   --flat               only near-horizontal triangles (|normal.y| > threshold)
 *   --slope <n>          normal.y threshold for --flat (default 0.9)
 *   --y <min:max>        only triangles whose centre y is in range
 *   --bounds x0:x1:z0:z1 crop to this XZ window (and use it as the plot extent)
 *   --cols <n>           plot width in characters (default 150)
 *   --rows <n>           plot height in characters (default 60)
 *   --mode <m>           'cell' (default) or 'centroid'
 *
 * Examples:
 *   node tools/plot-geometry.mjs assets/raw/track_raw.glb --list
 *   node tools/plot-geometry.mjs assets/raw/track_raw.glb --material 11001Mtl --flat
 */
import { NodeIO } from '@gltf-transform/core';
import {
  KHRMaterialsSpecular,
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
} from '@gltf-transform/extensions';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/plot-geometry.mjs <file.glb> [--mesh s] [--flat] [--y min:max]');
  process.exit(2);
}

const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const collect = (flag) =>
  args
    .map((a, i) => (a === flag ? args[i + 1] : null))
    .filter(Boolean)
    .flatMap((s) => s.split(','))
    .filter(Boolean);

const meshFilters = collect('--mesh');
const materialFilters = collect('--material');
const listOnly = has('list');
const flatOnly = has('flat');
const verticalOnly = has('vertical');
const topBelow = opt('top', null) === null ? null : Number(opt('top', null));
const slopeMin = Number(opt('slope', 0.9));
const yRange = opt('y', null)?.split(':').map(Number) ?? null;
const bounds = opt('bounds', null)?.split(':').map(Number) ?? null;
const COLS = Number(opt('cols', 150));
const ROWS = Number(opt('rows', 60));
const MODE = opt('mode', 'cell');

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

/** Every kept triangle as an XZ pair of points plus its normal-y. */
const tris = [];
const matched = new Set();
const allNodes = [];

function walk(node, parent, path) {
  const world = mulMat(parent, Array.from(node.getMatrix()));
  const here = path ? `${path}/${node.getName() || '?'}` : node.getName() || '?';
  const mesh = node.getMesh();

  if (mesh && (!meshFilters.length || meshFilters.some((f) => here.includes(f)))) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      const n = idx ? idx.getCount() : pos.getCount();
      const mat = prim.getMaterial()?.getName() || '(none)';
      const triCount = Math.round(n / 3);

      if (listOnly) {
        allNodes.push({ here, mat, tris: triCount, verts: pos.getCount() });
        continue;
      }

      if (materialFilters.length && !materialFilters.some((f) => mat.includes(f))) continue;
      matched.add(`${here} [${mat}]`);

      const get = (i) => {
        const k = idx ? idx.getScalar(i) : i;
        const v = [0, 0, 0, 1];
        pos.getElement(k, v);
        return [
          world[0] * v[0] + world[4] * v[1] + world[8] * v[2] + world[12],
          world[1] * v[0] + world[5] * v[1] + world[9] * v[2] + world[13],
          world[2] * v[0] + world[6] * v[1] + world[10] * v[2] + world[14],
        ];
      };
      for (let i = 0; i + 2 < n; i += 3) {
        const a = get(i);
        const b = get(i + 1);
        const c = get(i + 2);
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nx = ab[1] * ac[2] - ab[2] * ac[1];
        const ny = ab[2] * ac[0] - ab[0] * ac[2];
        const nz = ab[0] * ac[1] - ab[1] * ac[0];
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) continue;
        const uy = Math.abs(ny / len);
        if (flatOnly && uy < slopeMin) continue;
        if (verticalOnly && uy > 0.4) continue;
        const cy = (a[1] + b[1] + c[1]) / 3;
        if (yRange && (cy < yRange[0] || cy > yRange[1])) continue;
        if (topBelow !== null) {
          const topY = Math.max(a[1], b[1], c[1]);
          if (topY > topBelow) continue;
        }
        if (bounds) {
          const cx = (a[0] + b[0] + c[0]) / 3;
          const cz = (a[2] + b[2] + c[2]) / 3;
          if (cx < bounds[0] || cx > bounds[1] || cz < bounds[2] || cz > bounds[3]) continue;
        }
        tris.push({ a, b, c, uy, cy });
      }
    }
  }
  for (const child of node.listChildren()) walk(child, world, here);
}
for (const scene of root.listScenes()) for (const n of scene.listChildren()) walk(n, IDENTITY, '');

if (listOnly) {
  allNodes.sort((a, b) => b.tris - a.tris);
  console.log(`${allNodes.length} mesh primitives\n`);
  console.log(`${'tris'.padStart(8)}  ${'verts'.padStart(8)}  ${'path'.padEnd(52)}  material`);
  for (const r of allNodes) {
    const p = r.here.length > 50 ? `…${r.here.slice(-49)}` : r.here;
    console.log(`${String(r.tris).padStart(8)}  ${String(r.verts).padStart(8)}  ${p.padEnd(52)}  ${r.mat}`);
  }
  const mats = new Map();
  for (const r of allNodes) mats.set(r.mat, (mats.get(r.mat) ?? 0) + r.tris);
  console.log(`\n=== triangles per material ===`);
  for (const [m, t] of [...mats].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(t).padStart(8)}  ${m}`);
  }
  process.exit(0);
}

if (!tris.length) {
  console.error('no triangles matched.');
  if (meshFilters.length) console.error(`node filters: ${meshFilters.join(', ')}`);
  if (materialFilters.length) console.error(`material filters: ${materialFilters.join(', ')}`);
  process.exit(1);
}

let minX = bounds ? bounds[0] : Infinity;
let maxX = bounds ? bounds[1] : -Infinity;
let minZ = bounds ? bounds[2] : Infinity;
let maxZ = bounds ? bounds[3] : -Infinity;
let minY = Infinity,
  maxY = -Infinity;
for (const t of tris) {
  for (const p of [t.a, t.b, t.c]) {
    if (!bounds) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    }
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
}

console.log(`${tris.length.toLocaleString('en-US')} triangles plotted`);
if (matched.size) console.log(`nodes matched: ${[...matched].map((m) => m.split('/').pop()).join(', ')}`);
console.log(`X ${minX.toFixed(1)} .. ${maxX.toFixed(1)}   Z ${minZ.toFixed(1)} .. ${maxZ.toFixed(1)}   Y ${minY.toFixed(2)} .. ${maxY.toFixed(2)}`);

const sx = (COLS - 1) / Math.max(maxX - minX, 1e-9);const sz = (ROWS - 1) / Math.max(maxZ - minZ, 1e-9);
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));

/** Bresenham-ish stamping so thin road ribbons do not vanish between cells. */
const stamp = (p, q) => {
  const steps = Math.max(2, Math.ceil(Math.max(Math.abs(q[0] - p[0]) * sx, Math.abs(q[1] - p[1]) * sz) * 2));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round((p[0] + (q[0] - p[0]) * t - minX) * sx);
    const cz = Math.round((p[1] + (q[1] - p[1]) * t - minZ) * sz);
    if (cx >= 0 && cx < COLS && cz >= 0 && cz < ROWS) grid[cz][cx]++;
  }
};

for (const t of tris) {
  if (MODE === 'centroid') {
    const cx = Math.round(((t.a[0] + t.b[0] + t.c[0]) / 3 - minX) * sx);
    const cz = Math.round(((t.a[2] + t.b[2] + t.c[2]) / 3 - minZ) * sz);
    if (cx >= 0 && cx < COLS && cz >= 0 && cz < ROWS) grid[cz][cx]++;
  } else {
    stamp([t.a[0], t.a[2]], [t.b[0], t.b[2]]);
    stamp([t.b[0], t.b[2]], [t.c[0], t.c[2]]);
    stamp([t.c[0], t.c[2]], [t.a[0], t.a[2]]);
  }
}

const peak = Math.max(...grid.flat());
const RAMP = ' .:-=+*#%@';
// Density is extremely uneven — stacked ground slabs spike one cell while roads
// sit at 1-3 — so the ramp is logarithmic by default, or the plot is all blanks.
const scale = opt('scale', 'log');
const level = (v) => {
  const t = scale === 'lin' ? v / peak : Math.log1p(v) / Math.log1p(peak);
  return Math.min(RAMP.length - 1, Math.floor(t * (RAMP.length - 1)));
};
console.log(`\nZ is down the page, X is across. Peak cell density ${peak}, ${scale} ramp.`);
console.log(`+${'-'.repeat(COLS)}+`);
for (let r = 0; r < ROWS; r++) {
  let line = '';
  for (let c = 0; c < COLS; c++) {
    const v = grid[r][c];
    line += v === 0 ? ' ' : RAMP[Math.max(1, level(v))];
  }
  console.log(`|${line}|`);
}
console.log(`+${'-'.repeat(COLS)}+`);
console.log(`X: ${minX.toFixed(0)} (left) .. ${maxX.toFixed(0)} (right)`);
console.log(`Z: ${minZ.toFixed(0)} (top) .. ${maxZ.toFixed(0)} (bottom)`);
