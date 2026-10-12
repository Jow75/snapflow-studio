/**
 * SnapFlow - Service Worker Coordinator
 *
 * Owns the parts of a capture that only the extension process can do: taking the
 * screenshots (with Chrome's two-per-second quota respected), writing frames to
 * local storage as they arrive, and opening the Studio when a capture is saved.
 *
 * The content script drives every multi-frame capture and asks for one screenshot
 * at a time. Session state lives in chrome.storage.session and frames in IndexedDB,
 * so the worker can be suspended and restarted mid-capture without losing anything.
 */

importScripts('../engine/capture-store.js');

/**
 * Injected once per page, inert until the content script sets the attributes.
 * Scroll animation and snapping are disabled so a requested offset is reached
 * immediately; scrollbars of the capture target are hidden so they are not captured.
 */
const CAPTURE_CSS = `
html[data-snapflow-capturing],
html[data-snapflow-capturing] * {
  scroll-behavior: auto !important;
  scroll-snap-type: none !important;
}
html[data-snapflow-capturing="document"] { scrollbar-width: none !important; }
[data-snapflow-target] { scrollbar-width: none !important; }
`;

/** Chrome allows two captureVisibleTab calls per second. */
const MIN_CAPTURE_INTERVAL_MS = 520;
const MAX_CAPTURE_ATTEMPTS = 6;
const SESSION_KEY = 'snapflowActiveSession';

let lastCaptureAt = 0;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

async function getSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

function setSession(session) {
  return chrome.storage.session.set({ [SESSION_KEY]: session });
}

async function endSession(session, { keepFrames = false } = {}) {
  await chrome.storage.session.remove(SESSION_KEY);
  if (!session) return;
  setBadge(session.tabId, '');
  if (!keepFrames) await CaptureStore.deleteFrames(session.id).catch(() => {});
}

function setBadge(tabId, text) {
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * Takes one screenshot of the visible tab, spacing calls to stay inside Chrome's
 * quota and backing off if the quota is hit anyway.
 */
async function grabVisibleTab(windowId) {
  let backoff = MIN_CAPTURE_INTERVAL_MS;
  for (let attempt = 1; ; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    try {
      lastCaptureAt = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const message = (err && err.message) || String(err);
      const quota = message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      if (!quota || attempt >= MAX_CAPTURE_ATTEMPTS) {
        throw new Error(quota ? 'Chrome is limiting screenshots right now. Try again in a moment.' : message);
      }
      await delay(backoff);
      backoff = Math.min(backoff * 2, 2000);
    }
  }
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

// ---------------------------------------------------------------------------
// Content script
// ---------------------------------------------------------------------------

async function ensureContentScripts(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'SF_PING' });
    if (pong && pong.ok) return pong;
  } catch (_) {}

  await chrome.scripting.insertCSS({ target: { tabId }, css: CAPTURE_CSS, origin: 'USER' });
  // The library may already be defined by a script left over from before the
  // extension was reloaded; declaring its class twice would throw.
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof ScrollStitcher !== 'undefined'
  });
  const files = probe && probe.result
    ? ['engine/end-detector.js', 'engine/content.js']
    : ['engine/scroll-stitcher.js', 'engine/end-detector.js', 'engine/content.js'];
  await chrome.scripting.executeScript({ target: { tabId }, files });
  return { ok: true, busy: false };
}

function explainInjectionFailure(err) {
  const message = (err && err.message) || String(err);
  if (/Cannot access|chrome:\/\/|extensions gallery|webstore|not allowed/i.test(message)) {
    return 'Chrome does not allow extensions to capture this page.';
  }
  return message;
}

async function openStudio(sessionId, sourceTab) {
  const options = { url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`) };
  if (sourceTab) {
    options.index = sourceTab.index + 1;
    options.windowId = sourceTab.windowId;
  }
  await chrome.tabs.create(options);
}

// ---------------------------------------------------------------------------
// Single-frame captures
// ---------------------------------------------------------------------------

async function runVisibleCapture(tabId, settings) {
  const sessionId = 'capture_' + Date.now();
  try {
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await grabVisibleTab(tab.windowId);
    await CaptureStore.putCapture({
      id: sessionId,
      format: 2,
      timestamp: Date.now(),
      mode: 'visible',
      url: tab.url || '',
      title: tab.title || 'Webpage Capture',
      sourcePage: { title: tab.title || 'Webpage Capture', url: tab.url || '' },
      rawImage: dataUrl,
      settings
    });
    CaptureStore.prune(sessionId).catch(() => {});
    broadcast({ action: 'CAPTURE_COMPLETE' });
    await openStudio(sessionId, tab);
  } catch (err) {
    console.error('[SnapFlow] Visible capture failed:', err);
    broadcast({ action: 'CAPTURE_ERROR', error: explainInjectionFailure(err) });
  }
}

/** Selected Area and non-scrolling elements: one screenshot plus a crop rectangle. */
async function handleSelectedCapture(message, senderTab) {
  const sessionId = 'capture_' + Date.now();
  const dataUrl = await grabVisibleTab(senderTab.windowId);
  const label = message.label || 'Selected Area';
  const page = message.page || {};
  const title = page.title || senderTab.title || 'Webpage';
  const url = page.url || senderTab.url || '';
  await CaptureStore.putCapture({
    id: sessionId,
    format: 2,
    timestamp: Date.now(),
    mode: 'selected',
    url,
    title: `${title} - ${label}`,
    sourcePage: { title, url },
    rawImage: dataUrl,
    cropCss: message.rect,
    viewport: message.viewport
  });
  CaptureStore.prune(sessionId).catch(() => {});
  await openStudio(sessionId, senderTab);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Multi-frame captures (driven by the content script)
// ---------------------------------------------------------------------------

async function beginSession(message, sender) {
  const tab = sender.tab;
  if (!tab) return { error: 'Captures can only start from a browser tab.' };

  const existing = await getSession();
  if (existing && existing.tabId !== tab.id) {
    // Another tab holds the session. It is only honoured if that tab is still capturing.
    let busy = false;
    try {
      const pong = await chrome.tabs.sendMessage(existing.tabId, { action: 'SF_PING' });
      busy = !!(pong && pong.busy);
    } catch (_) {}
    if (busy) return { error: 'Another capture is already running in a different tab.' };
  }
  if (existing) await endSession(existing);

  const session = {
    id: 'capture_' + Date.now(),
    tabId: tab.id,
    windowId: tab.windowId,
    mode: message.mode,
    startedAt: Date.now(),
    frameCount: 0,
    cancelled: false
  };
  await setSession(session);
  CaptureStore.prune(session.id).catch(() => {});
  setBadge(tab.id, '…');
  return { ok: true, sessionId: session.id };
}

async function grabFrame(message, sender) {
  let session = await getSession();
  if (!session || !sender.tab || session.tabId !== sender.tab.id) {
    return { error: 'The capture session is no longer active.' };
  }
  if (session.cancelled) return { cancelled: true };
  if (message.index !== session.frameCount) {
    return { error: 'Capture frames arrived out of order.' };
  }

  // captureVisibleTab photographs whichever tab is in front, so the source tab must be it.
  const tab = await chrome.tabs.get(session.tabId);
  if (!tab.active) {
    return { error: 'The tab was switched during the capture. Keep it in front until the capture finishes.' };
  }

  const dataUrl = await grabVisibleTab(tab.windowId);
  const blob = await dataUrlToBlob(dataUrl);
  // The content script lays frames out in device pixels and needs the real bitmap
  // size; window.innerWidth/innerHeight are rounded and cannot provide it.
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  await CaptureStore.putFrame(session.id, message.index, blob);

  // Re-read: the capture may have been cancelled while the screenshot was in flight.
  session = await getSession();
  if (!session || session.cancelled) return { cancelled: true };
  session.frameCount = message.index + 1;
  await setSession(session);

  const progress = message.progress;
  if (progress && progress.total > 0) {
    const percent = Math.max(1, Math.min(99, Math.round((progress.done / progress.total) * 100)));
    setBadge(session.tabId, `${percent}%`);
    broadcast({
      action: 'CAPTURE_PROGRESS',
      percent,
      state: `Capturing frame ${session.frameCount}`,
      stepInfo: `${Math.round(progress.done).toLocaleString()} of ${Math.round(progress.total).toLocaleString()} px`
    });
  }
  return { ok: true, width: size.width, height: size.height };
}

async function finishSession(message, sender) {
  const session = await getSession();
  if (!session || !sender.tab || session.tabId !== sender.tab.id) {
    return { error: 'The capture session is no longer active.' };
  }
  if (session.cancelled) return { error: 'Capture cancelled' };
  if (!Array.isArray(message.frames) || message.frames.length !== session.frameCount || !session.frameCount) {
    await endSession(session);
    return { error: 'The capture is incomplete and was discarded.' };
  }

  const page = message.page || {};
  const title = page.title || sender.tab.title || 'Webpage Capture';
  const url = page.url || sender.tab.url;
  const settings = await loadSettings();

  await CaptureStore.putCapture({
    id: session.id,
    format: 2,
    timestamp: Date.now(),
    mode: message.mode === 'element' ? 'element' : 'full',
    url,
    title: message.mode === 'element' ? `${title} - Scrolling Region` : title,
    sourcePage: { title, url },
    plan: message.plan,
    frames: message.frames,
    frameCount: session.frameCount,
    warnings: Array.isArray(message.warnings) ? message.warnings : [],
    settings
  });
  // Applied as soon as the capture is saved, so there are never more than the kept number.
  await CaptureStore.prune(session.id).catch(() => {});

  await endSession(session, { keepFrames: true });
  broadcast({ action: 'CAPTURE_COMPLETE' });
  await openStudio(session.id, sender.tab);
  return { ok: true };
}

async function abortSession(message, sender) {
  const session = await getSession();
  if (session && sender.tab && session.tabId === sender.tab.id) await endSession(session);
  if (message.error) broadcast({ action: 'CAPTURE_ERROR', error: message.error });
  else broadcast({ action: 'CAPTURE_CANCELLED' });
  return { ok: true };
}

async function cancelCapture(tabId) {
  const session = await getSession();
  if (session && session.tabId === tabId) {
    session.cancelled = true;
    await setSession(session);
  }
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'SF_CANCEL' });
  } catch (_) {
    // The page is gone or was never injected; drop the session ourselves.
    if (session && session.tabId === tabId) await endSession(session);
  }
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get(['scrollDelay', 'hideFixed', 'preflight', 'defaultFormat']);
  return {
    scrollDelay: Number.isFinite(stored.scrollDelay) ? stored.scrollDelay : 200,
    hideFixed: stored.hideFixed !== false,
    preflight: stored.preflight !== false,
    defaultFormat: stored.defaultFormat || 'png'
  };
}

async function startCapture(mode, tabId, settings) {
  if (mode === 'visible') {
    runVisibleCapture(tabId, settings);
    return { started: true };
  }

  try {
    await ensureContentScripts(tabId);
  } catch (err) {
    return { error: explainInjectionFailure(err) };
  }

  const action = {
    full: 'SF_START_FULL',
    selected: 'START_AREA_SELECTION',
    element: 'START_ELEMENT_SELECTION'
  }[mode];
  if (!action) return { error: 'Unknown capture mode: ' + mode };

  const response = await chrome.tabs.sendMessage(tabId, { action, settings });
  if (response && response.error) return { error: response.error };
  return { started: true };
}

const handlers = {
  START_CAPTURE: (message) => startCapture(message.mode, message.tabId, message.settings || {}),
  CANCEL_CAPTURE: (message) => cancelCapture(message.tabId),
  EXECUTE_SELECTED_CAPTURE: (message, sender) => {
    if (!message.rect || !sender.tab) return { error: 'Nothing was selected.' };
    return handleSelectedCapture(message, sender.tab);
  },
  SF_SESSION_BEGIN: beginSession,
  SF_GRAB: grabFrame,
  SF_FINISH: finishSession,
  SF_ABORT: abortSession
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;
  const handler = handlers[message.action];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (err) => {
      console.error(`[SnapFlow] ${message.action} failed:`, err);
      sendResponse({ error: (err && err.message) || String(err) });
    });
  return true;
});

// A capture cannot outlive its page.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session && session.tabId === tabId) await endSession(session);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const session = await getSession();
  if (session && session.tabId === tabId) {
    await endSession(session);
    broadcast({ action: 'CAPTURE_ERROR', error: 'The page navigated away, so the capture was stopped.' });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const mode = { 'capture-full-page': 'full', 'capture-visible': 'visible' }[command];
  if (!mode) return;

  const result = await startCapture(mode, tab.id, await loadSettings());
  if (result && result.error) {
    // No popup is open for a keyboard shortcut, so the toolbar badge reports the failure.
    setBadge(tab.id, '!');
    chrome.action.setTitle({ tabId: tab.id, title: 'SnapFlow: ' + result.error }).catch(() => {});
    setTimeout(() => setBadge(tab.id, ''), 5000);
  }
});
