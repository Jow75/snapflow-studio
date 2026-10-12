/**
 * Export verification. Every check reads the file Chrome actually downloaded.
 *
 *   PNG / JPEG / WebP: decoded and compared, pixel for pixel or by geometry, with
 *                      what the editor holds.
 *   PDF:               parsed structurally (page boxes, placement matrices, embedded
 *                      image data) and rendered with pdf.js; the fixture's square and
 *                      circle are measured in the rendering to prove nothing stretched.
 */

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { group, test, assert, assertEqual, assertClose } = require('../lib/runner');
const px = require('../lib/pixels');
const shapes = require('../lib/shapes');
const pdf = require('../lib/pdf');
const act = require('../lib/actions');

const PT_PER_MM = 72 / 25.4;
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
const SOURCE_URL = 'page.html?h=3450&shapes=1';

// Fixture geometry in source CSS px.
const SQUARE = { x: 520, y: 120, size: 200 };
const CIRCLE = { x: 800, y: 70, size: 300 };
const SECRET = { x: 520, y: 560, w: 420, h: 60 };

module.exports = async function exportsSuite(ctx) {
  const d = ctx.dpr;

  // --- Studio helpers -------------------------------------------------------

  async function toScreen(studio, cx, cy) {
    return studio.evaluate((x, y) => {
      const c = document.getElementById('overlay-canvas');
      const r = c.getBoundingClientRect();
      return { x: r.left + (x * r.width) / c.width, y: r.top + (y * r.height) / c.height };
    }, cx, cy);
  }

  async function selectTool(studio, tool) {
    await studio.click(`.floating-toolbar .tool-btn[data-tool="${tool}"]`);
  }

  async function drag(studio, tool, from, to) {
    await selectTool(studio, tool);
    const a = await toScreen(studio, from[0], from[1]);
    const b = await toScreen(studio, to[0], to[1]);
    await studio.mouse.move(a.x, a.y);
    await studio.mouse.down();
    await studio.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
    await studio.mouse.move(b.x, b.y, { steps: 3 });
    await studio.mouse.up();
    await act.sleep(80);
  }

  /** What the editor shows: the image canvas with the annotation layer on top. */
  async function editorComposite(studio) {
    const dataUrl = await studio.evaluate(() => {
      const base = document.getElementById('base-canvas');
      const overlay = document.getElementById('overlay-canvas');
      const c = document.createElement('canvas');
      c.width = base.width;
      c.height = base.height;
      const g = c.getContext('2d');
      g.drawImage(base, 0, 0);
      g.drawImage(overlay, 0, 0);
      return c.toDataURL('image/png');
    });
    return px.decodePng(Buffer.from(dataUrl.split(',')[1], 'base64'));
  }

  async function exportImage(studio, format, saveAs) {
    const dl = await ctx.download(studio, () => studio.click(`#btn-export-${format}`));
    if (saveAs) fs.writeFileSync(path.join(ctx.outputDir, saveAs), dl.buffer);
    return dl;
  }

  async function exportPdf(studio, options, saveAs) {
    const dl = await ctx.download(studio, async () => {
      await studio.click('#btn-export-pdf');
      await studio.select('#pdf-page-size', options.size);
      if (options.size !== 'image') {
        await studio.select('#pdf-orientation', options.orientation);
        await studio.select('#pdf-layout', options.layout);
      }
      await studio.select('#pdf-margin', String(options.marginMm));
      await studio.click('#btn-pdf-confirm');
    });
    if (saveAs) fs.writeFileSync(path.join(ctx.outputDir, saveAs), dl.buffer);
    return dl;
  }

  async function expectNoDownload(studio, trigger, waitMs = 2500) {
    for (const stale of fs.readdirSync(ctx.downloadDir)) fs.rmSync(path.join(ctx.downloadDir, stale), { force: true });
    await trigger();
    await act.sleep(waitMs);
    assertEqual(fs.readdirSync(ctx.downloadDir).length, 0, 'files downloaded');
  }

  function maxDiff(a, b) {
    let worst = 0;
    for (let i = 0; i < a.data.length; i++) {
      const diff = Math.abs(a.data[i] - b.data[i]);
      if (diff > worst) worst = diff;
    }
    return worst;
  }

  function decodeJpeg(buffer) {
    const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 2048 });
    return { width: img.width, height: img.height, data: img.data };
  }

  /** Square and circle must keep their size, position and 1:1 proportions. */
  function assertShapes(img, label, { scale = 1, offsetX = 0, offsetY = 0, tolerance = 1 } = {}) {
    const roi = (shape) => ({
      x: offsetX + (shape.x - 30) * scale,
      y: offsetY + (shape.y - 30) * scale,
      w: (shape.size + 60) * scale,
      h: (shape.size + 60) * scale
    });
    const square = shapes.boundingBox(img, shapes.isBlack, SQUARE.size * scale * 0.5, roi(SQUARE));
    const circle = shapes.boundingBox(img, shapes.isCircleRed, CIRCLE.size * scale * 0.25, roi(CIRCLE));
    assert(square, `${label}: square not found`);
    assert(circle, `${label}: circle not found`);
    assertClose(square.w, SQUARE.size * scale, tolerance, `${label}: square width`);
    assertClose(square.h, SQUARE.size * scale, tolerance, `${label}: square height`);
    assertClose(square.x, offsetX + SQUARE.x * scale, tolerance, `${label}: square left edge`);
    assertClose(square.y, offsetY + SQUARE.y * scale, tolerance, `${label}: square top edge`);
    // The circle's projection is thresholded, so its box is slightly inside the true edge.
    assertClose(circle.w / circle.h, 1, 0.02, `${label}: circle width/height ratio`);
    assertClose(square.w / square.h, 1, 0.012, `${label}: square width/height ratio`);
    return { square, circle };
  }

  // --- PDF verification -----------------------------------------------------

  /**
   * @param {Buffer} buffer downloaded PDF
   * @param {{width,height,data}} source the flattened image the PDF was made from
   * @param {Object} options settings chosen in the dialog
   * @param {Object} [expect] optional extra expectations
   */
  async function verifyPdf(buffer, source, options, label) {
    const structure = pdf.readStructure(buffer);
    const pages = structure.pages;
    assert(pages.length >= 1, `${label}: no pages`);
    assertEqual(structure.declaredCount, pages.length, `${label}: /Count`);

    const margin = options.marginMm * PT_PER_MM;
    let pageW, pageH;
    if (options.size === 'image') {
      const s = pages[0].width / pages[0].imageWidth;
      pageW = source.width * s + margin * 2;
      pageH = source.height * s + margin * 2;
    } else {
      const [w, h] = PAGE[options.size];
      pageW = options.orientation === 'landscape' ? h : w;
      pageH = options.orientation === 'landscape' ? w : h;
    }

    const scale = pages[0].width / pages[0].imageWidth;
    assert(scale <= 0.75 + 1e-6, `${label}: image enlarged beyond 100% (scale ${scale})`);
    let rows = 0;

    for (const [i, p] of pages.entries()) {
      const tag = `${label} page ${i + 1}`;
      assertClose(p.pageWidth, pageW, 0.02, `${tag}: page width (pt)`);
      assertClose(p.pageHeight, pageH, 0.02, `${tag}: page height (pt)`);
      assertEqual(p.matrix.b, 0, `${tag}: matrix skew b`);
      assertEqual(p.matrix.c, 0, `${tag}: matrix skew c`);

      // The decisive check: horizontal and vertical scale are the same number.
      const sx = p.width / p.imageWidth;
      const sy = p.height / p.imageHeight;
      assertClose(sx / sy, 1, 0.0015, `${tag}: horizontal/vertical scale ratio`);
      assertClose(sx, scale, 0.0005, `${tag}: same scale on every page`);

      assertEqual(p.imageWidth, source.width, `${tag}: slice width`);
      assert(p.x >= margin - 0.02, `${tag}: left margin respected (${p.x} < ${margin})`);
      assert(p.x + p.width <= pageW - margin + 0.02, `${tag}: right margin respected`);
      assert(p.y >= margin - 0.02, `${tag}: bottom margin respected (${p.y} < ${margin})`);
      assertClose(p.y + p.height, pageH - margin, 0.02, `${tag}: aligned to the top margin`);
      assertClose(p.x, (pageW - p.width) / 2, 0.02, `${tag}: centred horizontally`);
      rows += p.imageHeight;
    }
    assertEqual(rows, source.height, `${label}: rows across all pages`);
    if (options.layout === 'fit' || options.size === 'image') {
      assertEqual(pages.length, 1, `${label}: page count for a one-page layout`);
    }

    // Content: the pages, stacked, are the source image. Order, continuity and
    // completeness all follow from this.
    const stacked = pdf.stackPageImages(structure);
    const mean = shapes.meanAbsDiff(stacked, source);
    const worstRow = shapes.worstRowDiff(stacked, source);
    assert(mean < 4, `${label}: page content differs from the source (mean ${mean.toFixed(2)})`);
    assert(worstRow < 14, `${label}: a row differs from the source (worst ${worstRow.toFixed(2)})`);

    // Independent reader: pdf.js must open the file and agree on its geometry.
    const renderScale = Math.min(4, Math.max(1.5, 1 / scale));
    const rendered = await pdf.renderWithPdfJs(buffer, { scale: renderScale, renderPages: [1] });
    assertEqual(rendered.numPages, pages.length, `${label}: pdf.js page count`);
    for (const page of rendered.pages) {
      assertClose(page.width, pageW, 0.05, `${label}: pdf.js page width`);
      assertClose(page.height, pageH, 0.05, `${label}: pdf.js page height`);
    }

    const first = pages[0];
    const image = rendered.pages[0].image;
    const k = scale * renderScale; // rendered px per source px
    const left = first.x * renderScale;
    const top = (pageH - first.y - first.height) * renderScale;
    assertShapes(image, `${label} (rendered)`, { scale: k, offsetX: left, offsetY: top, tolerance: 2 });

    // Everything outside the placement rectangle is blank paper.
    const right = left + first.width * renderScale;
    const bottom = top + first.height * renderScale;
    let stray = 0;
    for (let y = 0; y < image.height; y += 3) {
      for (let x = 0; x < image.width; x += 3) {
        if (x >= left - 2 && x <= right + 2 && y >= top - 2 && y <= bottom + 2) continue;
        const o = (y * image.width + x) * 4;
        if (!shapes.isPaperWhite(image.data[o], image.data[o + 1], image.data[o + 2])) stray++;
      }
    }
    assertEqual(stray, 0, `${label}: non-white pixels outside the image area`);

    return `${pages.length}p @ ${(scale / 0.75 * 100).toFixed(0)}%`;
  }

  // --- Sources --------------------------------------------------------------

  group(`EXPORTS (device pixel ratio ${d})`);

  const wideTab = await ctx.openFixture(SOURCE_URL);
  const wide = await act.captureVisible(ctx, wideTab);
  const tallTab = await ctx.openFixture(SOURCE_URL);
  const tall = await act.captureFullPage(ctx, tallTab);
  const sources = [
    { name: 'wide', studio: wide, expected: [1280, 800] },
    { name: 'tall', studio: tall, expected: [1280, 3450] }
  ];

  // --- Raster formats -------------------------------------------------------

  for (const source of sources) {
    const { studio, name } = source;
    await studio.bringToFront();
    const dims = await act.studioDims(studio);

    await test(`${name} source is ${source.expected.join('×')} px in the editor`, async () => {
      assertEqual(dims.width, source.expected[0] * d, 'editor canvas width');
      assertEqual(dims.height, source.expected[1] * d, 'editor canvas height');
    });

    await test(`PNG (${name}): downloaded file is pixel-identical to the editor image`, async () => {
      const composite = await editorComposite(studio);
      const dl = await exportImage(studio, 'png', `export-${name}.png`);
      assert(dl.name.endsWith('.png'), 'file extension: ' + dl.name);
      const file = px.decodePng(dl.buffer);
      assertEqual(file.width, dims.width, 'PNG width');
      assertEqual(file.height, dims.height, 'PNG height');
      assert(shapes.identical(file, composite), 'PNG pixels differ from the editor image');
      assertShapes(file, 'PNG', { scale: d });
      source.png = file;
      return `${file.width}×${file.height}, ${(dl.buffer.length / 1024).toFixed(0)} KB`;
    });

    await test(`PNG (${name}): editor zoom does not change the exported size`, async () => {
      await studio.click('#btn-zoom-level');
      await studio.click('.zoom-option[data-zoom="0.5"]');
      const half = px.decodePng((await exportImage(studio, 'png')).buffer);
      await studio.click('#btn-zoom-level');
      await studio.click('.zoom-option[data-zoom="2.0"]');
      const twice = px.decodePng((await exportImage(studio, 'png')).buffer);
      await studio.click('#btn-zoom-fit-width');
      assert(shapes.identical(half, source.png), 'export at 50% zoom differs');
      assert(shapes.identical(twice, source.png), 'export at 200% zoom differs');
    });

    await test(`JPEG (${name}): same dimensions and geometry, only compression differs`, async () => {
      const dl = await exportImage(studio, 'jpeg', `export-${name}.jpg`);
      assert(dl.name.endsWith('.jpg'), 'file extension: ' + dl.name);
      assert(dl.buffer[0] === 0xff && dl.buffer[1] === 0xd8, 'file is not JPEG data');
      const file = decodeJpeg(dl.buffer);
      assertEqual(file.width, dims.width, 'JPEG width');
      assertEqual(file.height, dims.height, 'JPEG height');
      assertShapes(file, 'JPEG', { scale: d });
      const mean = shapes.meanAbsDiff(file, source.png);
      assert(mean < 4, `JPEG content differs from the editor image (mean ${mean.toFixed(2)})`);
      assert(shapes.worstRowDiff(file, source.png) < 14, 'a JPEG row differs from the editor image');
      return `mean difference ${mean.toFixed(2)} / 255`;
    });

    await test(`WebP (${name}): really WebP, same dimensions and geometry`, async () => {
      const dl = await exportImage(studio, 'webp', `export-${name}.webp`);
      assert(dl.name.endsWith('.webp'), 'file extension: ' + dl.name);
      const size = shapes.webpSize(dl.buffer);
      assertEqual(size.width, dims.width, 'WebP width');
      assertEqual(size.height, dims.height, 'WebP height');
      // Decoded by the browser, since Node has no WebP decoder here.
      const rgbaBase64 = await studio.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext('2d').drawImage(bitmap, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      }, dl.buffer.toString('base64'));
      const file = px.decodePng(Buffer.from(rgbaBase64, 'base64'));
      assertShapes(file, 'WebP', { scale: d });
      const mean = shapes.meanAbsDiff(file, source.png);
      assert(mean < 4, `WebP content differs from the editor image (mean ${mean.toFixed(2)})`);
      return `mean difference ${mean.toFixed(2)} / 255`;
    });
  }

  // --- PDF layouts ----------------------------------------------------------

  const combos = [];
  for (const size of ['a4', 'letter']) {
    for (const orientation of ['portrait', 'landscape']) {
      for (const layout of ['fit', 'split']) combos.push({ size, orientation, layout, marginMm: 10 });
    }
  }
  combos.push({ size: 'image', orientation: 'portrait', layout: 'fit', marginMm: 10 });
  combos.push({ size: 'a4', orientation: 'portrait', layout: 'split', marginMm: 0 });
  combos.push({ size: 'a4', orientation: 'portrait', layout: 'split', marginMm: 20 });
  combos.push({ size: 'letter', orientation: 'landscape', layout: 'fit', marginMm: 0 });
  combos.push({ size: 'image', orientation: 'portrait', layout: 'fit', marginMm: 0 });

  for (const source of sources) {
    const { studio, name } = source;
    await studio.bringToFront();
    for (const options of combos) {
      const what = options.size === 'image'
        ? `same-as-image, ${options.marginMm} mm margins`
        : `${options.size.toUpperCase()} ${options.orientation}, ${options.layout === 'fit' ? 'fit to one page' : 'split across pages'}, ${options.marginMm} mm margins`;
      const file = `pdf-${name}-${options.size}-${options.orientation}-${options.layout}-m${options.marginMm}.pdf`;
      await test(`PDF (${name}): ${what}`, async () => {
        assert(source.png, 'source PNG unavailable');
        const dl = await exportPdf(studio, options, file);
        assert(dl.name.endsWith('.pdf'), 'file extension: ' + dl.name);
        return verifyPdf(dl.buffer, source.png, options, name);
      });
    }
  }

  await test('PDF dialog: explains the result before exporting and warns when text will be small', async () => {
    await tall.bringToFront();
    await tall.click('#btn-export-pdf');
    await tall.select('#pdf-page-size', 'a4');
    await tall.select('#pdf-orientation', 'portrait');
    await tall.select('#pdf-layout', 'split');
    await tall.select('#pdf-margin', '10');
    const split = await tall.$eval('#pdf-summary', (el) => el.textContent);
    await tall.select('#pdf-layout', 'fit');
    const fit = await tall.$eval('#pdf-summary', (el) => el.textContent);
    await tall.select('#pdf-page-size', 'image');
    const sized = await tall.$eval('#pdf-summary', (el) => el.textContent);
    const disabled = await tall.$eval('#pdf-orientation', (el) => el.disabled);
    await tall.screenshot({ path: path.join(ctx.outputDir, `ui-pdf-dialog-dpr${d}.png`) });
    await tall.select('#pdf-page-size', 'a4');
    await tall.select('#pdf-layout', 'split');
    await tall.click('#btn-pdf-cancel');
    assert(/About \d+ pages/.test(split), 'split summary: ' + split);
    assert(fit.startsWith('1 page') && fit.includes('small'), 'fit summary: ' + fit);
    assert(sized.startsWith('1 page') && sized.includes('100%'), 'same-as-image summary: ' + sized);
    assert(disabled, 'orientation is not applicable to a page sized to the image');
    return split;
  });

  // --- Edits carried into every format --------------------------------------

  const editTab = await ctx.openFixture(SOURCE_URL);
  const edit = await act.captureVisible(ctx, editTab);
  await edit.bringToFront();

  await test('Annotations, padding and crop: PNG matches the editor and has the right size', async () => {
    assertEqual(d, 1, 'this scenario uses fixed pixel coordinates and runs at ratio 1');
    await drag(edit, 'rect', [480, 90], [760, 350]);
    await drag(edit, 'arrow', [900, 500], [1100, 380]);
    await drag(edit, 'highlight', [40, 100], [400, 140]);
    await selectTool(edit, 'text');
    const at = await toScreen(edit, 100, 300);
    await edit.mouse.click(at.x, at.y);
    await edit.keyboard.type('Reviewed', { delay: 10 });
    await edit.keyboard.press('Enter');
    await selectTool(edit, 'step');
    const step = await toScreen(edit, 300, 400);
    await edit.mouse.click(step.x, step.y);

    await edit.click('#btn-padding-menu');
    await edit.click('#padding-dropdown .chip-btn[data-pad="32"]');
    await act.sleep(100);
    let dims = await act.studioDims(edit);
    assertEqual(dims.width, 1280 + 64, 'width after 32 px padding');
    assertEqual(dims.height, 800 + 64, 'height after 32 px padding');

    // Crop to x 100..1200, y 60..700 of the padded canvas.
    await drag(edit, 'crop', [100, 60], [1200, 700]);
    await edit.click('#btn-crop-confirm');
    await act.sleep(100);
    await edit.keyboard.press('Escape');
    dims = await act.studioDims(edit);
    assertClose(dims.width, 1100, 2, 'width after crop');
    assertClose(dims.height, 640, 2, 'height after crop');

    const composite = await editorComposite(edit);
    const dl = await exportImage(edit, 'png', 'export-edited.png');
    const file = px.decodePng(dl.buffer);
    assertEqual(file.width, dims.width, 'PNG width');
    assertEqual(file.height, dims.height, 'PNG height');
    // The export redraws the vector layer directly onto the image; the editor
    // composites two canvases. Anti-aliased edges may differ by a rounding step.
    assert(maxDiff(file, composite) <= 3, `edited PNG differs from the editor (max ${maxDiff(file, composite)})`);

    // Rectangle was drawn at x 480 in the original; +32 padding, -100 crop.
    const rectLeft = 480 + 32 - 100;
    const rectTop = 90 + 32 - 60;
    const [r, g, b] = px.pixel(file, rectLeft + 100, rectTop);
    assert(r > 200 && g < 110 && b < 110, `rectangle stroke not where it was drawn (${r},${g},${b})`);
    // The fixture square is still square underneath.
    const square = shapes.boundingBox(file, shapes.isBlack, 100, { x: rectLeft + 20, y: rectTop + 10, w: 260, h: 250 });
    assertClose(square.w, 200, 1, 'square width under the annotation');
    assertClose(square.h, 200, 1, 'square height under the annotation');
    edit.reference = file;
    return `${file.width}×${file.height}`;
  });

  await test('Edited image: JPEG, WebP and PDF carry the same composition', async () => {
    assert(edit.reference, 'edited reference unavailable');
    const ref = edit.reference;
    const jpg = decodeJpeg((await exportImage(edit, 'jpeg', 'export-edited.jpg')).buffer);
    assertEqual(jpg.width, ref.width, 'JPEG width');
    assertEqual(jpg.height, ref.height, 'JPEG height');
    assert(shapes.meanAbsDiff(jpg, ref) < 4, 'edited JPEG differs from the edited PNG');

    const webp = shapes.webpSize((await exportImage(edit, 'webp', 'export-edited.webp')).buffer);
    assertEqual(webp.width, ref.width, 'WebP width');
    assertEqual(webp.height, ref.height, 'WebP height');

    const dl = await exportPdf(edit, { size: 'a4', orientation: 'landscape', layout: 'fit', marginMm: 10 }, 'pdf-edited-a4-landscape-fit.pdf');
    const structure = pdf.readStructure(dl.buffer);
    assertEqual(structure.pages.length, 1, 'page count');
    const stacked = pdf.stackPageImages(structure);
    assertEqual(stacked.width, ref.width, 'PDF image width');
    assertEqual(stacked.height, ref.height, 'PDF image height');
    assert(shapes.meanAbsDiff(stacked, ref) < 4, 'PDF image differs from the edited PNG (annotations missing?)');
    const p = structure.pages[0];
    assertClose((p.width / p.imageWidth) / (p.height / p.imageHeight), 1, 0.0015, 'PDF scale ratio');
  });

  await test('Metadata banners add rows without touching or scaling the image', async () => {
    assert(edit.reference, 'edited reference unavailable');
    const ref = edit.reference;
    await edit.click('#btn-metadata-menu');
    await edit.click('#meta-url-pos-group [data-url-pos="top"]');
    await edit.click('#meta-date-fmt-group [data-date-fmt="iso"]');
    await edit.click('#btn-metadata-menu');
    await act.sleep(100);
    const file = px.decodePng((await exportImage(edit, 'png', 'export-edited-banners.png')).buffer);
    assertEqual(file.width, ref.width, 'width with banners');
    assertEqual(file.height, ref.height + 34 + 34, 'height with a top and a bottom banner');
    // The image between the banners is byte-for-byte the image without them.
    const middle = { width: ref.width, height: ref.height, data: file.data.subarray(34 * file.width * 4, (34 + ref.height) * file.width * 4) };
    assert(shapes.identical(middle, ref), 'image area changed when banners were added');
    const topBanner = px.pixel(file, 600, 17);
    assert(topBanner[0] < 60 && topBanner[1] < 70, 'top banner missing');

    const dl = await exportPdf(edit, { size: 'letter', orientation: 'portrait', layout: 'fit', marginMm: 10 }, 'pdf-edited-banners.pdf');
    const stacked = pdf.stackPageImages(pdf.readStructure(dl.buffer));
    assertEqual(stacked.height, file.height, 'PDF includes both banners');
    assert(shapes.meanAbsDiff(stacked, file) < 4, 'PDF differs from the PNG with banners');
  });

  const redactTab = await ctx.openFixture(SOURCE_URL);
  const redact = await act.captureVisible(ctx, redactTab);
  await redact.bringToFront();

  await test('Redaction is destroyed in the pixels of every exported format', async () => {
    const before = px.decodePng((await exportImage(redact, 'png')).buffer);
    const yellow = (img) => {
      let count = 0;
      for (let y = SECRET.y * d; y < (SECRET.y + SECRET.h) * d; y++) {
        for (let x = SECRET.x * d; x < (SECRET.x + SECRET.w) * d; x++) {
          const [r, g, b] = px.pixel(img, x, y);
          if (r > 200 && g > 160 && b < 110) count++;
        }
      }
      return count;
    };
    assert(yellow(before) > 1000, 'fixture secret box should be visible before redaction');

    await drag(redact, 'redact', [SECRET.x * d - 6, SECRET.y * d - 6], [(SECRET.x + SECRET.w) * d + 6, (SECRET.y + SECRET.h) * d + 6]);
    const png = px.decodePng((await exportImage(redact, 'png', 'export-redacted.png')).buffer);
    const jpg = decodeJpeg((await exportImage(redact, 'jpeg')).buffer);
    const dl = await exportPdf(redact, { size: 'a4', orientation: 'landscape', layout: 'fit', marginMm: 10 }, 'pdf-redacted.pdf');
    const fromPdf = pdf.stackPageImages(pdf.readStructure(dl.buffer));
    for (const [label, img] of [['PNG', png], ['JPEG', jpg], ['PDF', fromPdf]]) {
      assertEqual(yellow(img), 0, `${label}: secret pixels remaining`);
      let bright = 0;
      for (let y = SECRET.y * d + 4; y < (SECRET.y + SECRET.h) * d - 4; y += 2) {
        for (let x = SECRET.x * d + 4; x < (SECRET.x + SECRET.w) * d - 4; x += 2) {
          const [r, g, b] = px.pixel(img, x, y);
          if (Math.max(r, g, b) > 70) bright++;
        }
      }
      assertEqual(bright, 0, `${label}: non-black pixels inside the redacted box`);
    }
  });

  await test('Format limits are reported, never worked around silently (WebP over 16,383 px)', async () => {
    const page = await ctx.openFixture('page.html?h=17000');
    const studio = await act.captureFullPage(ctx, page, { scrollDelay: 100, preflight: false });
    const dims = await act.studioDims(studio);
    assertEqual(dims.height, 17000 * d, 'tall capture height');
    await expectNoDownload(studio, () => studio.click('#btn-export-webp'));
    const toast = await studio.$eval('#toast', (el) => ({ text: el.textContent, error: el.classList.contains('error'), hidden: el.classList.contains('hidden') }));
    assert(toast.error && !toast.hidden && toast.text.includes('WebP'), 'error toast: ' + JSON.stringify(toast));
    // PNG and JPEG of the same image still work at full size.
    const png = px.decodePng((await exportImage(studio, 'png')).buffer);
    assertEqual(png.height, dims.height, 'PNG height of the tall capture');
    const jpg = decodeJpeg((await exportImage(studio, 'jpeg')).buffer);
    assertEqual(jpg.height, dims.height, 'JPEG height of the tall capture');
    await studio.close();
    await page.close();
    return toast.text;
  });

  for (const tab of [wide, tall, edit, redact, wideTab, tallTab, editTab, redactTab]) await tab.close();
};
