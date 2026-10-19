/**
 * Render a 4-pane inspection sheet (perspective / front / side / top) of any
 * glTF in `public/`, so geometry, orientation and material work can actually be
 * looked at instead of inferred from numbers.
 *
 * Usage:
 *   node tools/preview-model.mjs <public-url> [out.png] [--size WxH] [--base URL]
 *   node tools/preview-model.mjs /assets/car.glb
 *
 * Needs the dev server running (`npm run dev`). Set CHROME_PATH if Chrome is not
 * at the default macOS location.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const sizeArg = args.includes('--size') ? args[args.indexOf('--size') + 1] : null;
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;

const model = positional[0];
if (!model) {
  console.error('usage: node tools/preview-model.mjs <public-url> [out.png] [--size WxH]');
  process.exit(2);
}

const [vw, vh] = (sizeArg ?? '1280x960').split('x').map(Number);
const out = positional[1] ?? path.join(ROOT, 'dist', 'preview.png');
const base = baseArg ?? process.env.PREVIEW_BASE ?? 'http://localhost:5173';

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=metal',
    `--window-size=${vw},${vh}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: vw, height: vh });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text());
});

const url = `${base}/tools/model-preview.html?model=${encodeURIComponent(model)}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

try {
  // Big models (the 59 MB track) take a while to parse.
  await page.waitForFunction(() => window.__READY__ === true, { timeout: 600000 });
} catch {
  const txt = await page.evaluate(() => document.getElementById('status')?.textContent);
  console.error(`did not become ready. status: ${txt}`);
  await page.screenshot({ path: out });
  await browser.close();
  process.exit(1);
}

const info = await page.evaluate(() => window.__INFO__);
console.log(`size     ${info.size.map((v) => v.toFixed(2)).join(' x ')}`);
console.log(`centre   ${info.center.map((v) => v.toFixed(2)).join(', ')}`);
console.log(`${info.meshes} meshes, ${info.tris.toLocaleString('en-US')} tris, ${info.textures} textures`);
console.log(`parsed in ${(info.loadMs / 1000).toFixed(1)} s`);

await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
