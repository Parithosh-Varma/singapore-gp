/**
 * Turn the raw Shanghai International Circuit Sketchfab model into a drivable
 * track: a decimated visual mesh, a road collision mesh, and a centreline.
 *
 * Unlike the Marina Bay model this file really is a circuit, so the track can be
 * isolated structurally rather than heuristically. The key is that the track
 * surface layers are essentially 100% horizontal (asphalt, kerbs, painted
 * lines), while the terrain around them carries slopes and embankments and so
 * never exceeds ~50% horizontal. That single test cleanly separates them.
 *
 * Usage:
 *   node scripts/prepare_track.mjs --analyze     # report only
 *   node scripts/prepare_track.mjs --overlay     # report + centreline overlay
 *   node scripts/prepare_track.mjs               # build outputs
 */
import { NodeIO } from '@gltf-transform/core';
import {
  KHRMaterialsSpecular,
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
  KHRTextureTransform,
  KHRMeshQuantization,
} from '@gltf-transform/extensions';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAW = path.join(ROOT, 'assets', 'raw', 'track_raw.glb');

const args = process.argv.slice(2);
const ANALYZE = args.includes('--analyze');
const OVERLAY = args.includes('--overlay') || ANALYZE;
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

if (!fs.existsSync(RAW)) {
  console.error(`missing ${path.relative(ROOT, RAW)} — run: npm run fetch-assets track`);
  process.exit(1);
}

const t0 = Date.now();
const doc = await new NodeIO()
  .registerExtensions([
    KHRMaterialsSpecular,
    KHRMaterialsClearcoat,
    KHRMaterialsEmissiveStrength,
    KHRTextureTransform,
  ])
  .read(RAW);
const root = doc.getRoot();
console.log(`loaded ${path.relative(ROOT, RAW)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

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

/**
 * Visit every mesh primitive in world space. `fn` receives world-space
 * coordinates only, so callers do not have to redo the transform math.
 */
function forEachPrimitive(fn) {
  const visit = (node, parent) => {
    const world = mulMat(parent, Array.from(node.getMatrix()));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        if (!pos) continue;
        const n = idx ? idx.getCount() : pos.getCount();
        const p = [0, 0, 0, 0];
        const get = (i) => {
          const k = idx ? idx.getScalar(i) : i;
          pos.getElement(k, p);
          return [
            world[0] * p[0] + world[4] * p[1] + world[8] * p[2] + world[12],
            world[1] * p[0] + world[5] * p[1] + world[9] * p[2] + world[13],
            world[2] * p[0] + world[6] * p[1] + world[10] * p[2] + world[14],
          ];
        };
        const matName = prim.getMaterial()?.getName() || '(none)';
        fn(node.getName() || '?', get, n, matName);
      }
    }
    for (const child of node.listChildren()) visit(child, world);
  };
  for (const scene of root.listScenes()) for (const n of scene.listChildren()) visit(n, IDENTITY);
}

// ---------------------------------------------------------------------------
// pass 1: per-mesh statistics
// ---------------------------------------------------------------------------

const meshes = new Map();
let globalMin = [Infinity, Infinity, Infinity];
let globalMax = [-Infinity, -Infinity, -Infinity];
const yHist = new Map();

forEachPrimitive((name, get, n, matName) => {
  let rec = meshes.get(name);
  if (!rec) {
    rec = {
      name,
      tris: 0,
      horizontal: 0,
      vertical: 0,
      materials: new Set(),
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    meshes.set(name, rec);
  }
  rec.materials.add(matName);
  rec.tris += Math.round(n / 3);

  for (let i = 0; i + 2 < n; i += 3) {
    const a = get(i);
    const b = get(i + 1);
    const c = get(i + 2);
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < rec.min[k]) rec.min[k] = v[k];
        if (v[k] > rec.max[k]) rec.max[k] = v[k];
        if (v[k] < globalMin[k]) globalMin[k] = v[k];
        if (v[k] > globalMax[k]) globalMax[k] = v[k];
      }
    }
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = ab[1] * ac[2] - ab[2] * ac[1];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    const nz = ab[0] * ac[1] - ab[1] * ac[0];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const uy = Math.abs(ny / len);
    if (uy >= 0.9) {
      rec.horizontal++;
      const k = Math.floor((a[1] + b[1] + c[1]) / 3);
      yHist.set(k, (yHist.get(k) ?? 0) + 1);
    } else if (uy < 0.5) {
      rec.vertical++;
    }
  }
});

const meshList = [...meshes.values()];
const totalTris = meshList.reduce((s, m) => s + m.tris, 0);
const size = globalMax.map((v, i) => v - globalMin[i]);
const fmt = (v) => v.map((x) => x.toFixed(1)).join(', ');
console.log(
  `\n=== model ===\n  ${meshList.length} meshes, ${totalTris.toLocaleString('en-US')} triangles`,
);
console.log(`  bbox min [${fmt(globalMin)}]  max [${fmt(globalMax)}]`);
console.log(`  size ${fmt(size)}`);

console.log(`\n=== Y histogram of near-horizontal geometry (1 m buckets) ===`);
const ranked = [...yHist].sort((a, b) => b[1] - a[1]);
const histPeak = ranked[0][1];
for (const [y, n] of ranked.slice(0, 14)) {
  console.log(
    `  y ${String(y).padStart(6)}  ${String(n).padStart(9)}  ${'#'.repeat(Math.max(1, Math.round((n / histPeak) * 44)))}`,
  );
}

// ---------------------------------------------------------------------------
// textures
//
// Nodes and materials are both uselessly named here (`Object_39`,
// `advert_side_a_7`), so the only dependable description of what a mesh *is*
// comes from the colour of its base-colour texture. Asphalt is dark and
// unsaturated, grass is green, kerbs and painted lines are bright.
// ---------------------------------------------------------------------------

const sharp = (await import('sharp')).default;
const materialColour = new Map();
{
  const started = Date.now();
  for (const mat of root.listMaterials()) {
    const tex = mat.getBaseColorTexture();
    let rgb = null;
    const img = tex?.getImage();
    if (img?.length) {
      try {
        const info = await sharp(Buffer.from(img))
          .resize(1, 1, { fit: 'fill' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        rgb = [info.data[0], info.data[1], info.data[2]];
      } catch {
        rgb = null;
      }
    }
    materialColour.set(mat.getName(), rgb);
  }
  console.log(
    `\n=== textures ===\n  averaged ${materialColour.size} material base colours in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}

/** Mean base colour across the materials a mesh uses, or null when unknown. */
function meshColour(m) {
  const cols = [...m.materials].map((n) => materialColour.get(n)).filter(Boolean);
  if (!cols.length) return null;
  return [0, 1, 2].map((k) => Math.round(cols.reduce((s, c) => s + c[k], 0) / cols.length));
}

const hex = (c) => (c ? `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}` : '  ?  ');

console.log(`\n=== meshes with >=1000 triangles, largest first ===`);
console.log(
  `${'mesh'.padEnd(12)}  ${'tris'.padStart(7)}  ${'horiz'.padStart(5)}  ${'footprint'.padEnd(20)}  ${'y range'.padEnd(13)}  colour`,
);
for (const m of meshList.filter((m) => m.tris >= 1000).sort((a, b) => b.tris - a.tris)) {
  const s = m.max.map((v, i) => v - m.min[i]);
  console.log(
    `${m.name.padEnd(12)}  ${String(m.tris).padStart(7)}  ` +
      `${((m.horizontal / m.tris) * 100).toFixed(0).padStart(4)}%  ` +
      `${`${s[0].toFixed(0)} x ${s[1].toFixed(0)} x ${s[2].toFixed(0)}`.padEnd(20)}  ` +
      `${`${m.min[1].toFixed(0)}..${m.max[1].toFixed(0)}`.padEnd(13)}  ${hex(meshColour(m))}`,
  );
}

// ---------------------------------------------------------------------------
// isolate the track surface
// ---------------------------------------------------------------------------

const FLAT_MIN = Number(opt('flat-min', 0.95));
const MIN_TRIS = Number(opt('min-tris', 5000));
const trackMeshes = meshList.filter(
  (m) => m.tris > MIN_TRIS && m.horizontal / m.tris >= FLAT_MIN,
);
const trackNames = new Set(trackMeshes.map((m) => m.name));

/**
 * Every paved layer, kept even when `--only` narrows the ribbon the centreline
 * is taken from and `--min-tris` drops the thin ones. The model stacks layers
 * on the racing surface, and the height a wheel lands on is the top of the
 * stack — a thinner layer over the asphalt sits a good 15 cm proud of it in
 * places, which is enough to sink the car into the road.
 */
const surfaceNames = new Set(
  meshList.filter((m) => m.tris > 200 && m.horizontal / m.tris >= FLAT_MIN).map((m) => m.name),
);

// Escape hatch: the flatness test finds every paved layer, and the apron is just
// as flat as the asphalt. `--only Object_39,Object_85` narrows to a subset while
// the right layer is identified.
const ONLY = opt('only', null);
if (ONLY) {
  const wanted = new Set(ONLY.split(',').map((s) => s.trim()));
  for (const name of [...trackNames]) if (!wanted.has(name)) trackNames.delete(name);
  for (let i = trackMeshes.length - 1; i >= 0; i--)
    if (!wanted.has(trackMeshes[i].name)) trackMeshes.splice(i, 1);
  console.log(`\n  --only ${[...wanted].join(', ')} -> ${trackNames.size} mesh(es) kept`);
}

console.log(
  `\n=== track surface: meshes >=${(FLAT_MIN * 100).toFixed(0)}% horizontal (${trackNames.size} of ${meshList.length}) ===`,
);
let trackTris = 0;
for (const m of [...trackMeshes].sort((a, b) => b.tris - a.tris)) {
  const s = m.max.map((v, i) => v - m.min[i]);
  trackTris += m.tris;
  console.log(
    `  ${String(m.tris).padStart(7)}  ${((m.horizontal / m.tris) * 100).toFixed(0).padStart(3)}%  ` +
      `${`${s[0].toFixed(0)} x ${s[1].toFixed(0)} x ${s[2].toFixed(0)}`.padEnd(22)}  ` +
      `y ${m.min[1].toFixed(1)}..${m.max[1].toFixed(1)}  ${m.name}`,
  );
}
console.log(`  ${trackTris.toLocaleString('en-US')} triangles total`);

if (!trackNames.size) {
  console.error('\nnothing matched the track-surface test — adjust --flat-min / --min-tris');
  process.exit(1);
}

const tBox = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
};
for (const m of trackMeshes)
  for (let k = 0; k < 3; k++) {
    tBox.min[k] = Math.min(tBox.min[k], m.min[k]);
    tBox.max[k] = Math.max(tBox.max[k], m.max[k]);
  }
console.log(
  `  combined footprint ${(tBox.max[0] - tBox.min[0]).toFixed(0)} x ${(tBox.max[2] - tBox.min[2]).toFixed(0)} m, ` +
    `y ${tBox.min[1].toFixed(1)} .. ${tBox.max[1].toFixed(1)}`,
);

// ---------------------------------------------------------------------------
// rasterise the track surface
// ---------------------------------------------------------------------------

const CELL = Number(opt('cell', 2));
const PAD = Number(opt('pad', 40));
const x0 = tBox.min[0] - PAD;
const z0 = tBox.min[2] - PAD;
const cols = Math.ceil((tBox.max[0] - tBox.min[0] + 2 * PAD) / CELL);
const rows = Math.ceil((tBox.max[2] - tBox.min[2] + 2 * PAD) / CELL);
const mask = new Uint8Array(cols * rows);

/**
 * Fill a world-space triangle into a mask.
 *
 * Stamping only the three edges is not enough. A track ribbon is meshed from
 * long thin triangles, whose edges are two nearly parallel lines with nothing
 * between them — so an edge-only raster shows the ribbon as a pair of lines, the
 * distance transform reads the gap as "outside", and the ridge walk oscillates
 * between the two edges instead of following the track.
 *
 * Terrain-sized triangles fall back to edge stamping so one giant triangle
 * cannot blow the loop up.
 */
function fillTriangle(m, a, b, c) {
  const minC = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - x0) / CELL));
  const maxC = Math.min(cols - 1, Math.floor((Math.max(a[0], b[0], c[0]) - x0) / CELL));
  const minR = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - z0) / CELL));
  const maxR = Math.min(rows - 1, Math.floor((Math.max(a[2], b[2], c[2]) - z0) / CELL));
  if (minC > maxC || minR > maxR) return;
  if ((maxC - minC) * (maxR - minR) > 40000) {
    stampEdges(m, a, b, c);
    return;
  }
  for (let r = minR; r <= maxR; r++) {
    const pz = z0 + (r + 0.5) * CELL;
    for (let cc = minC; cc <= maxC; cc++) {
      const px = x0 + (cc + 0.5) * CELL;
      const d1 = (px - b[0]) * (a[2] - b[2]) - (a[0] - b[0]) * (pz - b[2]);
      const d2 = (px - c[0]) * (b[2] - c[2]) - (b[0] - c[0]) * (pz - c[2]);
      const d3 = (px - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (pz - a[2]);
      if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
      m[r * cols + cc] = 1;
    }
  }
}

/** Stamp just the three edges; the fallback for very large triangles. */
function stampEdges(m, a, b, c) {
  const put = (p, q) => {
    const steps = Math.max(
      1,
      Math.ceil((Math.abs(q[0] - p[0]) + Math.abs(q[2] - p[2])) / (CELL * 0.5)),
    );
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const cx = Math.floor((p[0] + (q[0] - p[0]) * u - x0) / CELL);
      const cz = Math.floor((p[2] + (q[2] - p[2]) * u - z0) / CELL);
      if (cx < 0 || cx >= cols || cz < 0 || cz >= rows) continue;
      m[cz * cols + cx] = 1;
    }
  };
  put(a, b);
  put(b, c);
  put(c, a);
}

forEachPrimitive((name, get, n) => {
  if (!trackNames.has(name)) return;
  for (let i = 0; i + 2 < n; i += 3) {
    const a = get(i);
    const b = get(i + 1);
    const c = get(i + 2);
    fillTriangle(mask, a, b, c);
  }
});

let maskCells = 0;
for (const v of mask) if (v) maskCells++;
console.log(
  `\n=== rasterised track surface ===\n  ${cols} x ${rows} cells @ ${CELL} m, origin ${x0.toFixed(0)}, ${z0.toFixed(0)}`,
);
console.log(
  `  ${maskCells.toLocaleString('en-US')} cells = ${((maskCells * CELL * CELL) / 1e6).toFixed(3)} km^2` +
    `  (a 5.451 km lap 15 m wide is ~0.082 km^2)`,
);

/** Rasterise one named mesh on its own, to compare footprints. */
function rasteriseMesh(name) {
  const m = new Uint8Array(cols * rows);
  forEachPrimitive((n2, get2, count2) => {
    if (n2 !== name) return;
    for (let i = 0; i + 2 < count2; i += 3) {
      fillTriangle(m, get2(i), get2(i + 1), get2(i + 2));
    }
  });
  return m;
}

// ---------------------------------------------------------------------------
// footprint survey
//
// Flatness alone cannot identify the circuit, because the apron and the runoff
// are just as flat as the asphalt. Width can: a track ribbon is a couple of
// cells wide everywhere, while an apron opens out into a wide slab. And a track
// is a single ribbon, not a scatter of separate strips. Both are measured here
// rather than assumed.
// ---------------------------------------------------------------------------

/** Count 8-connected components of a binary mask. */
function countComponents(m) {
  const seen = new Uint8Array(m.length);
  let groups = 0;
  const stack = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    groups++;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      const r = (i / cols) | 0;
      const c = i % cols;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const j = nr * cols + nc;
          if (m[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
  }
  return groups;
}

console.log(`\n=== footprint survey: which mesh is the ribbon? ===`);
console.log(
  `${'mesh'.padEnd(13)} ${'tris'.padStart(7)} ${'cells'.padStart(7)} ${'fill'.padStart(6)} ` +
    `${'parts'.padStart(5)}  ${'width p10/p50/p90'.padEnd(18)} colour`,
);
const surveyNames = args.includes('--survey-all')
  ? meshList.filter((m) => m.tris >= 1000).map((m) => m.name)
  : trackMeshes.map((m) => m.name);

const footprint = new Map();
for (const name of surveyNames) {
  const m = meshes.get(name);
  const mm = rasteriseMesh(name);
  footprint.set(name, mm);
  let cells = 0;
  for (const v of mm) if (v) cells++;
  if (!cells) continue;
  const boxCells = ((m.max[0] - m.min[0]) / CELL) * ((m.max[2] - m.min[2]) / CELL);
  const d = distanceTransform(mm);
  const vals = [];
  for (let i = 0; i < mm.length; i++) if (mm[i]) vals.push(d[i] * CELL);
  vals.sort((a, b) => a - b);
  const p = (q) => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
  const width = `${p(0.1).toFixed(1)} / ${p(0.5).toFixed(1)} / ${p(0.9).toFixed(1)}`.padEnd(18);
  console.log(
    `${name.padEnd(13)} ${String(m.tris).padStart(7)} ${String(cells).padStart(7)} ` +
      `${((cells / Math.max(boxCells, 1)) * 100).toFixed(1).padStart(5)}% ` +
      `${String(countComponents(mm)).padStart(5)}  ${width} ${hex(meshColour(m))}`,
  );
}

// ---------------------------------------------------------------------------
// seal pinholes
//
// A single layer of the track mesh has small holes wherever another layer sits
// on top of it — painted lines, the start/finish gantry area, kerb edges. Left
// alone those holes stop the ridge walk dead. A morphological closing bridges
// them without fattening the ribbon the way a dilation alone would.
// ---------------------------------------------------------------------------

/** Square-structuring-element dilation: 1 when any neighbour is 1. */
function dilate(m, radius) {
  const out = new Uint8Array(m.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let on = 0;
      for (let dr = -radius; dr <= radius && !on; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        const base = nr * cols;
        for (let dc = -radius; dc <= radius; dc++) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          if (m[base + nc]) {
            on = 1;
            break;
          }
        }
      }
      out[r * cols + c] = on;
    }
  }
  return out;
}

/** Square-structuring-element erosion: 1 only when every neighbour is 1. */
function erode(m, radius) {
  const out = new Uint8Array(m.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let off = 0;
      for (let dr = -radius; dr <= radius && !off; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) {
          off = 1;
          break;
        }
        const base = nr * cols;
        for (let dc = -radius; dc <= radius; dc++) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols || !m[base + nc]) {
            off = 1;
            break;
          }
        }
      }
      out[r * cols + c] = off ? 0 : 1;
    }
  }
  return out;
}

const FILL_R = Number(opt('fill', 2));
let sealed = mask;
if (FILL_R > 0) {
  sealed = erode(dilate(mask, FILL_R), FILL_R);
  let n = 0;
  for (const v of sealed) if (v) n++;
  console.log(
    `  sealing pinholes (radius ${FILL_R} cells = ${FILL_R * CELL} m): ${maskCells.toLocaleString('en-US')} -> ${n.toLocaleString('en-US')} cells`,
  );
}

// ---------------------------------------------------------------------------
// render masks to PNG
//
// Unicode art in a terminal is too coarse to tell a 12 m ribbon from a 40 m
// apron: one character covers five cells. A PNG has one pixel per cell, so what
// a mesh actually looks like can simply be looked at.
// ---------------------------------------------------------------------------

async function writeMaskPng(file, cells, overlay) {
  const buf = Buffer.alloc(cols * rows * 3, 255);
  for (let i = 0; i < cols * rows; i++) {
    if (!cells[i]) continue;
    const o = i * 3;
    buf[o] = 208;
    buf[o + 1] = 208;
    buf[o + 2] = 208;
  }
  if (overlay) {
    for (const [wx, wz] of overlay) {
      const c = Math.round((wx - x0) / CELL);
      const r = Math.round((wz - z0) / CELL);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const o = (nr * cols + nc) * 3;
          buf[o] = 226;
          buf[o + 1] = 26;
          buf[o + 2] = 26;
        }
    }
  }
  await sharp(buf, { raw: { width: cols, height: rows, channels: 3 } }).png().toFile(file);
}

const PNG_MESHES = opt('png-meshes', null);
if (PNG_MESHES) {
  fs.mkdirSync(PNG_MESHES, { recursive: true });
  for (const [name, sq] of footprint) await writeMaskPng(path.join(PNG_MESHES, `${name}.png`), sq, null);
  console.log(`\n  wrote ${footprint.size} per-mesh masks to ${PNG_MESHES}`);
}

// ---------------------------------------------------------------------------
// distance transform: distance from every track cell to the nearest edge
// ---------------------------------------------------------------------------

function distanceTransform(m) {
  const INF = 1e9;
  const d = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) d[i] = m[i] ? INF : 0;
  // two-pass chamfer (3-4 approximation), forward then backward
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!m[i]) continue;
      let v = d[i];
      if (r > 0) v = Math.min(v, d[i - cols] + 1);
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0 && c > 0) v = Math.min(v, d[i - cols - 1] + 1.414);
      if (r > 0 && c < cols - 1) v = Math.min(v, d[i - cols + 1] + 1.414);
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!m[i]) continue;
      let v = d[i];
      if (r < rows - 1) v = Math.min(v, d[i + cols] + 1);
      if (c < cols - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < rows - 1 && c < cols - 1) v = Math.min(v, d[i + cols + 1] + 1.414);
      if (r < rows - 1 && c > 0) v = Math.min(v, d[i + cols - 1] + 1.414);
      d[i] = v;
    }
  }
  return d;
}

let dist = distanceTransform(sealed);
let maxDist = 0;
for (const v of dist) if (v < 1e8 && v > maxDist) maxDist = v;
console.log(
  `  widest clear span ${(maxDist * CELL * 2).toFixed(0)} m (half-width ${(maxDist * CELL).toFixed(1)} m)`,
);

// ---------------------------------------------------------------------------
// centreline from the mesh boundary
//
// The asphalt is a ribbon: a strip of surface with two edges. Its mesh boundary
// is therefore two closed loops — the left and right edge of the circuit — and
// the centreline is exactly the midpoint between them. That beats thinning a
// raster: there is no cell size to choose, no spurs to prune, and no way to
// take a wrong turn at a hairpin, because the answer is read off the geometry
// rather than walked along it.
//
// A boundary edge is one used by exactly one triangle, so shared vertices have
// to be welded first: a mesh stores each corner once per triangle, and without
// welding every single edge would look like a boundary.
// ---------------------------------------------------------------------------

const WELD = 1e-3; // metres; positions closer than this are the same vertex
const verts = [];
const vertKey = new Map();

function vertexOf(p) {
  const key = `${Math.round(p[0] / WELD)},${Math.round(p[1] / WELD)},${Math.round(p[2] / WELD)}`;
  let i = vertKey.get(key);
  if (i === undefined) {
    i = verts.length;
    verts.push(p);
    vertKey.set(key, i);
  }
  return i;
}

const edgeUse = new Map();
forEachPrimitive((name, get, n) => {
  if (!trackNames.has(name)) return;
  for (let i = 0; i + 2 < n; i += 3) {
    const t = [vertexOf(get(i)), vertexOf(get(i + 1)), vertexOf(get(i + 2))];
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
});

const boundaryOf = new Map();
let boundaryEdges = 0;
for (const [key, uses] of edgeUse) {
  if (uses !== 1) continue;
  const [a, b] = key.split(',').map(Number);
  if (!boundaryOf.has(a)) boundaryOf.set(a, []);
  if (!boundaryOf.has(b)) boundaryOf.set(b, []);
  boundaryOf.get(a).push(b);
  boundaryOf.get(b).push(a);
  boundaryEdges++;
}

function loopLength(ring) {
  let L = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = verts[ring[i]];
    const q = verts[ring[(i + 1) % ring.length]];
    L += Math.hypot(q[0] - p[0], q[2] - p[2]);
  }
  return L;
}

/** Chain boundary edges into closed rings of vertex indices. */
function boundaryLoops() {
  const used = new Set();
  const loops = [];
  for (const key of edgeUse.keys()) {
    if (edgeUse.get(key) !== 1 || used.has(key)) continue;
    const [a0, b0] = key.split(',').map(Number);
    used.add(key);
    const ring = [a0, b0];
    let prev = a0;
    let cur = b0;
    for (;;) {
      let next = -1;
      for (const nb of boundaryOf.get(cur) || []) {
        if (nb === prev) continue;
        const k = cur < nb ? `${cur},${nb}` : `${nb},${cur}`;
        if (!used.has(k)) {
          next = nb;
          break;
        }
      }
      if (next < 0) break;
      const k = cur < next ? `${cur},${next}` : `${next},${cur}`;
      used.add(k);
      if (next === a0) break;
      ring.push(next);
      prev = cur;
      cur = next;
    }
    if (ring.length > 2) loops.push(ring);
  }
  return loops;
}

const rings = boundaryLoops().sort((a, b) => loopLength(b) - loopLength(a));

console.log(`\n=== mesh boundary ===`);
console.log(
  `  ${verts.length.toLocaleString('en-US')} welded vertices, ` +
    `${edgeUse.size.toLocaleString('en-US')} unique edges, ${boundaryEdges.toLocaleString('en-US')} used once`,
);
console.log(`  ${rings.length} closed loop(s):`);
for (const [i, ring] of rings.slice(0, 10).entries()) {
  console.log(
    `    #${i}  ${String(ring.length).padStart(7)} points  ${loopLength(ring).toFixed(0).padStart(7)} m`,
  );
}
if (rings.length < 2) {
  console.error(
    `\n  the selected meshes do not form a ribbon — a circuit needs two edge loops.` +
      `\n  try a different --only selection.`,
  );
  process.exit(1);
}

/** Walk a ring at a fixed spacing so the two edges can be paired by index. */
function resampleRing(ring, spacing) {
  const n = ring.length;
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const p = verts[ring[i]];
    const q = verts[ring[(i + 1) % n]];
    const seg = Math.hypot(q[0] - p[0], q[2] - p[2]);
    if (seg < 1e-9) continue;
    for (let t = Math.ceil(acc / spacing) * spacing; t < acc + seg; t += spacing) {
      const u = (t - acc) / seg;
      out.push([p[0] + (q[0] - p[0]) * u, p[2] + (q[2] - p[2]) * u]);
    }
    acc += seg;
  }
  return out;
}

const EDGE_SPACING = Number(opt('edge-spacing', 2));
const edgeA = resampleRing(rings[0], EDGE_SPACING);

// Collect every vertex of every other loop. The far side of the ribbon is not
// necessarily a single loop: a non-manifold vertex where two triangles meet
// splits it in two, which is exactly what happens here. Matching against the
// whole set rather than one chosen loop makes that irrelevant.
const otherPts = [];
for (const ring of rings.slice(1)) for (const vi of ring) otherPts.push(verts[vi]);

const MAXW = Number(opt('max-width', 30));
const MAXW2 = MAXW * MAXW;

// For each point of the outer edge, find the nearest point of the far edge and
// take the midpoint. The distance cap is what keeps a hole or a distant piece
// of scenery from being mistaken for the other side of the track.
const centre = [];
const widths = [];
let unmatched = 0;
for (const [ax, az] of edgeA) {
  let bestD = MAXW2;
  let bx = ax;
  let bz = az;
  let found = false;
  for (const q of otherPts) {
    const dd = (q[0] - ax) ** 2 + (q[2] - az) ** 2;
    if (dd < bestD) {
      bestD = dd;
      bx = q[0];
      bz = q[2];
      found = true;
    }
  }
  if (!found) unmatched++;
  centre.push([(ax + bx) / 2, (az + bz) / 2]);
  widths.push(found ? Math.sqrt(bestD) : 0);
}

let lapHint = 0;
for (let i = 0; i < centre.length; i++) {
  const a = centre[i];
  const b = centre[(i + 1) % centre.length];
  lapHint += Math.hypot(b[0] - a[0], b[1] - a[1]);
}
const sortedW = [...widths].sort((a, b) => a - b);
const wp = (q) => sortedW[Math.min(sortedW.length - 1, Math.floor(sortedW.length * q))];
console.log(
  `\n=== ribbon ===\n  outer edge resampled at ${EDGE_SPACING} m: ${edgeA.length.toLocaleString('en-US')} points`,
);
console.log(
  `  track width p10/p50/p90 ${wp(0.1).toFixed(1)} / ${wp(0.5).toFixed(1)} / ${wp(0.9).toFixed(1)} m` +
    `${unmatched ? `, ${unmatched} point(s) had no opposite edge within ${MAXW} m` : ''}`,
);
console.log(
  `  ${centre.length.toLocaleString('en-US')} raw centreline points, closed length ${lapHint.toFixed(0)} m  (Shanghai International is 5451 m)`,
);

let pts = centre;
// ---------------------------------------------------------------------------
// centreline: snap to maximum clearance, smooth, resample
// ---------------------------------------------------------------------------

/** Nudge each point to the local clearance maximum, to sit on the track centre. */
function snapToCentre(p, radius) {
  return p.map(([px, pz]) => {
    const c = Math.round((px - x0) / CELL);
    const r = Math.round((pz - z0) / CELL);
    let bestScore = -1;
    let bestPt = [px, pz];
    for (let dr = -radius; dr <= radius; dr++)
      for (let dc = -radius; dc <= radius; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const v = dist[nr * cols + nc];
        if (v < 1e8 && v > bestScore) {
          bestScore = v;
          bestPt = [x0 + (nc + 0.5) * CELL, z0 + (nr + 0.5) * CELL];
        }
      }
    return bestPt;
  });
}

function smoothClosed(p, window, passes) {
  let out = p;
  for (let pass = 0; pass < passes; pass++) {
    const n = out.length;
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sz = 0;
      for (let k = -window; k <= window; k++) {
        const j = (((i + k) % n) + n) % n;
        sx += out[j][0];
        sz += out[j][1];
      }
      next[i] = [sx / (2 * window + 1), sz / (2 * window + 1)];
    }
    out = next;
  }
  return out;
}

function resampleClosed(p, spacing) {
  const n = p.length;
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  const out = [];
  const count = Math.floor(total / spacing);
  let idx = 0;
  let acc = 0;
  for (let s = 0; s < count; s++) {
    const target = s * spacing;
    while (idx < n - 1 && acc + seg[idx] < target) {
      acc += seg[idx];
      idx++;
    }
    const a = p[idx];
    const b = p[(idx + 1) % n];
    const t = seg[idx] > 1e-9 ? (target - acc) / seg[idx] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { points: out, length: total };
}

const SNAP = Number(opt('snap', 1));
const SMOOTH = Number(opt('smooth', 3));
const SPACING = Number(opt('spacing', 5));

pts = snapToCentre(pts, SNAP);
pts = smoothClosed(pts, SMOOTH, 3);
const { points: clRaw, length } = resampleClosed(pts, SPACING);
let cl = clRaw;

let clMinX = Infinity, clMaxX = -Infinity, clMinZ = Infinity, clMaxZ = -Infinity;
for (const [px, pz] of cl) {
  clMinX = Math.min(clMinX, px);
  clMaxX = Math.max(clMaxX, px);
  clMinZ = Math.min(clMinZ, pz);
  clMaxZ = Math.max(clMaxZ, pz);
}

console.log(`\n=== centreline ===`);
console.log(`  ${cl.length} points at ${SPACING} m spacing`);
console.log(`  lap length ${length.toFixed(1)} m   (Shanghai International is 5451 m)`);
console.log(`  bbox X ${clMinX.toFixed(0)} .. ${clMaxX.toFixed(0)}  (${(clMaxX - clMinX).toFixed(0)} m)`);
console.log(`       Z ${clMinZ.toFixed(0)} .. ${clMaxZ.toFixed(0)}  (${(clMaxZ - clMinZ).toFixed(0)} m)`);

let corners = 0;
let inCorner = false;
for (let i = 0; i < cl.length; i++) {
  const a = cl[(i - 2 + cl.length) % cl.length];
  const b = cl[i];
  const c = cl[(i + 2) % cl.length];
  const v1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const v2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = v2 - v1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) / (2 * SPACING) > 1 / 60) {
    if (!inCorner) corners++;
    inCorner = true;
  } else inCorner = false;
}
console.log(`  ~${corners} corners detected  (Shanghai has 16)`);

let area2 = 0;
for (let i = 0; i < cl.length; i++) {
  const a = cl[i];
  const b = cl[(i + 1) % cl.length];
  area2 += a[0] * b[1] - b[0] * a[1];
}
console.log(
  `  signed area ${area2 > 0 ? 'positive' : 'negative'} -> ` +
    `${area2 > 0 ? 'clockwise' : 'anticlockwise'} in this map view (+X right, +Z down)`,
);

// ---------------------------------------------------------------------------
// direction
//
// Shanghai runs clockwise. In this map view — +X right, +Z down — a positive
// shoelace sum is clockwise, so a negative one has to be reversed. The model is
// not mirrored (its layout matches the official map up to rotation), so the
// handedness of the view matches the real thing.
// ---------------------------------------------------------------------------

const WANT_CLOCKWISE = !args.includes('--anticlockwise');
if ((area2 > 0) !== WANT_CLOCKWISE) {
  cl.reverse();
  console.log(`  reversed so the lap runs ${WANT_CLOCKWISE ? 'clockwise' : 'anticlockwise'}, as the real circuit does`);
}

// ---------------------------------------------------------------------------
// start / finish
//
// The start line sits on the pit straight, and which straight that is follows
// from the shape of the circuit rather than from any building: the pit straight
// joins the left-hander that ends the lap to the right-hander that begins it.
// Shanghai's back straight is bounded by right-handers at both ends, so the
// sign change picks the pit straight out on its own.
// ---------------------------------------------------------------------------

const headingAt = (i) => {
  const a = cl[(i - 1 + cl.length) % cl.length];
  const b = cl[(i + 1) % cl.length];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};
const angDiff = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// Curvature over a 50 m window. Heading here is atan2(dz, dx), so a rising
// angle is a turn towards +Z — a right-hander as this map is drawn.
const CURV_WIN = Math.max(2, Math.round(50 / SPACING));
const curv = cl.map(
  (_, i) =>
    angDiff(
      headingAt((i - CURV_WIN + cl.length) % cl.length),
      headingAt((i + CURV_WIN) % cl.length),
    ) /
    (2 * CURV_WIN * SPACING),
);

const STRAIGHT_R = Number(opt('straight-radius', 800));
const STRAIGHT_MIN = Number(opt('straight-min', 250));
const isStraight = curv.map((c) => Math.abs(c) < 1 / STRAIGHT_R);

/** Runs of true in a circular flag array, as {start, len} in samples. */
function runsOf(flags) {
  const n = flags.length;
  let i = 0;
  while (i < n && flags[i]) i++;
  if (i === n) return [{ start: 0, len: n }];
  const out = [];
  let run = 0;
  let runStart = 0;
  for (let k = 1; k <= n; k++) {
    const j = (i + k) % n;
    if (flags[j]) {
      if (run === 0) runStart = j;
      run++;
    } else {
      if (run > 0) out.push({ start: runStart, len: run });
      run = 0;
    }
  }
  if (run > 0) out.push({ start: runStart, len: run });
  return out;
}

/** Sign of the tightest corner within `span` samples, walking `dir` from `i`. */
function cornerSign(i, dir, span) {
  let peak = 0;
  for (let k = 0; k < span; k++) {
    const j = (((i + dir * k) % cl.length) + cl.length) % cl.length;
    if (Math.abs(curv[j]) > Math.abs(peak)) peak = curv[j];
  }
  return Math.sign(peak);
}

const CORNER_SPAN = Math.round(250 / SPACING);
const straights = runsOf(isStraight)
  .filter((r) => r.len * SPACING >= STRAIGHT_MIN)
  .map((r) => ({
    ...r,
    lenM: r.len * SPACING,
    before: cornerSign((r.start - 1 + cl.length) % cl.length, -1, CORNER_SPAN),
    after: cornerSign((r.start + r.len) % cl.length, 1, CORNER_SPAN),
  }))
  .sort((a, b) => b.lenM - a.lenM);

const side = (s) => (s > 0 ? 'right' : s < 0 ? 'left ' : 'none ');

// The start/finish line is sometimes modelled, and if it is, that is a far
// better anchor than any guess: it is a thin patch of surface lying across the
// track, wide enough to span it and only a couple of metres long.
const stripes = [];
for (const m of meshList) {
  if (m.tris < 8 || m.tris > 2000 || m.max[1] > 10 || m.min[1] < -12) continue;
  const w = m.max[0] - m.min[0];
  const d = m.max[2] - m.min[2];
  const lo = Math.min(w, d);
  const hi = Math.max(w, d);
  if (lo > 9 || hi < 9 || hi > 34) continue;
  const cx = (m.min[0] + m.max[0]) / 2;
  const cz = (m.min[2] + m.max[2]) / 2;
  let near = Infinity;
  let nearAt = 0;
  for (let i = 0; i < cl.length; i++) {
    const dd = Math.hypot(cl[i][0] - cx, cl[i][1] - cz);
    if (dd < near) {
      near = dd;
      nearAt = i;
    }
  }
  if (near > 25) continue;
  stripes.push({ m, lo, hi, near, nearAt });
}
if (stripes.length) {
  console.log(`\n  thin patches across the track (candidate start lines / grid marks):`);
  stripes.sort((a, b) => a.near - b.near);
  for (const s of stripes.slice(0, 8)) {
    console.log(
      `    ${s.m.name.padEnd(12)} ${s.lo.toFixed(1).padStart(5)} x ${s.hi.toFixed(1).padStart(5)} m  ` +
        `${s.near.toFixed(1).padStart(5)} m from the line, at sample #${s.nearAt}`,
    );
  }
}
const straightSamples = isStraight.filter(Boolean).length;
console.log(
  `\n  straight-radius ${STRAIGHT_R} m: ${straightSamples} of ${cl.length} samples count as straight ` +
    `(${((straightSamples / cl.length) * 100).toFixed(0)}% of the lap, ${(straightSamples * SPACING).toFixed(0)} m)`,
);
// Which of the straights bounded left-then-right is the pit straight is then
// settled by what is built beside it: the pit complex has far more structures
// around it than a mid-lap straight does, so counting the buildings within
// 250 m of each candidate picks it out without knowing where anything is.
const buildings = meshList.filter((m) => {
  if (m.tris < 200 || m.tris > 20000 || m.max[1] <= 6) return false;
  const w = m.max[0] - m.min[0];
  const d = m.max[2] - m.min[2];
  return w < 160 && d < 160;
});
console.log(`\n  ${buildings.length} small tall structures on the site (stands, towers, sheds)`);

for (const s of straights) {
  const mid = cl[(s.start + Math.round(s.len / 2)) % cl.length];
  let n = 0;
  for (const b of buildings) {
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    if (Math.hypot(cx - mid[0], cz - mid[1]) < 250) n++;
  }
  s.buildings = n;
}

console.log(`  straights over ${STRAIGHT_MIN} m, and the corners that bound them:`);
for (const s of straights) {
  const e = cl[(s.start + s.len) % cl.length];
  console.log(
    `    ${s.lenM.toFixed(0).padStart(5)} m  from ${cl[s.start][0].toFixed(0).padStart(6)}, ` +
      `${cl[s.start][1].toFixed(0).padStart(6)}  to ${e[0].toFixed(0).padStart(6)}, ${e[1].toFixed(0).padStart(6)}` +
      `   ${side(s.before)} -> ${side(s.after)}   ${String(s.buildings).padStart(3)} structures within 250 m`,
  );
}

const pit =
  straights
    .filter((s) => s.before < 0 && s.after > 0)
    .sort((a, b) => b.buildings - a.buildings)[0] ??
  straights.find((s) => s.before > 0 && s.after < 0) ??
  straights[0];

if (pit) {
  const frac = Number(opt('start-frac', 0.66));
  const at = (pit.start + Math.round(pit.len * frac)) % cl.length;
  cl = cl.slice(at).concat(cl.slice(0, at));
  console.log(
    `  start/finish on the ${pit.lenM.toFixed(0)} m straight, ${(pit.lenM * frac).toFixed(0)} m into it ` +
      `(${side(pit.before).trim()} into ${side(pit.after).trim()})`,
  );
} else {
  console.log(`  no straight long enough to hold a start line, keeping index 0`);
}
console.log(
  `  start at ${cl[0][0].toFixed(1)}, ${cl[0][1].toFixed(1)} heading ` +
    `${(((Math.atan2(cl[1][1] - cl[0][1], cl[1][0] - cl[0][0]) * 180) / Math.PI + 360) % 360).toFixed(1)} deg`,
);
// ---------------------------------------------------------------------------
// top-down map
//
// Everything laid over everything: the whole model as a footprint, buildings
// tinted so the pit complex can be told from the grandstands, and the centreline
// drawn with direction arrows. This is what settles questions like "which
// straight is the pit straight" and "which way round does the lap run" — both of
// which are invisible in a terminal.
// ---------------------------------------------------------------------------

const MAP_PNG = opt('png', null);
if (MAP_PNG) {
  const buf = Buffer.alloc(cols * rows * 3, 255);
  const px = (c, r, rgb) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return;
    const o = (r * cols + c) * 3;
    buf[o] = rgb[0];
    buf[o + 1] = rgb[1];
    buf[o + 2] = rgb[2];
  };
  const cell = (x, z) => [
    Math.round((x - x0) / CELL),
    Math.round((z - z0) / CELL),
  ];
  const line = (x1, z1, x2, z2, rgb) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const [c, r] = cell(x1 + (x2 - x1) * u, z1 + (z2 - z1) * u);
      for (let dr = 0; dr <= 0; dr++) px(c, r, rgb);
    }
  };

  const ground = new Uint8Array(cols * rows);
  const built = new Uint8Array(cols * rows);

  // A faint 200 m grid, so a position in the render can be read off directly.
  for (let gx = Math.ceil(x0 / 200) * 200; gx < x0 + cols * CELL; gx += 200) {
    const c = Math.round((gx - x0) / CELL);
    for (let r = 0; r < rows; r++) px(c, r, gx % 1000 === 0 ? [214, 234, 214] : [238, 238, 238]);
  }
  for (let gz = Math.ceil(z0 / 200) * 200; gz < z0 + rows * CELL; gz += 200) {
    const r = Math.round((gz - z0) / CELL);
    for (let c = 0; c < cols; c++) px(c, r, gz % 1000 === 0 ? [214, 234, 214] : [238, 238, 238]);
  }
  forEachPrimitive((name, get, n) => {
    const rec = meshes.get(name);
    if (!rec || rec.tris < 200) return;
    const m = rec.max[1] > 6 ? built : ground;
    for (let i = 0; i + 2 < n; i += 3) {
      fillTriangle(m, get(i), get(i + 1), get(i + 2));
    }
  });
  for (let i = 0; i < cols * rows; i++) {
    if (ground[i]) px(i % cols, (i / cols) | 0, [214, 214, 214]);
  }
  for (let i = 0; i < cols * rows; i++) {
    if (built[i]) px(i % cols, (i / cols) | 0, [172, 206, 255]);
  }

  // Paint the biggest flat meshes in their own colours. The racing surface is
  // obvious, but the pit lane and the aprons are not: giving each its own hue
  // is what makes them tellable apart.
  const palette = [
    [110, 200, 110],
    [250, 165, 50],
    [205, 115, 225],
    [70, 200, 220],
    [235, 120, 120],
    [170, 190, 80],
    [110, 140, 235],
    [225, 200, 70],
    [140, 100, 60],
    [90, 90, 90],
  ];
  const flatBig = meshList
    .filter((m) => m.tris >= 2000 && m.tris <= 40000 && m.max[1] <= 6 && m.min[1] > -20)
    .sort((a, b) => b.tris - a.tris)
    .slice(0, palette.length);
  console.log(`\n  map colours (flat meshes, most triangles first):`);
  for (const [i, m] of flatBig.entries()) {
    console.log(
      `    rgb(${palette[i].join(',').padEnd(11)})  ${m.name.padEnd(12)} ${String(m.tris).padStart(6)} tris`,
    );
  }
  for (const [i, m] of flatBig.entries()) {
    const mm = rasteriseMesh(m.name);
    const rgb = palette[i];
    for (let k = 0; k < mm.length; k++) {
      if (mm[k]) px(k % cols, (k / cols) | 0, rgb);
    }
  }

  for (let i = 0; i < cl.length; i++) {
    const a = cl[i];
    const b = cl[(i + 1) % cl.length];
    line(a[0], a[1], b[0], b[1], [220, 30, 30]);
  }

  // Direction arrows with proper heads, so the lap direction is visible at a
  // glance instead of having to be inferred from a row of dots.
  const ARROW = Math.max(20, Math.floor(cl.length / 40));
  const RGB_ARROW = [0, 80, 200];
  for (let i = 0; i < cl.length; i += ARROW) {
    const a = cl[i];
    const b = cl[(i + 7) % cl.length];
    line(a[0], a[1], b[0], b[1], RGB_ARROW);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.8;
    for (const off of [2.5, -2.5]) {
      line(
        b[0],
        b[1],
        b[0] + Math.cos(ang + off) * len,
        b[1] + Math.sin(ang + off) * len,
        RGB_ARROW,
      );
    }
  }

  const startC = cell(cl[0][0], cl[0][1]);
  for (let dr = -6; dr <= 6; dr++)
    for (let dc = -6; dc <= 6; dc++) {
      if (dc * dc + dr * dr > 36) continue;
      px(startC[0] + dc, startC[1] + dr, [0, 150, 0]);
    }

  await sharp(buf, { raw: { width: cols, height: rows, channels: 3 } }).png().toFile(MAP_PNG);
  console.log(`  wrote map to ${MAP_PNG}`);
}

// ---------------------------------------------------------------------------
// overlay
// ---------------------------------------------------------------------------

if (OVERLAY) {
  const PC = Number(opt('cols', 150));
  const PR = Number(opt('rows', 46));
  const art = Array.from({ length: PR }, () => new Array(PC).fill(' '));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i]) continue;
      const ch = dist[i] > 3 ? ':' : '.';
      const pr = Math.min(PR - 1, ((r / rows) * PR) | 0);
      const pc = Math.min(PC - 1, ((c / cols) * PC) | 0);
      if (art[pr][pc] === ' ') art[pr][pc] = ch;
    }
  for (const [px, pz] of cl) {
    const c = Math.min(PC - 1, Math.max(0, Math.floor(((px - x0) / CELL / cols) * PC)));
    const r = Math.min(PR - 1, Math.max(0, Math.floor(((pz - z0) / CELL / rows) * PR)));
    art[r][c] = '#';
  }
  console.log(`\n=== centreline (#) over track surface (. track, : wide/open) ===`);
  console.log(`+${'-'.repeat(PC)}+`);
  for (const row of art) console.log(`|${row.join('')}|`);
  console.log(`+${'-'.repeat(PC)}+`);
  console.log(`X ${x0.toFixed(0)} (left) .. ${(x0 + cols * CELL).toFixed(0)} (right)`);
  console.log(`Z ${z0.toFixed(0)} (top) .. ${(z0 + rows * CELL).toFixed(0)} (bottom)`);
}

if (ANALYZE) process.exit(0);
console.log('\n(report only — build steps not written yet)');

// ---------------------------------------------------------------------------
// build
//
// Two things come out: the visual model and the centreline. The collision
// surface is *not* shipped as a mesh — it is swept along the centreline when
// the track loads. A ribbon of quads is smoother than the source asphalt (long,
// thin triangles at wildly varying heights, which make a raycast vehicle
// rattle), costs a few thousand triangles instead of a million, and cannot
// disagree with the line the lap is timed against.
// ---------------------------------------------------------------------------

const OUT_GLB = path.join(ROOT, 'public', 'assets', 'track.glb');
const OUT_JSON = path.join(ROOT, 'public', 'assets', 'centerline.json');

const countTriangles = () =>
  root
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);

if (!ANALYZE) {
  console.log(`\n=== build ===`);

  // --- track width along the lap --------------------------------------------
  //
  // Half the distance across from the centre to the far edge. Capped, because
  // where the circuit pinches at a hairpin the nearest edge point can belong to
  // the other side of the corner rather than the other side of the road.

  const MAX_HALF = Number(opt('max-half-width', 26));
  const halfWidths = cl.map(([x, z]) => {
    let best = MAX_HALF;
    for (const q of otherPts) {
      const d = Math.hypot(q[0] - x, q[2] - z);
      if (d < best) best = d;
    }
    return best;
  });
  const rankedW = [...halfWidths].sort((a, b) => a - b);
  const wq = (p) => rankedW[Math.min(rankedW.length - 1, Math.floor(rankedW.length * p))];
  console.log(
    `  track width p10/p50/p90 ${(wq(0.1) * 2).toFixed(1)} / ${(wq(0.5) * 2).toFixed(1)} / ` +
      `${(wq(0.9) * 2).toFixed(1)} m`,
  );

  // --- recentre, in plan only -----------------------------------------------
  //
  // The start line becomes the origin. The vertical offset is applied later,
  // once the height of the surface has been measured — and it is measured from
  // the *built* geometry, because decimation and quantization move a surface by
  // a few centimetres each, and the drivable height has to match what is on
  // screen rather than what was in the source file.

  const dx = -cl[0][0];
  const dz = -cl[0][1];

  // --- where the walls are -------------------------------------------------
  //
  // The collision walls have to sit where the model's walls are, or the car
  // stops against thin air. They are the dark, near-vertical meshes, so their
  // vertices go into a coarse grid and each centreline point looks up its
  // nearest one.

  const WALL_RGB = [0x36, 0x3a, 0x3c];
  const wallNames = new Set();
  for (const m of meshList) {
    if (m.vertical / Math.max(1, m.tris) < 0.35) continue;
    const c = meshColour(m);
    if (!c) continue;
    const d =
      Math.abs(c[0] - WALL_RGB[0]) + Math.abs(c[1] - WALL_RGB[1]) + Math.abs(c[2] - WALL_RGB[2]);
    if (d < 90) wallNames.add(m.name);
  }

  const wallPts = [];
  forEachPrimitive((name, get, n) => {
    if (!wallNames.has(name)) return;
    for (let i = 0; i < n; i += 2) {
      const p = get(i);
      if (p[1] < -12 || p[1] > 24) continue;
      wallPts.push(p[0], p[2]);
    }
  });
  console.log(
    `  ${wallNames.size} barrier mesh(es): ${(wallPts.length / 2).toLocaleString('en-US')} wall vertices`,
  );

  const WG = 20;
  const wCols = Math.ceil((cols * CELL) / WG);
  const wRows = Math.ceil((rows * CELL) / WG);
  const wallGrid = new Map();
  for (let i = 0; i < wallPts.length; i += 2) {
    const c = Math.floor((wallPts[i] - x0) / WG);
    const r = Math.floor((wallPts[i + 1] - z0) / WG);
    if (c < 0 || c >= wCols || r < 0 || r >= wRows) continue;
    const k = r * wCols + c;
    let list = wallGrid.get(k);
    if (!list) wallGrid.set(k, (list = []));
    list.push(wallPts[i], wallPts[i + 1]);
  }

  function nearestWall(x, z, cap) {
    const c0 = Math.floor((x - x0) / WG);
    const r0 = Math.floor((z - z0) / WG);
    let best = cap * cap;
    for (let ring = 0; ring * WG <= cap; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (ring > 0 && Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const list = wallGrid.get((r0 + dr) * wCols + (c0 + dc));
          if (!list) continue;
          for (let i = 0; i < list.length; i += 2) {
            const d = (list[i] - x) ** 2 + (list[i + 1] - z) ** 2;
            if (d < best) best = d;
          }
        }
      }
      if (best < cap * cap) return Math.sqrt(best);
    }
    return null;
  }

  const wallOffsets = cl.map(([x, z], i) => {
    const d = nearestWall(x, z, 70);
    return Math.max(halfWidths[i] + 2.5, Math.min(d ?? halfWidths[i] + 12, halfWidths[i] + 45));
  });

  // Barriers come and go around the lap, so the raw offsets step; a wide
  // smoothing pass turns them into the continuous wall the car expects.
  for (let pass = 0; pass < 8; pass++) {
    const w = 14;
    const next = wallOffsets.map((_, i) => {
      let s = 0;
      for (let k = -w; k <= w; k++)
        s += wallOffsets[(i + k + wallOffsets.length) % wallOffsets.length];
      return s / (2 * w + 1);
    });
    for (let i = 0; i < next.length; i++) wallOffsets[i] = next[i];
  }

  const rankedWall = [...wallOffsets].sort((a, b) => a - b);
  console.log(
    `  wall offset from the centreline: ${rankedWall[0].toFixed(1)} .. ` +
      `${rankedWall[rankedWall.length - 1].toFixed(1)} m (median ${rankedWall[rankedWall.length >> 1].toFixed(1)})`,
  );

  // --- the visual model ----------------------------------------------------

  const scene = root.listScenes()[0];
  const sceneChildren = scene.listChildren();
  const holder = doc.createNode('recentred').setTranslation([dx, 0, dz]);
  scene.addChild(holder);
  for (const child of sceneChildren) holder.addChild(child);

  const { weld, simplify, quantize, prune, dedup } = await import('@gltf-transform/functions');
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;

  const before = countTriangles();
  const t1 = Date.now();
  await doc.transform(
    weld(),
    simplify({
      simplifier: MeshoptSimplifier,
      ratio: Number(opt('ratio', 0.09)),
      error: Number(opt('error', 0.05)),
    }),
    weld(),
    prune(),
    dedup(),
    // Positions, normals and UVs as integers. The model carries 2.1 M vertices
    // at 32 bytes each, which is where almost all of the file size is; this
    // cuts that by more than half and is invisible on screen.
    quantize({
      quantizePosition: 16,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeWeight: 12,
    }),
  );
  const after = countTriangles();
  console.log(
    `  decimated ${before.toLocaleString('en-US')} -> ${after.toLocaleString('en-US')} triangles ` +
      `in ${((Date.now() - t1) / 1000).toFixed(0)} s`,
  );

  // --- the height of the paved surface --------------------------------------
  //
  // The surface is not flat and the site around it drops tens of metres, so the
  // height has to be measured rather than assumed. Every paved triangle is
  // bucketed by its footprint and each centreline point is solved against the
  // triangles that actually cover it, taking the top of the stack.

  const HZ = Number(opt('height-cell', 16));
  const gx0 = x0 + dx;
  const gz0 = z0 + dz;
  const hCols = Math.ceil((cols * CELL) / HZ) + 2;
  const hRows = Math.ceil((rows * CELL) / HZ) + 2;

  const tri = [];
  forEachPrimitive((name, get, n) => {
    if (!surfaceNames.has(name)) return;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = get(i);
      const b = get(i + 1);
      const c = get(i + 2);
      tri.push([
        a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
        Math.min(a[0], b[0], c[0]), Math.max(a[0], b[0], c[0]),
        Math.min(a[2], b[2], c[2]), Math.max(a[2], b[2], c[2]),
      ]);
    }
  });

  const buckets = new Map();
  for (let t = 0; t < tri.length; t++) {
    const e = tri[t];
    const c0 = Math.floor((e[9] - gx0) / HZ);
    const c1 = Math.floor((e[10] - gx0) / HZ);
    const r0 = Math.floor((e[11] - gz0) / HZ);
    const r1 = Math.floor((e[12] - gz0) / HZ);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * hCols + c;
        let list = buckets.get(k);
        if (!list) buckets.set(k, (list = []));
        list.push(t);
      }
    }
  }
  console.log(
    `  ${tri.length.toLocaleString('en-US')} paved triangles in the built model to solve the surface against`,
  );

  /** Height of one triangle at (x, z), or null if the point is outside it. */
  function heightIn(e, x, z) {
    const ax = e[0];
    const az = e[2];
    const v0x = e[3] - ax;
    const v0z = e[5] - az;
    const v1x = e[6] - ax;
    const v1z = e[8] - az;
    const den = v0x * v1z - v1x * v0z;
    if (Math.abs(den) < 1e-12) return null;
    const px = x - ax;
    const pz = z - az;
    const v = (px * v1z - v1x * pz) / den;
    const w = (v0x * pz - px * v0z) / den;
    const u = 1 - v - w;
    if (u < -0.005 || v < -0.005 || w < -0.005) return null;
    return u * e[1] + v * e[4] + w * e[7];
  }

  /**
   * Height of the paved surface at (x, z): the top of whatever is stacked on
   * the road there. Anything floating more than 60 cm above the lowest layer
   * is a bridge rather than a surface, and is ignored.
   */
  function surfaceY(x, z) {
    const c = Math.floor((x - gx0) / HZ);
    const r = Math.floor((z - gz0) / HZ);
    for (let ring = 0; ring <= 3; ring++) {
      let lowest = null;
      let best = null;
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (ring > 0 && Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const list = buckets.get((r + dr) * hCols + (c + dc));
          if (!list) continue;
          for (const t of list) {
            const y = heightIn(tri[t], x, z);
            if (y === null) continue;
            if (lowest === null || y < lowest) lowest = y;
            if (best === null || y > best) best = y;
          }
        }
      }
      if (lowest === null) continue;
      return best - lowest <= 0.6 ? best : lowest;
    }
    return null;
  }

  const centre = cl.map(([x, z]) => [x + dx, z + dz]);
  const solved = centre.map(([x, z]) => surfaceY(x, z));

  const gaps = [];
  for (let i = 0; i < solved.length; i++) {
    if (solved[i] !== null) continue;
    gaps.push(i);
    solved[i] = solved[(i - 1 + solved.length) % solved.length] ?? 0;
  }

  const dy = -solved[0];
  const ys = solved.map((y) => y + dy);
  holder.setTranslation([dx, dy, dz]);

  const rankedY = [...ys].sort((a, b) => a - b);
  console.log(
    `  paved surface along the lap: ${rankedY[0].toFixed(2)} .. ${rankedY[rankedY.length - 1].toFixed(2)} m ` +
      `(${(rankedY[rankedY.length - 1] - rankedY[0]).toFixed(1)} m of relief` +
      `${gaps.length ? `, ${gaps.length} point(s) interpolated` : ''})`,
  );
  console.log(
    `  recentred by (${dx.toFixed(1)}, ${dy.toFixed(2)}, ${dz.toFixed(1)}) so the start line sits at the origin`,
  );

  // --- textures ------------------------------------------------------------
  //
  // 93 texture images, and at 2 K they are far more detail than a circuit seen
  // from a car can use. Resize, and re-encode as JPEG where there is no real
  // transparency — JPEG is core glTF, so no EXT_texture_webp is needed and
  // every loader can read it.

  if (!args.includes('--keep-textures')) {
    const sharp = (await import('sharp')).default;
    const maxTex = Number(opt('tex', 1024));
    let saved = 0;
    for (const tex of root.listTextures()) {
      const image = tex.getImage();
      if (!image) continue;
      const src = Buffer.from(image);
      const meta = await sharp(src).metadata();
      if (!meta.width || !meta.height) continue;

      let opaque = !meta.hasAlpha;
      if (meta.hasAlpha) {
        const probe = await sharp(src).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer();
        opaque = probe.every((v, i) => i % 4 !== 3 || v > 250);
      }

      let pipe = sharp(src);
      if (Math.max(meta.width, meta.height) > maxTex) {
        pipe = pipe.resize({ width: maxTex, height: maxTex, fit: 'inside' });
      }
      const out = opaque
        ? await pipe.jpeg({ quality: Number(opt('quality', 82)) }).toBuffer()
        : await pipe.png({ compressionLevel: 9 }).toBuffer();
      if (out.length >= src.length) continue;
      tex.setImage(new Uint8Array(out));
      tex.setMimeType(opaque ? 'image/jpeg' : 'image/png');
      saved += src.length - out.length;
    }
    console.log(`  textures: saved ${(saved / 1048576).toFixed(1)} MB`);
  }

  fs.mkdirSync(path.dirname(OUT_GLB), { recursive: true });
  const t2 = Date.now();
  await new NodeIO()
    .registerExtensions([
      KHRMaterialsSpecular,
      KHRMaterialsClearcoat,
      KHRMaterialsEmissiveStrength,
      KHRTextureTransform,
      KHRMeshQuantization,
    ])
    .write(OUT_GLB, doc);
  console.log(
    `  wrote ${path.relative(ROOT, OUT_GLB)} — ${(fs.statSync(OUT_GLB).size / 1048576).toFixed(1)} MB ` +
      `in ${((Date.now() - t2) / 1000).toFixed(0)} s`,
  );

  // --- the centreline ------------------------------------------------------

  const startHeading = Math.atan2(cl[1][1] - cl[0][1], cl[1][0] - cl[0][0]);
  const payload = {
    name: 'Shanghai International Circuit',
    layout: '2018',
    lapLength: Number(length.toFixed(1)),
    spacing: SPACING,
    direction: WANT_CLOCKWISE ? 'clockwise' : 'anticlockwise',
    startHeading: Number(startHeading.toFixed(4)),
    width: {
      min: Number((wq(0) * 2).toFixed(2)),
      median: Number((wq(0.5) * 2).toFixed(2)),
      max: Number((wq(1) * 2).toFixed(2)),
    },
    // Distance from each point to the barrier the model puts there, so the
    // collision wall can follow the circuit's own walls.
    wall: wallOffsets.map((v) => Number(v.toFixed(2))),
    // [x, y, z, halfWidth] in metres. Index 0 is the start/finish line and the
    // points run in the racing direction.
    points: cl.map(([x, z], i) => [
      Number((x + dx).toFixed(2)),
      Number(ys[i].toFixed(3)),
      Number((z + dz).toFixed(2)),
      Number(halfWidths[i].toFixed(2)),
    ]),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload));
  console.log(
    `  wrote ${path.relative(ROOT, OUT_JSON)} — ${(fs.statSync(OUT_JSON).size / 1024).toFixed(0)} KB, ` +
      `${payload.points.length} points, lap ${payload.lapLength} m ${payload.direction}`,
  );
}
