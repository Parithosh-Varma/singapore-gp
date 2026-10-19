/**
 * Drive the running game in headless Chrome and capture screenshots, optionally
 * brightening the scene first so a dark night-time build is still legible.
 *
 * Usage:
 *   node tools/shot-game.mjs [outDir] [--wide] [--bright] [--drive MS] [--all-cams]
 *
 * Needs the dev server running. Set CHROME_PATH if Chrome is not at the default
 * macOS location.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'dist', 'shots');
const wide = args.includes('--wide');
const bright = args.includes('--bright');
const allCams = args.includes('--all-cams');
const driveMs = args.includes('--drive') ? Number(args[args.indexOf('--drive') + 1]) : 0;

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=metal',
    `--window-size=${wide ? 1600 : 1100},${wide ? 900 : 620}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: wide ? 1600 : 1100, height: wide ? 900 : 620 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text());
});

await page.goto(process.env.GAME_URL ?? 'http://localhost:5173/', {
  waitUntil: 'networkidle2',
  timeout: 180000,
});
await page.waitForFunction(() => window.__MARINA_BAY__?.running === true, { timeout: 180000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

if (bright) {
  // Inspection only: this is Stage 5 lighting work, done here so the model is
  // readable in a screenshot.
  await page.evaluate(() => {
    const g = window.__MARINA_BAY__;
    g.renderer.toneMappingExposure = 2.6;
    g.scene.traverse((o) => {
      if (o.isHemisphereLight) o.intensity = 5;
      if (o.isDirectionalLight) o.intensity = Math.max(o.intensity, 3.5);
      if (o.isAmbientLight) o.intensity = 2;
    });
  });
}

const shoot = async (name) => {
  await sleep(700);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`saved ${name}.png  (${await page.evaluate(() => window.__MARINA_BAY__.rig.mode)})`);
};

// KeyC is consumed once per frame, so presses have to straddle frames.
const cycleCamera = async () => {
  await page.keyboard.press('KeyC');
  await sleep(450);
};

if (driveMs > 0) {
  await page.keyboard.down('KeyW');
  await sleep(driveMs);
  await shoot('driving');
  await page.keyboard.up('KeyW');
} else {
  await shoot('chase-idle');
}

if (allCams) {
  await cycleCamera();
  await shoot('hood');
  await cycleCamera();
  await shoot('cockpit');
  await cycleCamera();
}

console.log('mode now:', await page.evaluate(() => window.__MARINA_BAY__.rig.mode));
await browser.close();
