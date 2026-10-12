/**
 * User-level actions against the extension under test.
 *
 * Captures are started the way the popup starts them (the service worker's
 * startCapture entry point). The region picker is then driven with real pointer
 * and keyboard input, because its UI lives in a closed shadow root.
 */

const DEFAULT_SETTINGS = { scrollDelay: 200, hideFixed: true, preflight: true, defaultFormat: 'png' };

// SNAPFLOW_E2E_SLOW=2 doubles every pause between simulated user actions, for a
// machine that is too busy to keep up with the normal pace. Nothing else changes.
const PACE = Number(process.env.SNAPFLOW_E2E_SLOW) > 0 ? Number(process.env.SNAPFLOW_E2E_SLOW) : 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));

async function knownStudioUrls(ctx) {
  return (await ctx.browser.pages()).map((p) => p.url());
}

async function start(ctx, page, mode, settings = {}) {
  const tabId = await ctx.tabIdFor(page);
  const worker = await ctx.worker();
  const result = await worker.evaluate(
    (m, id, s) => startCapture(m, id, s),
    mode,
    tabId,
    { ...DEFAULT_SETTINGS, ...settings }
  );
  if (result && result.error) throw new Error('startCapture failed: ' + result.error);
  return tabId;
}

/** Runs a capture that ends in a Studio tab and returns that tab. */
async function captureToStudio(ctx, page, mode, settings, timeout) {
  const known = await knownStudioUrls(ctx);
  await page.bringToFront();
  await start(ctx, page, mode, settings);
  return ctx.waitForStudio(known, timeout);
}

async function captureFullPage(ctx, page, settings, timeout = 240000) {
  return captureToStudio(ctx, page, 'full', settings, timeout);
}

async function captureVisible(ctx, page, settings) {
  return captureToStudio(ctx, page, 'visible', settings, 60000);
}

/** Centre of an element in viewport coordinates. */
async function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/**
 * Opens the region picker, hovers and clicks the given point, and leaves the
 * confirmation pill open.
 */
async function pickRegion(ctx, page, point, settings) {
  await page.bringToFront();
  await start(ctx, page, 'element', settings);
  await sleep(150);
  await page.mouse.move(point.x - 3, point.y - 3);
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await sleep(150);
  await page.mouse.click(point.x, point.y);
  await sleep(200);
}

/** Picks a region and captures it automatically (Enter on the confirmation pill). */
async function captureRegionAuto(ctx, page, point, settings, timeout = 240000) {
  const known = await knownStudioUrls(ctx);
  await pickRegion(ctx, page, point, settings);
  await page.keyboard.press('Enter');
  return ctx.waitForStudio(known, timeout);
}

/** Reads the notices the Studio shows for a capture. */
async function studioNotices(studio) {
  return studio.$$eval('#capture-notices .capture-notice span', (nodes) => nodes.map((n) => n.textContent));
}

async function studioDims(studio) {
  return studio.$eval('#base-canvas', (c) => ({ width: c.width, height: c.height }));
}

/** Snapshot of everything a capture is allowed to touch, to prove it was restored. */
async function pageState(page, selectors = []) {
  return page.evaluate((sels) => {
    const html = document.documentElement;
    const state = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      htmlStyle: html.getAttribute('style') || '',
      bodyStyle: document.body.getAttribute('style') || '',
      capturing: html.hasAttribute('data-snapflow-capturing'),
      targets: document.querySelectorAll('[data-snapflow-target]').length,
      uiHosts: document.querySelectorAll('snapflow-ui').length,
      elements: {}
    };
    for (const sel of sels) {
      const el = document.querySelector(sel);
      state.elements[sel] = el
        ? { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, style: el.getAttribute('style') || '' }
        : null;
    }
    return state;
  }, selectors);
}

module.exports = {
  DEFAULT_SETTINGS,
  sleep,
  start,
  captureFullPage,
  captureVisible,
  captureRegionAuto,
  pickRegion,
  centreOf,
  studioNotices,
  studioDims,
  pageState,
  knownStudioUrls
};
