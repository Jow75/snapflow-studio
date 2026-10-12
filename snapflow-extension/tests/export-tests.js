/**
 * SnapFlow - Export Pipeline Test Suite
 *
 * PDF page layout is pure arithmetic and is verified exhaustively here: for every
 * paper size, orientation, layout and margin, the image must keep its proportions,
 * stay inside the printable area, and lose or repeat no rows.
 * The generated PDF bytes are parsed back to check the file structure.
 *
 * Real downloaded files are verified in e2e/ (decoded images, pdf.js rendering).
 */

const assert = require('assert');
const path = require('path');

const SmartPdfExporter = require(path.resolve(__dirname, '../studio/pdf-exporter.js'));
const ImageExporter = require(path.resolve(__dirname, '../studio/image-exporter.js'));

let testsRun = 0;
let testsPassed = 0;
const queue = [];
const section = (name) => queue.push({ section: name });
const test = (title, fn) => queue.push({ title, fn });

const MM = 72 / 25.4;
const A4 = { w: 595.28, h: 841.89 };
const LETTER = { w: 612, h: 792 };
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);

/** Invariants every layout must satisfy, whatever the settings. */
function assertLayoutInvariants(layout, imageWidth, imageHeight) {
  const { pageWidthPt, pageHeightPt, marginPt, scale, pages } = layout;
  assert.ok(scale > 0 && scale <= SmartPdfExporter.POINTS_PER_PIXEL + 1e-9, 'scale within (0, 100%]');
  let cursor = 0;
  for (const [i, p] of pages.entries()) {
    assert.strictEqual(p.srcY, cursor, `page ${i + 1} starts where the previous one ended`);
    assert.ok(p.srcH > 0, `page ${i + 1} is not empty`);
    cursor += p.srcH;
    // One scale for both axes: this is what makes stretching impossible.
    near(p.width / imageWidth, scale, 1e-9, `page ${i + 1} horizontal scale`);
    near(p.height / p.srcH, scale, 1e-9, `page ${i + 1} vertical scale`);
    assert.ok(p.x >= marginPt - 1e-6, `page ${i + 1} left margin`);
    assert.ok(p.x + p.width <= pageWidthPt - marginPt + 1e-6, `page ${i + 1} right margin`);
    assert.ok(p.y >= marginPt - 1e-6, `page ${i + 1} bottom margin`);
    near(p.y + p.height, pageHeightPt - marginPt, 1e-6, `page ${i + 1} aligned to the top margin`);
    near(p.x + p.width / 2, pageWidthPt / 2, 1e-6, `page ${i + 1} centred horizontally`);
  }
  assert.strictEqual(cursor, imageHeight, 'all rows placed, none repeated');
}

// ---------------------------------------------------------------------------
section('1. PDF PAGE GEOMETRY');
// ---------------------------------------------------------------------------

test('A4 and US Letter have their standard dimensions in points', () => {
  near(SmartPdfExporter.PAGE_SIZES.a4.width, 210 * MM, 0.01, 'A4 width');
  near(SmartPdfExporter.PAGE_SIZES.a4.height, 297 * MM, 0.01, 'A4 height');
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.letter.width, 8.5 * 72);
  assert.strictEqual(SmartPdfExporter.PAGE_SIZES.letter.height, 11 * 72);
});

test('Orientation swaps the page, and changes nothing about the image proportions', () => {
  const portrait = SmartPdfExporter.planLayout(1280, 800, { size: 'a4', orientation: 'portrait', layout: 'fit', marginMm: 10 });
  const landscape = SmartPdfExporter.planLayout(1280, 800, { size: 'a4', orientation: 'landscape', layout: 'fit', marginMm: 10 });
  assert.strictEqual(portrait.pageWidthPt, A4.w);
  assert.strictEqual(portrait.pageHeightPt, A4.h);
  assert.strictEqual(landscape.pageWidthPt, A4.h);
  assert.strictEqual(landscape.pageHeightPt, A4.w);
  for (const layout of [portrait, landscape]) {
    const p = layout.pages[0];
    near(p.width / p.height, 1280 / 800, 1e-9, 'image aspect ratio on the page');
  }
});

test('Margins are converted from millimetres and define the printable area', () => {
  const layout = SmartPdfExporter.planLayout(4000, 1000, { size: 'letter', orientation: 'portrait', layout: 'fit', marginMm: 20 });
  near(layout.marginPt, 20 * MM, 1e-9, 'margin in points');
  near(layout.pages[0].width, LETTER.w - 40 * MM, 1e-6, 'image fills the printable width');
  near(layout.pages[0].x, 20 * MM, 1e-6, 'image starts at the left margin');
});

test('Margins that leave no printable area are rejected', () => {
  assert.throws(() => SmartPdfExporter.planLayout(1000, 1000, { size: 'a4', marginMm: 200 }), /margins/i);
});

// ---------------------------------------------------------------------------
section('2. EVERY LAYOUT KEEPS PROPORTIONS, MARGINS AND ALL ROWS');
// ---------------------------------------------------------------------------

const IMAGES = [
  ['wide screenshot', 1280, 800],
  ['long page', 1280, 9000],
  ['very long page', 1920, 31000],
  ['narrow sidebar', 257, 2000],
  ['small element', 300, 120],
  ['panorama', 6000, 400]
];

for (const [label, w, h] of IMAGES) {
  test(`${label} (${w} × ${h}): all sizes, orientations, layouts and margins`, () => {
    let checked = 0;
    for (const size of ['a4', 'letter']) {
      for (const orientation of ['portrait', 'landscape']) {
        for (const layout of ['fit', 'split']) {
          for (const marginMm of [0, 10, 20]) {
            const plan = SmartPdfExporter.planLayout(w, h, { size, orientation, layout, marginMm });
            assertLayoutInvariants(plan, w, h);
            if (layout === 'fit') assert.strictEqual(plan.pages.length, 1, 'fit is always one page');
            checked++;
          }
        }
      }
    }
    assert.strictEqual(checked, 24);
  });
}

test('Fit to one page: the binding dimension touches the printable box, the other has room', () => {
  const tall = SmartPdfExporter.planLayout(1280, 9000, { size: 'a4', orientation: 'portrait', layout: 'fit', marginMm: 10 });
  near(tall.pages[0].height, A4.h - 20 * MM, 1e-6, 'tall image fills the printable height');
  assert.ok(tall.pages[0].width < A4.w - 20 * MM);
  const wide = SmartPdfExporter.planLayout(6000, 400, { size: 'a4', orientation: 'portrait', layout: 'fit', marginMm: 10 });
  near(wide.pages[0].width, A4.w - 20 * MM, 1e-6, 'wide image fills the printable width');
});

test('Split across pages: pages are full except the last, which is clipped to what remains', () => {
  const plan = SmartPdfExporter.planLayout(1280, 9000, { size: 'a4', orientation: 'portrait', layout: 'split', marginMm: 10 });
  const rowsPerPage = Math.floor((A4.h - 20 * MM) / plan.scale + 1e-6);
  assert.ok(plan.pages.length > 1);
  for (const p of plan.pages.slice(0, -1)) assert.strictEqual(p.srcH, rowsPerPage);
  const last = plan.pages[plan.pages.length - 1];
  assert.strictEqual(last.srcH, 9000 - rowsPerPage * (plan.pages.length - 1));
  assert.ok(last.height <= A4.h - 20 * MM + 1e-6);
});

test('Split: an image that already fits one page stays on one page', () => {
  const plan = SmartPdfExporter.planLayout(1280, 800, { size: 'a4', orientation: 'portrait', layout: 'split', marginMm: 10 });
  assert.strictEqual(plan.pages.length, 1);
});

test('Small images are never enlarged beyond 100%', () => {
  for (const layout of ['fit', 'split']) {
    const plan = SmartPdfExporter.planLayout(300, 120, { size: 'a4', orientation: 'portrait', layout, marginMm: 10 });
    assert.strictEqual(plan.scale, SmartPdfExporter.POINTS_PER_PIXEL);
    near(plan.percent, 100, 1e-9, 'percent of actual size');
    near(plan.pages[0].width, 225, 1e-9, 'placed width in points');
  }
});

test('"Same as image": one page with exactly the image proportions plus margins', () => {
  const plan = SmartPdfExporter.planLayout(1280, 3450, { size: 'image', marginMm: 10 });
  assert.strictEqual(plan.pages.length, 1);
  near(plan.pageWidthPt, 1280 * 0.75 + 20 * MM, 1e-6, 'page width');
  near(plan.pageHeightPt, 3450 * 0.75 + 20 * MM, 1e-6, 'page height');
  assertLayoutInvariants(plan, 1280, 3450);
});

test('"Same as image" for a huge image stays within the PDF page limit, proportions kept', () => {
  const plan = SmartPdfExporter.planLayout(2560, 32000, { size: 'image', marginMm: 0 });
  assert.ok(plan.pageHeightPt <= SmartPdfExporter.MAX_PAGE_POINTS + 1e-6);
  near(plan.pageWidthPt / plan.pageHeightPt, 2560 / 32000, 1e-9, 'page aspect ratio');
  assertLayoutInvariants(plan, 2560, 32000);
});

// ---------------------------------------------------------------------------
section('3. SMART PAGE BREAKS');
// ---------------------------------------------------------------------------

test('A page break may give up a little space but never overflows the page', () => {
  const calls = [];
  const plan = SmartPdfExporter.planLayout(1280, 9000, { size: 'a4', layout: 'split', marginMm: 10 }, (nominal, radius) => {
    calls.push([nominal, radius]);
    return nominal - 37;
  });
  assert.ok(calls.length >= 1);
  assertLayoutInvariants(plan, 1280, 9000);
  const rowsPerPage = Math.floor((A4.h - 20 * MM) / plan.scale + 1e-6);
  for (const p of plan.pages.slice(0, -1)) assert.strictEqual(p.srcH, rowsPerPage - 37);
});

test('A break finder that returns something out of range is ignored', () => {
  for (const bad of [(n) => n + 50, (n) => n - 5000, () => NaN, () => 0]) {
    const plan = SmartPdfExporter.planLayout(1280, 9000, { size: 'a4', layout: 'split', marginMm: 10 }, bad);
    assertLayoutInvariants(plan, 1280, 9000);
    const rowsPerPage = Math.floor((A4.h - 20 * MM) / plan.scale + 1e-6);
    assert.strictEqual(plan.pages[0].srcH, rowsPerPage);
  }
});

/** Builds a fake 2D context over rows of a given colour; text rows alternate dark and light. */
function fakeContext(width, height, rowColour) {
  return {
    canvas: { width, height },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const [r, g, b] = rowColour(y + row, x + col);
          const o = (row * w + col) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
      return { data };
    }
  };
}

test('Break finder picks the nearest blank row above the boundary on a light page', () => {
  // Text occupies rows 150-199 and 210-260; the gap is rows 200-209.
  const ctx = fakeContext(800, 1000, (y, x) => ((y >= 150 && y < 200) || (y >= 210 && y <= 260)) && x % 7 < 3 ? [20, 20, 20] : [255, 255, 255]);
  const split = SmartPdfExporter.findBestSplitRow(ctx, 800, 240, 90);
  assert.strictEqual(split, 209);
});

test('Break finder works on a dark page (uniform rows of any colour count as gaps)', () => {
  const ctx = fakeContext(800, 1000, (y, x) => (y >= 300 && y < 380 && x % 5 < 2 ? [230, 230, 230] : [15, 23, 42]));
  const split = SmartPdfExporter.findBestSplitRow(ctx, 800, 350, 90);
  assert.strictEqual(split, 299);
});

test('Break finder never moves the break below the page boundary', () => {
  const ctx = fakeContext(800, 1000, (y, x) => (y <= 400 && x % 4 < 2 ? [0, 0, 0] : [255, 255, 255]));
  const split = SmartPdfExporter.findBestSplitRow(ctx, 800, 400, 90);
  assert.ok(split <= 400, 'break must not exceed the nominal boundary, got ' + split);
});

// ---------------------------------------------------------------------------
section('4. PDF FILE STRUCTURE');
// ---------------------------------------------------------------------------

function buildSample() {
  const layout = SmartPdfExporter.planLayout(1280, 9000, { size: 'a4', orientation: 'portrait', layout: 'split', marginMm: 10 });
  const images = layout.pages.map((p, i) => ({
    // Stand-in JPEG payloads, including bytes that would break a text-based writer.
    bytes: Uint8Array.from([0xff, 0xd8, 0x0a, 0x0d, 0x00, 0x25, i, 0xff, 0xd9]),
    width: 1280,
    height: p.srcH
  }));
  return { layout, images, file: Buffer.from(SmartPdfExporter.buildPdf(layout, images)) };
}

test('Cross-reference table points at every object, and startxref at the table', () => {
  const { file } = buildSample();
  const text = file.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.strictEqual(text.substr(startxref, 5), 'xref\n');
  const header = /xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const count = Number(header[1]);
  const entries = text.slice(startxref + header[0].length).split('\n').slice(0, count);
  assert.strictEqual(entries[0], '0000000000 65535 f ');
  for (let id = 1; id < count; id++) {
    assert.ok(/^\d{10} 00000 n $/.test(entries[id]), `xref entry ${id} is 20 bytes long`);
    const offset = Number(entries[id].slice(0, 10));
    assert.strictEqual(text.substr(offset, `${id} 0 obj`.length), `${id} 0 obj`, `object ${id} offset`);
  }
  assert.ok(new RegExp(`/Size ${count} /Root 1 0 R`).test(text));
});

test('Each page draws its image with one scale on both axes, and declares exact lengths', () => {
  const { file, layout, images } = buildSample();
  const text = file.toString('latin1');
  assert.ok(new RegExp(`/Count ${layout.pages.length} `).test(text));
  const matrices = [...text.matchAll(/q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im(\d+) Do\nQ\n/g)];
  assert.strictEqual(matrices.length, layout.pages.length);
  matrices.forEach((m, i) => {
    const [width, height] = [Number(m[1]), Number(m[2])];
    near(width / 1280, height / images[i].height, 1e-5, `page ${i + 1} scale on both axes`);
  });
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n([^]*?)endstream/g)) {
    assert.strictEqual(m[2].length, Number(m[1]), 'content stream /Length');
  }
  let imagesSeen = 0;
  for (const m of text.matchAll(/\/Filter \/DCTDecode\n\s+\/Length (\d+)\n>>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const length = Number(m[1]);
    assert.strictEqual(file[start], 0xff);
    assert.strictEqual(file[start + 1], 0xd8);
    assert.strictEqual(text.substr(start + length, 10), '\nendstream', 'image stream /Length');
    imagesSeen++;
  }
  assert.strictEqual(imagesSeen, layout.pages.length);
  for (const box of text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)) {
    assert.strictEqual(Number(box[1]), 595.28);
    assert.strictEqual(Number(box[2]), 841.89);
  }
});

// ---------------------------------------------------------------------------
section('5. IMAGE FORMATS');
// ---------------------------------------------------------------------------

test('Format limits: WebP stops at 16,383 px, PNG and JPEG at 65,535 px', () => {
  assert.strictEqual(ImageExporter.checkLimits('webp', 16383, 16383), null);
  assert.ok(/WebP.*16,383/.test(ImageExporter.checkLimits('webp', 1280, 16384)));
  assert.strictEqual(ImageExporter.checkLimits('jpeg', 1280, 32000), null);
  assert.strictEqual(ImageExporter.checkLimits('png', 1280, 32000), null);
  assert.ok(ImageExporter.checkLimits('jpeg', 70000, 10));
  assert.ok(ImageExporter.checkLimits('png', 0, 10));
  assert.ok(ImageExporter.checkLimits('tiff', 10, 10));
});

function fakeCanvas(width, height, produce) {
  return { width, height, toBlob: (cb, mime, quality) => cb(produce(mime, quality)) };
}

test('A blob of the requested type is returned as-is', async () => {
  const blob = await ImageExporter.encode(fakeCanvas(10, 10, (mime) => ({ type: mime })), 'png');
  assert.strictEqual(blob.type, 'image/png');
});

test('A browser that silently falls back to PNG is reported, not saved as .webp', async () => {
  await assert.rejects(
    ImageExporter.encode(fakeCanvas(10, 10, () => ({ type: 'image/png' })), 'webp'),
    /cannot encode WebP/
  );
});

test('An encoder that returns nothing is reported', async () => {
  await assert.rejects(ImageExporter.encode(fakeCanvas(10, 10, () => null), 'png'), /could not create a PNG/);
});

test('An image beyond the format limit is refused before encoding', async () => {
  let encoded = false;
  const canvas = fakeCanvas(1280, 20000, () => { encoded = true; return { type: 'image/webp' }; });
  await assert.rejects(ImageExporter.encode(canvas, 'webp'), /16,383/);
  assert.strictEqual(encoded, false);
});

test('JPEG is composited onto white at the same size (it cannot store transparency)', async () => {
  const original = global.document;
  const created = [];
  global.document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        ops: [],
        getContext() {
          return {
            set fillStyle(v) { canvas.ops.push(['fillStyle', v]); },
            fillRect: (...a) => canvas.ops.push(['fillRect', ...a]),
            drawImage: (...a) => canvas.ops.push(['drawImage', a.length, a[1], a[2]])
          };
        },
        toBlob: (cb, mime) => cb({ type: mime })
      };
      created.push(canvas);
      return canvas;
    }
  };
  try {
    const source = fakeCanvas(640, 480, () => { throw new Error('the source canvas must not be encoded directly'); });
    const blob = await ImageExporter.encode(source, 'jpeg');
    assert.strictEqual(blob.type, 'image/jpeg');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].width, 640);
    assert.strictEqual(created[0].height, 480);
    assert.deepStrictEqual(created[0].ops, [
      ['fillStyle', '#ffffff'],
      ['fillRect', 0, 0, 640, 480],
      ['drawImage', 3, 0, 0]   // drawn 1:1 at the origin, no destination size
    ]);
  } finally {
    global.document = original;
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  console.log('\n===============================================================');
  console.log('   SNAPFLOW - EXPORT PIPELINE TEST SUITE');
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
  console.log(`EXPORT SUITE RESULT: ${testsPassed} of ${testsRun} tests passed.`);
  console.log('===============================================================\n');
  if (testsPassed !== testsRun) process.exit(1);
})();
