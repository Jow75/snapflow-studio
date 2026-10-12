/**
 * Studio editor layout: the left tool panel must stay fully usable at the window
 * heights people actually have, without moving or resizing the canvas area.
 *
 * Window sizes are the page area Chrome leaves on common Windows displays:
 *   1920 × 937   1080p at 100 % scaling
 *   1536 × 730   1080p at 125 % scaling (the default on most laptops)
 *   1366 × 633   768p laptop
 *   1229 × 584   the 125 % display with the browser zoomed to 125 %
 *   1280 × 480   a short, resized window
 */

const path = require('path');
const { group, test, assert, assertEqual } = require('../lib/runner');
const act = require('../lib/actions');
const px = require('../lib/pixels');

const SIZES = [
  { width: 1920, height: 937, label: '1080p at 100%' },
  { width: 1536, height: 730, label: '1080p at 125%' },
  { width: 1366, height: 633, label: '768p laptop' },
  { width: 1229, height: 584, label: '125% display, browser zoom 125%' },
  { width: 1280, height: 480, label: 'short window' }
];

/** From this page height up, the whole panel must be visible without scrolling it. */
const NO_SCROLL_FROM = 700;

module.exports = async function studioLayoutSuite(ctx) {
  async function openStudio(size) {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: ctx.dpr });
    await page.goto(`chrome-extension://${ctx.extensionId}/studio/viewer.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('base-canvas').width > 0);
    await page.bringToFront();
    return page;
  }

  /** Geometry of the panel and of every control in it, after bringing each into view. */
  const measure = (page) => page.evaluate(() => {
    const bar = document.querySelector('.floating-toolbar');
    const barRect = bar.getBoundingClientRect();
    const controls = [];
    for (const el of bar.querySelectorAll('button, select, input[type="color"]')) {
      if (!el.offsetParent || el.offsetWidth === 0) continue; // not displayed
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      controls.push({
        name: el.id || el.dataset.tool || el.title,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        hit: hit === el || el.contains(hit)
      });
    }
    bar.scrollTop = 0;
    const view = document.getElementById('viewport-container').getBoundingClientRect();
    const stroke = document.getElementById('tool-stroke-width');
    const strokeRect = stroke.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      bar: { top: barRect.top, bottom: barRect.bottom, left: barRect.left, right: barRect.right, scrollHeight: bar.scrollHeight, clientHeight: bar.clientHeight },
      strokeAtRest: { top: strokeRect.top, bottom: strokeRect.bottom },
      strokeOptions: Array.from(stroke.options).map((o) => o.value),
      controls,
      canvasArea: { x: view.left, y: view.top, w: view.width, h: view.height }
    };
  });

  function assertReachable(m, context) {
    assert(m.bar.top >= 54 && m.bar.bottom <= m.innerHeight, `${context}: the panel itself must fit in the window (${m.bar.top}..${m.bar.bottom} of ${m.innerHeight})`);
    for (const c of m.controls) {
      assert(c.top >= m.bar.top - 0.5 && c.bottom <= m.bar.bottom + 0.5, `${context}: "${c.name}" cannot be brought fully into the panel (${c.top}..${c.bottom}, panel ${m.bar.top}..${m.bar.bottom})`);
      assert(c.left >= m.bar.left - 0.5 && c.right <= m.bar.right + 0.5, `${context}: "${c.name}" is cut off sideways (${c.left}..${c.right}, panel ${m.bar.left}..${m.bar.right})`);
      assert(c.hit, `${context}: "${c.name}" is covered by something else`);
    }
  }

  group(`STUDIO TOOL PANEL (device pixel ratio ${ctx.dpr})`);

  for (const size of SIZES) {
    await test(`${size.width} × ${size.height} (${size.label}): Stroke Thickness and every other control can be used`, async () => {
      const page = await openStudio(size);
      try {
        return await checkPanel(page, size);
      } finally {
        await page.close();
      }
    });
  }

  group(`STUDIO HEADER (device pixel ratio ${ctx.dpr})`);

  // 1024 is half of a 1080p display at 125 % scaling plus a little: a snapped window.
  for (const size of [...SIZES, { width: 1024, height: 640, label: 'narrow window' }]) {
    await test(`${size.width} × ${size.height} (${size.label}): every header control, Export PDF included, is inside the window`, async () => {
      const page = await openStudio(size);
      try {
        const m = await page.evaluate(() => {
          const header = document.querySelector('.studio-header');
          const controls = [];
          for (const el of header.querySelectorAll('.header-left > *, .header-center button, .header-right button')) {
            if (!el.offsetParent || el.offsetWidth === 0) continue; // not displayed
            if (el.closest('.studio-dropdown')) continue;           // closed menus
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            controls.push({
              name: el.id || el.className,
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              hit: hit === el || el.contains(hit),
              oneLine: r.height <= 40,
              named: !el.matches('button') || !!(el.title || el.textContent.trim())
            });
          }
          const box = (sel) => header.querySelector(sel).getBoundingClientRect();
          return {
            innerWidth: window.innerWidth,
            pageScrollWidth: document.documentElement.scrollWidth,
            left: box('.header-left').right,
            centre: [box('.header-center').left, box('.header-center').right],
            right: box('.header-right').left,
            controls
          };
        });
        await page.screenshot({ path: path.join(ctx.outputDir, `ui-studio-header-${size.width}x${size.height}.png`), clip: { x: 0, y: 0, width: size.width, height: 60 } });

        for (const name of ['btn-export-png', 'btn-export-jpeg', 'btn-export-webp', 'btn-export-pdf', 'btn-copy-clipboard', 'btn-undo', 'btn-zoom-in']) {
          assert(m.controls.some((c) => c.name === name), `"${name}" is shown`);
        }
        for (const c of m.controls) {
          assert(c.left >= 0 && c.right <= m.innerWidth + 0.5, `"${c.name}" is cut off (${Math.round(c.left)}..${Math.round(c.right)} of ${m.innerWidth})`);
          assert(c.top >= 0 && c.bottom <= 54.5, `"${c.name}" does not fit the header row (${Math.round(c.top)}..${Math.round(c.bottom)})`);
          assert(c.hit, `"${c.name}" is covered by something else`);
          assert(c.oneLine, `"${c.name}" wraps onto more than one line`);
          assert(c.named, `"${c.name}" has neither a label nor a tooltip`);
        }
        assert(m.left <= m.centre[0] + 0.5 && m.centre[1] <= m.right + 0.5, 'the three header groups do not overlap');
        assert(m.pageScrollWidth <= m.innerWidth, 'the page does not scroll sideways');
        const pdf = m.controls.find((c) => c.name === 'btn-export-pdf');
        return `Export PDF at x=${Math.round(pdf.left)}–${Math.round(pdf.right)} of ${m.innerWidth}`;
      } finally {
        await page.close();
      }
    });
  }

  async function checkPanel(page, size) {
    const m = await measure(page);
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-studio-panel-${size.width}x${size.height}.png`) });

    assertEqual(JSON.stringify(m.strokeOptions), JSON.stringify(['2', '4', '8', '14']), 'thickness choices');
    assert(m.controls.some((c) => c.name === 'tool-stroke-width') && m.controls.some((c) => c.name === 'tool-font-size'), 'thickness and font size are in the panel');
    assertReachable(m, 'nothing selected');

    const scrolls = m.bar.scrollHeight > m.bar.clientHeight + 1;
    if (size.height >= NO_SCROLL_FROM) {
      assert(!scrolls, `the panel must not need scrolling at this height (content ${m.bar.scrollHeight}px in ${m.bar.clientHeight}px)`);
      assert(m.strokeAtRest.bottom <= m.innerHeight - 8, `Stroke Thickness sits clear of the window edge (${m.strokeAtRest.bottom} of ${m.innerHeight})`);
    }

    // The canvas area is exactly the window below the header, as before.
    assertEqual(JSON.stringify(m.canvasArea), JSON.stringify({ x: 0, y: 54, w: m.innerWidth, h: m.innerHeight - 54 }), 'canvas area');

    // Each thickness can be chosen and takes effect on the next shape.
    for (const value of m.strokeOptions) {
      await page.select('#tool-stroke-width', value);
      assertEqual(await page.$eval('#tool-stroke-width', (el) => el.value), value, 'chosen thickness');
    }
    await page.select('#tool-stroke-width', '8');

    // Draw a rectangle: it becomes selected, which adds the layer buttons to the panel.
    await page.click('.floating-toolbar [data-tool="rect"]');
    const box = await page.$eval('#overlay-canvas', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, window.innerHeight - r.top) };
    });
    const from = { x: box.x + box.w * 0.45, y: box.y + box.h * 0.3 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 90, from.y + 60, { steps: 5 });
    await page.mouse.up();
    await act.sleep(250);
    assert(await page.$eval('#layer-controls', (el) => !el.classList.contains('hidden')), 'layer buttons appear for the selected shape');

    const selected = await measure(page);
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-studio-panel-${size.width}x${size.height}-selected.png`) });
    assert(selected.controls.some((c) => c.name === 'btn-delete-selected'), 'layer buttons are in the panel');
    assertReachable(selected, 'shape selected');
    assertEqual(JSON.stringify(selected.canvasArea), JSON.stringify(m.canvasArea), 'canvas area with a shape selected');

    // A panel that scrolls must show it, and must scroll with the mouse wheel.
    const selectedScrolls = selected.bar.scrollHeight > selected.bar.clientHeight + 1;
    if (selectedScrolls) {
      const bottomEdge = async () => {
        const shot = px.decodePng(Buffer.from(await page.screenshot({ captureBeyondViewport: false })));
        const [r, g, b] = px.pixel(shot, Math.round((selected.bar.left + 3) * ctx.dpr), Math.round((selected.bar.bottom - 3) * ctx.dpr));
        return { r, g, b, tint: b - r };
      };
      const atTop = await bottomEdge();
      await page.mouse.move(selected.bar.left + 20, selected.bar.top + 120);
      await page.mouse.wheel({ deltaY: 4000 });
      await act.sleep(300);
      const scrolled = await page.$eval('.floating-toolbar', (el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
      assert(scrolled.top >= scrolled.max - 1, `the mouse wheel scrolls the panel to its end (${scrolled.top} of ${scrolled.max})`);
      const atEnd = await bottomEdge();
      await page.screenshot({ path: path.join(ctx.outputDir, `ui-studio-panel-${size.width}x${size.height}-scrolled.png`) });
      assert(atTop.tint - atEnd.tint >= 40, `a band at the bottom edge shows there is more below, and goes once the end is reached (blue over red ${atTop.tint} then ${atEnd.tint})`);
      const last = await page.$eval('#btn-delete-selected', (el) => {
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, hit: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
      });
      assert(last.hit && last.bottom <= selected.bar.bottom + 0.5, 'the last control is in view after scrolling');
    }

    const mode = scrolls ? 'panel scrolls' : 'no scrolling needed';
    const withSelection = selected.bar.scrollHeight > selected.bar.clientHeight + 1 ? 'scrolls with a shape selected' : 'fits with a shape selected';
    return `${mode}; ${withSelection}; thickness at y=${Math.round(m.strokeAtRest.top)}–${Math.round(m.strokeAtRest.bottom)} of ${m.innerHeight}`;
  }
};
