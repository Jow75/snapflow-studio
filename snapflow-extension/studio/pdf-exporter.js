/**
 * SnapFlow - Smart-Split Multi-Page PDF Exporter
 * 100% Client-Side, Zero External Dependencies, Zero CDNs.
 * Implements intelligent horizontal whitespace gutter scanning to prevent slicing text lines in half.
 */

class SmartPdfExporter {
  /**
   * Page dimensions in PDF points (72 points = 1 inch)
   */
  static PAGE_SIZES = {
    a4: { width: 595.28, height: 841.89 },     // 210 x 297 mm
    letter: { width: 612.00, height: 792.00 }  // 8.5 x 11 in
  };

  /**
   * Scans a vertical slice of canvas pixels to find horizontal whitespace gutters
   * (empty gaps between paragraphs or sections).
   *
   * @param {CanvasRenderingContext2D} ctx Source canvas 2D context
   * @param {number} width Canvas total width
   * @param {number} nominalY Nominal page boundary Y
   * @param {number} searchRadius Search window (pixels above and below nominalY)
   * @returns {number} Optimal split Y coordinate
   */
  static findBestSplitRow(ctx, width, nominalY, searchRadius = 90) {
    const minY = Math.max(10, Math.round(nominalY - searchRadius));
    const maxY = Math.min(ctx.canvas.height - 10, Math.round(nominalY + searchRadius * 0.4));

    if (minY >= maxY) return nominalY;

    const sampleHeight = maxY - minY + 1;
    // Sample a strip across the middle 80% of width to avoid scrollbars / side borders
    const sampleX = Math.round(width * 0.05);
    const sampleWidth = Math.round(width * 0.9);

    const imgData = ctx.getImageData(sampleX, minY, sampleWidth, sampleHeight);
    const data = imgData.data;

    let bestY = nominalY;
    let maxWhitespaceScore = -1;

    for (let row = 0; row < sampleHeight; row++) {
      let whitePixelCount = 0;
      let totalVariation = 0;
      const rowOffset = row * sampleWidth * 4;

      // Sample 80 points across the row
      const step = Math.max(1, Math.floor(sampleWidth / 80));
      let pointsChecked = 0;

      for (let col = 0; col < sampleWidth; col += step) {
        const idx = rowOffset + col * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Luminance calculation
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 240) {
          whitePixelCount++;
        }
        // Variance from white
        totalVariation += Math.abs(255 - lum);
        pointsChecked++;
      }

      // Whitespace score: higher when row is mostly white/uniform background
      const rowScore = (whitePixelCount / pointsChecked) * 1000 - totalVariation;
      
      // Proximity bonus: slightly prefer splits closer to nominalY
      const actualY = minY + row;
      const distFromNominal = Math.abs(actualY - nominalY);
      const proximityWeight = Math.max(0, 1 - distFromNominal / searchRadius);
      const totalScore = rowScore + proximityWeight * 200;

      if (totalScore > maxWhitespaceScore) {
        maxWhitespaceScore = totalScore;
        bestY = actualY;
      }
    }

    return bestY;
  }

  /**
   * Slices the source canvas into page segments using smart whitespace splits.
   *
   * @param {HTMLCanvasElement} canvas Stitched source canvas
   * @param {Object} options { size: 'a4'|'letter', orientation: 'portrait'|'landscape', marginMm: number }
   * @returns {Array<HTMLCanvasElement>} Array of sliced page canvases
   */
  static sliceCanvasForPages(canvas, options = {}) {
    const sizeName = options.size || 'a4';
    const orientation = options.orientation || 'portrait';
    const baseSize = this.PAGE_SIZES[sizeName] || this.PAGE_SIZES.a4;

    const pageWidthPt = orientation === 'landscape' ? baseSize.height : baseSize.width;
    const pageHeightPt = orientation === 'landscape' ? baseSize.width : baseSize.height;

    // Aspect ratio of printable area (height / width)
    const pageAspect = pageHeightPt / pageWidthPt;
    const nominalPageHeightPx = Math.round(canvas.width * pageAspect);

    const pages = [];
    const ctx = canvas.getContext('2d');
    let currentY = 0;

    while (currentY < canvas.height) {
      const remainingHeight = canvas.height - currentY;

      if (remainingHeight <= nominalPageHeightPx * 1.05) {
        // Last page fits within remaining space
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = remainingHeight;
        const pageCtx = pageCanvas.getContext('2d');
        pageCtx.fillStyle = '#ffffff';
        pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        pageCtx.drawImage(canvas, 0, currentY, canvas.width, remainingHeight, 0, 0, canvas.width, remainingHeight);
        pages.push(pageCanvas);
        break;
      } else {
        // Find smart split boundary near nominal page cutoff
        const nominalSplitY = currentY + nominalPageHeightPx;
        const bestSplitY = this.findBestSplitRow(ctx, canvas.width, nominalSplitY);
        const sliceHeight = bestSplitY - currentY;

        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = sliceHeight;
        const pageCtx = pageCanvas.getContext('2d');
        pageCtx.fillStyle = '#ffffff';
        pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        pageCtx.drawImage(canvas, 0, currentY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        pages.push(pageCanvas);

        currentY = bestSplitY;
      }
    }

    return { pages, pageWidthPt, pageHeightPt };
  }

  /**
   * Synthesizes a valid standard multi-page PDF document buffer (%PDF-1.4).
   *
   * @param {HTMLCanvasElement} canvas Stitched source canvas
   * @param {Object} options { size: 'a4'|'letter', orientation: 'portrait'|'landscape' }
   * @returns {Promise<Blob>} Complete PDF binary blob
   */
  static async exportToPdf(canvas, options = {}) {
    const { pages, pageWidthPt, pageHeightPt } = this.sliceCanvasForPages(canvas, options);

    // Convert each page canvas to JPEG binary bytes
    const pageJpegs = [];
    for (let i = 0; i < pages.length; i++) {
      const dataUrl = pages[i].toDataURL('image/jpeg', 0.92);
      const base64 = dataUrl.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) {
        bytes[j] = binaryStr.charCodeAt(j);
      }
      pageJpegs.push({
        bytes,
        width: pages[i].width,
        height: pages[i].height
      });
    }

    // Build PDF structures
    const numPages = pageJpegs.length;
    let pdfParts = [];
    let xrefOffsets = [0]; // 0 is reserved

    function addString(str) {
      pdfParts.push(new TextEncoder().encode(str));
    }

    function addBytes(uint8Arr) {
      pdfParts.push(uint8Arr);
    }

    function currentOffset() {
      return pdfParts.reduce((acc, curr) => acc + curr.length, 0);
    }

    // Header
    addString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    // Obj 1: Catalog
    xrefOffsets[1] = currentOffset();
    addString('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // Obj 2: Pages Collection
    xrefOffsets[2] = currentOffset();
    const pageObjIds = [];
    for (let p = 0; p < numPages; p++) {
      // Each page uses 3 objects: Page (baseObj), Content Stream (baseObj+1), Image XObject (baseObj+2)
      pageObjIds.push(3 + p * 3);
    }
    const kidsStr = pageObjIds.map((id) => `${id} 0 R`).join(' ');
    addString(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${numPages} >>\nendobj\n`);

    // Generate objects for each page
    for (let p = 0; p < numPages; p++) {
      const pageObjId = 3 + p * 3;
      const contentObjId = pageObjId + 1;
      const imageObjId = pageObjId + 2;
      const img = pageJpegs[p];

      // Obj: Page
      xrefOffsets[pageObjId] = currentOffset();
      addString(
        `${pageObjId} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R\n` +
        `   /MediaBox [0 0 ${pageWidthPt} ${pageHeightPt}]\n` +
        `   /Contents ${contentObjId} 0 R\n` +
        `   /Resources << /XObject << /Im${p} ${imageObjId} 0 R >> >>\n` +
        `>>\nendobj\n`
      );

      // Obj: Content Stream (scale and draw image to fill page bounds)
      const contentStream = `q\n${pageWidthPt} 0 0 ${pageHeightPt} 0 0 cm\n/Im${p} Do\nQ\n`;
      xrefOffsets[contentObjId] = currentOffset();
      addString(
        `${contentObjId} 0 obj\n` +
        `<< /Length ${contentStream.length} >>\n` +
        `stream\n${contentStream}\nendstream\nendobj\n`
      );

      // Obj: Image XObject (DCTDecode / JPEG)
      xrefOffsets[imageObjId] = currentOffset();
      addString(
        `${imageObjId} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image\n` +
        `   /Width ${img.width} /Height ${img.height}\n` +
        `   /ColorSpace /DeviceRGB /BitsPerComponent 8\n` +
        `   /Filter /DCTDecode\n` +
        `   /Length ${img.bytes.length}\n` +
        `>>\nstream\n`
      );
      addBytes(img.bytes);
      addString('\nendstream\nendobj\n');
    }

    // Cross-Reference Table
    const startXrefOffset = currentOffset();
    const totalObjs = 3 + numPages * 3;
    addString(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
    for (let i = 1; i < totalObjs; i++) {
      const offsetStr = String(xrefOffsets[i] || 0).padStart(10, '0');
      addString(`${offsetStr} 00000 n \n`);
    }

    // Trailer
    addString(
      `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\n` +
      `startxref\n${startXrefOffset}\n%%EOF\n`
    );

    return new Blob(pdfParts, { type: 'application/pdf' });
  }
}

// Export for module/worker or window context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmartPdfExporter;
} else if (typeof globalThis !== 'undefined') {
  globalThis.SmartPdfExporter = SmartPdfExporter;
}
