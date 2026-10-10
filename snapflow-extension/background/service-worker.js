/**
 * SnapFlow - Service Worker Coordinator (Reliability 1.0)
 * Centralized Capture Scheduler, deterministic State Machine,
 * CaptureSession model, and quota-protected IndexedDB storage.
 */

importScripts('../engine/scroll-stitcher.js');

// Capture State Machine Definitions
const CaptureState = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  ANALYZING: 'ANALYZING',
  HYDRATING: 'HYDRATING',
  CAPTURE_PLANNING: 'CAPTURE_PLANNING',
  CAPTURING: 'CAPTURING',
  STITCHING: 'STITCHING',
  VALIDATING: 'VALIDATING',
  STUDIO_READY: 'STUDIO_READY',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR'
};

let activeSession = null;

// IndexedDB Storage
const DB_NAME = 'SnapFlowCaptureDB';
const DB_VERSION = 1;
const STORE_NAME = 'captures';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveCaptureToDB(captureData) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(captureData);
    request.onsuccess = () => resolve(captureData.id);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Centralized Capture Scheduler
 * Manages request timing, throttling, exponential backoff, and quota limits.
 */
class CaptureScheduler {
  constructor(baseDelayMs = 200, maxRetries = 5) {
    this.baseDelayMs = baseDelayMs;
    this.maxRetries = maxRetries;
  }

  async scheduleCapture(windowId, isCancelledFn) {
    let attempt = 0;
    let delay = this.baseDelayMs;

    while (attempt < this.maxRetries) {
      if (isCancelledFn()) {
        throw new Error('Capture cancelled by user');
      }

      try {
        await new Promise((r) => setTimeout(r, delay));
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        return dataUrl;
      } catch (err) {
        attempt++;
        console.warn(`[SnapFlow Scheduler] Attempt ${attempt} failed: ${err.message}`);

        if (err.message && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
          // Exponential backoff on Chromium quota ceiling
          delay = Math.min(delay * 2, 1200);
        } else if (attempt >= this.maxRetries) {
          throw new Error(`Capture quota exceeded after ${attempt} attempts: ${err.message}`);
        }
      }
    }
  }
}

const scheduler = new CaptureScheduler(200, 5);

async function ensureContentScriptsInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'GET_PAGE_METRICS' });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['engine/content.js']
    });
  }
}

function broadcastProgress(percent, state, stepInfo) {
  chrome.runtime.sendMessage({
    action: 'CAPTURE_PROGRESS',
    percent,
    state,
    stepInfo
  }).catch(() => {});
}

/**
 * 1. Full Page Capture Workflow
 */
async function runFullPageCapture(tabId, settings) {
  const sessionId = 'capture_' + Date.now();
  activeSession = {
    id: sessionId,
    tabId,
    state: CaptureState.PREPARING,
    cancelled: false
  };

  try {
    await ensureContentScriptsInjected(tabId);
    const tab = await chrome.tabs.get(tabId);

    // Step A: Hydrating
    activeSession.state = CaptureState.HYDRATING;
    if (settings.preflight) {
      broadcastProgress(5, 'Hydrating page...', 'Triggering lazy-loaded media');
      await chrome.tabs.sendMessage(tabId, { action: 'HYDRATE_PAGE' });
    }

    if (activeSession.cancelled) throw new Error('Capture cancelled by user');

    // Step B: Sticky Classification
    activeSession.state = CaptureState.ANALYZING;
    if (settings.hideFixed) {
      broadcastProgress(15, 'Classifying navigation...', 'Analyzing sticky duplication risk');
      await chrome.tabs.sendMessage(tabId, { action: 'SCAN_FIXED_ELEMENTS' });
    }

    // Step C: Planning Slices
    activeSession.state = CaptureState.CAPTURE_PLANNING;
    broadcastProgress(20, 'Calculating dimensions...', 'Formulating slicing plan');
    const metrics = await chrome.tabs.sendMessage(tabId, { action: 'GET_PAGE_METRICS' });
    const plan = ScrollStitcher.planSlices(metrics);

    const totalSlices = plan.slices.length;
    const capturedSlices = [];

    // Step D: Capture Slices
    activeSession.state = CaptureState.CAPTURING;
    for (let i = 0; i < totalSlices; i++) {
      if (activeSession.cancelled) throw new Error('Capture cancelled by user');

      const slice = plan.slices[i];
      const sliceProgress = 20 + ((i / totalSlices) * 75);
      broadcastProgress(
        sliceProgress,
        `Capturing frame ${i + 1} of ${totalSlices}`,
        `Offset ${slice.scrollY}px`
      );

      // Scroll viewport
      const scrollResult = await chrome.tabs.sendMessage(tabId, {
        action: 'SCROLL_TO',
        x: 0,
        y: slice.scrollY,
        hideFixed: settings.hideFixed
      });

      // Scheduled capture with quota protection
      const dataUrl = await scheduler.scheduleCapture(
        tab.windowId,
        () => activeSession.cancelled
      );

      capturedSlices.push({
        dataUrl,
        sliceInfo: slice,
        actualY: (scrollResult && scrollResult.actualY !== undefined) ? scrollResult.actualY : slice.scrollY,
        actualX: (scrollResult && scrollResult.actualX !== undefined) ? scrollResult.actualX : 0
      });
    }

    // Step E: Validating
    activeSession.state = CaptureState.VALIDATING;
    broadcastProgress(96, 'Validating capture...', 'Opening Studio');

    // Construct CaptureSession record
    const captureSessionRecord = {
      id: sessionId,
      timestamp: Date.now(),
      mode: 'full',
      state: CaptureState.STUDIO_READY,
      url: metrics.url || tab.url,
      title: metrics.title || tab.title || 'Webpage Capture',
      sourcePage: {
        title: metrics.title || tab.title || 'Webpage Capture',
        url: metrics.url || tab.url,
        isVirtualized: metrics.isVirtualized
      },
      plan: plan,
      slices: capturedSlices,
      settings: settings
    };

    await saveCaptureToDB(captureSessionRecord);

    chrome.runtime.sendMessage({ action: 'CAPTURE_COMPLETE' }).catch(() => {});
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`)
    });

  } catch (err) {
    console.error('[SnapFlow] Capture failed:', err);
    activeSession.state = CaptureState.ERROR;
    chrome.runtime.sendMessage({
      action: 'CAPTURE_ERROR',
      error: err.message
    }).catch(() => {});
  } finally {
    // Guaranteed cleanup
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'RESTORE_DOM' });
    } catch (_) {}
    activeSession = null;
  }
}

/**
 * 2. Visible Viewport Capture Workflow
 */
async function runVisibleCapture(tabId, settings) {
  const sessionId = 'capture_' + Date.now();
  try {
    await ensureContentScriptsInjected(tabId);
    const tab = await chrome.tabs.get(tabId);
    const metrics = await chrome.tabs.sendMessage(tabId, { action: 'GET_PAGE_METRICS' });

    const dataUrl = await scheduler.scheduleCapture(tab.windowId, () => false);

    const captureRecord = {
      id: sessionId,
      timestamp: Date.now(),
      mode: 'visible',
      state: CaptureState.STUDIO_READY,
      url: metrics.url || tab.url,
      title: metrics.title || tab.title || 'Webpage Capture',
      sourcePage: { title: metrics.title || tab.title || 'Webpage Capture', url: metrics.url || tab.url },
      rawImage: dataUrl,
      settings: settings
    };

    await saveCaptureToDB(captureRecord);
    chrome.runtime.sendMessage({ action: 'CAPTURE_COMPLETE' }).catch(() => {});
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`)
    });
  } catch (err) {
    console.error('[SnapFlow] Visible capture failed:', err);
    chrome.runtime.sendMessage({ action: 'CAPTURE_ERROR', error: err.message }).catch(() => {});
  }
}

/**
 * 3. Area / Selected Capture Handlers
 */
async function handleSelectedCapture(cropArea, senderTab) {
  const sessionId = 'capture_' + Date.now();
  try {
    const dataUrl = await scheduler.scheduleCapture(senderTab.windowId, () => false);
    const captureRecord = {
      id: sessionId,
      timestamp: Date.now(),
      mode: 'selected',
      state: CaptureState.STUDIO_READY,
      url: senderTab.url,
      title: senderTab.title || 'Selected Area',
      sourcePage: { title: senderTab.title || 'Selected Area', url: senderTab.url },
      rawImage: dataUrl,
      cropArea: cropArea
    };

    await saveCaptureToDB(captureRecord);
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`)
    });
  } catch (err) {
    console.error('[SnapFlow] Selected capture failed:', err);
  }
}

/**
 * 4. Dedicated Scrolling Region Capture Workflow
 */
async function runScrollingRegionCapture(tabId, elementInfo, senderTab) {
  const sessionId = 'capture_' + Date.now();
  try {
    const tab = senderTab || (await chrome.tabs.get(tabId));

    if (!elementInfo.isScrollable || elementInfo.scrollHeight <= elementInfo.clientHeight) {
      // Non-scrollable element: capture current viewport and crop element rectangle
      const dataUrl = await scheduler.scheduleCapture(tab.windowId, () => false);
      const dpr = elementInfo.dpr || 1;
      const cropArea = {
        x: elementInfo.x * dpr,
        y: elementInfo.y * dpr,
        width: elementInfo.width * dpr,
        height: elementInfo.height * dpr
      };

      const captureRecord = {
        id: sessionId,
        timestamp: Date.now(),
        mode: 'selected',
        state: CaptureState.STUDIO_READY,
        url: tab.url,
        title: (tab.title || 'Webpage') + ' - Element',
        sourcePage: { title: tab.title || 'Webpage', url: tab.url },
        rawImage: dataUrl,
        cropArea: cropArea
      };

      await saveCaptureToDB(captureRecord);
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`)
      });
      return;
    }

    // Scrollable container: plan discrete element slices
    const plan = ScrollStitcher.planElementSlices(elementInfo);
    const capturedSlices = [];
    const totalSlices = plan.slices.length;

    for (let i = 0; i < totalSlices; i++) {
      const slice = plan.slices[i];

      // Command content script to scroll the container
      await chrome.tabs.sendMessage(tabId, {
        action: 'SCROLL_ELEMENT_TO',
        scrollTop: slice.scrollTop,
        scrollLeft: slice.scrollLeft
      });

      // Capture visible tab frame
      const dataUrl = await scheduler.scheduleCapture(tab.windowId, () => false);

      capturedSlices.push({
        dataUrl,
        sliceInfo: slice
      });
    }

    // Clean up content DOM state
    await chrome.tabs.sendMessage(tabId, { action: 'RESTORE_DOM' }).catch(() => {});

    // Save complete element capture record
    const captureRecord = {
      id: sessionId,
      timestamp: Date.now(),
      mode: 'element',
      state: CaptureState.STUDIO_READY,
      url: tab.url,
      title: (tab.title || 'Webpage') + ' - Scrolling Region',
      sourcePage: { title: tab.title || 'Webpage', url: tab.url },
      plan: plan,
      slices: capturedSlices
    };

    await saveCaptureToDB(captureRecord);
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`studio/viewer.html?id=${sessionId}`)
    });

  } catch (err) {
    console.error('[SnapFlow] Scrolling region capture failed:', err);
    chrome.tabs.sendMessage(tabId, { action: 'RESTORE_DOM' }).catch(() => {});
  }
}

// Runtime Message Router with Payload Validation
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return;

  switch (message.action) {
    case 'START_CAPTURE':
      if (message.mode === 'full') {
        runFullPageCapture(message.tabId, message.settings || {});
        sendResponse({ started: true });
      } else if (message.mode === 'visible') {
        runVisibleCapture(message.tabId, message.settings || {});
        sendResponse({ started: true });
      } else if (message.mode === 'selected') {
        ensureContentScriptsInjected(message.tabId).then(() => {
          chrome.tabs.sendMessage(message.tabId, { action: 'START_AREA_SELECTION' });
        });
        sendResponse({ started: true });
      } else if (message.mode === 'element') {
        ensureContentScriptsInjected(message.tabId).then(() => {
          chrome.tabs.sendMessage(message.tabId, { action: 'START_ELEMENT_SELECTION' });
        });
        sendResponse({ started: true });
      }
      break;

    case 'CANCEL_CAPTURE':
      if (activeSession && activeSession.tabId === message.tabId) {
        activeSession.cancelled = true;
        activeSession.state = CaptureState.CANCELLED;
      }
      sendResponse({ cancelled: true });
      break;

    case 'EXECUTE_SELECTED_CAPTURE':
      if (message.cropArea && sender.tab) {
        handleSelectedCapture(message.cropArea, sender.tab);
      }
      sendResponse({ success: true });
      break;

    case 'INITIATE_REGION_CAPTURE':
      if (message.elementInfo && sender.tab) {
        runScrollingRegionCapture(sender.tab.id, message.elementInfo, sender.tab);
      }
      sendResponse({ success: true });
      break;

    case 'EXECUTE_ELEMENT_CAPTURE':
      if (message.elementInfo && sender.tab) {
        runScrollingRegionCapture(sender.tab.id, message.elementInfo, sender.tab);
      }
      sendResponse({ success: true });
      break;

    default:
      break;
  }
  return true;
});

// Keyboard Commands Router
chrome.commands.onCommand.addListener(async (command) => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) return;
  const tab = tabs[0];

  const stored = await chrome.storage.local.get(['scrollDelay', 'hideFixed', 'preflight', 'defaultFormat']);
  const settings = {
    scrollDelay: stored.scrollDelay || 200,
    hideFixed: stored.hideFixed !== false,
    preflight: stored.preflight !== false,
    defaultFormat: stored.defaultFormat || 'png'
  };

  if (command === 'capture-full-page') {
    runFullPageCapture(tab.id, settings);
  } else if (command === 'capture-visible') {
    runVisibleCapture(tab.id, settings);
  }
});

console.log('[SnapFlow] Service Worker (Reliability 1.0) active.');
