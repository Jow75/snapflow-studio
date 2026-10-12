/**
 * Pixel analysis for captured images: decodes the fixture ruler strip back into
 * source row numbers so duplicated, missing, or out-of-order rows are detected exactly.
 */

const { PNG } = require('pngjs');

function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

function pixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/**
 * Reads the vertical ruler at device column `x`. Returns one entry per image row:
 * the decoded source row, or null where the pixel is not ruler-coloured.
 */
function readVerticalRuler(img, x, channel) {
  const rows = [];
  for (let y = 0; y < img.height; y++) {
    const [r, g, b] = pixel(img, x, y);
    rows.push(b === channel ? (r << 8) | g : null);
  }
  return rows;
}

function readHorizontalRuler(img, y, channel) {
  const cols = [];
  for (let x = 0; x < img.width; x++) {
    const [r, g, b] = pixel(img, x, y);
    cols.push(b === channel ? (r << 8) | g : null);
  }
  return cols;
}

/**
 * Checks a decoded ruler sequence against the expected source range.
 *
 * At DPR 1 every source row must appear exactly once. At other ratios each device
 * row maps to floor(deviceRow / scale) (nearest-neighbour), so the sequence must be
 * non-decreasing, never skip a source row, and never repeat one more than
 * ceil(scale) times.
 */
function analyseRuler(decoded, { first = 0, last, scale = 1 }) {
  const problems = [];
  const present = decoded.filter((v) => v !== null);
  const missingPixels = decoded.length - present.length;
  if (missingPixels) problems.push(`${missingPixels} rows are not ruler-coloured`);

  const counts = new Map();
  let backwards = 0;
  let jumps = 0;
  let prev = null;
  for (const v of present) {
    counts.set(v, (counts.get(v) || 0) + 1);
    if (prev !== null) {
      if (v < prev) backwards++;
      if (v > prev + 1) jumps++;
    }
    prev = v;
  }

  const fractional = Math.abs(scale - Math.round(scale)) > 1e-9;
  const maxRepeat = Math.ceil(scale - 1e-9);
  const minRepeat = Math.floor(scale + 1e-9);
  const duplicated = [];
  const missing = [];
  for (let y = first; y <= last; y++) {
    const c = counts.get(y) || 0;
    if (c === 0 && fractional && y === last) continue;
    if (c === 0) missing.push(y);
    else if (c > maxRepeat) duplicated.push(y);
    else if (c < minRepeat && y !== last && y !== first) missing.push(y);
  }
  const outOfRange = present.filter((v) => v < first || v > last).length;

  if (backwards) problems.push(`${backwards} places where the row order goes backwards`);
  if (jumps) problems.push(`${jumps} places where rows are skipped`);
  if (duplicated.length) problems.push(`${duplicated.length} duplicated source rows (first: ${duplicated.slice(0, 5).join(', ')})`);
  if (missing.length) problems.push(`${missing.length} missing source rows (first: ${missing.slice(0, 5).join(', ')})`);
  if (outOfRange) problems.push(`${outOfRange} rows outside the expected range ${first}-${last}`);

  return {
    ok: problems.length === 0,
    problems,
    firstDecoded: present[0],
    lastDecoded: present[present.length - 1],
    rows: decoded.length
  };
}

/** Counts maximal vertical runs where a predicate holds at column x. */
function countRuns(img, x, predicate) {
  let runs = 0;
  let inRun = false;
  const spans = [];
  let start = 0;
  for (let y = 0; y < img.height; y++) {
    const hit = predicate(pixel(img, x, y));
    if (hit && !inRun) { runs++; inRun = true; start = y; }
    if (!hit && inRun) { inRun = false; spans.push([start, y]); }
  }
  if (inRun) spans.push([start, img.height]);
  return { runs, spans };
}

const near = (target, tolerance = 6) => ([r, g, b]) =>
  Math.abs(r - target[0]) <= tolerance && Math.abs(g - target[1]) <= tolerance && Math.abs(b - target[2]) <= tolerance;

module.exports = { decodePng, pixel, readVerticalRuler, readHorizontalRuler, analyseRuler, countRuns, near };
