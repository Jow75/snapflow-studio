/**
 * Scrolling Region on lists that load more as they are scrolled (conversation
 * histories) and on lists that keep only the visible rows in the DOM.
 *
 * The fixture's ruler encodes every content row, so each result is checked row by
 * row: everything the list could load must be present once, in order. The loading
 * placeholder is not ruler-coloured, so photographing it fails the same check.
 */

const { group, test, assert, assertEqual, assertClose } = require('../lib/runner');
const px = require('../lib/pixels');
const act = require('../lib/actions');

const CHANNEL = 130;
const SCROLLERS = ['#history', '#outer'];

module.exports = async function dynamicSuite(ctx, { quick = false } = {}) {
  const d = ctx.dpr;
  const col = (cssX) => Math.round(cssX * d);

  function assertDevice(actual, css, message) {
    assertClose(actual, Math.round(css * d), d === 1 ? 0 : 1, message);
  }

  function checkRuler(img, lastRow) {
    const decoded = px.readVerticalRuler(img, col(4), CHANNEL);
    const result = px.analyseRuler(decoded, { last: lastRow, scale: d });
    assert(result.ok, 'ruler: ' + result.problems.join('; '));
  }

  const listState = (page) => page.evaluate(() => {
    const el = document.getElementById('history');
    return {
      total: window.__history.total,
      loads: window.__history.loads,
      loading: window.__history.loading,
      rowHeight: window.__history.rowHeight,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth
    };
  });

  /** Captures #history automatically and proves the page was put back afterwards. */
  async function capture(query, name, { settings, timeout = 300000, prepare, during } = {}) {
    const page = await ctx.openFixture('history.html' + query);
    try {
      if (prepare) await prepare(page);
      const before = await act.pageState(page, SCROLLERS);
      const start = await listState(page);
      const known = await act.knownStudioUrls(ctx);
      await act.pickRegion(ctx, page, await act.centreOf(page, '#history'), settings);
      await page.keyboard.press('Enter');
      if (during) await during(page);
      const studio = await ctx.waitForStudio(known, timeout);
      const img = px.decodePng(await ctx.readCanvas(studio, `dynamic-${name}-dpr${d}.png`));
      const notices = await act.studioNotices(studio);
      await studio.close();
      await act.sleep(300);
      const end = await listState(page);
      const after = await act.pageState(page, SCROLLERS);
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after capture');
      return { img, notices, start, end };
    } finally {
      await page.close();
    }
  }

  /** The image must hold every row the list could load, with nothing said against it. */
  function expectComplete(result, rows, loads) {
    const { img, end, notices } = result;
    const height = rows * end.rowHeight;
    assertEqual(end.total, rows, 'rows the list ended up with');
    if (loads !== undefined) assertEqual(end.loads, loads, 'loads the list performed');
    assertDevice(img.width, end.clientWidth, 'image width is the list');
    assertDevice(img.height, height, 'image height is everything the list could load');
    checkRuler(img, height - 1);
    assertEqual(notices.length, 0, 'notices (' + notices.join(' | ') + ')');
    return `${result.start.scrollHeight}px at the start → ${img.width}×${img.height} captured`;
  }

  group(`DYNAMIC HISTORIES (device pixel ratio ${d})`);

  await test('List that grows several times as its bottom is reached: every loaded row, once, in order', async () => {
    const result = await capture('?rows=40&pages=4&page=25&delay=250', 'grow-several');
    return expectComplete(result, 140, 4);
  });

  await test('Virtualised list (rows recycled) that also loads more: complete', async () => {
    const result = await capture('?mode=virtual&rowh=32&rows=60&pages=2&page=45&delay=300', 'virtual-grow');
    return expectComplete(result, 150, 2);
  });

  if (quick) return;

  await test('List with nothing more to load: captured as before', async () => {
    const result = await capture('?rows=50', 'static');
    return expectComplete(result, 50, 0);
  });

  await test('List that grows once, quickly, after its bottom is reached', async () => {
    const result = await capture('?rows=40&pages=1&page=30&delay=120', 'grow-once');
    return expectComplete(result, 70, 1);
  });

  await test('Rows that arrive 1.2 s after the bottom is reached (loading placeholder shown meanwhile)', async () => {
    const result = await capture('?rows=40&pages=2&page=20&delay=1200', 'slow-placeholder');
    return expectComplete(result, 80, 2);
  });

  await test('Rows that arrive 1.5 s late with nothing on screen to show it: still followed to the end', async () => {
    const result = await capture('?rows=40&pages=2&page=20&delay=1500&indicator=none', 'slow-silent');
    return expectComplete(result, 80, 2);
  });

  await test('Loader that only reacts to scroll events: followed to the end', async () => {
    const result = await capture('?rows=40&pages=3&page=20&delay=200&trigger=scroll', 'scroll-trigger');
    return expectComplete(result, 100, 3);
  });

  await test('History of 16,825 px that grows to 24,150 px while it is captured: the whole 24,150 px', async () => {
    const result = await capture('?rowh=25&rows=673&sizes=100,100,93&delay=600', 'grow-16825-24150');
    assertEqual(result.start.scrollHeight, 16825, 'height before the capture');
    assertEqual(result.end.scrollHeight, 24150, 'height after the capture');
    return expectComplete(result, 966, 3);
  });

  await test('Height constant while the visible rows change (virtualised, drawn 120 ms late): every row once', async () => {
    const result = await capture('?mode=virtual&rowh=32&rows=150&render=120', 'virtual-late');
    return expectComplete(result, 150, 0);
  });

  await test('History inside another scrolling panel: complete, and the outer panel is put back', async () => {
    const result = await capture('?shell=nested&rows=30&pages=2&page=20&delay=300', 'nested', {
      prepare: (page) => page.$eval('#outer', (el) => el.scrollTo(0, 140))
    });
    return expectComplete(result, 70, 2);
  });

  await test('Pre-flight sweep switched off: growth is followed as the capture reaches each end', async () => {
    const result = await capture('?rows=40&pages=3&page=20&delay=300', 'no-preflight', { settings: { preflight: false } });
    return expectComplete(result, 100, 3);
  });

  await test('List that never stops loading: stops at the time limit, keeps what had loaded, and says so', async () => {
    const result = await capture('?rows=40&pages=inf&page=20&delay=400', 'endless', { settings: { regionLoadLimitMs: 4000 } });
    const { img, notices, start, end } = result;
    assert(notices.some((n) => /still loading/i.test(n)), 'a notice must say loading was cut short: ' + notices.join(' | '));
    const rows = img.height / d / end.rowHeight;
    assert(Number.isInteger(rows), `image ends on a row boundary (${rows} rows)`);
    assert(rows > start.total, `more than the first ${start.total} rows were captured (${rows})`);
    assert(rows <= end.total, `nothing beyond what loaded (${rows} of ${end.total})`);
    checkRuler(img, rows * end.rowHeight - 1);
    return `${rows} rows captured of ${end.total} loaded by the time it finished`;
  });

  await test('Enter while a list is loading: stops loading and captures what has loaded', async () => {
    const result = await capture('?rows=40&pages=inf&page=20&delay=500', 'stop-loading', {
      during: async (page) => {
        await act.sleep(3500);
        await page.keyboard.press('Enter');
      }
    });
    const { img, notices, start, end } = result;
    assert(notices.some((n) => /stopped/i.test(n)), 'a notice must say loading was stopped: ' + notices.join(' | '));
    const rows = img.height / d / end.rowHeight;
    assert(Number.isInteger(rows) && rows > start.total && rows <= end.total, `rows captured: ${rows} (list had ${end.total})`);
    checkRuler(img, rows * end.rowHeight - 1);
    return `${rows} rows captured`;
  });

  await test('Escape while more is loading: nothing opens, the list is put back where it was', async () => {
    const page = await ctx.openFixture('history.html?rows=40&pages=inf&page=20&delay=500');
    try {
      await page.$eval('#history', (el) => el.scrollTo(0, 120));
      const before = await act.pageState(page, SCROLLERS);
      const studios = (await act.knownStudioUrls(ctx)).length;
      await act.pickRegion(ctx, page, await act.centreOf(page, '#history'));
      await page.keyboard.press('Enter');
      await act.sleep(3000);
      const mid = await listState(page);
      assert(mid.loads >= 1, 'the list must have started loading more before Escape (loads: ' + mid.loads + ')');
      assert(await page.evaluate(() => document.documentElement.hasAttribute('data-snapflow-capturing')), 'capture still running');
      await page.keyboard.press('Escape');
      await act.sleep(1800);
      const after = await act.pageState(page, SCROLLERS);
      after.uiHosts = 0; // the "cancelled" message is still on screen
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after Escape');
      assertEqual((await act.knownStudioUrls(ctx)).length, studios, 'no Studio tab may open');
      // With the list back at its old position nothing keeps pulling more rows in.
      const settled = await listState(page);
      await act.sleep(1500);
      assertEqual((await listState(page)).loads, settled.loads, 'loading stopped after the cancel');
      await act.sleep(2500); // let the message expire
      assertEqual((await act.pageState(page)).uiHosts, 0, 'extension UI removed');
      return `cancelled after ${mid.loads} loads`;
    } finally {
      await page.close();
    }
  });
};
