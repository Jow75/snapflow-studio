/**
 * Snap Flow Studio - Chrome Web Store promotional tiles.
 *
 *   node promo-tiles.js      writes store-submission/assets/
 *
 * The two tiles are artwork, not screenshots: the extension's own icon and name on a
 * dark background. Both are needed by the dashboard at exact sizes, so each is
 * rendered in Chrome at that size and saved as a 24-bit PNG with no alpha channel,
 * then read back and checked.
 *
 *   small-promo-tile-440x280.png     440 x 280   (required)
 *   marquee-promo-tile-1400x560.png  1400 x 560  (optional; only used if Google
 *                                                 features the extension)
 *
 * The icon comes from the extension source, so the tiles always match the shipped
 * icon. This needs no extension and starts no capture, so it loads no package.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'store-submission', 'assets');
const ICON = path.join(ROOT, 'snapflow-extension', 'icons', 'icon128.png');

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean).find((p) => fs.existsSync(p));

const dataUrl = (buffer) => 'data:image/png;base64,' + Buffer.from(buffer).toString('base64');

/** Saves a screenshot as a 24-bit PNG with no alpha channel, after checking its size. */
function savePng(name, buffer, width, height) {
  const png = PNG.sync.read(Buffer.from(buffer));
  if (png.width !== width || png.height !== height) {
    throw new Error(`${name}: rendered ${png.width} x ${png.height}, expected ${width} x ${height}.`);
  }
  fs.writeFileSync(path.join(ASSETS, name), PNG.sync.write(png, { colorType: 2, inputHasAlpha: true }));
}

(async () => {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME_PATH.');
  fs.mkdirSync(ASSETS, { recursive: true });
  const icon = dataUrl(fs.readFileSync(ICON));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1'] });
  let failed = false;

  const tiles = [
    {
      name: 'small-promo-tile-440x280.png',
      width: 440,
      height: 280,
      html: `<body style="margin:0;width:440px;height:280px;overflow:hidden;
          background:radial-gradient(circle at 78% 18%,#4338ca 0%,rgba(67,56,202,0) 55%),linear-gradient(140deg,#0b1220 0%,#131c33 60%,#1e1b4b 100%);
          font-family:'Segoe UI',Arial,sans-serif;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
        <img src="${icon}" style="width:84px;height:84px;margin-bottom:14px;border-radius:18px">
        <div style="font-size:33px;font-weight:700;letter-spacing:-.01em">Snap Flow Studio</div>
        <div style="font-size:16px;color:#c7d2fe;margin-top:8px">Full page screenshots and editor</div>
      </body>`
    },
    {
      name: 'marquee-promo-tile-1400x560.png',
      width: 1400,
      height: 560,
      // Icon and wordmark on the left, the four capture modes on the right.
      html: `<body style="margin:0;width:1400px;height:560px;overflow:hidden;
          background:radial-gradient(circle at 82% 22%,#4338ca 0%,rgba(67,56,202,0) 52%),linear-gradient(130deg,#0b1220 0%,#131c33 58%,#1e1b4b 100%);
          font-family:'Segoe UI',Arial,sans-serif;color:#fff;display:flex;align-items:center;gap:72px;padding:0 96px;box-sizing:border-box">
        <div style="flex:none;display:flex;flex-direction:column;align-items:flex-start">
          <img src="${icon}" style="width:132px;height:132px;border-radius:28px;margin-bottom:28px">
          <div style="font-size:64px;font-weight:700;letter-spacing:-.015em;line-height:1.05">Snap&nbsp;Flow<br>Studio</div>
          <div style="font-size:22px;color:#c7d2fe;margin-top:18px">Full page screenshots, annotated and exported &mdash; all in your browser</div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:18px">
          ${[
            ['Full Page', 'Scroll and stitch the whole page'],
            ['Visible Area', 'Just what is on screen'],
            ['Selected Area', 'Drag a rectangle'],
            ['Scrolling Region', 'A panel that scrolls on its own']
          ].map(([t, d]) => `<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:20px 22px">
              <div style="font-size:24px;font-weight:700">${t}</div>
              <div style="font-size:16px;color:#aab6d6;margin-top:6px">${d}</div>
            </div>`).join('')}
        </div>
      </body>`
    }
  ];

  try {
    for (const tile of tiles) {
      const page = await browser.newPage();
      await page.setViewport({ width: tile.width, height: tile.height, deviceScaleFactor: 1 });
      await page.setContent(`<!DOCTYPE html><html>${tile.html}</html>`, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 150));
      savePng(tile.name, await page.screenshot(), tile.width, tile.height);
      await page.close();
    }

    console.log('Promo tiles (read back from disk)');
    for (const tile of tiles) {
      const file = fs.readFileSync(path.join(ASSETS, tile.name));
      const png = PNG.sync.read(file);
      const colorType = file[25]; // IHDR byte 25: 2 = RGB without alpha
      const ok = png.width === tile.width && png.height === tile.height && colorType === 2 && file[24] === 8;
      console.log(`  ${ok ? 'OK  ' : 'BAD '} ${tile.name}: ${png.width} x ${png.height} px, ${file[24]}-bit, colour type ${colorType}${colorType === 2 ? ' (RGB, no alpha)' : ''}, ${file.length.toLocaleString()} bytes`);
      if (!ok) failed = true;
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
  else console.log(`\nWritten to ${ASSETS}`);
})().catch((err) => {
  console.error('Promo tile generation failed:', err);
  process.exit(1);
});
