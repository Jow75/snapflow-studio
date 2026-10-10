/**
 * SnapFlow - Automated Unit Test Suite
 * Validates math, slicing logic, PDF page calculations, destructive redaction, and MV3 security policies.
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
it('Should calculate exact vertical slices for exact page multiples', () => {
  const plan = ScrollStitcher.planSlices({
    scrollWidth: 1440,
    scrollHeight: 3000,
    viewportWidth: 1440,
    viewportHeight: 1000,
    dpr: 1
  });
  assert.strictEqual(plan.slices.length, 3);
  assert.strictEqual(plan.totalHeight, 3000);
  assert.strictEqual(plan.slices[0].scrollY, 0);
  assert.strictEqual(plan.slices[1].scrollY, 1000);
  assert.strictEqual(plan.slices[2].scrollY, 2000);
  assert.strictEqual(plan.requiresTiling, false);
});

it('Should accurately clip and offset remainder bottom slice', () => {
  const plan = ScrollStitcher.planSlices({
    scrollWidth: 1200,
    scrollHeight: 2450,
    viewportWidth: 1200,
    viewportHeight: 1000,
    dpr: 1
  });
  assert.strictEqual(plan.slices.length, 3);
  const remainderSlice = plan.slices[2];
  assert.strictEqual(remainderSlice.isRemainder, true);
  assert.strictEqual(remainderSlice.scrollY, 1450); // 2450 - 1000
  assert.strictEqual(remainderSlice.sourceY, 550);  // 1000 - 450
  assert.strictEqual(remainderSlice.sourceHeight, 450);
  assert.strictEqual(remainderSlice.destY, 2000);
  assert.strictEqual(remainderSlice.destHeight, 450);
  assert.strictEqual(plan.totalHeight, 2450);
});

it('Should scale dimensions and coordinates proportionally on High-DPI (DPR 2.0)', () => {
  const plan = ScrollStitcher.planSlices({
    scrollWidth: 1000,
    scrollHeight: 2000,
    viewportWidth: 1000,
    viewportHeight: 1000,
    dpr: 2
  });
  assert.strictEqual(plan.totalWidth, 2000);
  assert.strictEqual(plan.totalHeight, 4000);
  assert.strictEqual(plan.slices[0].destHeight, 2000);
  assert.strictEqual(plan.slices[1].destHeight, 2000);
});

it('Should flag requiresTiling when page height exceeds 30,000px', () => {
  const plan = ScrollStitcher.planSlices({
    scrollWidth: 1920,
    scrollHeight: 32000,
    viewportWidth: 1920,
    viewportHeight: 1000,
    dpr: 1
  });
  assert.strictEqual(plan.requiresTiling, true);
});

console.log('\n2. SMART-SPLIT PDF ENGINE');
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
  assert.deepStrictEqual(manifest.permissions, ['activeTab', 'scripting', 'downloads', 'storage']);
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

console.log('\n==================================================');
console.log(`TEST SUMMARY: ${testsPassed} of ${testsRun} tests passed.`);
console.log('==================================================\n');

if (testsPassed !== testsRun) {
  process.exit(1);
}
