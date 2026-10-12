/**
 * Local storage and privacy: where captures live, how many are kept, what closing
 * the Studio does, and whether anything is sent over the network.
 *
 * The stores are read directly from the extension's IndexedDB, and network activity
 * is observed through the DevTools protocol on the page, the service worker and the
 * Studio tab, so these are checks of behaviour, not of source text.
 */

const { group, test, assert, assertEqual } = require('../lib/runner');
const act = require('../lib/actions');

const KEEP = 10;

module.exports = async function storageSuite(ctx) {
  /** Everything in the capture database, read from inside the service worker. */
  async function readStore() {
    const worker = await ctx.worker();
    return worker.evaluate(async () => {
      const db = await CaptureStore.open();
      const all = (store) => new Promise((resolve, reject) => {
        const req = db.transaction([store], 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const captures = await all(CaptureStore.CAPTURES);
      const frames = await all(CaptureStore.FRAMES);
      db.close();
      return {
        keep: CaptureStore.KEEP_RECENT,
        captures: captures.sort((a, b) => a.timestamp - b.timestamp).map((c) => ({ id: c.id, mode: c.mode })),
        frameSessions: [...new Set(frames.map((f) => f.sessionId))].sort(),
        frameCount: frames.length
      };
    });
  }

  const idOf = (studio) => new URL(studio.url()).searchParams.get('id');
  const isRemote = (url) => /^(https?|wss?|ftp):/i.test(url) && !url.startsWith(ctx.origin);

  group(`LOCAL STORAGE AND PRIVACY (device pixel ratio ${ctx.dpr})`);

  const made = []; // capture ids in the order they were made

  await test(`Retention: after ${KEEP + 3} captures only the ${KEEP} most recent remain, with their frames`, async () => {
    const short = await ctx.openFixture('page.html?h=600');
    const long = await ctx.openFixture('page.html?h=1700');

    // Captures get millisecond ids, so they are spaced to keep the order unambiguous.
    for (let i = 0; i < KEEP; i++) {
      const studio = await act.captureVisible(ctx, short);
      made.push(idOf(studio));
      await studio.close();
      await act.sleep(60);
    }
    let store = await readStore();
    assertEqual(store.keep, KEEP, 'retention setting');
    assertEqual(store.captures.length, KEEP, `captures stored after ${KEEP}`);

    // Three more, each made of several screenshots stored as separate frames.
    for (let i = 0; i < 3; i++) {
      const studio = await act.captureFullPage(ctx, long);
      made.push(idOf(studio));
      await studio.close();
      await act.sleep(300);
      store = await readStore();
      assert(store.captures.length <= KEEP, `never more than ${KEEP} captures stored (found ${store.captures.length} after capture ${made.length})`);
    }

    const expected = made.slice(-KEEP);
    assertEqual(JSON.stringify(store.captures.map((c) => c.id)), JSON.stringify(expected), 'the captures kept are the most recent ones');
    const multiFrame = store.captures.filter((c) => c.mode === 'full').map((c) => c.id).sort();
    assertEqual(JSON.stringify(store.frameSessions), JSON.stringify(multiFrame), 'frames exist only for captures that are kept');
    await short.close();
    await long.close();
    return `${made.length} made, ${store.captures.length} kept, ${store.frameCount} frames for ${store.frameSessions.length} multi-frame captures`;
  });

  await test('Closing the Studio tab does not delete the capture: it reopens from local storage', async () => {
    const before = await readStore();
    for (const tab of await ctx.browser.pages()) {
      if (tab.url().includes('studio/viewer.html')) await tab.close();
    }

    const kept = made[made.length - 1];
    const page = await ctx.browser.newPage();
    await page.goto(`chrome-extension://${ctx.extensionId}/studio/viewer.html?id=${kept}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('doc-dims').textContent !== '0 × 0 px' || document.getElementById('doc-title').textContent.startsWith('Error'));
    const title = await page.$eval('#doc-title', (el) => el.textContent);
    assert(!title.startsWith('Error'), 'a kept capture reopens: ' + title);
    await page.close();
    await act.sleep(300);

    const after = await readStore();
    assertEqual(JSON.stringify(after), JSON.stringify(before), 'stored captures after closing the Studio');
    return `${after.captures.length} captures still stored`;
  });

  await test('A capture older than the most recent 10 is really gone', async () => {
    const expired = made[0];
    const page = await ctx.browser.newPage();
    await page.goto(`chrome-extension://${ctx.extensionId}/studio/viewer.html?id=${expired}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('doc-title').textContent.startsWith('Error'), { timeout: 15000 });
    const title = await page.$eval('#doc-title', (el) => el.textContent);
    assert(/not found/i.test(title), 'message: ' + title);
    await page.close();
    return title;
  });

  await test('Nothing is sent over the network by a capture, the service worker or the Studio', async () => {
    const seen = { page: [], worker: [], studio: [] };
    /** Records every request and socket a target opens, through the DevTools protocol. */
    const observe = async (target, sink) => {
      const session = await target.createCDPSession();
      await session.send('Network.enable');
      session.on('Network.requestWillBeSent', (e) => sink.push(e.request.url));
      session.on('Network.webSocketCreated', (e) => sink.push(e.url));
      return session;
    };

    const workerTarget = await ctx.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(ctx.extensionId));
    const workerSession = await observe(workerTarget, seen.worker);
    const page = await ctx.openFixture('page.html?h=1700');
    await observe(page.target(), seen.page);

    const studio = await act.captureFullPage(ctx, page);
    // Reloaded under observation, so everything the Studio loads from start to finish is seen.
    await observe(studio.target(), seen.studio);
    await studio.reload({ waitUntil: 'load' });
    await studio.waitForFunction(() => document.getElementById('doc-dims').textContent !== '0 × 0 px');
    // An export runs the encoders and the download path as well.
    await ctx.download(studio, () => studio.click('#btn-export-png'));
    await act.sleep(500);

    const remote = [...seen.page, ...seen.worker, ...seen.studio].filter(isRemote);
    assertEqual(remote.length, 0, 'requests to a remote address: ' + remote.join(', '));
    assert(seen.studio.length > 0, 'the Studio tab was observed loading its own files');
    const foreign = seen.studio.filter((url) => !/^(chrome-extension|data|blob):/.test(url));
    assertEqual(foreign.length, 0, 'Studio requests outside the extension package: ' + foreign.join(', '));
    await workerSession.detach().catch(() => {});
    await studio.close();
    await page.close();
    return `page ${seen.page.length}, service worker ${seen.worker.length}, Studio ${seen.studio.length} requests observed; none remote`;
  });
};
