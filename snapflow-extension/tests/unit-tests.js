/**
 * SnapFlow - Automated Unit Test Suite
 * Validates the public engine surface, PDF page sizes, MV3 security policy and packaged assets.
 * Stitching mathematics is covered by engine-tests.js and export layout by export-tests.js.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const stitcherPath = path.resolve(__dirname, '../engine/scroll-stitcher.js');
const pdfExporterPath = path.resolve(__dirname, '../studio/pdf-exporter.js');
const manifestPath = path.resolve(__dirname, '../manifest.json');

const ScrollStitcher = require(stitcherPath);
const SmartPdfExporter = require(pdfExporterPath);

let testsRun = 0;
let testsPassed = 0;

function it(description, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`  [PASS] ${description}`);
  } catch (err) {
    console.error(`  [FAIL] ${description}`);
    console.error(`         Error: ${err.message}`);
  }
}

console.log('\n==================================================');
console.log('   SNAPFLOW AUTOMATED TEST SUITE');
console.log('==================================================\n');

console.log('1. SCROLL STITCHER & COORDINATE MATHEMATICS');
it('Should expose the frame compositor and its coordinate helpers', () => {
  for (const fn of ['newRows', 'planOutput', 'mapPaint', 'composeFrames', 'cropToCanvas', 'resolveScale']) {
    assert.strictEqual(typeof ScrollStitcher[fn], 'function', `ScrollStitcher.${fn}`);
  }
  assert.strictEqual(typeof ScrollStitcher.IntervalSet, 'function');
});

it('Should keep stitched canvases inside Chromium limits (32,767 px per side, 268,435,456 px area)', () => {
  assert.ok(ScrollStitcher.MAX_CANVAS_DIMENSION <= 32767);
  assert.ok(ScrollStitcher.MAX_CANVAS_AREA <= 268435456);
});

console.log('\n2. PDF ENGINE');
it('Should provide standard A4 and Letter page dimensions in points', () => {
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.a4.width, 595.28);
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.a4.height, 841.89);
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.letter.width, 612.00);
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.letter.height, 792.00);
});

console.log('\n3. SECURITY & MANIFEST V3 COMPLIANCE');
it('Should declare Manifest V3 with minimal least-privilege permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.strictEqual(manifest.host_permissions, undefined);
  assert.strictEqual(manifest.permissions.includes('<all_urls>'), false);
  assert.strictEqual(manifest.permissions.includes('*://*/*'), false);
});

it('Should enforce strict Content Security Policy restricting remote scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest.content_security_policy);
  assert.ok(manifest.content_security_policy.extension_pages.includes("script-src 'self'"));
});

console.log('\n4. FILE & ASSET INTEGRITY');
it('Should verify all declared extension icons exist on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const size of ['16', '48', '128']) {
    const iconRel = manifest.icons[size];
    const fullIconPath = path.resolve(__dirname, '..', iconRel);
    assert.ok(fs.existsSync(fullIconPath), `Icon ${iconRel} must exist`);
  }
});

it('Should ship every script that the service worker, Studio and popup load', () => {
  const root = path.resolve(__dirname, '..');
  const worker = fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8');

  for (const match of worker.matchAll(/importScripts\('([^']+)'\)/g)) {
    assert.ok(fs.existsSync(path.resolve(root, 'background', match[1])), `importScripts ${match[1]}`);
  }
  const injected = [...worker.matchAll(/'(engine\/[a-z-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(injected.includes('engine/content.js') && injected.includes('engine/scroll-stitcher.js'));
  for (const file of injected) assert.ok(fs.existsSync(path.join(root, file)), `injected ${file}`);

  for (const dir of ['studio', 'popup']) {
    const page = dir === 'studio' ? 'viewer.html' : 'popup.html';
    const html = fs.readFileSync(path.join(root, dir, page), 'utf8');
    for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(fs.existsSync(path.resolve(root, dir, match[1])), `${dir} script ${match[1]}`);
    }
  }
});

it('Should not expose extension files to web pages (no web_accessible_resources)', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.web_accessible_resources, undefined);
});

console.log('\n==================================================');
console.log(`TEST SUMMARY: ${testsPassed} of ${testsRun} tests passed.`);
console.log('==================================================\n');

if (testsPassed !== testsRun) {
  process.exit(1);
}
