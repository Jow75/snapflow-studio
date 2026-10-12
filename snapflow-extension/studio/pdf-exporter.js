/**
 * SnapFlow - PDF Page-Layout Exporter
 * 100% Client-Side, Zero External Dependencies, Zero CDNs.
 *
 * The screenshot's geometry and the paper's geometry are kept separate. Paper size,
 * orientation and margins define a printable box; the image is placed in that box
 * with ONE scale factor used for both axes, so it can never be stretched. Changing
 * orientation changes the page, not the proportions of the screenshot.
 *
 * Units:
 *   image px   pixels of the flattened Studio canvas
 *   PDF pt     1/72 inch; page sizes and placements are in points
 *   mm         only for margins as the user enters them (1 mm = 72 / 25.4 pt)
 *
 * Layout rules (all modes):
 *   - scale s (pt per image px) is the same horizontally and vertically
 *   - the image is never enlarged beyond 100% (1 image px = 1/96 inch = 0.75 pt)
 *   - placement is centred horizontally and aligned to the top margin
 *
 * The PDF embeds the flattened image (annotations, redactions, padding and banners
 * already rasterised). It does not contain editable layers.
 */

class SmartPdfExporter {
  /**
   * Page dimensions in PDF points (72 points = 1 inch)
   */
  static PAGE_SIZES = {
    a4: { width: 595.28, height: 841.89 },     // 210 x 297 mm
    letter: { width: 612.00, height: 792.00 }  // 8.5 x 11 in
  };

  static POINTS_PER_MM = 72 / 25.4;
  static POINTS_PER_PIXEL = 0.75;   // 96 px per inch: the image at 100%
  static MAX_PAGE_POINTS = 14400;   // PDF's 200-inch page limit
  static JPEG_QUALITY = 0.92;

  /**
   * Finds the best row at or above `nominalY` to end a page on: a row of uniform
   * colour (a gap between lines or sections) so text is not sliced through.
   * Works on any background colour, not only white.
   *
   * @param {CanvasRenderingContext2D} ctx Source canvas 2D context
   * @param {number} width Canvas total width
   * @param {number} nominalY Last row the page can hold (exclusive upper bound of the page)
   * @param {number} searchRadius How many rows above nominalY may be given up
   * @returns {number} Split row, always within [nominalY - searchRadius, nominalY]
   */
  static findBestSplitRow(ctx, width, nominalY, searchRadius = 90) {
    const maxY = Math.min(ctx.canvas.height - 1, Math.round(nominalY));
    const minY = Math.max(1, Math.round(nominalY - searchRadius));
    if (minY >= maxY) return nominalY;

    const sampleHeight = maxY - minY + 1;
    // The outer 5% on each side is skipped so scrollbars and side borders do not count.
    const sampleX = Math.round(width * 0.05);
    const sampleWidth = Math.round(width * 0.9);
    const data = ctx.getImageData(sampleX, minY, sampleWidth, sampleHeight).data;
    const step = Math.max(1, Math.floor(sampleWidth / 160));

    let bestY = nominalY;
    let bestSpread = Infinity;

    // Scan upward from the nominal boundary: the first uniform row loses the least space.
    for (let row = sampleHeight - 1; row >= 0; row--) {
      const rowOffset = row * sampleWidth * 4;
      let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
      for (let col = 0; col < sampleWidth; col += step) {
        const idx = rowOffset + col * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
        if (b < minB) minB = b;
        if (b > maxB) maxB = b;
      }
      const spread = Math.max(maxR - minR, maxG - minG, maxB - minB);
      if (spread <= 6) return minY + row;
      if (spread < bestSpread) {
        bestSpread = spread;
        bestY = minY + row;
      }
    }

    // No clean gap in range. Only leave the nominal boundary for a clearly calmer row.
    return bestSpread < 40 ? bestY : nominalY;
  }

  /**
   * Computes page geometry and where each part of the image goes. Pure arithmetic:
   * no canvas access, so the dialog can preview the result and tests can verify it.
   *
   * @param {number} imageWidth  flattened image width in px
   * @param {number} imageHeight flattened image height in px
   * @param {Object} options
   * @param {'a4'|'letter'|'image'} [options.size]  'image' sizes one page to the image
   * @param {'portrait'|'landscape'} [options.orientation]
   * @param {'split'|'fit'} [options.layout]  split across pages, or whole image on one page
   * @param {number} [options.marginMm]
   * @param {(nominalY:number, radius:number) => number} [findSplit] smart page-break finder
   * @returns {Object} { pageWidthPt, pageHeightPt, marginPt, scale, percent, pages: [...] }
   *          Each page: { srcY, srcH } in image px and { x, y, width, height } in points,
   *          with y measured from the bottom of the page as PDF requires.
   */
  static planLayout(imageWidth, imageHeight, options = {}, findSplit = null) {
    if (!(imageWidth > 0) || !(imageHeight > 0)) throw new Error('There is no image to export.');

    const size = options.size || 'a4';
    const layout = options.layout === 'fit' ? 'fit' : 'split';
    const marginPt = Math.max(0, Number(options.marginMm) || 0) * this.POINTS_PER_MM;

    // A. One page shaped like the image.
    if (size === 'image') {
      const room = this.MAX_PAGE_POINTS - marginPt * 2;
      const scale = Math.min(this.POINTS_PER_PIXEL, room / imageWidth, room / imageHeight);
      const width = imageWidth * scale;
      const height = imageHeight * scale;
      return {
        size,
        layout: 'fit',
        pageWidthPt: width + marginPt * 2,
        pageHeightPt: height + marginPt * 2,
        marginPt,
        scale,
        percent: (scale / this.POINTS_PER_PIXEL) * 100,
        pages: [{ srcY: 0, srcH: imageHeight, x: marginPt, y: marginPt, width, height }]
      };
    }

    const base = this.PAGE_SIZES[size] || this.PAGE_SIZES.a4;
    const landscape = options.orientation === 'landscape';
    const pageWidthPt = landscape ? base.height : base.width;
    const pageHeightPt = landscape ? base.width : base.height;
    const boxWidth = pageWidthPt - marginPt * 2;
    const boxHeight = pageHeightPt - marginPt * 2;
    if (boxWidth <= 1 || boxHeight <= 1) throw new Error('The margins leave no room on the page.');

    const place = (srcY, srcH, scale) => {
      const width = imageWidth * scale;
      const height = srcH * scale;
      return {
        srcY,
        srcH,
        x: marginPt + (boxWidth - width) / 2,
        y: pageHeightPt - marginPt - height,
        width,
        height
      };
    };

    // B. Whole image on one page.
    if (layout === 'fit') {
      const scale = Math.min(this.POINTS_PER_PIXEL, boxWidth / imageWidth, boxHeight / imageHeight);
      return {
        size, layout, pageWidthPt, pageHeightPt, marginPt, scale,
        percent: (scale / this.POINTS_PER_PIXEL) * 100,
        pages: [place(0, imageHeight, scale)]
      };
    }

    // C. Fit the width, continue down as many pages as the height needs.
    const scale = Math.min(this.POINTS_PER_PIXEL, boxWidth / imageWidth);
    // Tiny epsilon so a page that fits exactly is not lost to floating-point error.
    const rowsPerPage = Math.max(1, Math.floor(boxHeight / scale + 1e-6));

    const pages = [];
    const radius = Math.min(160, Math.floor(rowsPerPage * 0.15));
    let y = 0;
    while (y < imageHeight) {
      const remaining = imageHeight - y;
      if (remaining <= rowsPerPage) {
        pages.push(place(y, remaining, scale));
        break;
      }
      const nominal = y + rowsPerPage;
      let split = findSplit && radius >= 4 ? Math.round(findSplit(nominal, radius)) : nominal;
      // A break may give up some space but may never exceed the page or stall.
      if (!(split > y) || split > nominal || split < nominal - radius) split = nominal;
      pages.push(place(y, split - y, scale));
      y = split;
    }

    return {
      size, layout, pageWidthPt, pageHeightPt, marginPt, scale,
      percent: (scale / this.POINTS_PER_PIXEL) * 100,
      pages
    };
  }

  static formatNumber(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  /**
   * Assembles a PDF 1.4 file from pre-encoded JPEG pages.
   *
   * @param {Object} layout result of planLayout()
   * @param {Array<{bytes: Uint8Array, width: number, height: number}>} images one per page
   * @returns {Uint8Array} complete PDF file
   */
  static buildPdf(layout, images) {
    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [];
    let length = 0;

    const push = (chunk) => {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      parts.push(bytes);
      length += bytes.length;
    };
    const beginObject = (id) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
    };
    const n = (v) => this.formatNumber(v);

    const pageCount = layout.pages.length;
    const INFO = 3;
    const firstPageObject = 4;
    const objectCount = firstPageObject + pageCount * 3;

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // marks the file as binary

    beginObject(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    beginObject(2);
    const kids = layout.pages.map((_, p) => `${firstPageObject + p * 3} 0 R`).join(' ');
    push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);

    beginObject(INFO);
    push('<< /Producer (Snap Flow Studio) >>\nendobj\n');

    for (let p = 0; p < pageCount; p++) {
      const pageId = firstPageObject + p * 3;
      const contentId = pageId + 1;
      const imageId = pageId + 2;
      const placement = layout.pages[p];
      const image = images[p];

      beginObject(pageId);
      push(
        `<< /Type /Page /Parent 2 0 R\n` +
        `   /MediaBox [0 0 ${n(layout.pageWidthPt)} ${n(layout.pageHeightPt)}]\n` +
        `   /Contents ${contentId} 0 R\n` +
        `   /Resources << /XObject << /Im${p} ${imageId} 0 R >> >>\n` +
        `>>\nendobj\n`
      );

      // Width and height come from one scale factor, so the image keeps its proportions.
      const content =
        `q\n${n(placement.width)} 0 0 ${n(placement.height)} ${n(placement.x)} ${n(placement.y)} cm\n/Im${p} Do\nQ\n`;
      beginObject(contentId);
      push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

      beginObject(imageId);
      push(
        `<< /Type /XObject /Subtype /Image\n` +
        `   /Width ${image.width} /Height ${image.height}\n` +
        `   /ColorSpace /DeviceRGB /BitsPerComponent 8\n` +
        `   /Filter /DCTDecode\n` +
        `   /Length ${image.bytes.length}\n` +
        `>>\nstream\n`
      );
      push(image.bytes);
      push('\nendstream\nendobj\n');
    }

    const xrefOffset = length;
    push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
    for (let id = 1; id < objectCount; id++) {
      push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info ${INFO} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const file = new Uint8Array(length);
    let cursor = 0;
    for (const part of parts) {
      file.set(part, cursor);
      cursor += part.length;
    }
    return file;
  }

  /** Renders rows [srcY, srcY + srcH) of the source to a JPEG, at full resolution. */
  static encodePage(canvas, placement) {
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = placement.srcH;
    const ctx = pageCanvas.getContext('2d');
    // JPEG has no transparency; anything transparent becomes paper white.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(
      canvas,
      0, placement.srcY, canvas.width, placement.srcH,
      0, 0, canvas.width, placement.srcH
    );

    return new Promise((resolve, reject) => {
      pageCanvas.toBlob(async (blob) => {
        if (!blob || blob.type !== 'image/jpeg') {
          reject(new Error('The browser could not encode a page of this size.'));
          return;
        }
        resolve({
          bytes: new Uint8Array(await blob.arrayBuffer()),
          width: pageCanvas.width,
          height: pageCanvas.height
        });
      }, 'image/jpeg', this.JPEG_QUALITY);
    });
  }

  /**
   * Exports a canvas to PDF.
   *
   * @param {HTMLCanvasElement} canvas Flattened source canvas
   * @param {Object} options see planLayout(); `smartSplit: false` disables gap detection
   * @returns {Promise<Blob>} Complete PDF binary blob
   */
  static async exportToPdf(canvas, options = {}) {
    let findSplit = null;
    if (options.smartSplit !== false) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      findSplit = (nominalY, radius) => this.findBestSplitRow(ctx, canvas.width, nominalY, radius);
    }

    const layout = this.planLayout(canvas.width, canvas.height, options, findSplit);
    const images = [];
    for (const placement of layout.pages) {
      images.push(await this.encodePage(canvas, placement));
    }
    return new Blob([this.buildPdf(layout, images)], { type: 'application/pdf' });
  }
}

// Export for module/worker or window context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmartPdfExporter;
} else if (typeof globalThis !== 'undefined') {
  globalThis.SmartPdfExporter = SmartPdfExporter;
}
