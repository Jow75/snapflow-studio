/**
 * Full Page capture, verified against what the Studio actually renders.
 */

const { group, test, assert, assertEqual, assertClose } = require('../lib/runner');
const px = require('../lib/pixels');
const act = require('../lib/actions');

const RED = [185, 28, 28];      // fixed top bar
const BLUE = [29, 78, 216];     // fixed bottom bar
const GREEN = [21, 128, 61];    // sticky bar
const PURPLE = [126, 34, 206];  // scripted header
const LOADED = [22, 163, 74];   // lazy image once loaded

module.exports = async function fullPageSuite(ctx, { quick = false } = {}) {
  const d = ctx.dpr;
  const col = (cssX) => Math.round(cssX * d);

  /**
   * Image size in device px for a CSS length. Exact at ratio 1. At other ratios the
   * DOM reports CSS lengths rounded to whole pixels while layout is finer than that,
   * so the true device size can differ from the rounded product by one pixel.
   */
  function assertDevice(actual, css, message) {
    assertClose(actual, Math.round(css * d), d === 1 ? 0 : 1, message);
  }

  /** Captures a fixture and returns the decoded Studio canvas plus context. */
  async function capture(url, name, settings, prepare) {
    const page = await ctx.openFixture(url);
    if (prepare) await prepare(page);
    const before = await act.pageState(page);
    const studio = await act.captureFullPage(ctx, page, settings);
    const img = px.decodePng(await ctx.readCanvas(studio, `full-${name}-dpr${d}.png`));
    const notices = await act.studioNotices(studio);
    const after = await act.pageState(page);
    const metrics = await page.evaluate(() => ({ vw: innerWidth, vh: innerHeight }));
    await studio.close();
    await page.close();
    return { img, notices, before, after, metrics };
  }

  function checkRuler(img, channel, last, cssX = 4) {
    const result = px.analyseRuler(px.readVerticalRuler(img, col(cssX), channel), { last, scale: d });
    assert(result.ok, 'ruler: ' + result.problems.join('; '));
  }

  function assertRestored(before, after) {
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after capture');
  }

  group(`FULL PAGE (device pixel ratio ${d})`);

  await test('Long page, height not a multiple of the viewport: every row once, in order', async () => {
    const { img, before, after, metrics, notices } = await capture('page.html?h=3450', 'plain');
    assertDevice(img.width, metrics.vw, 'image width');
    assertDevice(img.height, 3450, 'image height');
    checkRuler(img, 77, 3449);
    assertRestored(before, after);
    assertEqual(notices.length, 0, 'unexpected notices');
    return `${img.width}×${img.height}`;
  });

  await test('Fixed top bar, fixed bottom bar and sticky bar each appear exactly once', async () => {
    const { img } = await capture('page.html?h=3450&fixed=1&sticky=1&fixedbottom=1', 'fixed-sticky');
    assertDevice(img.height, 3450, 'image height');
    checkRuler(img, 77, 3449);
    const red = px.countRuns(img, col(600), px.near(RED));
    const blue = px.countRuns(img, col(600), px.near(BLUE));
    const green = px.countRuns(img, col(28), px.near(GREEN));
    assertEqual(red.runs, 1, 'fixed top bar occurrences');
    assertEqual(blue.runs, 1, 'fixed bottom bar occurrences');
    assertEqual(green.runs, 1, 'sticky bar occurrences');
    assertEqual(red.spans[0][0], 0, 'fixed top bar position');
    assertEqual(blue.spans[0][1], img.height, 'fixed bottom bar ends at the bottom of the image');
    assertClose(blue.spans[0][1] - blue.spans[0][0], 44 * d, 1, 'fixed bottom bar height');
  });

  if (!quick) {
    await test('Page shorter than the viewport: one frame, nothing invented', async () => {
      const { img, metrics } = await capture('page.html?h=300', 'short');
      assertDevice(img.height, metrics.vh, 'image height equals the viewport');
      checkRuler({ ...img, height: Math.round(300 * d) }, 77, 299);
    });

    await test('Height an exact multiple of the viewport: no empty or repeated final frame', async () => {
      const probe = await ctx.openFixture('page.html?h=100');
      const vh = await probe.evaluate(() => innerHeight);
      await probe.close();
      const { img } = await capture(`page.html?h=${vh * 3}`, 'multiple');
      assertDevice(img.height, vh * 3, 'image height');
      checkRuler(img, 77, vh * 3 - 1);
    });

    await test('Smooth scrolling and mandatory scroll snapping do not disturb positions', async () => {
      const { img, before, after } = await capture('page.html?h=3450&smooth=1&snap=1', 'smooth-snap');
      assertDevice(img.height, 3450, 'image height');
      checkRuler(img, 77, 3449);
      assertRestored(before, after);
    });

    await test('Header that a script switches to position:fixed after scrolling appears once', async () => {
      const { img } = await capture('page.html?h=3450&jsheader=1', 'js-header');
      checkRuler(img, 77, 3449);
      assertEqual(px.countRuns(img, col(600), px.near(PURPLE)).runs, 1, 'scripted header occurrences');
    });

    await test('Lazy-loaded images are loaded in the capture, not placeholders', async () => {
      const { img } = await capture('page.html?h=5200&lazy=6', 'lazy');
      checkRuler(img, 77, 5199);
      const loaded = px.countRuns(img, img.width - col(100), px.near(LOADED));
      assertEqual(loaded.runs, 6, 'loaded lazy images');
    });

    await test('Lazy images still load with the pre-flight sweep switched off', async () => {
      const { img } = await capture('page.html?h=5200&lazy=6', 'lazy-nopreflight', { preflight: false });
      checkRuler(img, 77, 5199);
      assertEqual(px.countRuns(img, img.width - col(100), px.near(LOADED)).runs, 6, 'loaded lazy images');
    });

    await test('Page that grows while being captured: late content is included and reported', async () => {
      const { img, notices } = await capture('page.html?h=3450&grow=900', 'grow', { preflight: false });
      assertDevice(img.height, 4350, 'image height includes the late content');
      checkRuler({ ...img, height: Math.round(3450 * d) }, 77, 3449);
      const late = px.readVerticalRuler(img, col(4), 78).slice(Math.round(3450 * d));
      const lateResult = px.analyseRuler(late, { last: 899, scale: d });
      assert(lateResult.ok, 'late content ruler: ' + lateResult.problems.join('; '));
      assert(notices.some((n) => n.includes('changed height')), 'the height change must be reported: ' + JSON.stringify(notices));
    });

    await test('Document with horizontal overflow: captured at the viewport width, rows intact', async () => {
      const { img, metrics } = await capture('page.html?h=2600&wide=1', 'wide');
      assertDevice(img.width, metrics.vw, 'image width');
      checkRuler(img, 77, 2599);
    });

    await test('Capture started mid-page returns the page to where the user was', async () => {
      const { img, before, after } = await capture('page.html?h=3450', 'mid-page', {}, async (page) => {
        await page.evaluate(() => window.scrollTo(0, 1234));
      });
      checkRuler(img, 77, 3449);
      assertEqual(before.scrollY, 1234, 'starting scroll position');
      assertRestored(before, after);
    });

    await test('"Hide sticky headers" off: nothing on the page is altered', async () => {
      const { img } = await capture('page.html?h=2400&fixed=1', 'policy-off', { hideFixed: false });
      assert(px.countRuns(img, col(600), px.near(RED)).runs >= 2, 'the fixed bar should repeat when the policy is off');
    });

    await test('Very long page (30,000 px): complete, in order', async () => {
      const { img, notices } = await capture('page.html?h=30000', 'very-long', { scrollDelay: 100 });
      const native = Math.round(30000 * d);
      if (native <= 32000) {
        assertEqual(img.height, native, 'image height');
        checkRuler(img, 77, 29999);
        return `${img.width}×${img.height}`;
      }
      // Beyond the canvas limit the image is scaled down uniformly and says so.
      assert(img.height <= 32000, 'image must fit the canvas limit');
      const expectedShrink = 32000 / native;
      assertClose(img.width / (1280 * d), expectedShrink, 0.002, 'width scaled by the same factor as height');
      assert(notices.some((n) => n.includes('scaled to')), 'downscaling must be reported: ' + JSON.stringify(notices));
      return `scaled to ${img.width}×${img.height}`;
    });
  }

  await test('App shell (document does not scroll): the inner scroller is captured in full', async () => {
    const { img, notices, before, after, metrics } = await capture('app.html', 'app-shell');
    // topbar 48 + conversation content 3210 + composer 56
    assertDevice(img.width, metrics.vw, 'image width');
    assertDevice(img.height, (48 + 3210 + 56), 'image height');

    const conversation = px.readVerticalRuler(img, col(260 + 4), 102).slice(Math.round(48 * d), Math.round((48 + 3210) * d));
    const result = px.analyseRuler(conversation, { last: 3209, scale: d });
    assert(result.ok, 'conversation ruler: ' + result.problems.join('; '));

    // The sidebar is shown as it was on the first screen: its first rows, once.
    const sidebar = px.readVerticalRuler(img, col(4), 101).filter((v) => v !== null);
    assertEqual(sidebar[0], 0, 'sidebar starts at its first row');
    assert(sidebar.every((v, i) => i === 0 || v >= sidebar[i - 1]), 'sidebar rows in order');

    const composer = px.countRuns(img, col(700), px.near([167, 139, 250]));
    assertEqual(composer.runs, 1, 'composer bar occurrences');
    assertEqual(composer.spans[0][1], img.height, 'composer bar sits at the bottom');
    assert(notices.some((n) => n.includes('scrolls inside a panel')), 'inner-scroller capture must be explained');
    assertRestored(before, after);
    return `${img.width}×${img.height}`;
  });

  if (!quick) {
    await test('Cancelling mid-capture opens nothing and restores the page', async () => {
      const page = await ctx.openFixture('page.html?h=12000&fixed=1&sticky=1');
      await page.evaluate(() => window.scrollTo(0, 777));
      const before = await act.pageState(page, ['#sticky-bar', '#fixed-top']);
      const studiosBefore = (await act.knownStudioUrls(ctx)).length;
      const tabId = await act.start(ctx, page, 'full', { preflight: false });
      await act.sleep(2500);
      const during = await page.evaluate(() => document.documentElement.hasAttribute('data-snapflow-capturing'));
      assert(during, 'capture should be running before it is cancelled');
      const worker = await ctx.worker();
      await worker.evaluate((id) => cancelCapture(id), tabId);
      await act.sleep(2000);
      const after = await act.pageState(page, ['#sticky-bar', '#fixed-top']);
      // The only difference allowed is the transient "cancelled" toast host.
      after.uiHosts = 0;
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after cancel');
      assertEqual((await act.knownStudioUrls(ctx)).length, studiosBefore, 'no Studio tab may open');
      const session = await worker.evaluate(() => getSession());
      assertEqual(session, null, 'session must be cleared');
      await page.close();
    });

    await test('Escape key cancels a running capture', async () => {
      const page = await ctx.openFixture('page.html?h=12000');
      const before = await act.pageState(page);
      await act.start(ctx, page, 'full', { preflight: false });
      await act.sleep(2000);
      await page.keyboard.press('Escape');
      await act.sleep(2000);
      const after = await act.pageState(page);
      after.uiHosts = 0;
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after Escape');
      await page.close();
    });

    await test('A second capture request while one is running is refused, not run in parallel', async () => {
      const page = await ctx.openFixture('page.html?h=9000');
      const known = await act.knownStudioUrls(ctx);
      const tabId = await act.start(ctx, page, 'full', { preflight: false });
      await act.sleep(1200);
      const worker = await ctx.worker();
      const second = await worker.evaluate((id) => startCapture('full', id, {}), tabId);
      assert(second && second.error && second.error.includes('already in progress'), 'second request must be refused: ' + JSON.stringify(second));
      const studio = await ctx.waitForStudio(known);
      const img = px.decodePng(await ctx.readCanvas(studio));
      checkRuler(img, 77, 8999);
      await studio.close();
      await page.close();
    });
  }
};
