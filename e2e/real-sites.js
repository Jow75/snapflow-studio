/**
 * Captures live websites with Full Page and saves the result for visual review.
 * These are regression targets, not pass/fail tests: real pages change, so the
 * images are meant to be looked at.
 *
 *   node real-sites.js [url ...]
 *
 * Besides the image, each capture reports repeated horizontal bands: a block of
 * rows that appears more than once in the output is the signature of a sticky
 * header or hero section being stitched in twice.
 */

const fs = require('fs');
const path = require('path');
const { launch, OUTPUT_DIR } = require('./lib/harness');
const px = require('./lib/pixels');
const act = require('./lib/actions');

const DEFAULT_SITES = [
  'https://www.baziqhue.co.ke',
  'https://snapflow-studio-app.netlify.app/',
  'https://snapflow-studio-app.netlify.app/privacy.html'
];

/** Hash of one image row, sampled across its width. */
function rowHash(img, y) {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(img.width / 256));
  for (let x = 0; x < img.width; x += step) {
    const o = (y * img.width + x) * 4;
    h = Math.imul(h ^ img.data[o], 16777619);
    h = Math.imul(h ^ img.data[o + 1], 16777619);
    h = Math.imul(h ^ img.data[o + 2], 16777619);
  }
  return h >>> 0;
}

function rowIsFlat(img, y) {
  const o = y * img.width * 4;
  const step = Math.max(1, Math.floor(img.width / 256));
  for (let x = step; x < img.width; x += step) {
    const p = o + x * 4;
    if (Math.abs(img.data[p] - img.data[o]) > 6 || Math.abs(img.data[p + 1] - img.data[o + 1]) > 6 || Math.abs(img.data[p + 2] - img.data[o + 2]) > 6) {
      return false;
    }
  }
  return true;
}

/**
 * Finds bands of at least `minRows` consecutive, non-blank rows that occur at two
 * different vertical positions.
 */
function findRepeatedBands(img, minRows = 40) {
  const hashes = new Uint32Array(img.height);
  const flat = new Uint8Array(img.height);
  for (let y = 0; y < img.height; y++) {
    hashes[y] = rowHash(img, y);
    flat[y] = rowIsFlat(img, y) ? 1 : 0;
  }
  const firstSeen = new Map();
  const bands = [];
  let y = 0;
  while (y < img.height) {
    const earlier = firstSeen.get(hashes[y]);
    if (earlier !== undefined && !flat[y] && earlier + minRows <= y) {
      let length = 0;
      let detailed = 0;
      while (y + length < img.height && earlier + length < y && hashes[earlier + length] === hashes[y + length]) {
        if (!flat[y + length]) detailed++;
        length++;
      }
      if (length >= minRows && detailed >= minRows * 0.6) {
        bands.push({ firstAt: earlier, repeatedAt: y, rows: length });
        y += length;
        continue;
      }
    }
    if (!firstSeen.has(hashes[y])) firstSeen.set(hashes[y], y);
    y++;
  }
  return bands;
}

(async () => {
  const sites = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SITES;
  const ctx = await launch({ dpr: 1 });
  const report = [];
  try {
    for (const url of sites) {
      const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 60);
      try {
        const page = await ctx.openFixture(url);
        await act.sleep(1500);
        const metrics = await page.evaluate(() => ({
          scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
          vw: innerWidth,
          vh: innerHeight,
          fixed: [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === 'fixed').length,
          sticky: [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).position === 'sticky').length
        }));
        const before = await act.pageState(page);
        const started = Date.now();
        const studio = await act.captureFullPage(ctx, page, {}, 300000);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const buffer = await ctx.readCanvas(studio, `site-${slug}.png`);
        const img = px.decodePng(buffer);
        const notices = await act.studioNotices(studio);
        const after = await act.pageState(page);
        const entry = {
          url,
          image: `site-${slug}.png`,
          size: `${img.width}×${img.height}`,
          pageScrollHeight: metrics.scrollHeight,
          fixedElements: metrics.fixed,
          stickyElements: metrics.sticky,
          seconds,
          notices,
          restored: JSON.stringify(before) === JSON.stringify(after),
          repeatedBands: findRepeatedBands(img)
        };
        report.push(entry);
        console.log(JSON.stringify(entry, null, 1));
        await studio.close();
        await page.close();
      } catch (err) {
        report.push({ url, error: err.message });
        console.log(`${url}: ERROR ${err.message}`);
      }
    }
  } finally {
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'real-sites.json'), JSON.stringify(report, null, 2));
})();
