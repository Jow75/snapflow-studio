/**
 * Studio editing tools, driven with real pointer and keyboard input.
 *
 * What a tool did is read from what the editor shows: the Undo button, the pixels of
 * the annotation layer and of the image underneath, and the scroll position.
 */

const { group, test, assert, assertEqual } = require('../lib/runner');
const act = require('../lib/actions');

const DRAG_TOOLS = ['arrow', 'line', 'rect', 'circle', 'highlight', 'pen', 'blur', 'pixelate', 'redact'];

module.exports = async function studioToolsSuite(ctx) {
  async function openStudio() {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1366, height: 700, deviceScaleFactor: ctx.dpr });
    await page.goto(`chrome-extension://${ctx.extensionId}/studio/viewer.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('base-canvas').width > 0);
    await page.bringToFront();
    return page;
  }

  /** Image pixels to window coordinates. */
  const toScreen = (page, x, y) => page.$eval('#overlay-canvas', (el, px, py) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + px * (r.width / el.width), y: r.top + py * (r.height / el.height) };
  }, x, y);

  const state = (page) => page.evaluate(() => {
    const sum = (canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) total = (total + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7 + data[i + 3] * 11 + (i & 1023)) >>> 0;
      return total;
    };
    const editor = document.querySelector('.studio-inline-text-input');
    return {
      canUndo: !document.getElementById('btn-undo').disabled,
      image: sum(document.getElementById('base-canvas')),
      layer: sum(document.getElementById('overlay-canvas')),
      editorOpen: !!editor,
      editorFocused: !!editor && document.activeElement === editor,
      scrollTop: document.getElementById('viewport-container').scrollTop
    };
  });

  /** Clicks Undo until it is disabled and returns how many steps that took. */
  async function undoAll(page) {
    let steps = 0;
    while (await page.$eval('#btn-undo', (el) => !el.disabled)) {
      await page.click('#btn-undo');
      await act.sleep(120);
      if (++steps > 20) throw new Error('Undo never reached the start');
    }
    return steps;
  }

  async function drag(page, tool, from, to) {
    await page.click(`.floating-toolbar [data-tool="${tool}"]`);
    const a = await toScreen(page, from.x, from.y);
    const b = await toScreen(page, to.x, to.y);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, a.y + (b.y - a.y) * 0.4, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.up();
    await act.sleep(250);
  }

  async function clickWith(page, tool, point) {
    await page.click(`.floating-toolbar [data-tool="${tool}"]`);
    const p = await toScreen(page, point.x, point.y);
    await page.mouse.click(p.x, p.y);
    await act.sleep(250);
  }

  /** Deselects, so selection handles are not counted as part of the drawing. */
  async function deselect(page) {
    await page.click('.floating-toolbar [data-tool="select"]');
    const p = await toScreen(page, 30, 760);
    await page.mouse.click(p.x, p.y);
    await act.sleep(150);
  }

  group(`STUDIO EDITING TOOLS (device pixel ratio ${ctx.dpr})`);

  const page = await openStudio();
  const clean = await state(page);

  for (const tool of DRAG_TOOLS) {
    await test(`${tool}: dragging adds one edit, and Undo takes it back`, async () => {
      await drag(page, tool, { x: 300, y: 300 }, { x: 520, y: 420 });
      await deselect(page);
      const drawn = await state(page);
      assert(drawn.canUndo, 'the edit is in the history');
      assert(drawn.image !== clean.image || drawn.layer !== clean.layer, 'the edit is visible');
      const steps = await undoAll(page);
      assertEqual(steps, 1, 'undo steps');
      const undone = await state(page);
      assert(undone.image === clean.image && undone.layer === clean.layer, 'Undo restores the picture exactly');
      return drawn.image !== clean.image ? 'changes the image itself' : 'drawn on the annotation layer';
    });
  }

  await test('Arrow: the head is drawn in the same colour as the line', async () => {
    await drag(page, 'arrow', { x: 300, y: 300 }, { x: 520, y: 420 });
    await deselect(page);
    const colours = await page.$eval('#overlay-canvas', (canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = {};
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 250) continue; // anti-aliased edges
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        seen[key] = (seen[key] || 0) + 1;
      }
      return Object.entries(seen).filter(([, count]) => count > 20).map(([key]) => key.split(',').map(Number));
    });
    const stroke = await page.$eval('#tool-color', (el) => [1, 3, 5].map((i) => parseInt(el.value.slice(i, i + 2), 16)));
    await undoAll(page);
    assert(colours.length > 0, 'the arrow is drawn');
    // Where the head overlaps the line the canvas rounds a channel by one level, hence the margin.
    const off = colours.filter((c) => c.some((value, i) => Math.abs(value - stroke[i]) > 3));
    assert(off.length === 0, `every solid part of the arrow is the line colour ${stroke.join(',')}; also found ${off.map((c) => c.join(',')).join(' and ')}`);
  });

  await test('Text Note: clicking opens a text box that keeps the keyboard; Enter adds the note once', async () => {
    await clickWith(page, 'text', { x: 300, y: 300 });
    const open = await state(page);
    assert(open.editorOpen, 'a text box opens where the canvas was clicked');
    assert(open.editorFocused, 'the text box has the keyboard focus');
    await page.keyboard.type('A note with several words in it');
    await page.keyboard.press('Enter');
    await act.sleep(250);
    await deselect(page);
    const noted = await state(page);
    assert(!noted.editorOpen, 'the text box closes on Enter');
    assert(noted.canUndo && noted.layer !== clean.layer, 'the note is drawn and in the history');
    assertEqual(noted.scrollTop, open.scrollTop, 'typing spaces does not scroll the canvas');
    assertEqual(await undoAll(page), 1, 'undo steps');
    assertEqual((await state(page)).layer, clean.layer, 'annotation layer after Undo');
  });

  await test('Text Note: Esc discards what was typed', async () => {
    await clickWith(page, 'text', { x: 300, y: 300 });
    await page.keyboard.type('Not wanted');
    await page.keyboard.press('Escape');
    await act.sleep(250);
    const after = await state(page);
    assert(!after.editorOpen, 'the text box closes on Esc');
    assert(!after.canUndo && after.layer === clean.layer, 'nothing was added');
  });

  await test('Text Note: clicking elsewhere keeps the note, once', async () => {
    await clickWith(page, 'text', { x: 300, y: 300 });
    await page.keyboard.type('Kept');
    const away = await toScreen(page, 700, 500);
    await page.mouse.click(away.x, away.y);
    await act.sleep(250);
    await page.keyboard.press('Escape'); // the second click opened a new, empty box
    await act.sleep(200);
    await deselect(page);
    const after = await state(page);
    assert(after.canUndo && after.layer !== clean.layer, 'the note was kept');
    assertEqual(await undoAll(page), 1, 'undo steps');
  });

  await test('Step markers: each click adds one numbered marker', async () => {
    await clickWith(page, 'step', { x: 300, y: 300 });
    await clickWith(page, 'step', { x: 420, y: 300 });
    await deselect(page);
    assert((await state(page)).layer !== clean.layer, 'markers are drawn');
    assertEqual(await undoAll(page), 2, 'undo steps');
    assertEqual((await state(page)).layer, clean.layer, 'annotation layer after Undo');
  });

  await page.close();
};
