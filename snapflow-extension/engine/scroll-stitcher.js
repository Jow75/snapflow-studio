/**
 * SnapFlow - Scroll Stitcher & Coordinate Mathematics Engine
 *
 * One compositor serves Full Page and Scrolling Region. For every screenshot the
 * capture engine records which rectangle of that screenshot holds new content and
 * where it belongs in the finished image. Both rectangles are in device pixels
 * (the screenshot's own pixels) and are derived from the scroll position the
 * browser actually reached, never the one requested.
 *
 * Because source and destination are whole device pixels on the same grid, a paint
 * is a 1:1 copy: nothing is resampled, and two paints that share an edge cannot
 * leave a gap or repeat a row. The only resize ever applied is one uniform
 * reduction of the whole canvas when the image is too large for the browser.
 */

class ScrollStitcher {
  /**
   * Chromium refuses canvases above 32,767 px per side or 268,435,456 px in area.
   * Anything larger is scaled down uniformly and reported, never truncated.
   */
  static MAX_CANVAS_DIMENSION = 32000;
  static MAX_CANVAS_AREA = 250000000;

  /**
   * CSS-to-device scale of a screenshot. The reported devicePixelRatio is used when
   * the bitmap agrees with it (it is exact); otherwise the bitmap is trusted.
   * Used where a rectangle the user drew in CSS pixels must be mapped onto a bitmap.
   */
  static resolveScale(reportedDpr, imageWidth, viewportWidthCss) {
    const measured = viewportWidthCss > 0 ? imageWidth / viewportWidthCss : 0;
    if (!(measured > 0)) return reportedDpr > 0 ? reportedDpr : 1;
    if (reportedDpr > 0 && Math.abs(measured - reportedDpr) <= reportedDpr * 0.01) return reportedDpr;
    return measured;
  }

  /**
   * The overlap rule shared by every vertical capture. Given how many rows are
   * already written (`covered`) and a frame showing rows [start, start + length),
   * returns the part of that frame that is new, or null if it adds nothing.
   *
   * @returns {{ offset: number, count: number, dest: number }|null}
   *          offset  rows to skip at the top of the frame (already captured)
   *          count   new rows to copy
   *          dest    row in the finished image where they start
   */
  static newRows(covered, start, length) {
    const from = Math.max(covered, start);
    const count = start + length - from;
    return count > 0 ? { offset: from - start, count, dest: from } : null;
  }

  /**
   * Computes the stitched canvas size, shrinking uniformly when the native size
   * would exceed what the browser can allocate.
   *
   * @param {{width:number,height:number}} plan native size in device px
   * @returns {{ width, height, nativeWidth, nativeHeight, shrink }}
   */
  static planOutput(plan) {
    const nativeWidth = Math.max(1, Math.round(plan.width));
    const nativeHeight = Math.max(1, Math.round(plan.height));

    let shrink = 1;
    const longest = Math.max(nativeWidth, nativeHeight);
    if (longest > this.MAX_CANVAS_DIMENSION) {
      shrink = Math.min(shrink, this.MAX_CANVAS_DIMENSION / longest);
    }
    if (nativeWidth * nativeHeight * shrink * shrink > this.MAX_CANVAS_AREA) {
      shrink = Math.min(shrink, Math.sqrt(this.MAX_CANVAS_AREA / (nativeWidth * nativeHeight)));
    }

    return {
      width: Math.max(1, Math.round(nativeWidth * shrink)),
      height: Math.max(1, Math.round(nativeHeight * shrink)),
      nativeWidth,
      nativeHeight,
      shrink
    };
  }

  /**
   * Converts one paint instruction into source and destination rectangles, clamped
   * to the bitmap and the canvas.
   *
   * @param {Object} paint  { sx, sy, sw, sh } in the screenshot, { dx, dy } in the
   *                        finished image; all device px
   * @param {Object} plan   { originX, originY } subtracted from dx/dy
   * @param {number} shrink uniform reduction of the whole canvas (1 = none)
   * @param {{width:number,height:number}} image  bitmap size
   * @param {{width:number,height:number}} canvas canvas size
   * @returns {Object|null} rectangles, or null when nothing remains after clamping
   */
  static mapPaint(paint, plan, shrink, image, canvas) {
    let sx0 = Math.round(paint.sx);
    let sy0 = Math.round(paint.sy);
    let sx1 = sx0 + Math.round(paint.sw);
    let sy1 = sy0 + Math.round(paint.sh);
    let dx0 = Math.round(paint.dx - (plan.originX || 0));
    let dy0 = Math.round(paint.dy - (plan.originY || 0));

    // Clamp in native pixels, moving source and destination together, so a paint
    // that runs past an edge is cropped rather than squeezed.
    if (sx0 < 0) { dx0 -= sx0; sx0 = 0; }
    if (sy0 < 0) { dy0 -= sy0; sy0 = 0; }
    if (dx0 < 0) { sx0 -= dx0; dx0 = 0; }
    if (dy0 < 0) { sy0 -= dy0; dy0 = 0; }
    sx1 = Math.min(sx1, image.width);
    sy1 = Math.min(sy1, image.height);

    let sw = sx1 - sx0;
    let sh = sy1 - sy0;
    const nativeWidth = canvas.width / shrink;
    const nativeHeight = canvas.height / shrink;
    if (shrink === 1) {
      sw = Math.min(sw, canvas.width - dx0);
      sh = Math.min(sh, canvas.height - dy0);
    } else {
      sw = Math.min(sw, Math.ceil(nativeWidth - dx0));
      sh = Math.min(sh, Math.ceil(nativeHeight - dy0));
    }
    if (sw <= 0 || sh <= 0) return null;

    if (shrink === 1) {
      return { sx: sx0, sy: sy0, sw, sh, dx: dx0, dy: dy0, dw: sw, dh: sh };
    }

    // Reduced canvas: each edge is scaled from its absolute native position, so
    // neighbouring paints still meet on the same canvas row.
    const dx = Math.round(dx0 * shrink);
    const dy = Math.round(dy0 * shrink);
    const dw = Math.min(canvas.width, Math.round((dx0 + sw) * shrink)) - dx;
    const dh = Math.min(canvas.height, Math.round((dy0 + sh) * shrink)) - dy;
    if (dw <= 0 || dh <= 0) return null;
    return { sx: sx0, sy: sy0, sw, sh, dx, dy, dw, dh };
  }

  /**
   * Composites captured frames into one canvas.
   *
   * @param {Array<Object>} frames  [{ paints: [...] }] in capture order
   * @param {Object} plan           { width, height, originX, originY, background } in device px
   * @param {Object} io
   * @param {(index:number) => Promise<{width:number,height:number}>} io.loadFrameImage
   * @param {(image:Object) => void} [io.releaseFrameImage]
   * @param {(done:number, total:number) => void} [io.onProgress]
   * @returns {Promise<{ canvas, shrink, nativeWidth, nativeHeight }>}
   */
  static async composeFrames(frames, plan, io) {
    if (!frames || frames.length === 0) throw new Error('Capture contains no frames.');

    const output = this.planOutput(plan);
    const canvas = document.createElement('canvas');
    canvas.width = output.width;
    canvas.height = output.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width !== output.width || canvas.height !== output.height) {
      throw new Error(`The browser could not allocate a ${output.width} × ${output.height} px canvas.`);
    }
    ctx.fillStyle = plan.background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1:1 copies must stay untouched; only the whole-canvas reduction is filtered.
    ctx.imageSmoothingEnabled = output.shrink !== 1;
    if (output.shrink !== 1) ctx.imageSmoothingQuality = 'high';

    for (let i = 0; i < frames.length; i++) {
      const image = await io.loadFrameImage(i);
      for (const paint of frames[i].paints || []) {
        const r = this.mapPaint(paint, plan, output.shrink, image, canvas);
        if (r) ctx.drawImage(image, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
      }
      if (io.releaseFrameImage) io.releaseFrameImage(image);
      if (io.onProgress) io.onProgress(i + 1, frames.length);
    }

    return {
      canvas,
      shrink: output.shrink,
      nativeWidth: output.nativeWidth,
      nativeHeight: output.nativeHeight
    };
  }

  /**
   * Loads an image from a data URL with a safety timeout.
   */
  static loadImage(dataUrl, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Image decode timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve(img);
        }
      };
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(new Error('Failed to decode captured image.'));
        }
      };
      img.src = dataUrl;
    });
  }

  /**
   * Crops a rectangle out of a viewport screenshot (Selected Area and static elements).
   * The canvas takes the size of the pixels actually available, so a selection that
   * runs past the edge of the screenshot is trimmed instead of stretched.
   *
   * @param {{width:number,height:number}} image decoded screenshot
   * @param {Object} rect { x, y, width, height } in device px
   * @returns {HTMLCanvasElement}
   */
  static cropToCanvas(image, rect) {
    const sx = Math.max(0, Math.min(image.width - 1, Math.round(rect.x)));
    const sy = Math.max(0, Math.min(image.height - 1, Math.round(rect.y)));
    const sw = Math.max(1, Math.min(image.width - sx, Math.round(rect.x + rect.width) - Math.round(rect.x)));
    const sh = Math.max(1, Math.min(image.height - sy, Math.round(rect.y + rect.height) - Math.round(rect.y)));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }
}

/**
 * Sorted set of half-open [start, end) ranges. Tracks which part of a scrollable
 * extent has already been captured so no row is recorded twice and gaps are known.
 */
class IntervalSet {
  constructor() {
    this.ranges = [];
  }

  add(start, end) {
    if (!(end > start)) return;
    const merged = [];
    let s = start;
    let e = end;
    for (const [a, b] of this.ranges) {
      if (b < s || a > e) {
        merged.push([a, b]);
      } else {
        s = Math.min(s, a);
        e = Math.max(e, b);
      }
    }
    merged.push([s, e]);
    merged.sort((p, q) => p[0] - q[0]);
    this.ranges = merged;
  }

  /** Parts of [start, end) that are not covered yet. Slivers below `epsilon` are ignored. */
  missing(start, end, epsilon = 0.5) {
    const gaps = [];
    let cursor = start;
    for (const [a, b] of this.ranges) {
      if (b <= cursor) continue;
      if (a >= end) break;
      if (a > cursor) gaps.push([cursor, Math.min(a, end)]);
      cursor = Math.max(cursor, b);
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push([cursor, end]);
    return gaps.filter(([a, b]) => b - a > epsilon);
  }

  get min() {
    return this.ranges.length ? this.ranges[0][0] : 0;
  }

  get max() {
    return this.ranges.length ? this.ranges[this.ranges.length - 1][1] : 0;
  }

  get total() {
    return this.ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
  }

  get isEmpty() {
    return this.ranges.length === 0;
  }
}

ScrollStitcher.IntervalSet = IntervalSet;

// Export for module/worker or window context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrollStitcher;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ScrollStitcher = ScrollStitcher;
}
