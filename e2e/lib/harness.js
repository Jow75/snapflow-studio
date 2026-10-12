/**
 * Snap Flow Studio - real-browser test harness.
 *
 * Loads the unpacked extension into Chrome, serves the fixture pages from a local
 * HTTP server, and exposes helpers to run a capture and read back what the Studio
 * editor actually rendered and what the export buttons actually downloaded.
 *
 * The extension under test is a temporary copy whose manifest additionally grants
 * host access. Production relies on `activeTab`, which Chrome only grants on a real
 * toolbar click or keyboard shortcut; that gesture cannot be automated, so the copy
 * swaps it for a host permission. No source file other than the manifest differs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// SNAPFLOW_EXTENSION_DIR points the suites at another copy of the extension, such as
// an unpacked release archive, so the package itself can be tested.
const EXTENSION_DIR = process.env.SNAPFLOW_EXTENSION_DIR
  ? path.resolve(process.env.SNAPFLOW_EXTENSION_DIR)
  : path.join(REPO_ROOT, 'snapflow-extension');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const OUTPUT_DIR = process.env.SNAPFLOW_E2E_OUT || path.join(__dirname, '..', 'output');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium executable.');
  return found;
}

function copyDir(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Copies the extension to a temporary folder. With `hostAccess` the copy's manifest
 * also gets a host permission (see the note at the top of this file); without it the
 * copy is exactly what ships, and a capture has to be started through the toolbar
 * action so that Chrome grants `activeTab`.
 */
function buildTestExtension(hostAccess = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-ext-'));
  copyDir(EXTENSION_DIR, dir, ['tests']);
  if (!hostAccess) return dir;
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * Serves fixtures/ plus node_modules/ (for pdf.js). `/slow-image?ms=N&c=RRGGBB`
 * returns a solid PNG after a delay, which is how the lazy-image fixtures are built.
 */
function startServer() {
  const { PNG } = require('pngjs');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/slow-image') {
      const ms = Math.min(5000, parseInt(url.searchParams.get('ms') || '0', 10));
      const hex = url.searchParams.get('c') || '3366cc';
      const png = new PNG({ width: 8, height: 8 });
      for (let i = 0; i < 64; i++) {
        png.data[i * 4] = parseInt(hex.slice(0, 2), 16);
        png.data[i * 4 + 1] = parseInt(hex.slice(2, 4), 16);
        png.data[i * 4 + 2] = parseInt(hex.slice(4, 6), 16);
        png.data[i * 4 + 3] = 255;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        res.end(PNG.sync.write(png));
      }, ms);
      return;
    }

    const base = url.pathname.startsWith('/node_modules/') ? path.join(__dirname, '..') : FIXTURE_DIR;
    const file = path.normalize(path.join(base, decodeURIComponent(url.pathname)));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function launch({ dpr = 1, width = 1280, height = 800, headless = true, hostAccess = true } = {}) {
  const extensionDir = buildTestExtension(hostAccess);
  const { server, origin } = await startServer();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-dl-'));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    pipe: true,
    enableExtensions: [extensionDir],
    defaultViewport: null,
    args: [
      `--window-size=${width},${height}`,
      `--force-device-scale-factor=${dpr}`,
      '--force-color-profile=srgb',
      '--hide-scrollbars=false',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes('service-worker.js'),
    { timeout: 20000 }
  );
  const extensionId = new URL(workerTarget.url()).host;

  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  const ctx = {
    browser,
    origin,
    extensionId,
    extensionDir,
    downloadDir,
    outputDir: OUTPUT_DIR,
    dpr,

    /** The service worker can be restarted by Chrome, so always resolve it fresh. */
    async worker() {
      const target = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().includes(extensionId),
        { timeout: 20000 }
      );
      return target.worker();
    },

    async openFixture(relativeUrl, viewport = { width, height }) {
      const page = await browser.newPage();
      await page.setViewport({ ...viewport, deviceScaleFactor: dpr });
      await page.goto(relativeUrl.startsWith('http') ? relativeUrl : `${origin}/${relativeUrl}`, {
        waitUntil: 'load',
        timeout: 60000
      });
      await page.bringToFront();
      return page;
    },

    async tabIdFor(page) {
      const marker = `sf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await page.evaluate((m) => { document.documentElement.dataset.sfMarker = m; }, marker);
      const worker = await ctx.worker();
      const tabs = await worker.evaluate(() => chrome.tabs.query({}));
      for (const tab of tabs) {
        if (tab.url !== page.url()) continue;
        const [res] = await worker.evaluate(
          (tabId) => chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.documentElement.dataset.sfMarker
          }),
          tab.id
        );
        if (res && res.result === marker) return tab.id;
      }
      throw new Error('Could not resolve tab id for ' + page.url());
    },

    /** Waits for the Studio tab opened by a capture and for its canvas to be populated. */
    async waitForStudio(knownPages = [], timeout = 180000) {
      const target = await browser.waitForTarget(
        (t) => t.type() === 'page' && t.url().includes('studio/viewer.html?id=') &&
          !knownPages.includes(t.url()),
        { timeout }
      );
      const studio = await target.page();
      await studio.waitForFunction(
        () => {
          const title = document.getElementById('doc-title');
          const canvas = document.getElementById('base-canvas');
          if (title && title.textContent.startsWith('Error')) return true;
          return canvas && canvas.width > 0 && document.getElementById('doc-dims').textContent !== '0 × 0 px';
        },
        { timeout }
      );
      await studio.bringToFront();
      const title = await studio.$eval('#doc-title', (el) => el.textContent);
      if (title.startsWith('Error')) throw new Error('Studio failed to load capture: ' + title);
      return studio;
    },

    async readCanvas(studio, name) {
      const dataUrl = await studio.evaluate(() => document.getElementById('base-canvas').toDataURL('image/png'));
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
      if (name) fs.writeFileSync(path.join(OUTPUT_DIR, name), buffer);
      return buffer;
    },

    /** Clicks an export control and returns the file Chrome actually wrote to disk. */
    async download(studio, trigger, timeout = 60000) {
      // Headless Chrome overwrites a file of the same name instead of adding "(1)",
      // so the folder is emptied first and any file that appears is the new one.
      for (const stale of fs.readdirSync(downloadDir)) fs.rmSync(path.join(downloadDir, stale), { force: true });
      await trigger();
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const fresh = fs.readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'));
        if (fresh.length) {
          const file = path.join(downloadDir, fresh[0]);
          let size = -1;
          // Wait for the size to stop changing so a partially flushed file is never read.
          for (let i = 0; i < 50; i++) {
            const now = fs.statSync(file).size;
            if (now === size && now > 0) break;
            size = now;
            await new Promise((r) => setTimeout(r, 100));
          }
          return { file, name: fresh[0], buffer: fs.readFileSync(file) };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('No download appeared within ' + timeout + 'ms');
    },

    async close() {
      await browser.close().catch(() => {});
      server.close();
      fs.rmSync(extensionDir, { recursive: true, force: true });
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  };

  return ctx;
}

module.exports = { launch, OUTPUT_DIR, EXTENSION_DIR, FIXTURE_DIR, REPO_ROOT };
