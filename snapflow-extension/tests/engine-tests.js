/**
 * SnapFlow - Capture Engine Test Suite
 *
 * Exercises the stitching mathematics with a simulated canvas whose "pixels" carry
 * the identity of the source row (or cell) they came from. A capture is correct
 * when every source row ends up in the output exactly once and in order, which is
 * what these tests assert, rather than checking individual coordinates.
 *
 * The same rules are verified against real screenshots in e2e/.
 */

const assert = require('assert');
const path = require('path');

const ScrollStitcher = require(path.resolve(__dirname, '../engine/scroll-stitcher.js'));
const EndDetector = require(path.resolve(__dirname, '../engine/end-detector.js'));

let testsRun = 0;
let testsPassed = 0;
const queue = [];

function section(name) {
  queue.push({ section: name });
}

function test(title, fn) {
  queue.push({ title, fn });
}

// ---------------------------------------------------------------------------
// Simulated canvas: an Int32 grid; drawImage copies source cells to the canvas.
// ---------------------------------------------------------------------------

class GridCanvas {
  constructor() {
    this._width = 0;
    this._height = 0;
    this.cells = new Int32Array(0);
    this.draws = [];
  }
  get width() { return this._width; }
  set width(v) { this._width = v; this.cells = new Int32Array(this._width * this._height).fill(-1); }
  get height() { return this._height; }
  set height(v) { this._height = v; this.cells = new Int32Array(this._width * this._height).fill(-1); }
  getContext() {
    const canvas = this;
    return {
      fillStyle: '#fff',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
      fillRect() {},
      drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
        canvas.draws.push({ sx, sy, sw, sh, dx, dy, dw, dh });
        for (let y = 0; y < dh; y++) {
          const srcY = sy + Math.min(sh - 1, Math.floor((y * sh) / dh));
          for (let x = 0; x < dw; x++) {
            const srcX = sx + Math.min(sw - 1, Math.floor((x * sw) / dw));
            canvas.cells[(dy + y) * canvas._width + dx + x] = image.cells[srcY * image.width + srcX];
          }
        }
      }
    };
  }
}

function withGridCanvas(fn) {
  const original = global.document;
  global.document = { createElement: () => new GridCanvas() };
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.document = original; });
}

/** A screenshot of a document scrolled to device row `start`: cell value = document row. */
function documentFrame(start, width, height) {
  const cells = new Int32Array(width * height);
  for (let y = 0; y < height; y++) cells.fill(start + y, y * width, (y + 1) * width);
  return { width, height, cells };
}

/**
 * Simulates the full-page loop of the content script against a browser that
 * clamps scrolling at the bottom and may stop `lag(i)` rows short of the request.
 */
function simulateDocumentCapture({ total, shot, width = 3, lag = () => 0, origin = 0 }) {
  const frames = [];
  const images = [];
  const maxScroll = Math.max(0, total - shot);
  let covered = origin;
  let requested = origin;
  for (let i = 0; i < 500; i++) {
    const actual = Math.max(0, Math.min(maxScroll, requested - (i === 0 ? 0 : lag(i))));
    if (i > 0 && actual + shot <= covered) break;
    const fresh = ScrollStitcher.newRows(covered, actual, shot);
    frames.push({ paints: fresh ? [{ sx: 0, sy: fresh.offset, sw: width, sh: fresh.count, dx: 0, dy: fresh.dest }] : [] });
    images.push(documentFrame(actual, width, shot));
    covered = actual + shot;
    if (actual >= maxScroll) break;
    requested = covered;
  }
  const plan = { width, height: covered - origin, originX: 0, originY: origin };
  return { frames, images, plan };
}

async function compose(frames, images, plan) {
  return ScrollStitcher.composeFrames(frames, plan, { loadFrameImage: async (i) => images[i] });
}

/** Asserts column 0 of the canvas holds rows first..first+height-1, each exactly once. */
function assertRowsInOrder(canvas, first = 0) {
  for (let y = 0; y < canvas.height; y++) {
    const value = canvas.cells[y * canvas.width];
    if (value !== first + y) {
      assert.fail(`canvas row ${y} holds source row ${value}, expected ${first + y}`);
    }
  }
}

// ---------------------------------------------------------------------------
section('1. OVERLAP RULE');
// ---------------------------------------------------------------------------

test('A frame entirely below what is covered contributes all of its rows', () => {
  assert.deepStrictEqual(ScrollStitcher.newRows(800, 800, 800), { offset: 0, count: 800, dest: 800 });
});

test('A frame that overlaps covered rows contributes only the new ones', () => {
  assert.deepStrictEqual(ScrollStitcher.newRows(800, 650, 800), { offset: 150, count: 650, dest: 800 });
});

test('A frame with nothing new contributes nothing', () => {
  assert.strictEqual(ScrollStitcher.newRows(1450, 650, 800), null);
  assert.strictEqual(ScrollStitcher.newRows(2000, 0, 800), null);
});

// ---------------------------------------------------------------------------
section('2. FULL PAGE: EVERY ROW ONCE, AT EVERY DEVICE PIXEL RATIO');
// ---------------------------------------------------------------------------

for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) {
  test(`3450 × 900 px CSS page at DPR ${dpr}: output is exactly the document`, () =>
    withGridCanvas(async () => {
      const total = Math.round(3450 * dpr);
      const shot = Math.round(900 * dpr);
      const { frames, images, plan } = simulateDocumentCapture({ total, shot });
      const { canvas, shrink } = await compose(frames, images, plan);
      assert.strictEqual(shrink, 1);
      assert.strictEqual(canvas.height, total);
      assertRowsInOrder(canvas);
      // 1:1 copies only: nothing may be resampled.
      for (const draw of canvas.draws) {
        assert.strictEqual(draw.sw, draw.dw);
        assert.strictEqual(draw.sh, draw.dh);
      }
    }));
}

test('1-pixel remainder: the last frame contributes exactly one row', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 2001, shot: 1000 });
    assert.strictEqual(frames.length, 3);
    assert.deepStrictEqual(frames[2].paints[0], { sx: 0, sy: 999, sw: 3, sh: 1, dx: 0, dy: 2000 });
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.height, 2001);
    assertRowsInOrder(canvas);
  }));

test('Remainder of (viewport - 1) rows', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 1999, shot: 1000 });
    assert.strictEqual(frames.length, 2);
    assert.deepStrictEqual(frames[1].paints[0], { sx: 0, sy: 1, sw: 3, sh: 999, dx: 0, dy: 1000 });
    const { canvas } = await compose(frames, images, plan);
    assertRowsInOrder(canvas);
  }));

test('Height an exact multiple of the viewport: no empty trailing frame', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 3000, shot: 1000 });
    assert.strictEqual(frames.length, 3);
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.height, 3000);
    assertRowsInOrder(canvas);
  }));

test('Page shorter than the viewport: a single frame', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 800, shot: 800 });
    assert.strictEqual(frames.length, 1);
    const { canvas } = await compose(frames, images, plan);
    assertRowsInOrder(canvas);
  }));

test('Browser stops short of every requested offset: overlap is discarded, nothing repeats', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({
      total: 9137,
      shot: 811,
      lag: (i) => (i * 37) % 149
    });
    assert.ok(frames.length > 11, 'lag must have cost extra frames');
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.height, 9137);
    assertRowsInOrder(canvas);
  }));

test('Capture that cannot start at row 0 keeps its own origin', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 5000, shot: 700, origin: 240 });
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.height, 5000 - 240);
    assertRowsInOrder(canvas, 240);
  }));

// ---------------------------------------------------------------------------
section('3. CANVAS LIMITS: SCALE DOWN UNIFORMLY, NEVER TRUNCATE');
// ---------------------------------------------------------------------------

test('An image inside the limits is not scaled', () => {
  const out = ScrollStitcher.planOutput({ width: 2560, height: 30000 });
  assert.deepStrictEqual(out, { width: 2560, height: 30000, nativeWidth: 2560, nativeHeight: 30000, shrink: 1 });
});

test('A 1920 × 40,000 px image is reduced to fit, with its proportions kept', () => {
  const out = ScrollStitcher.planOutput({ width: 1920, height: 40000 });
  assert.strictEqual(out.height, ScrollStitcher.MAX_CANVAS_DIMENSION);
  assert.ok(out.shrink < 1);
  assert.ok(Math.abs(out.width / out.height - 1920 / 40000) < 1e-4, 'aspect ratio must be preserved');
  assert.strictEqual(out.nativeHeight, 40000);
});

test('The area limit applies as well as the per-side limit', () => {
  const out = ScrollStitcher.planOutput({ width: 20000, height: 20000 });
  assert.ok(out.width * out.height <= ScrollStitcher.MAX_CANVAS_AREA);
  assert.strictEqual(out.width, out.height);
});

test('Reduced canvas: neighbouring paints still meet with no gap and no overlap', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateDocumentCapture({ total: 70000, shot: 1300 });
    const { canvas, shrink } = await compose(frames, images, plan);
    assert.ok(shrink < 1);
    assert.strictEqual(canvas.height, ScrollStitcher.MAX_CANVAS_DIMENSION);
    let cursor = 0;
    for (const draw of canvas.draws) {
      assert.strictEqual(draw.dy, cursor, 'paint must start where the previous one ended');
      cursor = draw.dy + draw.dh;
    }
    assert.strictEqual(cursor, canvas.height, 'paints must reach the bottom of the canvas');
    // Rows remain in order after the reduction.
    for (let y = 1; y < canvas.height; y++) {
      assert.ok(canvas.cells[y * canvas.width] >= canvas.cells[(y - 1) * canvas.width]);
    }
    assert.strictEqual(canvas.cells[(canvas.height - 1) * canvas.width] >= 69990, true);
  }));

// ---------------------------------------------------------------------------
section('4. PAINT CLAMPING: CROP, NEVER STRETCH');
// ---------------------------------------------------------------------------

test('A paint that runs past the bottom of the screenshot is shortened on both sides', () => {
  const r = ScrollStitcher.mapPaint(
    { sx: 0, sy: 700, sw: 100, sh: 200, dx: 0, dy: 0 },
    {}, 1, { width: 100, height: 800 }, { width: 100, height: 500 }
  );
  assert.deepStrictEqual(r, { sx: 0, sy: 700, sw: 100, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 });
});

test('A paint that runs past the canvas is shortened on both sides', () => {
  const r = ScrollStitcher.mapPaint(
    { sx: 10, sy: 0, sw: 300, sh: 400, dx: 50, dy: 450 },
    {}, 1, { width: 400, height: 400 }, { width: 200, height: 500 }
  );
  assert.deepStrictEqual(r, { sx: 10, sy: 0, sw: 150, sh: 50, dx: 50, dy: 450, dw: 150, dh: 50 });
});

test('A paint starting before the origin drops the same rows from source and destination', () => {
  const r = ScrollStitcher.mapPaint(
    { sx: 0, sy: 0, sw: 100, sh: 300, dx: 0, dy: 90 },
    { originY: 200 }, 1, { width: 100, height: 300 }, { width: 100, height: 1000 }
  );
  assert.deepStrictEqual(r, { sx: 0, sy: 110, sw: 100, sh: 190, dx: 0, dy: 0, dw: 100, dh: 190 });
});

test('A paint entirely outside the canvas is dropped', () => {
  const r = ScrollStitcher.mapPaint(
    { sx: 0, sy: 0, sw: 100, sh: 100, dx: 0, dy: 600 },
    {}, 1, { width: 100, height: 100 }, { width: 100, height: 500 }
  );
  assert.strictEqual(r, null);
});

// ---------------------------------------------------------------------------
section('5. SCROLLING REGION: TWO-AXIS TRAVERSAL');
// ---------------------------------------------------------------------------

/**
 * Screenshot of a viewport containing a scroll container. Cells inside the
 * container's clip hold the content cell id (contentY * 1000 + contentX); cells
 * outside hold -7 (page chrome that must never reach the output).
 */
function regionFrame({ viewW, viewH, clip, scrollX, scrollY }) {
  const cells = new Int32Array(viewW * viewH).fill(-7);
  for (let y = 0; y < clip.h; y++) {
    for (let x = 0; x < clip.w; x++) {
      cells[(clip.y + y) * viewW + clip.x + x] = (scrollY + y) * 1000 + scrollX + x;
    }
  }
  return { width: viewW, height: viewH, cells };
}

/** Mirrors runRegionAuto(): row by row, column by column, using reached offsets. */
function simulateRegionCapture({ contentW, contentH, clip, viewW, viewH, scanX = true }) {
  const frames = [];
  const images = [];
  const maxX = contentW - clip.w;
  const maxY = contentH - clip.h;
  let y = 0;
  let width = 0;
  for (let guard = 0; guard < 500; guard++) {
    const scrollY = Math.min(y, maxY);
    if (scrollY + clip.h <= y) break;
    let x = 0;
    let rowEnd = Infinity;
    for (let inner = 0; inner < 500; inner++) {
      const scrollX = scanX ? Math.min(x, maxX) : 0;
      const right = scrollX + clip.w;
      if (right <= x) break;
      frames.push({
        paints: [{
          sx: clip.x + (x - scrollX),
          sy: clip.y + (y - scrollY),
          sw: right - x,
          sh: scrollY + clip.h - y,
          dx: x,
          dy: y
        }]
      });
      images.push(regionFrame({ viewW, viewH, clip, scrollX, scrollY }));
      width = Math.max(width, right);
      rowEnd = Math.min(rowEnd, scrollY + clip.h);
      x = right;
      if (!scanX) break;
    }
    y = rowEnd;
  }
  return { frames, images, plan: { width, height: y, originX: 0, originY: 0 } };
}

test('Region scrolling both ways: every content cell once, no page chrome', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateRegionCapture({
      contentW: 137, contentH: 211, clip: { x: 9, y: 6, w: 31, h: 23 }, viewW: 60, viewH: 40
    });
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.width, 137);
    assert.strictEqual(canvas.height, 211);
    for (let y = 0; y < 211; y++) {
      for (let x = 0; x < 137; x++) {
        assert.strictEqual(canvas.cells[y * 137 + x], y * 1000 + x, `cell ${x},${y}`);
      }
    }
  }));

test('Vertical-only region: width is the visible width, height the full extent', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateRegionCapture({
      contentW: 31, contentH: 500, clip: { x: 4, y: 8, w: 31, h: 37 }, viewW: 50, viewH: 60, scanX: false
    });
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.width, 31);
    assert.strictEqual(canvas.height, 500);
    for (let y = 0; y < 500; y++) assert.strictEqual(canvas.cells[y * 31], y * 1000);
    assert.strictEqual(canvas.cells.includes(-7), false, 'page chrome leaked into the region capture');
  }));

test('Region with no overflow: one frame, exactly the clip', () =>
  withGridCanvas(async () => {
    const { frames, images, plan } = simulateRegionCapture({
      contentW: 20, contentH: 15, clip: { x: 3, y: 3, w: 20, h: 15 }, viewW: 40, viewH: 30
    });
    assert.strictEqual(frames.length, 1);
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.width, 20);
    assert.strictEqual(canvas.height, 15);
  }));

// ---------------------------------------------------------------------------
section('6. MANUAL CAPTURE: COVERAGE TRACKING');
// ---------------------------------------------------------------------------

test('IntervalSet merges touching and overlapping ranges', () => {
  const set = new ScrollStitcher.IntervalSet();
  set.add(100, 200);
  set.add(300, 400);
  set.add(200, 300);
  set.add(350, 450);
  assert.deepStrictEqual(set.ranges, [[100, 450]]);
  assert.strictEqual(set.total, 350);
  assert.strictEqual(set.min, 100);
  assert.strictEqual(set.max, 450);
});

test('IntervalSet reports exactly the uncovered parts of a range', () => {
  const set = new ScrollStitcher.IntervalSet();
  set.add(0, 100);
  set.add(250, 400);
  assert.deepStrictEqual(set.missing(50, 500), [[100, 250], [400, 500]]);
  assert.deepStrictEqual(set.missing(0, 100), []);
  assert.deepStrictEqual(set.missing(260, 390), []);
  assert.deepStrictEqual(set.missing(set.min, set.max), [[100, 250]]);
});

test('Scrolling down, back up, and jumping ahead records each row once; gaps are then filled', () =>
  withGridCanvas(async () => {
    const clipH = 300;
    const covered = new ScrollStitcher.IntervalSet();
    const frames = [];
    const images = [];
    const record = (scrollY, limit) => {
      const range = limit
        ? [Math.max(limit[0], scrollY), Math.min(limit[1], scrollY + clipH)]
        : [scrollY, scrollY + clipH];
      const gaps = covered.missing(range[0], range[1]);
      if (!gaps.length) return;
      frames.push({ paints: gaps.map(([a, b]) => ({ sx: 0, sy: a - scrollY, sw: 3, sh: b - a, dx: 0, dy: a })) });
      images.push(documentFrame(scrollY, 3, clipH));
      gaps.forEach(([a, b]) => covered.add(a, b));
    };

    // The user starts part-way down, scrolls on, goes back up, then jumps far ahead.
    for (const position of [400, 550, 700, 480, 400, 1500, 1650]) record(position);
    assert.deepStrictEqual(covered.missing(covered.min, covered.max), [[1000, 1500]]);

    // Finish: the engine fills what was skipped.
    for (let guard = 0; guard < 20; guard++) {
      const gaps = covered.missing(covered.min, covered.max);
      if (!gaps.length) break;
      record(gaps[0][0], gaps[0]);
    }
    assert.deepStrictEqual(covered.ranges, [[400, 1950]]);

    const plan = { width: 3, height: covered.max - covered.min, originX: 0, originY: covered.min };
    const { canvas } = await compose(frames, images, plan);
    assert.strictEqual(canvas.height, 1550);
    assertRowsInOrder(canvas, 400);
  }));

// ---------------------------------------------------------------------------
section('7. SELECTED AREA');
// ---------------------------------------------------------------------------

test('A selection inside the screenshot is cropped at its own size', () =>
  withGridCanvas(() => {
    const image = documentFrame(0, 400, 300);
    const canvas = ScrollStitcher.cropToCanvas(image, { x: 50, y: 60, width: 220, height: 120 });
    assert.strictEqual(canvas.width, 220);
    assert.strictEqual(canvas.height, 120);
    assert.strictEqual(canvas.cells[0], 60);
    assert.deepStrictEqual(canvas.draws[0], { sx: 50, sy: 60, sw: 220, sh: 120, dx: 0, dy: 0, dw: 220, dh: 120 });
  }));

test('A selection running past the edge is trimmed, not stretched to its requested size', () =>
  withGridCanvas(() => {
    const image = documentFrame(0, 400, 300);
    const canvas = ScrollStitcher.cropToCanvas(image, { x: 300, y: 250, width: 220, height: 120 });
    assert.strictEqual(canvas.width, 100);
    assert.strictEqual(canvas.height, 50);
    const draw = canvas.draws[0];
    assert.strictEqual(draw.sw, draw.dw);
    assert.strictEqual(draw.sh, draw.dh);
  }));

test('Fractional selection edges round once, consistently', () =>
  withGridCanvas(() => {
    const image = documentFrame(0, 1000, 1000);
    // 100.4 CSS px at DPR 1.25 = 125.5 device px.
    const canvas = ScrollStitcher.cropToCanvas(image, { x: 125.5, y: 125.5, width: 250.5, height: 100.25 });
    assert.strictEqual(canvas.width, Math.round(376) - Math.round(125.5));
    assert.strictEqual(canvas.height, Math.round(225.75) - Math.round(125.5));
  }));

test('Screenshot scale: the reported ratio is used when the bitmap agrees, the bitmap otherwise', () => {
  assert.strictEqual(ScrollStitcher.resolveScale(1.25, 1600, 1280), 1.25);
  assert.strictEqual(ScrollStitcher.resolveScale(1.25, 1601, 1280), 1.25);   // rounding of the bitmap size
  assert.strictEqual(ScrollStitcher.resolveScale(1, 2560, 1280), 2);          // stale ratio: trust the bitmap
  assert.strictEqual(ScrollStitcher.resolveScale(2, 0, 0), 2);
});

// ---------------------------------------------------------------------------
section('8. END OF CONTENT: LISTS THAT LOAD MORE AS THEY ARE SCROLLED');
// ---------------------------------------------------------------------------

/**
 * Plays a timeline against the detector the way the capture engine does: park at
 * the bottom, observe every poll, perform the extra scroll attempt when asked.
 *
 * @param {Object} timeline functions of the time since the container was parked
 * @returns {{ verdict, elapsed, nudges, nudgeAt }}
 */
function watchBottom(detector, { extent, changed = () => false, busy = () => false }) {
  let now = 0;
  let nudges = 0;
  let nudgeAt = null;
  detector.arrive(now, extent(now));
  for (;;) {
    now += detector.opts.pollMs;
    assert.ok(now < 120000, 'the detector must always reach a decision');
    const verdict = detector.observe({ now, extent: extent(now), changed: changed(now), busy: busy(now) });
    if (verdict === 'wait') continue;
    if (verdict === 'nudge') {
      nudges++;
      nudgeAt = now;
      now += 60; // scrolling away and back takes a moment
      detector.settled(now);
      continue;
    }
    return { verdict, elapsed: now, nudges, nudgeAt };
  }
}

test('A container that never changes is confirmed after a short wait and one extra scroll attempt', () => {
  const detector = new EndDetector();
  const result = watchBottom(detector, { extent: () => 2000 });
  assert.strictEqual(result.verdict, 'end');
  assert.strictEqual(result.nudges, 1, 'exactly one extra scroll attempt');
  assert.ok(result.elapsed >= 1000 && result.elapsed <= 1500, `ordinary containers are not delayed (${result.elapsed} ms)`);
  assert.strictEqual(detector.dynamic, false);
  assert.strictEqual(detector.confirmedExtent, 2000);
});

test('Content that arrives after the bottom is reached is reported as growth, not as the end', () => {
  const detector = new EndDetector();
  const result = watchBottom(detector, { extent: (t) => (t >= 400 ? 2740 : 2000) });
  assert.strictEqual(result.verdict, 'grew');
  assert.ok(result.elapsed <= 600, `noticed promptly (${result.elapsed} ms)`);
  assert.strictEqual(detector.dynamic, true);
  assert.strictEqual(detector.confirmedExtent, null);
});

test('Once a list has loaded more, a later load taking 2.4 s is still waited for', () => {
  const detector = new EndDetector();
  assert.strictEqual(watchBottom(detector, { extent: (t) => (t >= 400 ? 3000 : 2000) }).verdict, 'grew');
  const result = watchBottom(detector, { extent: (t) => (t >= 2400 ? 4000 : 3000) });
  assert.strictEqual(result.verdict, 'grew', 'a static container would have been confirmed at about 1.2 s');
  // And when nothing more comes, the end is declared only after the longer wait.
  const last = watchBottom(detector, { extent: () => 4000 });
  assert.strictEqual(last.verdict, 'end');
  assert.ok(last.elapsed >= 3000, `waited for another load before believing the end (${last.elapsed} ms)`);
  assert.strictEqual(last.nudges, 1);
});

test('Patience follows the slowest load seen, within fixed bounds', () => {
  const detector = new EndDetector();
  assert.strictEqual(detector.patience(), detector.opts.quietMs);
  detector.loads = 1;
  detector.slowestLoadMs = 400;
  assert.strictEqual(detector.patience(), 3000, 'never less than the minimum for a list that loads more');
  detector.slowestLoadMs = 2000;
  assert.strictEqual(detector.patience(), 5000, '2.5 × the slowest load');
  detector.slowestLoadMs = 10000;
  assert.strictEqual(detector.patience(), 8000, 'capped');
});

test('An unchanged height is not proof on its own: rows that keep changing postpone the decision', () => {
  const detector = new EndDetector();
  // The height never moves, but the DOM is rewritten until 2 s have passed.
  const result = watchBottom(detector, { extent: () => 5000, changed: (t) => t <= 2000 });
  assert.strictEqual(result.verdict, 'end');
  // Observations fall every pollMs, so the last change is seen at the final poll before 2 s.
  const lastChangeSeen = Math.floor(2000 / detector.opts.pollMs) * detector.opts.pollMs;
  assert.strictEqual(result.nudgeAt, lastChangeSeen + detector.opts.quietMs, 'quiet time is counted from the last change');
});

test('A visible loading indicator buys time for a first load that is slow', () => {
  const slowFirstLoad = { extent: (t) => (t >= 2000 ? 2800 : 2000) };
  assert.strictEqual(watchBottom(new EndDetector(), slowFirstLoad).verdict, 'end', 'with no sign of loading the wait is short');
  const hinted = watchBottom(new EndDetector(), { ...slowFirstLoad, busy: () => true });
  assert.strictEqual(hinted.verdict, 'grew');
});

test('An indicator that never goes away cannot hold the capture: the end is still declared', () => {
  const result = watchBottom(new EndDetector(), { extent: () => 2000, busy: () => true });
  assert.strictEqual(result.verdict, 'end');
  assert.ok(result.elapsed >= 3000 && result.elapsed <= 4500, `bounded (${result.elapsed} ms)`);
});

test('A change caused by the extra scroll attempt does not trigger a second attempt', () => {
  const detector = new EndDetector();
  let seenNudge = null;
  const result = watchBottom(detector, {
    extent: () => 2000,
    // A list that redraws 150 ms after being scrolled: one change right after the attempt.
    changed: (t) => {
      if (detector.check && detector.check.nudged && seenNudge === null) {
        seenNudge = t;
        return true;
      }
      return false;
    }
  });
  assert.strictEqual(result.verdict, 'end');
  assert.strictEqual(result.nudges, 1);
  assert.ok(result.elapsed >= seenNudge + detector.opts.confirmMs, 'the redraw is waited out');
});

test('Content that never stops changing is reported as unsettled at the hard limit', () => {
  const detector = new EndDetector();
  const result = watchBottom(detector, { extent: () => 2000, changed: () => true });
  assert.strictEqual(result.verdict, 'unsettled');
  assert.ok(result.elapsed >= 20000 && result.elapsed <= 20300, `stopped at the limit (${result.elapsed} ms)`);
  assert.strictEqual(detector.confirmedExtent, null, 'an unsettled bottom is never recorded as the end');
});

test('A placeholder that disappears makes the list shorter: neither growth nor the end', () => {
  const detector = new EndDetector();
  const result = watchBottom(detector, { extent: (t) => (t >= 450 ? 2000 : 2080) });
  assert.strictEqual(result.verdict, 'end');
  assert.strictEqual(detector.confirmedExtent, 2000);
  assert.ok(result.nudgeAt >= 450 + detector.opts.quietMs, 'quiet time restarts when the placeholder goes');
});

test('An end that was already confirmed is re-checked briefly, without another scroll attempt', () => {
  const detector = new EndDetector();
  assert.strictEqual(watchBottom(detector, { extent: () => 2000 }).verdict, 'end');
  const again = watchBottom(detector, { extent: () => 2000 });
  assert.strictEqual(again.verdict, 'end');
  assert.strictEqual(again.nudges, 0);
  assert.ok(again.elapsed <= 600, `brief (${again.elapsed} ms)`);
  // The brief re-check still notices content that arrives during it.
  assert.strictEqual(watchBottom(detector, { extent: (t) => (t >= 300 ? 2600 : 2000) }).verdict, 'grew');
});

test('Growth that happened between two checks marks the list as one that loads more', () => {
  const detector = new EndDetector();
  assert.strictEqual(watchBottom(detector, { extent: () => 1492 }).verdict, 'end');
  // The capture ran, and on reaching the bottom again the list is taller than it was.
  const result = watchBottom(detector, { extent: () => 2232 });
  assert.strictEqual(detector.dynamic, true);
  assert.strictEqual(result.verdict, 'end');
  assert.strictEqual(result.nudges, 1, 'a new extent gets the full check');
  assert.ok(result.elapsed >= 3000, `and the longer wait (${result.elapsed} ms)`);
});

test('History of 16,825 px that grows to 24,150 px: followed load by load to the real end', () => {
  const detector = new EndDetector();
  const steps = [16825, 19325, 21825, 24150];
  let stage = 0;
  let checks = 0;
  for (;;) {
    checks++;
    const from = steps[stage];
    const to = steps[stage + 1];
    const result = watchBottom(detector, { extent: (t) => (to !== undefined && t >= 600 ? to : from) });
    if (result.verdict === 'end') break;
    assert.strictEqual(result.verdict, 'grew');
    stage++;
  }
  assert.strictEqual(steps[stage], 24150, 'the end is declared at the final height, not the first');
  assert.strictEqual(detector.loads, 3);
  assert.strictEqual(checks, 4);
  assert.strictEqual(detector.confirmedExtent, 24150);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n===============================================================');
  console.log('   SNAPFLOW - CAPTURE ENGINE TEST SUITE');
  console.log('===============================================================');
  for (const item of queue) {
    if (item.section) {
      console.log(`\n--- ${item.section} ---`);
      continue;
    }
    testsRun++;
    try {
      await item.fn();
      testsPassed++;
      console.log(`  [PASS] ${item.title}`);
    } catch (err) {
      console.error(`  [FAIL] ${item.title}`);
      console.error(`         ${err.message}`);
    }
  }
  console.log('\n===============================================================');
  console.log(`ENGINE SUITE RESULT: ${testsPassed} of ${testsRun} tests passed.`);
  console.log('===============================================================\n');
  if (testsPassed !== testsRun) process.exit(1);
})();
