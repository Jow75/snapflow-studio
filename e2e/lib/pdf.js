/**
 * PDF inspection for the export tests. Two independent readers are used:
 *
 *   readStructure()  a direct parse of the file's objects: page boxes, the placement
 *                    matrix of every image, and the embedded JPEG data itself
 *   renderWithPdfJs() Mozilla's pdf.js, which must accept the file (valid xref,
 *                    streams, lengths) and whose rendered pages are measured
 */

const path = require('path');
const { pathToFileURL } = require('url');
const jpeg = require('jpeg-js');

function readStructure(buffer) {
  const text = buffer.toString('latin1');
  if (!text.startsWith('%PDF-')) throw new Error('Not a PDF file');

  const pages = [];
  const pageRe = /\/Type \/Page\b[^]*?\/MediaBox \[([^\]]+)\][^]*?\/Contents (\d+) 0 R[^]*?\/Im\d+ (\d+) 0 R/g;
  let match;
  while ((match = pageRe.exec(text))) {
    const mediaBox = match[1].trim().split(/\s+/).map(Number);
    const contentId = match[2];
    const imageId = match[3];

    const content = new RegExp(`\\n${contentId} 0 obj\\n<< /Length (\\d+) >>\\nstream\\n([^]*?)endstream`).exec(text);
    if (!content) throw new Error(`Content stream ${contentId} not found`);
    if (content[2].length !== Number(content[1])) throw new Error(`Content stream ${contentId} has a wrong /Length`);
    const cm = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/.exec(content[2]);
    if (!cm) throw new Error(`No placement matrix in content stream ${contentId}`);
    const [a, b, c, d, e, f] = cm.slice(1).map(Number);

    const image = new RegExp(
      `\\n${imageId} 0 obj\\n<<[^]*?/Width (\\d+) /Height (\\d+)[^]*?/Length (\\d+)\\s*>>\\nstream\\n`
    ).exec(text);
    if (!image) throw new Error(`Image object ${imageId} not found`);
    const start = image.index + image[0].length;
    const length = Number(image[3]);
    const bytes = buffer.subarray(start, start + length);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`Image ${imageId} is not JPEG data`);
    if (text.substr(start + length, 10) !== '\nendstream') throw new Error(`Image ${imageId} has a wrong /Length`);

    pages.push({
      pageWidth: mediaBox[2] - mediaBox[0],
      pageHeight: mediaBox[3] - mediaBox[1],
      matrix: { a, b, c, d, e, f },
      // Placement on the page in points; (x, y) is the bottom-left corner.
      x: e,
      y: f,
      width: a,
      height: d,
      imageWidth: Number(image[1]),
      imageHeight: Number(image[2]),
      jpeg: bytes
    });
  }

  const count = /\/Type \/Pages[^]*?\/Count (\d+)/.exec(text);
  return { pages, declaredCount: count ? Number(count[1]) : null };
}

/** Decodes every page's JPEG and stacks them into one RGBA image, in page order. */
function stackPageImages(structure) {
  const decoded = structure.pages.map((p) => jpeg.decode(p.jpeg, { useTArray: true, maxMemoryUsageInMB: 2048 }));
  const width = decoded[0].width;
  const height = decoded.reduce((sum, img) => sum + img.height, 0);
  const data = new Uint8Array(width * height * 4);
  let offset = 0;
  for (const img of decoded) {
    if (img.width !== width) throw new Error('Page images have different widths');
    data.set(img.data, offset);
    offset += img.data.length;
  }
  return { width, height, data };
}

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    const entry = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
    pdfjsPromise = import(pathToFileURL(entry).href);
  }
  return pdfjsPromise;
}

/**
 * Opens the file with pdf.js and renders the requested pages.
 * @returns {{ numPages, pages: [{ width, height, image?: {width,height,data} }] }}
 *          page sizes in points; images are RGBA at `scale` px per point
 */
async function renderWithPdfJs(buffer, { scale = 2, renderPages = [1] } = {}) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const out = { numPages: doc.numPages, pages: [] };
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const entry = { width: base.width, height: base.height };
    if (renderPages.includes(i)) {
      const viewport = page.getViewport({ scale });
      const target = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: target.context, viewport }).promise;
      const pixels = target.context.getImageData(0, 0, target.canvas.width, target.canvas.height);
      entry.image = { width: pixels.width, height: pixels.height, data: pixels.data };
      doc.canvasFactory.destroy(target);
    }
    out.pages.push(entry);
    page.cleanup();
  }
  await doc.destroy();
  return out;
}

module.exports = { readStructure, stackPageImages, renderWithPdfJs };
