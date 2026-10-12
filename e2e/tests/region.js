/**
 * Scrolling Region capture: picker behaviour, automatic and manual traversal,
 * nested and virtualised containers, overlays, cancellation and restoration.
 * The picker is operated with real pointer and keyboard input.
 */

const fs = require('fs');
const path = require('path');
const { group, test, assert, assertEqual, assertClose } = require('../lib/runner');
const px = require('../lib/pixels');
const act = require('../lib/actions');

const APP_SCROLLERS = ['#sidebar', '#conversation', '#codeblock', '#tablepanel', '#nested-outer', '#nested-inner', '#virtual', '#right'];

module.exports = async function regionSuite(ctx, { quick = false } = {}) {
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

  async function decode(studio, name) {
    return px.decodePng(await ctx.readCanvas(studio, `region-${name}-dpr${d}.png`));
  }

  function checkRuler(img, channel, last, cssX = 4, offsetCss = 0) {
    const decoded = px.readVerticalRuler(img, col(cssX), channel).slice(Math.round(offsetCss * d));
    const result = px.analyseRuler(decoded, { last, scale: d });
    assert(result.ok, `ruler ${channel}: ` + result.problems.join('; '));
  }

  /** Opens the app fixture, runs fn, and proves the page was put back exactly. */
  async function withApp(query, fn) {
    const page = await ctx.openFixture('app.html' + query);
    try {
      const before = await act.pageState(page, APP_SCROLLERS);
      const result = await fn(page);
      await act.sleep(300);
      const after = await act.pageState(page, APP_SCROLLERS);
      assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after capture');
      return result;
    } finally {
      // Closed even when a check fails, so one failure cannot hold up the tests after it.
      await page.close();
    }
  }

  group(`SCROLLING REGION (device pixel ratio ${d})`);

  await test('A. Sidebar: the whole list, only the sidebar', () => withApp('', async (page) => {
    const size = await page.$eval('#sidebar', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#sidebar'));
    const img = await decode(studio, 'A-sidebar');
    assertDevice(img.width, size.w, 'width is the sidebar content box');
    assertDevice(img.height, size.h, 'height is the full scrollable extent');
    checkRuler(img, 101, 1999);
    const title = await studio.$eval('#doc-title', (el) => el.textContent);
    assert(title.includes('Scrolling Region'), 'opens in the editor as a region capture');
    await studio.close();
    return `${img.width}×${img.height}`;
  }));

  await test('B. Long central response: continuous, sticky header once, floating button absent', () => withApp('?convsticky=1', async (page) => {
    const size = await page.$eval('#conversation', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#conversation'));
    const img = await decode(studio, 'B-conversation');
    assertDevice(img.width, size.w, 'width');
    assertDevice(img.height, size.h, 'height');
    checkRuler(img, 102, 3209, 4, 36);
    const sticky = px.countRuns(img, img.width - col(40), px.near([253, 224, 71]));
    assertEqual(sticky.runs, 1, 'sticky header occurrences');
    assertEqual(sticky.spans[0][0], 0, 'sticky header sits at its natural position (top)');
    let fabPixels = 0;
    for (let y = 0; y < img.height; y += 2) {
      for (let x = Math.round(img.width * 0.6); x < img.width; x += 2) {
        if (px.near([220, 38, 38], 4)(px.pixel(img, x, y))) fabPixels++;
      }
    }
    assertEqual(fabPixels, 0, 'pixels of the floating button that overlapped the region');
    await studio.close();
  }));

  await test('C. Code block scrolling both ways: every line and every column once', () => withApp('', async (page) => {
    const size = await page.$eval('#codeblock', (el) => ({ w: el.scrollWidth, h: el.scrollHeight, cw: el.clientWidth }));
    assert(size.w > size.cw, 'fixture must overflow horizontally');
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#codeblock'));
    const img = await decode(studio, 'C-code');
    assertDevice(img.width, size.w, 'width is the full scrollable width');
    assertDevice(img.height, size.h, 'height is the full scrollable height');
    checkRuler(img, 103, 60 * 18 - 1, 4, 16);
    const columns = px.readHorizontalRuler(img, col(4), 113);
    const result = px.analyseRuler(columns, { last: 1299, scale: d });
    assert(result.ok, 'horizontal ruler: ' + result.problems.join('; '));
    await studio.close();
    return `${img.width}×${img.height}`;
  }));

  await test('D. Table in a scrolling panel: sticky header once, all rows, columns aligned', () => withApp('', async (page) => {
    const size = await page.$eval('#tablepanel', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#tablepanel'));
    const img = await decode(studio, 'D-table');
    assertDevice(img.width, size.w, 'width');
    assertDevice(img.height, size.h, 'height');
    const header = px.countRuns(img, col(size.w - 6), px.near([49, 46, 129]));
    assertEqual(header.runs, 1, 'table header occurrences');
    assertEqual(header.spans[0][0], 0, 'table header is at the top');
    const rules = px.countRuns(img, col(size.w - 6), px.near([226, 232, 240], 3));
    assertEqual(rules.runs, 70, 'row separators (one per data row)');
    // Equal spacing between separators means no row was squeezed, stretched or dropped.
    const gaps = rules.spans.slice(1).map((s, i) => s[0] - rules.spans[i][0]);
    assert(Math.max(...gaps) - Math.min(...gaps) <= 1, `row pitch varies: ${Math.min(...gaps)}..${Math.max(...gaps)}`);
    await studio.close();
  }));

  await test('F. Nested scrollers: the inner one by default, the outer one after widening', () => withApp('', async (page) => {
    const outerStart = await page.$eval('#nested-outer', (el) => { el.scrollTo(0, 150); return el.scrollTop; });
    const inner = await page.$eval('#nested-inner', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    let studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#nested-inner'));
    let img = await decode(studio, 'F-nested-inner');
    assertDevice(img.width, inner.w, 'inner width');
    assertDevice(img.height, inner.h, 'inner height');
    checkRuler(img, 106, 499);
    await studio.close();

    // Same pointer position, widened once with the arrow key: the parent is captured instead.
    const outer = await page.$eval('#nested-outer', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    const known = await act.knownStudioUrls(ctx);
    const point = await act.centreOf(page, '#nested-inner');
    await page.bringToFront();
    await act.start(ctx, page, 'element');
    await act.sleep(150);
    await page.mouse.move(point.x - 2, point.y - 2);
    await page.mouse.move(point.x, point.y);
    await act.sleep(150);
    await page.keyboard.press('ArrowUp');
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-picker-widened-dpr${d}.png`) });
    await page.keyboard.press('Enter');
    await act.sleep(200);
    await page.keyboard.press('Enter');
    studio = await ctx.waitForStudio(known);
    img = await decode(studio, 'F-nested-outer');
    assertDevice(img.width, outer.w, 'outer width');
    assertDevice(img.height, outer.h, 'outer height');
    checkRuler({ ...img, height: Math.round(150 * d) }, 105, 149);
    const tail = px.readVerticalRuler(img, col(4), 115).slice(img.height - Math.round(420 * d));
    const tailResult = px.analyseRuler(tail, { last: 419, scale: d });
    assert(tailResult.ok, 'outer tail ruler: ' + tailResult.problems.join('; '));
    await studio.close();
    await act.sleep(300);
    assertEqual(await page.$eval('#nested-outer', (el) => el.scrollTop), outerStart, 'outer scroller returned to where it was');
    await page.$eval('#nested-outer', (el) => el.scrollTo(0, 0));
  }));

  await test('H. Virtualised list (only visible rows exist in the DOM): all 400 rows captured', () => withApp('', async (page) => {
    await page.$eval('#right', (el) => el.scrollTo(0, el.scrollHeight));
    const before = await act.pageState(page, APP_SCROLLERS);
    const domRows = await page.$$eval('#virtual [data-index]', (rows) => rows.length);
    assert(domRows < 20, 'fixture must be virtualised, found ' + domRows + ' rows in the DOM');
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#virtual'));
    const img = await decode(studio, 'H-virtual');
    assertDevice(img.height, 12800, 'height is the full logical extent');
    checkRuler(img, 107, 12799, 4);
    await studio.close();
    // withApp compares against the state at open; put the helper scroll back first.
    const after = await act.pageState(page, APP_SCROLLERS);
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'state after virtual capture');
    await page.$eval('#right', (el) => el.scrollTo(0, 0));
    return `${domRows} DOM rows → ${img.height / d}px captured`;
  }));

  await test('Region larger than the window, under a fixed page header: complete, page scroll restored', async () => {
    const page = await ctx.openFixture('tall-region.html');
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await act.pageState(page, ['#panel', '#header']);
    const size = await page.$eval('#panel', (el) => ({ w: el.clientWidth, h: el.scrollHeight }));
    const studio = await act.captureRegionAuto(ctx, page, { x: 400, y: 600 });
    const img = await decode(studio, 'tall-panel');
    assertDevice(img.width, size.w, 'width');
    assertDevice(img.height, 3000, 'height');
    checkRuler(img, 120, 2999);
    await studio.close();
    await act.sleep(300);
    const after = await act.pageState(page, ['#panel', '#header']);
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after capture');
    await page.close();
  });

  if (quick) return;

  await test('G. Area with nothing to scroll: says so and offers a plain element capture', () => withApp('', async (page) => {
    // #topbar has no scrollable ancestor at all (unlike boxes inside the right panel,
    // where pointing at them correctly selects the panel that scrolls them).
    const rect = await page.$eval('#topbar', (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const known = await act.knownStudioUrls(ctx);
    await act.pickRegion(ctx, page, await act.centreOf(page, '#topbar'));
    const shot = path.join(ctx.outputDir, `ui-picker-static-dpr${d}.png`);
    await page.screenshot({ path: shot });
    await page.keyboard.press('Enter');
    const studio = await ctx.waitForStudio(known);
    const img = await decode(studio, 'G-static');
    // The hovered node is the text box itself; it is cropped, never "scrolled".
    assertClose(img.width, rect.w * d, 2, 'static capture width');
    assertClose(img.height, rect.h * d, 2, 'static capture height');
    const title = await studio.$eval('#doc-title', (el) => el.textContent);
    assert(!title.includes('Scrolling Region'), 'must not be labelled a scrolling capture');
    await studio.close();
    return 'picker screenshot saved: ' + path.basename(shot);
  }));

  await test('Picker and progress UI: screenshots for visual review', () => withApp('', async (page) => {
    await page.bringToFront();
    await act.start(ctx, page, 'element');
    const point = await act.centreOf(page, '#sidebar');
    await page.mouse.move(point.x - 2, point.y);
    await page.mouse.move(point.x, point.y);
    await act.sleep(200);
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-picker-hover-dpr${d}.png`) });
    await page.mouse.click(point.x, point.y);
    await act.sleep(250);
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-picker-confirm-dpr${d}.png`) });
    await page.keyboard.press('m');
    await act.sleep(900);
    await page.screenshot({ path: path.join(ctx.outputDir, `ui-manual-hud-dpr${d}.png`) });
    await page.keyboard.press('Escape');
    await act.sleep(4200);
    assert(fs.existsSync(path.join(ctx.outputDir, `ui-manual-hud-dpr${d}.png`)), 'screenshots written');
  }));

  await test('Manual mode: user scrolls with the wheel, result is one continuous span', () => withApp('', async (page) => {
    const known = await act.knownStudioUrls(ctx);
    const point = await act.centreOf(page, '#sidebar');
    await act.pickRegion(ctx, page, point);
    await page.keyboard.press('m');
    await act.sleep(900);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel({ deltaY: 300 });
      await act.sleep(1100);
    }
    const reached = await page.$eval('#sidebar', (el) => el.scrollTop + el.clientHeight);
    // Scroll back up over content that is already recorded: must add nothing.
    await page.mouse.wheel({ deltaY: -500 });
    await act.sleep(1000);
    await page.keyboard.press('Enter');
    const studio = await ctx.waitForStudio(known);
    const img = await decode(studio, 'manual-wheel');
    assertClose(img.height, reached * d, 1, 'height is exactly what the user scrolled through');
    checkRuler(img, 101, Math.round(reached) - 1);
    await studio.close();
    return `${reached}px recorded`;
  }));

  await test('Manual mode: a jump that skips content is filled in so there is no gap', () => withApp('', async (page) => {
    const known = await act.knownStudioUrls(ctx);
    await act.pickRegion(ctx, page, await act.centreOf(page, '#sidebar'));
    await page.keyboard.press('m');
    await act.sleep(900);
    // Jump straight to the end, as dragging the scrollbar would.
    await page.$eval('#sidebar', (el) => el.scrollTo(0, el.scrollHeight));
    await act.sleep(1200);
    await page.keyboard.press('Enter');
    const studio = await ctx.waitForStudio(known);
    const img = await decode(studio, 'manual-jump');
    assertDevice(img.height, 2000, 'height covers first to last captured row');
    checkRuler(img, 101, 1999);
    await studio.close();
  }));

  await test('Manual mode starting part-way down: the image starts where the user started', () => withApp('', async (page) => {
    await page.$eval('#sidebar', (el) => el.scrollTo(0, 500));
    const before = await act.pageState(page, APP_SCROLLERS);
    const known = await act.knownStudioUrls(ctx);
    await act.pickRegion(ctx, page, await act.centreOf(page, '#sidebar'));
    await page.keyboard.press('m');
    await act.sleep(900);
    await page.mouse.wheel({ deltaY: 400 });
    await act.sleep(1100);
    const view = await page.$eval('#sidebar', (el) => ({ top: el.scrollTop, h: el.clientHeight }));
    await page.keyboard.press('Enter');
    const studio = await ctx.waitForStudio(known);
    const img = await decode(studio, 'manual-offset');
    const decoded = px.readVerticalRuler(img, col(4), 101);
    assertEqual(decoded[0], 500, 'first captured row');
    assertEqual(decoded[decoded.length - 1], view.top + view.h - 1, 'last captured row');
    const result = px.analyseRuler(decoded, { first: 500, last: view.top + view.h - 1, scale: d });
    assert(result.ok, 'ruler: ' + result.problems.join('; '));
    await studio.close();
    await act.sleep(300);
    const after = await act.pageState(page, APP_SCROLLERS);
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'sidebar returned to where the user had it');
    await page.$eval('#sidebar', (el) => el.scrollTo(0, 0));
  }));

  await test('Escape during an automatic region capture: nothing opens, region scroll restored', () => withApp('', async (page) => {
    await page.$eval('#conversation', (el) => el.scrollTo(0, 400));
    const before = await act.pageState(page, APP_SCROLLERS);
    const studios = (await act.knownStudioUrls(ctx)).length;
    await act.pickRegion(ctx, page, await act.centreOf(page, '#conversation'));
    await page.keyboard.press('Enter');
    await act.sleep(1500);
    await page.keyboard.press('Escape');
    await act.sleep(1800);
    const after = await act.pageState(page, APP_SCROLLERS);
    after.uiHosts = 0;
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state after Escape');
    assertEqual((await act.knownStudioUrls(ctx)).length, studios, 'no Studio tab may open');
    await act.sleep(3500); // let the "cancelled" toast expire before the outer comparison
    await page.$eval('#conversation', (el) => el.scrollTo(0, 0));
  }));

  await test('Escape while picking leaves the page untouched and clickable', () => withApp('', async (page) => {
    await act.start(ctx, page, 'element');
    const point = await act.centreOf(page, '#conversation');
    await page.mouse.move(point.x, point.y);
    await act.sleep(150);
    await page.keyboard.press('Escape');
    await act.sleep(150);
    await page.evaluate(() => {
      window.__clicked = 0;
      document.getElementById('topbar').addEventListener('click', () => { window.__clicked++; });
    });
    await page.click('#topbar');
    assertEqual(await page.evaluate(() => window.__clicked), 1, 'page receives clicks again');
  }));

  await test('Region capture with the region already scrolled: restored to the same offset', () => withApp('', async (page) => {
    await page.$eval('#sidebar', (el) => el.scrollTo(0, 321));
    const before = await act.pageState(page, APP_SCROLLERS);
    const studio = await act.captureRegionAuto(ctx, page, await act.centreOf(page, '#sidebar'));
    const img = await decode(studio, 'restore-offset');
    checkRuler(img, 101, 1999);
    await studio.close();
    await act.sleep(300);
    const after = await act.pageState(page, APP_SCROLLERS);
    assertEqual(after.elements['#sidebar'].scrollTop, 321, 'sidebar scroll offset');
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'page state');
    await page.$eval('#sidebar', (el) => el.scrollTo(0, 0));
  }));

  await test('Selected Area: a dragged rectangle is cropped exactly, without scaling', async () => {
    const page = await ctx.openFixture('page.html?h=2000&shapes=1');
    const known = await act.knownStudioUrls(ctx);
    await page.bringToFront();
    await act.start(ctx, page, 'selected');
    await act.sleep(200);
    // Drag exactly around the 200×200 black square at (520,120), with a 10px margin.
    await page.mouse.move(510, 110);
    await page.mouse.down();
    await page.mouse.move(600, 200, { steps: 4 });
    await page.mouse.move(730, 330, { steps: 4 });
    await page.mouse.up();
    const studio = await ctx.waitForStudio(known);
    const img = px.decodePng(await ctx.readCanvas(studio, `selected-area-dpr${d}.png`));
    assertDevice(img.width, 220, 'selection width');
    assertDevice(img.height, 220, 'selection height');
    const mid = Math.round(img.height / 2);
    const run = px.countRuns({ ...img }, Math.round(img.width / 2), px.near([0, 0, 0], 2));
    assertEqual(run.runs, 1, 'square present once');
    assertClose(run.spans[0][1] - run.spans[0][0], 200 * d, 1, 'square height in the crop');
    let wide = 0;
    for (let x = 0; x < img.width; x++) if (px.near([0, 0, 0], 2)(px.pixel(img, x, mid))) wide++;
    assertClose(wide, 200 * d, 1, 'square width in the crop');
    assertEqual((await act.pageState(page)).uiHosts, 0, 'selection overlay removed');
    await studio.close();
    await page.close();
  });
};
