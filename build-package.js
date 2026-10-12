/**
 * Builds the Snap Flow Studio packages.
 *
 *   node build-package.js                    build both packages into dist/
 *   node build-package.js --next-submission  reserve the next Chrome Web Store number
 *
 * Two version numbers are kept apart on purpose:
 *
 *   development version   snapflow-extension/manifest.json, three parts (1.1.0).
 *                         Changed by hand when development moves on.
 *   submission version    release.json, four parts (1.0.0.0). The number the Chrome
 *                         Web Store sees. Its last part goes up by one per upload.
 *
 * Each build writes two archives and removes older ones from the same folders, so
 * there is never more than one candidate to upload:
 *
 *   dist/development/snapflow-studio-dev-<development version>.zip
 *       manifest exactly as in the source tree. For testing and archiving only.
 *   dist/chrome-web-store/snapflow-studio-webstore-<submission version>.zip
 *       the same files, with the manifest version replaced by the submission
 *       version. This is the only file to upload to the Chrome Web Store.
 *
 * The source manifest is never modified. Chrome compares versions number by number,
 * so 1.1.0 ranks above every 1.0.0.x: uploading the development archive would
 * block all later 1.0.0.x submissions, which is why the two are named and stored
 * separately.
 *
 * Archives contain exactly what the extension needs at runtime (tests are left
 * out), use forward slashes in entry names as the ZIP format requires, and are
 * byte-for-byte reproducible from the same sources. No dependencies.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'snapflow-extension');
const RELEASE_FILE = path.join(ROOT, 'release.json');
const DIST = path.join(ROOT, 'dist');
const EXCLUDE = new Set(['tests']);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Chrome accepts one to four dot-separated integers, each 0-65535, no leading zeros. */
function parseVersion(text, parts) {
  const pieces = String(text).split('.');
  const valid = pieces.length === parts && pieces.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
  if (!valid) throw new Error(`"${text}" is not a valid ${parts}-part version (integers 0-65535 separated by dots).`);
  return pieces.map(Number);
}

/** Orders versions the way Chrome does: number by number, missing parts count as 0. */
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function nextSubmissionVersion(current) {
  const parts = parseVersion(current, 4);
  if (parts[3] >= 65535) throw new Error(`The last part of ${current} cannot go any higher. Raise an earlier part by hand in release.json.`);
  parts[3] += 1;
  return parts.join('.');
}

function readDevelopmentVersion(sourceDir = SOURCE) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  parseVersion(manifest.version, 3);
  return manifest.version;
}

/**
 * Reads release.json and checks that it is usable for a build of `developmentVersion`.
 * @returns {{ submissions: Array, current: { submissionVersion, developmentVersion } }}
 */
function readRelease(developmentVersion, file = RELEASE_FILE) {
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  const submissions = release.submissions;
  if (!Array.isArray(submissions) || !submissions.length) {
    throw new Error('release.json must list at least one submission.');
  }
  submissions.forEach((entry, i) => {
    parseVersion(entry.submissionVersion, 4);
    parseVersion(entry.developmentVersion, 3);
    if (i > 0 && compareVersions(entry.submissionVersion, submissions[i - 1].submissionVersion) <= 0) {
      throw new Error(
        `release.json: ${entry.submissionVersion} does not come after ${submissions[i - 1].submissionVersion}. ` +
        'The Chrome Web Store only accepts a version higher than the one before.'
      );
    }
  });

  const current = submissions[submissions.length - 1];
  if (current.developmentVersion !== developmentVersion) {
    throw new Error(
      `release.json pairs submission ${current.submissionVersion} with development version ` +
      `${current.developmentVersion}, but manifest.json is at ${developmentVersion}.\n` +
      `If ${current.submissionVersion} has already been uploaded, run:  node build-package.js --next-submission\n` +
      'Otherwise correct the last entry in release.json.'
    );
  }
  return { submissions, current };
}

/** Adds the next submission number, paired with the current development version. */
function reserveNextSubmission(file = RELEASE_FILE, sourceDir = SOURCE) {
  const developmentVersion = readDevelopmentVersion(sourceDir);
  const release = JSON.parse(fs.readFileSync(file, 'utf8'));
  const last = release.submissions[release.submissions.length - 1];
  const entry = { submissionVersion: nextSubmissionVersion(last.submissionVersion), developmentVersion };
  release.submissions.push(entry);
  fs.writeFileSync(file, JSON.stringify(release, null, 2) + '\n');
  return entry;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!base && EXCLUDE.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Array<{name:string,data:Buffer}>} entries */
function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp (1 Jan 2026) so the same sources always produce the same archive.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const { name: rel, data } of entries) {
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8);      // deflate
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + compressed.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** Reads an archive back (as written by buildZip) so a build can be checked from the file itself. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('Not a ZIP archive.');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Corrupt ZIP directory.');
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const data = zlib.inflateRawSync(buffer.subarray(dataAt, dataAt + compressedSize));
    if (crc32(data) !== buffer.readUInt32LE(at + 16)) throw new Error(`Checksum mismatch in ${name}.`);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/** The manifest text with only its version changed; everything else stays byte-identical. */
function manifestWithVersion(text, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(text)) throw new Error('manifest.json has no "version" field.');
  const out = text.replace(pattern, `$1${version}$2`);
  if (JSON.parse(out).version !== version) throw new Error('Could not set the manifest version.');
  return out;
}

function collectEntries(sourceDir, manifestVersion) {
  return listFiles(sourceDir).map((name) => {
    let data = fs.readFileSync(path.join(sourceDir, name));
    if (name === 'manifest.json' && manifestVersion) {
      data = Buffer.from(manifestWithVersion(data.toString('utf8'), manifestVersion), 'utf8');
    }
    return { name, data };
  });
}

/** Writes one archive, then re-reads the file and checks what is actually inside it. */
function writePackage(dir, fileName, entries, expectedVersion) {
  fs.mkdirSync(dir, { recursive: true });
  for (const stale of fs.readdirSync(dir)) {
    if (/^snapflow-.*\.zip$/i.test(stale)) fs.rmSync(path.join(dir, stale));
  }
  const target = path.join(dir, fileName);
  fs.writeFileSync(target, buildZip(entries));

  const written = fs.readFileSync(target);
  const packed = readZip(written);
  const manifest = JSON.parse(packed.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  if (manifest.version !== expectedVersion) {
    throw new Error(`${fileName}: packaged manifest says ${manifest.version}, expected ${expectedVersion}.`);
  }
  if (packed.length !== entries.length || packed.some((e) => e.name.includes('\\') || e.name.startsWith('tests/'))) {
    throw new Error(`${fileName}: unexpected entries in the archive.`);
  }
  return {
    file: target,
    version: manifest.version,
    files: packed.map((e) => e.name),
    bytes: written.length,
    sha256: crypto.createHash('sha256').update(written).digest('hex')
  };
}

/**
 * Builds both archives.
 * @param {Object} [options] sourceDir, releaseFile and outDir default to the project's own
 */
function build({ sourceDir = SOURCE, releaseFile = RELEASE_FILE, outDir = DIST } = {}) {
  const developmentVersion = readDevelopmentVersion(sourceDir);
  const { current } = readRelease(developmentVersion, releaseFile);
  const submissionVersion = current.submissionVersion;

  const development = writePackage(
    path.join(outDir, 'development'),
    `snapflow-studio-dev-${developmentVersion}.zip`,
    collectEntries(sourceDir, null),
    developmentVersion
  );
  const store = writePackage(
    path.join(outDir, 'chrome-web-store'),
    `snapflow-studio-webstore-${submissionVersion}.zip`,
    collectEntries(sourceDir, submissionVersion),
    submissionVersion
  );
  return { developmentVersion, submissionVersion, development, store };
}

function main(args) {
  if (args.includes('--next-submission')) {
    const entry = reserveNextSubmission();
    console.log(`release.json: next Chrome Web Store submission is ${entry.submissionVersion} (development version ${entry.developmentVersion}).`);
    console.log('Run "node build-package.js" to build it.');
    return;
  }

  const result = build();
  const describe = (label, pkg) => {
    console.log(`\n${label}`);
    console.log(`  ${path.relative(ROOT, pkg.file)}`);
    console.log(`  manifest version ${pkg.version} · ${pkg.files.length} files · ${(pkg.bytes / 1024).toFixed(1)} KB`);
    console.log(`  sha256 ${pkg.sha256}`);
  };
  console.log(`Snap Flow Studio: development version ${result.developmentVersion}, Chrome Web Store submission ${result.submissionVersion}`);
  describe('Development archive (testing and archiving only, never upload):', result.development);
  describe('Chrome Web Store archive (the file to upload):', result.store);
  console.log('\nContents of both archives:');
  for (const file of result.store.files) console.log('  ' + file);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error('Package build failed: ' + err.message);
    process.exit(1);
  }
}

module.exports = {
  build,
  buildZip,
  readZip,
  readRelease,
  reserveNextSubmission,
  readDevelopmentVersion,
  nextSubmissionVersion,
  compareVersions,
  parseVersion,
  manifestWithVersion,
  listFiles
};
