/**
 * SnapFlow - Content Script Engine (Reliability 1.0)
 * Runs inside the target tab to analyze DOM, classify sticky elements,
 * detect virtualized rendering, handle nested scrollers, and guarantee DOM restoration.
 */

(() => {
  if (window.__SNAPFLOW_CONTENT_ENGINE__) {
    return;
  }
  window.__SNAPFLOW_CONTENT_ENGINE__ = true;

  /**
   * 1. Guaranteed DOM State Tracker
   * Records every style mutation so it can be completely reversed.
   */
  class DOMStateTracker {
    constructor() {
      this.mutatedElements = new Map();
      this.originalScrollX = window.scrollX;
      this.originalScrollY = window.scrollY;
      this.originalHtmlOverflow = document.documentElement.style.overflow;
      this.originalBodyOverflow = document.body ? document.body.style.overflow : '';
      this.originalHtmlScrollBehavior = document.documentElement.style.scrollBehavior;
      this.originalBodyScrollBehavior = document.body ? document.body.style.scrollBehavior : '';
      this.hasRecordedScrollBehavior = false;
      this.hasHiddenScrollbars = false;
    }

    recordMutation(el, properties) {
      if (!this.mutatedElements.has(el)) {
        const originalStyles = {};
        for (const prop of properties) {
          originalStyles[prop] = el.style[prop] || '';
        }
        this.mutatedElements.set(el, originalStyles);
      }
    }

    restoreAll() {
      // Restore all mutated elements
      for (const [el, originalStyles] of this.mutatedElements.entries()) {
        try {
          for (const [prop, val] of Object.entries(originalStyles)) {
            el.style[prop] = val;
          }
        } catch (_) {}
      }
      this.mutatedElements.clear();

      // Restore scrollbars & behavior & position
      try {
        document.documentElement.style.overflow = this.originalHtmlOverflow;
        document.documentElement.style.scrollBehavior = this.originalHtmlScrollBehavior;
        if (document.body) {
          document.body.style.overflow = this.originalBodyOverflow;
          document.body.style.scrollBehavior = this.originalBodyScrollBehavior;
        }
        window.scrollTo({ left: this.originalScrollX, top: this.originalScrollY, behavior: 'instant' });
      } catch (_) {
        try { window.scrollTo(this.originalScrollX, this.originalScrollY); } catch (_) {}
      }
      this.hasRecordedScrollBehavior = false;
      this.hasHiddenScrollbars = false;
    }
  }

  const domTracker = new DOMStateTracker();
  let stickyCandidates = [];
  let selectionOverlay = null;

  /**
   * 2. Advanced Page Metrics & Virtualization Detector
   */
  function getPageMetrics() {
    const doc = document.documentElement;
    const body = document.body || {};

    const scrollWidth = Math.max(
      doc.scrollWidth || 0,
      doc.offsetWidth || 0,
      doc.clientWidth || 0,
      body.scrollWidth || 0,
      body.offsetWidth || 0
    );

    const scrollHeight = Math.max(
      doc.scrollHeight || 0,
      doc.offsetHeight || 0,
      doc.clientHeight || 0,
      body.scrollHeight || 0,
      body.offsetHeight || 0
    );

    const viewportWidth = window.innerWidth || doc.clientWidth || 0;
    const viewportHeight = window.innerHeight || doc.clientHeight || 0;
    const dpr = window.devicePixelRatio || 1;

    // Virtualization heuristic:
    // If page is very tall (>10,000px) but has unusually few DOM elements (<500 elements),
    // or contains virtual scroll markers, flag virtualization.
    const totalElements = document.querySelectorAll('*').length;
    const elementDensity = scrollHeight > 0 ? totalElements / (scrollHeight / 1000) : 100;
    const hasVirtualMarkers = !!document.querySelector('[data-virtualized], [data-virtual-scroll], .virtual-list, .react-window, [role="feed"]');
    const isVirtualized = (scrollHeight > 10000 && elementDensity < 15) || hasVirtualMarkers;

    return {
      scrollWidth,
      scrollHeight,
      viewportWidth,
      viewportHeight,
      dpr,
      title: document.title || 'Webpage',
      url: window.location.href,
      isVirtualized,
      elementCount: totalElements
    };
  }

  /**
   * 3. Sticky Candidate Classification Engine
   * Classifies elements based on computed position, viewport coverage, stationary behavior,
   * and duplication risk, rather than blindly hiding all sticky content.
   */
  function classifyStickyElements() {
    domTracker.restoreAll();
    stickyCandidates = [];

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      if (el.id && el.id.startsWith('snapflow-')) continue;

      const style = window.getComputedStyle(el);
      const pos = style.position;

      if (pos === 'fixed' || pos === 'sticky') {
        const rect = el.getBoundingClientRect();
        // Ignore invisible or collapsed elements
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') {
          continue;
        }

        // Classification properties
        const isHeaderCandidate = rect.top <= 10 && rect.width >= viewportW * 0.5 && rect.height <= viewportH * 0.4;
        const isFooterCandidate = rect.bottom >= (viewportH - 10) && rect.width >= viewportW * 0.5 && rect.height <= viewportH * 0.4;
        const isFloatingWidget = rect.width < viewportW * 0.4 && rect.height < viewportH * 0.3;

        // Duplication risk score (0 to 100)
        let duplicationRisk = 0;
        if (pos === 'fixed') {
          duplicationRisk = isHeaderCandidate ? 95 : isFooterCandidate ? 90 : isFloatingWidget ? 80 : 50;
        } else if (pos === 'sticky') {
          duplicationRisk = isHeaderCandidate ? 85 : 40;
        }

        // Record candidate
        stickyCandidates.push({
          element: el,
          positionType: pos,
          isHeader: isHeaderCandidate,
          isFooter: isFooterCandidate,
          isFloatingWidget: isFloatingWidget,
          duplicationRisk: duplicationRisk,
          initialRect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        });
      }
    }

    return {
      totalFound: stickyCandidates.length,
      highRiskHeaders: stickyCandidates.filter((c) => c.duplicationRisk >= 80).length
    };
  }

  /**
   * Suppresses high-risk sticky elements during vertical scroll passes (Y > 0)
   */
  function setStickySuppression(suppress) {
    if (suppress) {
      for (const candidate of stickyCandidates) {
        if (candidate.duplicationRisk >= 60) {
          domTracker.recordMutation(candidate.element, ['visibility', 'opacity', 'transition']);
          candidate.element.style.transition = 'none';
          candidate.element.style.visibility = 'hidden';
        }
      }
      // Dynamically catch any elements that became fixed/sticky on scroll
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if (el.id && el.id.startsWith('snapflow-')) continue;
        const style = window.getComputedStyle(el);
        const pos = style.position;
        if (pos === 'fixed' || pos === 'sticky') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
            if (rect.top <= 25 || rect.bottom >= window.innerHeight - 25 || pos === 'fixed') {
              domTracker.recordMutation(el, ['visibility', 'opacity', 'transition']);
              el.style.transition = 'none';
              el.style.visibility = 'hidden';
            }
          }
        }
      }
    } else {
      for (const [el, originalStyles] of domTracker.mutatedElements.entries()) {
        if (el !== document.documentElement && el !== document.body) {
          try {
            for (const [prop, val] of Object.entries(originalStyles)) {
              el.style[prop] = val;
            }
          } catch (_) {}
        }
      }
    }
  }

  /**
   * 4. Pre-Flight Hydration (Lazy-Load & Image Decode Await)
   */
  async function hydratePage() {
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const viewHeight = window.innerHeight;
    const stepSize = Math.max(viewHeight * 1.5, 800);
    let currentY = 0;

    // Fast sweep down page
    while (currentY < docHeight) {
      window.scrollTo(0, currentY);
      currentY += stepSize;
      await new Promise((r) => setTimeout(r, 40));
    }

    window.scrollTo(0, docHeight);
    await new Promise((r) => setTimeout(r, 60));

    // Wait for uncompleted images
    const images = Array.from(document.images || []);
    const pendingImages = images.filter((img) => !img.complete && img.src);

    if (pendingImages.length > 0) {
      await Promise.race([
        Promise.all(
          pendingImages.map(
            (img) =>
              new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
              })
          )
        ),
        new Promise((r) => setTimeout(r, 1200))
      ]);
    }

    // Reset smoothly to top
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  }

  let activeScrollElement = null;
  let originalElementScrollTop = 0;
  let originalElementScrollLeft = 0;

  /**
   * 5. Interactive Selected Area Marquee
   */
  function startAreaSelection() {
    if (selectionOverlay) selectionOverlay.remove();

    const overlay = document.createElement('div');
    overlay.id = 'snapflow-selection-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(15, 23, 42, 0.45);
      z-index: 2147483647;
      cursor: crosshair;
      user-select: none;
    `;

    // Instruction banner
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: fixed;
      top: 16px; left: 50%;
      transform: translateX(-50%);
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      padding: 8px 18px;
      border-radius: 30px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      pointer-events: none;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    banner.innerHTML = `<span>📐</span><span>Click & drag to select area. Press <kbd style="background:#334155;padding:1px 5px;border-radius:4px;font-size:11px;">Esc</kbd> to cancel.</span>`;
    overlay.appendChild(banner);

    const marquee = document.createElement('div');
    marquee.id = 'snapflow-marquee';
    marquee.style.cssText = `
      position: absolute;
      border: 2px dashed #6366f1;
      background: rgba(99, 102, 241, 0.18);
      pointer-events: none;
      display: none;
    `;

    const dimsBadge = document.createElement('div');
    dimsBadge.id = 'snapflow-dims';
    dimsBadge.style.cssText = `
      position: absolute;
      top: -28px; left: 0;
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, sans-serif;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      white-space: nowrap;
    `;
    marquee.appendChild(dimsBadge);
    overlay.appendChild(marquee);
    document.documentElement.appendChild(overlay);
    selectionOverlay = overlay;

    let startX = 0, startY = 0, isDragging = false;

    const onMouseDown = (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      marquee.style.display = 'block';
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      marquee.style.left = `${x}px`;
      marquee.style.top = `${y}px`;
      marquee.style.width = `${w}px`;
      marquee.style.height = `${h}px`;
      dimsBadge.textContent = `${Math.round(w * window.devicePixelRatio)} × ${Math.round(h * window.devicePixelRatio)} px`;
    };

    const cleanup = () => {
      overlay.remove();
      selectionOverlay = null;
      window.removeEventListener('keydown', onKeyDown);
    };

    const onMouseUp = (e) => {
      if (!isDragging) return;
      isDragging = false;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      cleanup();

      if (w < 10 || h < 10) return;

      chrome.runtime.sendMessage({
        action: 'EXECUTE_SELECTED_CAPTURE',
        cropArea: {
          x: x * window.devicePixelRatio,
          y: y * window.devicePixelRatio,
          width: w * window.devicePixelRatio,
          height: h * window.devicePixelRatio
        }
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
  }

  /**
   * 6. Interactive Scrolling Region Selection & Action Confirmation Pill
   */
  function startElementSelection() {
    let hoveredElement = null;
    let selectedElement = null;

    // Top Instruction Banner
    const banner = document.createElement('div');
    banner.id = 'snapflow-region-banner';
    banner.style.cssText = `
      position: fixed;
      top: 16px; left: 50%;
      transform: translateX(-50%);
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      padding: 8px 18px;
      border-radius: 30px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
    `;
    banner.innerHTML = `<span>🔍</span><span>Hover & click any scrollable container, table, or code block. Press <kbd style="background:#334155;padding:1px 5px;border-radius:4px;font-size:11px;">Esc</kbd> to cancel.</span>`;
    document.documentElement.appendChild(banner);

    // Dynamic Hover / Selection Frame
    const highlightBox = document.createElement('div');
    highlightBox.id = 'snapflow-elem-highlighter';
    highlightBox.style.cssText = `
      position: fixed;
      pointer-events: none;
      border: 2px solid #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      z-index: 2147483646;
      display: none;
      transition: all 0.05s ease;
    `;

    const badge = document.createElement('div');
    badge.style.cssText = `
      position: absolute;
      top: -26px; left: 0;
      background: #0284c7;
      color: #ffffff;
      font-family: -apple-system, sans-serif;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      white-space: nowrap;
    `;
    highlightBox.appendChild(badge);
    document.documentElement.appendChild(highlightBox);

    // Floating Action Confirmation Pill (Appears upon clicking an element)
    const actionPill = document.createElement('div');
    actionPill.id = 'snapflow-action-pill';
    actionPill.style.cssText = `
      position: fixed;
      display: none;
      background: #0f172a;
      color: #f8fafc;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      align-items: center;
      gap: 12px;
      font-size: 13px;
    `;
    document.documentElement.appendChild(actionPill);

    const onMouseMove = (e) => {
      if (selectedElement) return; // Frozen on selection

      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === highlightBox || target === banner || target === actionPill) return;

      let curr = target;
      let foundScrollable = null;
      while (curr && curr !== document.documentElement && curr !== document.body) {
        const style = window.getComputedStyle(curr);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;
        const isScrollY = (overflowY === 'auto' || overflowY === 'scroll') && curr.scrollHeight > curr.clientHeight;
        const isScrollX = (overflowX === 'auto' || overflowX === 'scroll') && curr.scrollWidth > curr.clientWidth;
        if (isScrollY || isScrollX) {
          foundScrollable = curr;
          break;
        }
        curr = curr.parentElement;
      }

      hoveredElement = foundScrollable || target;
      const rect = hoveredElement.getBoundingClientRect();
      const isScroll = hoveredElement.scrollHeight > hoveredElement.clientHeight;

      highlightBox.style.display = 'block';
      highlightBox.style.left = `${rect.left}px`;
      highlightBox.style.top = `${rect.top}px`;
      highlightBox.style.width = `${rect.width}px`;
      highlightBox.style.height = `${rect.height}px`;

      if (isScroll) {
        highlightBox.style.borderColor = '#38bdf8';
        badge.style.background = '#0284c7';
        badge.textContent = `Scrollable: ${hoveredElement.scrollHeight}px (${hoveredElement.tagName.toLowerCase()})`;
      } else {
        highlightBox.style.borderColor = '#a855f7';
        badge.style.background = '#7e22ce';
        badge.textContent = `Visible: ${Math.round(rect.width)}×${Math.round(rect.height)}px (${hoveredElement.tagName.toLowerCase()})`;
      }
    };

    const cleanup = () => {
      banner.remove();
      highlightBox.remove();
      actionPill.remove();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
    };

    const onClick = (e) => {
      if (actionPill.contains(e.target)) return;

      e.preventDefault();
      e.stopPropagation();

      if (!hoveredElement) return;
      selectedElement = hoveredElement;

      const rect = selectedElement.getBoundingClientRect();
      const isScroll = selectedElement.scrollHeight > selectedElement.clientHeight;

      // Position action pill right below or above element
      const pillTop = Math.min(window.innerHeight - 60, Math.max(10, rect.bottom + 10));
      const pillLeft = Math.min(window.innerWidth - 320, Math.max(10, rect.left));

      actionPill.style.display = 'flex';
      actionPill.style.top = `${pillTop}px`;
      actionPill.style.left = `${pillLeft}px`;

      actionPill.innerHTML = `
        <div style="font-weight:600;font-size:12px;color:#94a3b8;">
          ${isScroll ? `Scrollable (${selectedElement.scrollHeight}px)` : `Static Element`}
        </div>
        <button id="snapflow-pill-confirm" style="
          background: #4f46e5; color: #fff; border: none; padding: 6px 12px;
          border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer;
        ">
          📸 ${isScroll ? 'Capture Scrolling Region' : 'Capture Region'}
        </button>
        <button id="snapflow-pill-cancel" style="
          background: transparent; color: #94a3b8; border: 1px solid #334155; padding: 6px 10px;
          border-radius: 6px; font-size: 12px; cursor: pointer;
        ">
          Cancel
        </button>
      `;

      document.getElementById('snapflow-pill-cancel').addEventListener('click', () => {
        cleanup();
      });

      document.getElementById('snapflow-pill-confirm').addEventListener('click', () => {
        const el = selectedElement;
        const finalRect = el.getBoundingClientRect();
        activeScrollElement = el;
        originalElementScrollTop = el.scrollTop;
        originalElementScrollLeft = el.scrollLeft;

        cleanup();

        chrome.runtime.sendMessage({
          action: 'INITIATE_REGION_CAPTURE',
          elementInfo: {
            x: finalRect.left,
            y: finalRect.top,
            width: finalRect.width,
            height: finalRect.height,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
            dpr: window.devicePixelRatio,
            isScrollable: el.scrollHeight > el.clientHeight
          }
        });
      });
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') cleanup();
      if (e.key === 'Enter' && selectedElement) {
        const btn = document.getElementById('snapflow-pill-confirm');
        if (btn) btn.click();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown);
  }

  /**
   * 7. Runtime Message Dispatcher
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'GET_PAGE_METRICS':
        sendResponse(getPageMetrics());
        break;

      case 'HYDRATE_PAGE':
        hydratePage()
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ error: err.message }));
        return true;

      case 'SCAN_FIXED_ELEMENTS':
        const classification = classifyStickyElements();
        sendResponse({ success: true, classification });
        break;

      case 'SCROLL_TO': {
        const targetX = message.x || 0;
        const targetY = message.y || 0;

        // Ensure instantaneous scrolling without CSS smooth animation lag
        if (!domTracker.hasRecordedScrollBehavior) {
          domTracker.recordMutation(document.documentElement, ['scrollBehavior', 'overflow']);
          if (document.body) {
            domTracker.recordMutation(document.body, ['scrollBehavior', 'overflow']);
          }
          document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
          document.documentElement.style.overflow = 'hidden';
          if (document.body) {
            document.body.style.setProperty('scroll-behavior', 'auto', 'important');
          }
          domTracker.hasRecordedScrollBehavior = true;
          domTracker.hasHiddenScrollbars = true;
        }

        if (message.hideFixed) {
          setStickySuppression(targetY > 0);
        }

        // Instantaneous scroll execution
        try {
          window.scrollTo({ left: targetX, top: targetY, behavior: 'instant' });
        } catch (_) {
          window.scrollTo(targetX, targetY);
        }
        if (document.scrollingElement) {
          document.scrollingElement.scrollLeft = targetX;
          document.scrollingElement.scrollTop = targetY;
        }

        // Double RAF compositor and layout synchronization
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const actualX = window.scrollX || (document.scrollingElement ? document.scrollingElement.scrollLeft : 0);
            const actualY = window.scrollY || (document.scrollingElement ? document.scrollingElement.scrollTop : 0);
            sendResponse({
              success: true,
              actualX,
              actualY,
              scrollY: actualY,
              scrollX: actualX,
              clientWidth: document.documentElement.clientWidth || window.innerWidth,
              clientHeight: document.documentElement.clientHeight || window.innerHeight,
              scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
              scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
              dpr: window.devicePixelRatio || 1
            });
          });
        });
        return true;
      }

      case 'SCROLL_ELEMENT_TO':
        if (activeScrollElement) {
          activeScrollElement.scrollTop = message.scrollTop || 0;
          activeScrollElement.scrollLeft = message.scrollLeft || 0;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const r = activeScrollElement.getBoundingClientRect();
              sendResponse({
                success: true,
                actualScrollTop: activeScrollElement.scrollTop,
                actualRect: {
                  x: r.left,
                  y: r.top,
                  width: r.width,
                  height: r.height
                }
              });
            });
          });
          return true;
        } else {
          sendResponse({ error: 'No active scrollable element registered' });
        }
        break;

      case 'RESTORE_DOM':
        if (activeScrollElement) {
          try {
            activeScrollElement.scrollTop = originalElementScrollTop;
            activeScrollElement.scrollLeft = originalElementScrollLeft;
          } catch (_) {}
          activeScrollElement = null;
        }
        domTracker.restoreAll();
        sendResponse({ success: true });
        break;

      case 'START_AREA_SELECTION':
        startAreaSelection();
        sendResponse({ success: true });
        break;

      case 'START_ELEMENT_SELECTION':
        startElementSelection();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: 'Unknown action: ' + message.action });
        break;
    }
  });

  console.log('[SnapFlow] Content Script Engine (Reliability 1.0) ready.');
})();
