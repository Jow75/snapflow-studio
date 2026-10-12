/**
 * SnapFlow - Release Packaging Test Suite
 *
 * The development version (manifest.json, three parts) and the Chrome Web Store
 * submission version (release.json, four parts) are separate numbers. These tests
 * build both archives into a temporary folder and read the files back, so what is
 * checked is what would actually be uploaded.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'build-package.js'));

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
    console.error(`         ${err.message}`);
  }
}

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-release-'));
const manifestOf = (file) =>
  JSON.parse(pkg.readZip(fs.readFileSync(file)).find((e) => e.name === 'manifest.json').data.toString('utf8'));

console.log('\n==================================================');
console.log('   SNAPFLOW RELEASE PACKAGING TEST SUITE');
console.log('==================================================\n');

console.log('1. VERSION NUMBERS');

it('Development version in manifest.json has three parts', () => {
  const version = pkg.readDevelopmentVersion();
  assert.strictEqual(version.split('.').length, 3, version);
});

it('release.json pairs the submission being built with the current development version', () => {
  const development = pkg.readDevelopmentVersion();
  const { current } = pkg.readRelease(development);
  assert.strictEqual(current.developmentVersion, development);
  assert.strictEqual(current.submissionVersion.split('.').length, 4, current.submissionVersion);
});

it('First submission is 1.0.0.0, built from development version 1.1.0', () => {
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
  assert.deepStrictEqual(release.submissions[0], { submissionVersion: '1.0.0.0', developmentVersion: '1.1.0' });
});

it('Each later submission raises only the last part: 1.0.0.0, 1.0.0.1, 1.0.0.2', () => {
  assert.strictEqual(pkg.nextSubmissionVersion('1.0.0.0'), '1.0.0.1');
  assert.strictEqual(pkg.nextSubmissionVersion('1.0.0.1'), '1.0.0.2');
  assert.strictEqual(pkg.nextSubmissionVersion('1.0.0.9'), '1.0.0.10');
});

it('Versions are ordered the way Chrome orders them', () => {
  assert.strictEqual(pkg.compareVersions('1.0.0.1', '1.0.0.0'), 1);
  assert.strictEqual(pkg.compareVersions('1.0.0.10', '1.0.0.9'), 1);
  assert.strictEqual(pkg.compareVersions('1.0.0', '1.0.0.0'), 0);
  // The reason the development archive must never be uploaded: it outranks every 1.0.0.x.
  assert.strictEqual(pkg.compareVersions('1.1.0', '1.0.0.65535'), 1);
});

it('Malformed version numbers are rejected', () => {
  assert.throws(() => pkg.parseVersion('1.0.0', 4), /not a valid 4-part/);
  assert.throws(() => pkg.parseVersion('1.0.0.70000', 4), /not a valid/);
  assert.throws(() => pkg.parseVersion('01.0.0.0', 4), /not a valid/);
  assert.throws(() => pkg.parseVersion('1.0.0.0', 3), /not a valid 3-part/);
  assert.throws(() => pkg.nextSubmissionVersion('1.0.0.65535'), /cannot go any higher/);
});

console.log('\n2. BUILT ARCHIVES');

const out = tempDir();
const manifestBefore = sha(fs.readFileSync(path.join(SOURCE, 'manifest.json')));
let result = null;
try {
  result = pkg.build({ outDir: out });
} catch (err) {
  console.error('  Build failed: ' + err.message);
}

it('Both archives are built, in separate folders, each named after its own version', () => {
  assert.ok(result, 'build must succeed');
  assert.strictEqual(
    path.relative(out, result.development.file).replace(/\\/g, '/'),
    `development/snapflow-studio-dev-${result.developmentVersion}.zip`
  );
  assert.strictEqual(
    path.relative(out, result.store.file).replace(/\\/g, '/'),
    `chrome-web-store/snapflow-studio-webstore-${result.submissionVersion}.zip`
  );
});

it('Chrome Web Store archive carries the submission version in its manifest', () => {
  assert.strictEqual(manifestOf(result.store.file).version, result.submissionVersion);
});

it('Development archive carries the development version, exactly as in the source tree', () => {
  const packed = pkg.readZip(fs.readFileSync(result.development.file)).find((e) => e.name === 'manifest.json');
  assert.ok(packed.data.equals(fs.readFileSync(path.join(SOURCE, 'manifest.json'))));
  assert.strictEqual(manifestOf(result.development.file).version, result.developmentVersion);
});

it('Building does not change the source manifest', () => {
  assert.strictEqual(sha(fs.readFileSync(path.join(SOURCE, 'manifest.json'))), manifestBefore);
});

it('The two manifests differ in the version and in nothing else', () => {
  const store = manifestOf(result.store.file);
  const development = manifestOf(result.development.file);
  assert.deepStrictEqual({ ...store, version: null }, { ...development, version: null });
});

it('Every runtime file is packaged byte for byte; tests are left out', () => {
  const expected = pkg.listFiles(SOURCE);
  assert.ok(expected.length >= 17 && !expected.some((f) => f.startsWith('tests/')));
  for (const file of [result.store.file, result.development.file]) {
    const entries = pkg.readZip(fs.readFileSync(file));
    assert.deepStrictEqual(entries.map((e) => e.name), expected);
    for (const entry of entries) {
      assert.ok(!entry.name.includes('\\'), `forward slashes only: ${entry.name}`);
      if (entry.name === 'manifest.json') continue;
      assert.ok(entry.data.equals(fs.readFileSync(path.join(SOURCE, entry.name))), `${entry.name} matches the source`);
    }
  }
});

it('Archive contains everything the manifest, service worker and pages refer to', () => {
  const names = new Set(result.store.files);
  const manifest = manifestOf(result.store.file);
  const needed = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    'studio/viewer.html',
    'engine/content.js',
    'engine/scroll-stitcher.js',
    'engine/end-detector.js',
    'engine/capture-store.js'
  ];
  for (const file of needed) assert.ok(names.has(file), `${file} is in the archive`);
});

it('The same sources always produce the same archive', () => {
  const again = pkg.build({ outDir: tempDir() });
  assert.strictEqual(again.store.sha256, result.store.sha256);
  assert.strictEqual(again.development.sha256, result.development.sha256);
});

it('An older archive in the output folder is replaced, never left beside the new one', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'chrome-web-store'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chrome-web-store', 'snapflow-studio-webstore-0.9.0.0.zip'), 'stale');
  pkg.build({ outDir: dir });
  const zips = fs.readdirSync(path.join(dir, 'chrome-web-store'));
  assert.deepStrictEqual(zips, [`snapflow-studio-webstore-${result.submissionVersion}.zip`]);
});

console.log('\n3. SAFEGUARDS');

it('A build is refused when the development version moved on but the submission number did not', () => {
  const dir = tempDir();
  const releaseFile = path.join(dir, 'release.json');
  fs.writeFileSync(releaseFile, JSON.stringify({ submissions: [{ submissionVersion: '1.0.0.0', developmentVersion: '0.9.0' }] }));
  assert.throws(() => pkg.build({ outDir: dir, releaseFile }), /--next-submission/);
  assert.ok(!fs.existsSync(path.join(dir, 'chrome-web-store')), 'nothing is written');
});

it('Submission numbers that do not increase are refused', () => {
  const dir = tempDir();
  const releaseFile = path.join(dir, 'release.json');
  const development = pkg.readDevelopmentVersion();
  fs.writeFileSync(releaseFile, JSON.stringify({
    submissions: [
      { submissionVersion: '1.0.0.1', developmentVersion: '1.0.0' },
      { submissionVersion: '1.0.0.1', developmentVersion: development }
    ]
  }));
  assert.throws(() => pkg.readRelease(development, releaseFile), /does not come after/);
});

it('Reserving the next submission adds one entry and keeps the history', () => {
  const dir = tempDir();
  const releaseFile = path.join(dir, 'release.json');
  fs.copyFileSync(path.join(ROOT, 'release.json'), releaseFile);
  const before = JSON.parse(fs.readFileSync(releaseFile, 'utf8')).submissions;
  const entry = pkg.reserveNextSubmission(releaseFile);
  const after = JSON.parse(fs.readFileSync(releaseFile, 'utf8')).submissions;
  assert.deepStrictEqual(after.slice(0, -1), before);
  assert.strictEqual(entry.submissionVersion, pkg.nextSubmissionVersion(before[before.length - 1].submissionVersion));
  assert.strictEqual(entry.developmentVersion, pkg.readDevelopmentVersion());
});

it('No extension archive sits in the project root where it could be uploaded by mistake', () => {
  const stray = fs.readdirSync(ROOT).filter((name) => /\.zip$/i.test(name));
  assert.deepStrictEqual(stray, []);
});

console.log('\n==================================================');
console.log(`RELEASE SUITE RESULT: ${testsPassed} of ${testsRun} tests passed.`);
console.log('==================================================\n');

if (testsPassed !== testsRun) process.exit(1);
