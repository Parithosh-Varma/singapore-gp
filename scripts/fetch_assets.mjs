#!/usr/bin/env node
/**
 * Downloads the source models from Sketchfab into `assets/raw/`.
 *
 * Files are skipped when they already exist, so re-running is cheap; pass
 * `--force` to fetch them again. Both models are large (the track is ~59 MB), so
 * progress is printed as they stream to disk.
 *
 *   node scripts/fetch_assets.mjs              # fetch whatever is missing
 *   node scripts/fetch_assets.mjs car          # only the car
 *   node scripts/fetch_assets.mjs --force      # re-download everything
 *
 * Requires SKETCHFAB_API_TOKEN in `.env` (see `.env.example`). The token is
 * never printed.
 *
 * LICENSING: both models are third-party, non-commercial-only assets. See the
 * licensing section of README.md before doing anything with the output.
 * Neither `assets/raw/` nor `public/assets/` may be committed or redistributed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAW_DIR = path.join(ROOT, 'assets', 'raw');
const ENV_FILE = path.join(ROOT, '.env');
const API = 'https://api.sketchfab.com/v3/models';

/** Source models, in fetch order. */
const ASSETS = {
  car: {
    uid: 'a463226115184535928ec75660c6571f',
    file: 'car_raw.glb',
    note: '"Ferrari 296 GT3" by vecarz (@heynic), CC BY-NC 4.0',
  },
  track: {
    uid: '4d3365f4de6442a5ae56e8807c518c4f',
    file: 'track_raw.glb',
    note: '"Shanghai International Circuit 2018 layout" by Dave Love SketchFab (@Tyler_Dave), CC BY 4.0',
  },
  // Kept for reference: the original Marina Bay pick turned out to be a whole
  // city district rather than a circuit, so it cannot serve as the track. See
  // the "Track model" section of README.md.
  city: {
    uid: 'e665d831c57546609d4c15287a6107b7',
    file: 'city_raw.glb',
    note: '"Marina Bay Street Circuit" by Dave Love (@Tyler_Dave), CC BY 4.0',
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Read SKETCHFAB_API_TOKEN. A hand-rolled parser rather than
 * `process.loadEnvFile()` because that only exists on Node 20.12+ and this
 * project supports Node 18.
 */
function loadToken() {
  if (process.env.SKETCHFAB_API_TOKEN) return process.env.SKETCHFAB_API_TOKEN.trim();
  if (!fs.existsSync(ENV_FILE)) return null;
  const line = fs
    .readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('SKETCHFAB_API_TOKEN='));
  if (!line) return null;
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * Ask the Sketchfab download API where the GLB lives.
 *
 * The API returns short-lived signed archive URLs. Those URLs reject HEAD with
 * 403, so they can only be fetched with GET — don't "optimise" this into a HEAD
 * probe for the size.
 */
async function resolveGlbUrl(uid, token) {
  const res = await fetch(`${API}/${uid}/download`, {
    headers: { Authorization: `Token ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Sketchfab rejected the API token (HTTP ${res.status}). ` +
        `Check SKETCHFAB_API_TOKEN in .env — it must be a Download API token.`,
    );
  }
  if (res.status === 404) {
    throw new Error(`model ${uid} was not found, or the owner disabled downloads`);
  }
  if (!res.ok) {
    throw new Error(`Sketchfab download API returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const glb = json.glb;
  if (!glb?.url) {
    const offered = Object.keys(json).join(', ') || 'nothing';
    throw new Error(`no glb offered for ${uid} (endpoint offered: ${offered})`);
  }
  return { url: glb.url, size: glb.size ?? 0 };
}

/** Stream a URL to `dest`, showing progress. Writes via `.part` then renames. */
async function download(url, dest, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);

  const expected = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.part`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let seen = 0;
  let lastPaint = 0;
  const started = Date.now();

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        const pct = expected ? ` ${((seen / expected) * 100).toFixed(0)}%` : '';
        const rate = seen / Math.max((now - started) / 1000, 0.001);
        process.stdout.write(
          `\r    ${label}  ${human(seen)}${expected ? ` / ${human(expected)}` : ''}${pct}` +
            `  (${human(rate)}/s)      `,
        );
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  process.stdout.write('\r\x1b[K'); // clear the progress line
  await fsp.rename(tmp, dest);
  return { bytes: seen, seconds: (Date.now() - started) / 1000 };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const wanted = args.filter((a) => !a.startsWith('-'));

  for (const name of wanted) {
    if (!ASSETS[name]) {
      console.error(`Unknown asset "${name}". Known: ${Object.keys(ASSETS).join(', ')}`);
      process.exit(1);
    }
  }
  const names = wanted.length ? wanted : Object.keys(ASSETS);

  const token = loadToken();
  if (!token) {
    console.error(
      'Missing SKETCHFAB_API_TOKEN.\n\n' +
        '  cp .env.example .env\n' +
        '  # then paste your Sketchfab Download API token into .env\n',
    );
    process.exit(1);
  }

  console.log(`\nFetching ${names.length} model(s) into assets/raw/\n`);

  let downloaded = 0;
  let skipped = 0;

  for (const name of names) {
    const asset = ASSETS[name];
    const dest = path.join(RAW_DIR, asset.file);

    if (!force && fs.existsSync(dest)) {
      const { size } = await fsp.stat(dest);
      console.log(`  ${name.padEnd(6)} skip   ${asset.file} already present (${human(size)})`);
      skipped += 1;
      continue;
    }

    console.log(`  ${name.padEnd(6)} fetch  ${asset.file}`);
    console.log(`           ${asset.note}`);

    const { url, size } = await resolveGlbUrl(asset.uid, token);
    const { bytes, seconds } = await download(url, dest, asset.file);

    const mb = bytes / 1024 ** 2;
    console.log(
      `           done   ${human(bytes)} in ${seconds.toFixed(1)}s` +
        `  (${(mb / seconds).toFixed(1)} MB/s)` +
        (size && size !== bytes ? `  [api reported ${human(size)}]` : ''),
    );
    downloaded += 1;
  }

  console.log(
    `\nDone. ${downloaded} downloaded, ${skipped} skipped.` +
      `\nRaw models are gitignored and must not be redistributed — see README.md.\n`,
  );
}

main().catch((err) => {
  console.error(`\n  error: ${err.message}\n`);
  process.exit(1);
});
