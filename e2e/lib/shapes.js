/**
 * Geometry measurements on decoded RGBA images, used to prove an export did not
 * stretch its content. The fixture draws a 200 px black square and a 300 px red
 * circle; after any correct export their bounding boxes are still square.
 */

const isBlack = (r, g, b) => r < 30 && g < 30 && b < 30;
const isCircleRed = (r, g, b) => r > 170 && g < 90 && b < 130;
const isPaperWhite = (r, g, b) => r > 245 && g > 245 && b > 245;

/**
 * Bounding box of the pixels matching `predicate`, found by projecting onto each
 * axis and keeping rows/columns with at least `minCount` matches. Projection makes
 * the result immune to stray matching pixels such as anti-aliased text.
 */
function boundingBox(img, predicate, minCount, roi) {
  const x0 = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const y0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const x1 = roi ? Math.min(img.width, Math.ceil(roi.x + roi.w)) : img.width;
  const y1 = roi ? Math.min(img.height, Math.ceil(roi.y + roi.h)) : img.height;
  const cols = new Uint32Array(img.width);
  const rows = new Uint32Array(img.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      if (predicate(img.data[o], img.data[o + 1], img.data[o + 2])) {
        cols[x]++;
        rows[y]++;
      }
    }
  }
  let left = -1, right = -1, top = -1, bottom = -1;
  for (let x = x0; x < x1; x++) if (cols[x] >= minCount) { if (left < 0) left = x; right = x; }
  for (let y = y0; y < y1; y++) if (rows[y] >= minCount) { if (top < 0) top = y; bottom = y; }
  if (left < 0 || top < 0) return null;
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/** Mean absolute difference per channel between two same-sized RGBA images. */
function meanAbsDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
  }
  return sum / (n * 3);
}

/** Largest mean difference of any single row; catches a shifted or repeated band. */
function worstRowDiff(a, b) {
  let worst = 0;
  for (let y = 0; y < a.height; y++) {
    let sum = 0;
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4;
      sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
    }
    worst = Math.max(worst, sum / (a.width * 3));
  }
  return worst;
}

function identical(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Reads the canvas size from a WebP file header (VP8, VP8L or VP8X). */
function webpSize(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('Not a WebP file');
  }
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error('Unknown WebP variant ' + chunk);
}

module.exports = { isBlack, isCircleRed, isPaperWhite, boundingBox, meanAbsDiff, worstRowDiff, identical, webpSize };
