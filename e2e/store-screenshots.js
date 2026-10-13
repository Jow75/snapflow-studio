/**
 * Snap Flow Studio - Chrome Web Store screenshots.
 *
 *   node build-package.js            (project root) build the archive first
 *   node e2e/store-screenshots.js    writes store-submission/assets/
 *
 * Every screenshot is taken from the Chrome Web Store archive itself: the ZIP in
 * dist/chrome-web-store/ is unpacked and loaded with its manifest untouched, so no
 * host permission is added. Captures are started the way a person starts them, by
 * opening the toolbar popup (Chrome's own "trigger extension action" command, which
 * grants `activeTab` exactly as a click does) and clicking a button in it.
 *
 * The pages captured are the invented demonstration pages in fixtures/store/.
 *
 * One image is a composition: Chrome draws the toolbar popup in its own small
 * window, which a page screenshot does not include. 01-product-overview.png is the
 * popup's real screenshot placed, unscaled, over the real screenshot of the page it
 * was opened on. The other four are single unedited screenshots. The promo tiles
 * are artwork (icon and name) and are made separately by promo-tiles.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'build-package.js'));
const ASSETS = path.join(ROOT, 'store-submission', 'assets');
const WIDTH = 1280;
const HEIGHT = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Unpacks the one archive in dist/chrome-web-store/ and returns its folder and version. */
function unpackStoreArchive() {
  const dir = path.join(ROOT, 'dist', 'chrome-web-store');
  const archives = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.zip$/i.test(f)) : [];
  if (archives.length !== 1) throw new Error(`Expected exactly one archive in ${dir}; run "node build-package.js" first.`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-store-'));
  for (const entry of pkg.readZip(fs.readFileSync(path.join(dir, archives[0])))) {
    const file = path.join(out, entry.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
  return { dir: out, archive: archives[0] };
}

/** Writes a screenshot as a 24-bit PNG with no alpha channel, after checking its size. */
function savePng(name, buffer, width = WIDTH, height = HEIGHT) {
  const png = PNG.sync.read(Buffer.from(buffer));
  if (png.width !== width || png.height !== height) {
    throw new Error(`${name}: screenshot is ${png.width} × ${png.height}, expected ${width} × ${height}.`);
  }
  fs.writeFileSync(path.join(ASSETS, name), PNG.sync.write(png, { colorType: 2, inputHasAlpha: true }));
  console.log(`  wrote ${name}`);
}

const dataUrl = (buffer) => 'data:image/png;base64,' + Buffer.from(buffer).toString('base64');

(async () => {
  const store = unpackStoreArchive();
  process.env.SNAPFLOW_EXTENSION_DIR = store.dir;
  const { launch } = require('./lib/harness');
  const act = require('./lib/actions');

  fs.mkdirSync(ASSETS, { recursive: true });
  const ctx = await launch({ hostAccess: false, width: WIDTH, height: HEIGHT });
  let failed = false;

  try {
    const worker = await ctx.worker();
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    console.log(`Loaded ${store.archive}: "${manifest.name}" ${manifest.version}`);
    console.log(`  permissions ${JSON.stringify(manifest.permissions)}, host permissions ${JSON.stringify(manifest.host_permissions || [])}`);
    if (manifest.host_permissions) throw new Error('The archive under test must not carry host permissions.');
    const extension = (await ctx.browser.extensions()).get(ctx.extensionId);

    /** Opens the toolbar popup on a page, as a click on the extension's button does. */
    async function openPopup(page) {
      const before = new Set(ctx.browser.targets());
      await page.bringToFront();
      await page.triggerExtensionAction(extension);
      const target = await ctx.browser.waitForTarget(
        (t) => !before.has(t) && t.url().endsWith('popup/popup.html'),
        { timeout: 20000 }
      );
      const popup = await target.asPage();
      await popup.waitForSelector('#btn-capture-full');
      await sleep(600);
      return popup;
    }

    async function sizeStudio(studio) {
      await studio.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      await studio.bringToFront();
      await sleep(300);
    }

    /** Image pixels of the capture to window coordinates in the Studio. */
    async function toScreen(studio, x, y) {
      return studio.$eval('#overlay-canvas', (el, px, py) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + px * (r.width / el.width), y: r.top + py * (r.height / el.height) };
      }, x, y);
    }

    async function drag(studio, tool, from, to) {
      await studio.click(`.floating-toolbar [data-tool="${tool}"]`);
      const a = await toScreen(studio, from.x, from.y);
      const b = await toScreen(studio, to.x, to.y);
      await studio.mouse.move(a.x, a.y);
      await studio.mouse.down();
      await studio.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await studio.mouse.move(b.x, b.y, { steps: 4 });
      await studio.mouse.up();
      await sleep(250);
    }

    async function clickAt(studio, tool, point) {
      await studio.click(`.floating-toolbar [data-tool="${tool}"]`);
      const p = await toScreen(studio, point.x, point.y);
      await studio.mouse.click(p.x, p.y);
      await sleep(250);
    }

    // -----------------------------------------------------------------------
    // 1. Product overview: the popup, open on a page
    // -----------------------------------------------------------------------
    console.log('\n1. Product overview');
    const guide = await ctx.openFixture('store/guide.html', { width: WIDTH, height: HEIGHT });
    // Where things are on the page, so the editor screenshot can point at them.
    const spots = await guide.evaluate(() => {
      const box = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height };
      };
      return {
        pageHeight: document.documentElement.scrollHeight,
        climb: box('.fact:nth-child(3)'),
        distance: box('.fact:nth-child(1)'),
        lead: box('.lead'),
        stage1: box('.stage h3'),
        days: box('.fact:nth-child(4) b')
      };
    });
    const pageShot = await guide.screenshot();
    const popup = await openPopup(guide);
    const popupSize = await popup.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const popupShot = await popup.screenshot();
    console.log(`  popup opened by the toolbar action: ${popupSize.width} × ${popupSize.height} px`);

    // -----------------------------------------------------------------------
    // 2. Full Page capture, started from the popup
    // -----------------------------------------------------------------------
    console.log('\n2. Full Page capture');
    let known = await act.knownStudioUrls(ctx);
    await popup.click('#btn-capture-full');
    const fullStudio = await ctx.waitForStudio(known, 240000);

    // The overview is composed now: opening another tab earlier would have closed the popup.
    const stage = await ctx.browser.newPage();
    await stage.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    await stage.setContent(`<!DOCTYPE html><html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;position:relative;background:#000">
      <img src="${dataUrl(pageShot)}" style="position:absolute;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px">
      <img src="${dataUrl(popupShot)}" style="position:absolute;right:28px;top:10px;width:${popupSize.width}px;height:${popupSize.height}px;border-radius:10px;box-shadow:0 18px 50px rgba(2,6,23,.55),0 0 0 1px rgba(15,23,42,.35)">
    </body></html>`, { waitUntil: 'load' });
    savePng('01-product-overview.png', await stage.screenshot());
    await stage.close();

    await sizeStudio(fullStudio);
    const fullDims = await act.studioDims(fullStudio);
    console.log(`  page is ${spots.pageHeight} px tall in a ${HEIGHT} px window; capture is ${fullDims.width} × ${fullDims.height} px`);
    if (fullDims.width !== WIDTH || fullDims.height !== spots.pageHeight) throw new Error('The full-page capture does not match the page size.');
    await fullStudio.click('#btn-zoom-fit-screen');
    await sleep(500);
    savePng('02-full-page-capture.png', await fullStudio.screenshot());

    // -----------------------------------------------------------------------
    // 3. Scrolling Region: the picker on a panel that scrolls on its own
    // -----------------------------------------------------------------------
    console.log('\n3. Scrolling Region');
    const workspace = await ctx.openFixture('store/workspace.html', { width: WIDTH, height: HEIGHT });
    const thread = await workspace.$eval('#thread', (el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, clientWidth: el.clientWidth }));
    const regionPopup = await openPopup(workspace);
    await regionPopup.click('#btn-capture-element');
    await sleep(700);
    await workspace.bringToFront();
    const point = await act.centreOf(workspace, '#thread');
    await workspace.mouse.move(point.x - 40, point.y - 30);
    await workspace.mouse.move(point.x, point.y, { steps: 4 });
    await sleep(300);
    await workspace.mouse.click(point.x, point.y);
    await sleep(600);
    savePng('03-scrolling-region.png', await workspace.screenshot());

    known = await act.knownStudioUrls(ctx);
    await workspace.keyboard.press('Enter');
    const regionStudio = await ctx.waitForStudio(known, 240000);
    const regionDims = await act.studioDims(regionStudio);
    console.log(`  thread shows ${thread.clientHeight} px of ${thread.scrollHeight} px; capture is ${regionDims.width} × ${regionDims.height} px`);
    if (regionDims.height !== thread.scrollHeight) throw new Error('The region capture does not cover the whole thread.');
    await regionStudio.close();

    // -----------------------------------------------------------------------
    // 4. Studio editing: real tools, real pointer input
    // -----------------------------------------------------------------------
    console.log('\n4. Studio editor');
    await sizeStudio(fullStudio);
    await fullStudio.click('#btn-zoom-fit-width');
    await sleep(500);

    const l = spots.lead;
    await drag(fullStudio, 'highlight', { x: l.x - 4, y: l.y + 1 }, { x: l.x + 318, y: l.y + l.h / 2 });

    const c = spots.climb;
    await drag(fullStudio, 'rect', { x: c.x - 10, y: c.y - 10 }, { x: c.x + c.w + 10, y: c.y + c.h + 10 });
    await drag(fullStudio, 'arrow', { x: c.x + c.w + 150, y: c.y - 120 }, { x: c.x + c.w - 6, y: c.y - 14 });
    await clickAt(fullStudio, 'text', { x: c.x + c.w + 60, y: c.y - 170 });
    await fullStudio.keyboard.type('Most of the climb is on stage 4');
    await fullStudio.keyboard.press('Enter');
    await sleep(250);
    const d = spots.days;
    await drag(fullStudio, 'pixelate', { x: d.x - 6, y: d.y + 2 }, { x: d.x + 96, y: d.y + d.h - 2 });
    await clickAt(fullStudio, 'step', { x: spots.distance.x - 26, y: spots.distance.y + spots.distance.h / 2 });
    await clickAt(fullStudio, 'step', { x: spots.stage1.x - 34, y: spots.stage1.y + spots.stage1.h / 2 });
    const edits = await fullStudio.evaluate(() => document.getElementById('btn-undo').disabled === false);
    if (!edits) throw new Error('The annotations were not recorded in the edit history.');
    savePng('04-studio-editor.png', await fullStudio.screenshot());

    // -----------------------------------------------------------------------
    // 5. Export: the PDF dialog, and proof that the exports download
    // -----------------------------------------------------------------------
    console.log('\n5. Export options');
    await fullStudio.click('.floating-toolbar [data-tool="select"]');
    await fullStudio.click('#btn-export-pdf');
    await fullStudio.waitForSelector('#pdf-modal:not(.hidden)');
    await sleep(400);
    const summary = await fullStudio.$eval('#pdf-summary', (el) => el.textContent.trim());
    console.log(`  PDF dialog summary: ${summary}`);
    savePng('05-export-options.png', await fullStudio.screenshot());

    const pdf = await ctx.download(fullStudio, () => fullStudio.click('#btn-pdf-confirm'));
    if (pdf.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('The PDF export did not produce a PDF.');
    console.log(`  downloaded ${pdf.name} (${pdf.buffer.length.toLocaleString()} bytes, ${(pdf.buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length} pages)`);
    await sleep(500);
    const image = await ctx.download(fullStudio, () => fullStudio.click('#btn-export-png'));
    const exported = PNG.sync.read(image.buffer);
    console.log(`  downloaded ${image.name} (${exported.width} × ${exported.height} px)`);
    if (exported.width !== fullDims.width || exported.height !== fullDims.height) throw new Error('The PNG export does not match the capture size.');

    // -----------------------------------------------------------------------
    // Validation: re-read every file from disk
    // -----------------------------------------------------------------------
    console.log('\nValidation (read back from disk)');
    const expected = {
      '01-product-overview.png': [WIDTH, HEIGHT],
      '02-full-page-capture.png': [WIDTH, HEIGHT],
      '03-scrolling-region.png': [WIDTH, HEIGHT],
      '04-studio-editor.png': [WIDTH, HEIGHT],
      '05-export-options.png': [WIDTH, HEIGHT]
    };
    for (const [name, [w, hgt]] of Object.entries(expected)) {
      const file = fs.readFileSync(path.join(ASSETS, name));
      const png = PNG.sync.read(file);
      const colorType = file[25]; // IHDR: 2 = RGB without alpha
      const ok = png.width === w && png.height === hgt && colorType === 2 && file[24] === 8;
      console.log(`  ${ok ? 'OK  ' : 'BAD '} ${name}: ${png.width} × ${png.height} px, ${file[24]}-bit, colour type ${colorType}${colorType === 2 ? ' (RGB, no alpha)' : ''}, ${file.length.toLocaleString()} bytes`);
      if (!ok) failed = true;
    }
  } catch (err) {
    failed = true;
    console.error('\nSCREENSHOT RUN FAILED:', err);
  } finally {
    await ctx.close();
    fs.rmSync(store.dir, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else console.log(`\nAll assets written to ${ASSETS}`);
})();
