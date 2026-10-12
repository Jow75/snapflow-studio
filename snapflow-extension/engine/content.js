/**
 * SnapFlow - Content Script Engine
 *
 * Runs inside the target tab. It owns everything that needs the live DOM:
 *   - choosing a capture target (page, dominant inner scroller, or a picked region)
 *   - moving that target through its scrollable extent and reporting where the
 *     browser actually ended up
 *   - the sticky / fixed element policy
 *   - the selection overlay, progress HUD and cancellation
 *   - restoring every style, attribute and scroll position it touched
 *
 * The service worker only takes the screenshots: this script asks for one frame at
 * a time (SF_GRAB) and describes, in device pixels, which part of that frame is new.
 */

(() => {
  // A copy left behind by a reloaded extension can no longer reach the service
  // worker; only a live copy blocks re-initialisation.
  const previous = window.__SNAPFLOW_CONTENT_ENGINE__;
  if (previous && typeof previous.alive === 'function' && previous.alive()) {
    return;
  }
  window.__SNAPFLOW_CONTENT_ENGINE__ = {
    alive: () => {
      try {
        return !!chrome.runtime.id;
      } catch (_) {
        return false;
      }
    }
  };

  const CAPTURE_ATTR = 'data-snapflow-capturing';
  const TARGET_ATTR = 'data-snapflow-target';

  const MAX_FRAMES = 200;            // hard stop for a single capture
  const GROWTH_FACTOR = 3;           // how far a page may grow while being captured
  const GROWTH_ALLOWANCE_PX = 4000;
  const MIN_HORIZONTAL_SCAN_PX = 8;  // smaller horizontal overflow is treated as noise
  const HUD_CLEARANCE_PX = 16;       // the progress panel's shadow extends this far past its box
  const INNER_SCROLLER_MIN_AREA = 0.3;
  const GRAB_TIMEOUT_MS = 30000;
  // A region is given four minutes to finish loading more content, which is longer
  // than it takes to load as much as MAX_FRAMES can hold at about a second per load.
  const REGION_LOAD_LIMIT_MS = 240000;
  const REGION_TIME_LIMIT_MS = 600000; // hard stop for one automatic region capture

  const EndDetector = globalThis.SnapFlowEndDetector;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** requestAnimationFrame never fires in a hidden tab, so it is raced with a timer. */
  const nextFrame = () =>
    Promise.race([new Promise((r) => requestAnimationFrame(() => r())), delay(120)]);

  class CaptureCancelled extends Error {
    constructor() {
      super('Capture cancelled');
      this.cancelled = true;
    }
  }

  // ===========================================================================
  // 1. RESTORATION LEDGERS
  // ===========================================================================

  /**
   * Records the inline value and priority of every style property before it is
   * first changed. A property is only restored if it still holds the value this
   * script wrote, so a change the page made in the meantime is left alone.
   */
  class StyleLedger {
    constructor() {
      this.entries = new Map();
    }

    set(el, prop, value) {
      let props = this.entries.get(el);
      if (!props) {
        props = new Map();
        this.entries.set(el, props);
      }
      if (!props.has(prop)) {
        props.set(prop, {
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop)
        });
      }
      props.get(prop).applied = value;
      el.style.setProperty(prop, value, 'important');
    }

    has(el) {
      return this.entries.has(el);
    }

    restore(el) {
      const props = this.entries.get(el);
      if (!props) return;
      for (const [prop, original] of props) {
        try {
          if (el.style.getPropertyValue(prop) !== original.applied) continue;
          if (original.value) el.style.setProperty(prop, original.value, original.priority);
          else el.style.removeProperty(prop);
        } catch (_) {}
      }
      this.entries.delete(el);
    }

    restoreAll() {
      for (const el of Array.from(this.entries.keys())) this.restore(el);
    }
  }

  /** Remembers the scroll position of the window and of any element before moving it. */
  class ScrollLedger {
    constructor() {
      this.positions = new Map();
    }

    record(target) {
      if (this.positions.has(target)) return;
      if (target === window) this.positions.set(target, { x: window.scrollX, y: window.scrollY });
      else this.positions.set(target, { x: target.scrollLeft, y: target.scrollTop });
    }

    restoreAll() {
      // Innermost targets were recorded first; restore outermost first so nested
      // offsets land where they started.
      for (const [target, pos] of Array.from(this.positions).reverse()) {
        try {
          target.scrollTo({ left: pos.x, top: pos.y, behavior: 'instant' });
        } catch (_) {
          try { target.scrollTo(pos.x, pos.y); } catch (__) {}
        }
      }
      this.positions.clear();
    }
  }

  // ===========================================================================
  // 2. EXTENSION UI (isolated in a closed shadow root)
  // ===========================================================================

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    .dim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); cursor: crosshair; pointer-events: auto; user-select: none; }
    .banner {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #0f172a; color: #f8fafc; font-size: 13px; font-weight: 500;
      padding: 8px 18px; border-radius: 30px; border: 1px solid rgba(255,255,255,0.2);
      box-shadow: 0 4px 16px rgba(0,0,0,0.4); display: flex; align-items: center; gap: 8px;
      white-space: nowrap; max-width: calc(100vw - 24px); overflow: hidden; text-overflow: ellipsis;
    }
    kbd { background: #334155; padding: 1px 5px; border-radius: 4px; font-size: 11px; font-family: inherit; }
    .marquee { position: fixed; border: 2px dashed #6366f1; background: rgba(99,102,241,0.18); display: none; }
    .tag {
      position: absolute; top: -26px; left: 0; color: #ffffff; font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 4px; white-space: nowrap; background: #0284c7;
    }
    .tag.inside { top: 4px; left: 4px; }
    .highlight { position: fixed; border: 2px solid #38bdf8; background: rgba(56,189,248,0.12); display: none; }
    .highlight.static { border-color: #a855f7; background: rgba(168,85,247,0.10); }
    .highlight.static .tag { background: #7e22ce; }
    .highlight.locked { background: transparent; }
    .outline { position: fixed; border: 2px solid #38bdf8; border-radius: 2px; display: none; }
    .pill {
      position: fixed; display: none; pointer-events: auto; background: #0f172a; color: #f8fafc;
      padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2);
      box-shadow: 0 8px 24px rgba(0,0,0,0.5); font-size: 13px; max-width: min(460px, calc(100vw - 20px));
    }
    .pill .info { font-weight: 600; font-size: 12px; color: #cbd5e1; margin-bottom: 4px; }
    .pill .hint { font-size: 11px; color: #94a3b8; margin-bottom: 9px; line-height: 1.4; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button {
      border: none; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 12px;
      cursor: pointer; font-family: inherit;
    }
    button.primary { background: #4f46e5; color: #ffffff; }
    button.primary:hover { background: #4338ca; }
    button.secondary { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
    button.secondary:hover { background: #334155; }
    button.ghost { background: transparent; color: #94a3b8; border: 1px solid #334155; }
    button.ghost:hover { color: #e2e8f0; }
    .hud {
      position: fixed; display: none; pointer-events: auto; background: #0f172a; color: #f8fafc;
      padding: 9px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2);
      box-shadow: 0 2px 10px rgba(0,0,0,0.45); font-size: 12px; min-width: 250px;
    }
    .hud .title { font-weight: 600; margin-bottom: 6px; }
    .hud .detail { color: #94a3b8; font-size: 11px; margin-bottom: 7px; }
    .bar { height: 4px; background: #1e293b; border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
    .bar > div { height: 100%; width: 0%; background: #6366f1; transition: width 0.15s ease; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); display: none;
      background: #0f172a; color: #f8fafc; padding: 9px 16px; border-radius: 8px; font-size: 12px;
      font-weight: 500; border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      max-width: min(520px, calc(100vw - 24px));
    }
    .toast.error { border-color: #ef4444; }
  `;

  let ui = null;

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('snapflow-ui');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    const layer = document.createElement('div');
    layer.className = 'layer';
    root.append(style, layer);
    document.documentElement.appendChild(host);
    ui = { host, root, layer };
    return ui;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function removeUi() {
    if (ui) {
      ui.host.remove();
      ui = null;
    }
  }

  let toastTimer = null;
  function showToast(message, isError = false) {
    const { layer } = getUi();
    layer.querySelectorAll('.toast').forEach((n) => n.remove());
    const toast = el('div', 'toast' + (isError ? ' error' : ''), message);
    toast.style.display = 'block';
    layer.appendChild(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.remove();
      if (ui && !ui.layer.childElementCount) removeUi();
    }, isError ? 6000 : 3200);
  }

  const fmt = (n) => Math.round(n).toLocaleString();

  function describeElement(node) {
    let label = node.tagName.toLowerCase();
    if (node.id) label += '#' + node.id;
    else if (typeof node.className === 'string' && node.className.trim()) {
      label += '.' + node.className.trim().split(/\s+/)[0];
    }
    return label.length > 40 ? label.slice(0, 39) + '…' : label;
  }

  // ===========================================================================
  // 3. GEOMETRY
  // ===========================================================================

  // Two coordinate spaces are used and never mixed:
  //   CSS px     what the DOM reports; used for scrolling, hit tests and extension UI
  //   device px  the screenshot's pixels (CSS px * devicePixelRatio); used for every
  //              rectangle that decides which pixels are copied where
  //
  // Chrome paints each box at its position rounded to whole device pixels and keeps
  // scroll offsets on whole device pixels. The device rectangles below reproduce that
  // rounding, so frame boundaries are exact integers even at ratios such as 1.25,
  // where a CSS pixel boundary falls between device pixels.

  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.w, b.x + b.w);
    const bottom = Math.min(a.y + a.h, b.y + b.h);
    return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
  }

  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  const getDpr = () => window.devicePixelRatio || 1;

  function viewportRect() {
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  }

  /** Visual size of one scroll unit, which differs from 1 under a CSS scale transform. */
  function unitScale(rendered, layout) {
    if (!(layout > 0) || !(rendered > 0)) return 1;
    const ratio = rendered / layout;
    return Math.abs(ratio - 1) < 0.02 ? 1 : ratio;
  }

  /** Padding box of an element in CSS px (extension UI placement only). */
  function paddingBox(node) {
    const rect = node.getBoundingClientRect();
    const ux = unitScale(rect.width, node.offsetWidth);
    const uy = unitScale(rect.height, node.offsetHeight);
    return {
      x: rect.left + node.clientLeft * ux,
      y: rect.top + node.clientTop * uy,
      w: node.clientWidth * ux,
      h: node.clientHeight * uy
    };
  }

  /**
   * Padding box of an element in device px, as Chrome paints it: border-box edges
   * rounded to device pixels, inset by the (already whole-pixel) border widths and
   * by any classic scrollbar that is still showing.
   */
  function devicePaddingBox(node, dpr) {
    const rect = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const ux = unitScale(rect.width, node.offsetWidth);
    const uy = unitScale(rect.height, node.offsetHeight);
    const border = {
      left: parseFloat(cs.borderLeftWidth) || 0,
      right: parseFloat(cs.borderRightWidth) || 0,
      top: parseFloat(cs.borderTopWidth) || 0,
      bottom: parseFloat(cs.borderBottomWidth) || 0
    };
    const dev = (cssLength, unit) => Math.round(cssLength * unit * dpr);

    let barV = 0;
    let barH = 0;
    if (typeof node.offsetWidth === 'number') {
      barV = node.offsetWidth - node.clientWidth - border.left - border.right;
      barH = node.offsetHeight - node.clientHeight - border.top - border.bottom;
    }

    const left = Math.round(rect.left * dpr) + dev(border.left, ux);
    const top = Math.round(rect.top * dpr) + dev(border.top, uy);
    const right = Math.round(rect.right * dpr) - dev(border.right, ux) - (barV > 2 ? dev(barV, ux) : 0);
    const bottom = Math.round(rect.bottom * dpr) - dev(border.bottom, uy) - (barH > 2 ? dev(barH, uy) : 0);
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top), ux, uy };
  }

  /**
   * Describes a scroll container for capture. All rectangles are device px.
   *
   * Policy: the captured area is the container's padding box. Its padding belongs
   * to the scrollable content and is included; its border and scrollbars are not.
   *
   *   clip    padding box
   *   outer   what the viewport and clipping ancestors leave visible
   *   vis     clip ∩ outer: the part of the container a screenshot can see
   *   c*      content coordinates (device px from the content origin) of `vis`
   *   visCss  `vis` in CSS px, for hit tests and UI placement
   */
  function elementGeometry(node) {
    const dpr = getDpr();
    const box = devicePaddingBox(node, dpr);
    const root = document.documentElement;
    // clientWidth/Height exclude the page's own scrollbars, which must not be captured.
    let outer = {
      x: 0,
      y: 0,
      w: Math.floor((root.clientWidth || window.innerWidth) * dpr),
      h: Math.floor((root.clientHeight || window.innerHeight) * dpr)
    };
    for (let p = node.parentElement; p && p !== document.documentElement && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pb = devicePaddingBox(p, dpr);
        outer = intersect(outer, { x: pb.x, y: pb.y, w: pb.w, h: pb.h });
      }
    }
    const clip = { x: box.x, y: box.y, w: box.w, h: box.h };
    const vis = intersect(clip, outer);
    const sx = Math.round(node.scrollLeft * box.ux * dpr);
    const sy = Math.round(node.scrollTop * box.uy * dpr);
    const cLeft = sx + (vis.x - clip.x);
    const cTop = sy + (vis.y - clip.y);
    return {
      dpr,
      clip,
      outer,
      vis,
      visCss: { x: vis.x / dpr, y: vis.y / dpr, w: vis.w / dpr, h: vis.h / dpr },
      ux: box.ux,
      uy: box.uy,
      sx,
      sy,
      contentW: Math.round(node.scrollWidth * box.ux * dpr),
      contentH: Math.round(node.scrollHeight * box.uy * dpr),
      cLeft,
      cTop,
      cRight: cLeft + vis.w,
      cBottom: cTop + vis.h
    };
  }

  /** True when a scroll container has been scrolled as far down as it goes. */
  function atScrollEnd(node) {
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  }

  /**
   * Returns how an element can scroll, or null if it cannot.
   * `native` means the user can scroll it; otherwise it is clipped content that only
   * scripts can move, which is offered as a candidate but never chosen by default.
   */
  function scrollInfo(node) {
    if (!(node instanceof Element)) return null;
    const extentY = node.scrollHeight - node.clientHeight;
    const extentX = node.scrollWidth - node.clientWidth;
    if (extentY < 2 && extentX < 2) return null;

    const cs = getComputedStyle(node);
    const userScroll = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
    const nativeY = extentY >= 2 && userScroll(cs.overflowY);
    const nativeX = extentX >= 2 && userScroll(cs.overflowX);
    const native = nativeY || nativeX;
    const clipped =
      !native &&
      ((extentY >= 40 && cs.overflowY === 'hidden') || (extentX >= 40 && cs.overflowX === 'hidden'));
    if (!native && !clipped) return null;

    return {
      native,
      extentX: nativeX || (clipped && cs.overflowX === 'hidden') ? extentX : 0,
      extentY: nativeY || (clipped && cs.overflowY === 'hidden') ? extentY : 0,
      rtl: cs.direction === 'rtl'
    };
  }

  function documentScrolls() {
    const scroller = document.scrollingElement || document.documentElement;
    return scroller.scrollHeight - window.innerHeight >= 8;
  }

  /** Scrollable ancestors of a node, innermost first. The page itself is not included. */
  function scrollableChain(start) {
    const chain = [];
    for (let node = start; node && node !== document.documentElement; node = node.parentElement) {
      // <body> only counts when it is the real scroll container, not the viewport's proxy.
      if (node === document.body && documentScrolls()) break;
      const info = scrollInfo(node);
      if (info) chain.push({ node, ...info });
    }
    return chain;
  }

  /** A candidate worth selecting by default: user-scrollable, visible, with real overflow. */
  function isMeaningful(candidate) {
    if (!candidate.native) return false;
    if (Math.max(candidate.extentX, candidate.extentY) < 16) return false;
    const rect = candidate.node.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 24;
  }

  /**
   * When the document itself does not scroll (application shells), finds the element
   * that carries the page's scrolling: the largest visible vertically scrollable one.
   */
  function findDominantScroller() {
    const view = viewportRect();
    const minArea = view.w * view.h * INNER_SCROLLER_MIN_AREA;
    let best = null;
    const all = document.querySelectorAll('*');
    for (const node of all) {
      if (node.scrollHeight - node.clientHeight < 32) continue;
      if (ui && node === ui.host) continue;
      const info = scrollInfo(node);
      if (!info || !info.native || info.extentY < 32) continue;
      const vis = elementGeometry(node).visCss;
      const area = vis.w * vis.h;
      if (area < minArea) continue;
      if (!best || area > best.area || (area === best.area && info.extentY > best.extentY)) {
        best = { node, area, extentY: info.extentY };
      }
    }
    return best ? best.node : null;
  }

  // ===========================================================================
  // 4. SETTLING
  // ===========================================================================

  /** Waits until a position reader returns the same value on consecutive frames. */
  async function waitStable(read, maxMs = 1000) {
    let prev = read();
    let same = 0;
    const start = performance.now();
    while (performance.now() - start < maxMs) {
      await nextFrame();
      const cur = read();
      if (cur[0] === prev[0] && cur[1] === prev[1]) {
        if (++same >= 2) return;
      } else {
        same = 0;
      }
      prev = cur;
    }
  }

  /** Resolves once a subtree has stopped adding or removing nodes (virtual lists, lazy content). */
  function waitForQuietDom(root, quietMs = 70, maxMs = 900) {
    return new Promise((resolve) => {
      let quietTimer = null;
      const finish = () => {
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(capTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      quietTimer = setTimeout(finish, quietMs);
      const capTimer = setTimeout(finish, maxMs);
    });
  }

  /** Waits (bounded) for images that are on screen but have not finished loading. */
  function waitForImages(area, maxMs = 1500) {
    const pending = Array.from(document.images || []).filter((img) => {
      if (img.complete || !(img.currentSrc || img.src)) return false;
      if (!area) return true;
      const r = img.getBoundingClientRect();
      return overlaps({ x: r.left, y: r.top, w: r.width, h: r.height }, area);
    });
    if (!pending.length) return Promise.resolve();
    return Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
        )
      ),
      delay(maxMs)
    ]);
  }

  /**
   * Waits (bounded) for transitions and animations that are on their way to an end
   * state, such as sections that fade in when scrolled into view. Endless ones
   * (spinners, marquees) are ignored because they never settle.
   */
  function waitForAnimations(maxMs = 1500) {
    if (typeof document.getAnimations !== 'function') return Promise.resolve();
    const finishing = document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running' || !animation.effect) return false;
      const timing = animation.effect.getComputedTiming();
      return Number.isFinite(timing.endTime) && timing.endTime > 0;
    });
    if (!finishing.length) return Promise.resolve();
    return Promise.race([
      Promise.all(finishing.map((animation) => animation.finished.catch(() => {}))),
      delay(maxMs)
    ]);
  }

  async function settle(root, area, settings) {
    await nextFrame();
    await nextFrame();
    await waitForQuietDom(root);
    await waitForImages(area);
    await waitForAnimations();
    const extra = Math.max(0, Math.min(1500, settings.scrollDelay || 0));
    if (extra) await delay(extra);
    await nextFrame();
  }

  // ===========================================================================
  // 5. STICKY / FIXED ELEMENT POLICY
  // ===========================================================================
  //
  // Sticky elements are returned to their natural position in the flow for the whole
  // capture, so each appears exactly once, where the document places it.
  //
  // Viewport-fixed elements are captured exactly once:
  //   - in the upper half of the viewport: only in the first frame (top of the image)
  //   - in the lower half: only in the last frame (bottom of the image)
  // A fixed element covering nearly the whole viewport is a backdrop and is left alone.
  //
  // For a picked region, anything positioned on top of the region that is not part of
  // it is hidden for the duration of the capture.
  //
  // All of this is skipped when the user turns "Hide sticky headers" off.

  function isOwnNode(node) {
    return ui && (node === ui.host);
  }

  function neutralizeSticky(run, node) {
    run.styles.set(node, 'position', 'relative');
    run.styles.set(node, 'top', 'auto');
    run.styles.set(node, 'bottom', 'auto');
    run.styles.set(node, 'left', 'auto');
    run.styles.set(node, 'right', 'auto');
  }

  function hideNode(run, node) {
    run.styles.set(node, 'transition', 'none');
    run.styles.set(node, 'opacity', '0');
    run.hidden.add(node);
  }

  function showNode(run, node) {
    if (!run.hidden.has(node)) return;
    run.hidden.delete(node);
    const props = run.styles.entries.get(node);
    if (!props) return;
    for (const prop of ['opacity', 'transition']) {
      const original = props.get(prop);
      if (!original) continue;
      if (original.value) node.style.setProperty(prop, original.value, original.priority);
      else node.style.removeProperty(prop);
      props.delete(prop);
    }
    if (!props.size) run.styles.entries.delete(node);
  }

  /**
   * Applies the document policy for one frame.
   * @returns {{x:number,y:number,w:number,h:number}|null} union of lower-half fixed
   *          elements shown in this frame, so the caller can repaint that band.
   */
  function applyDocumentPolicy(run, { first, last }) {
    const view = viewportRect();
    const all = document.querySelectorAll('*');
    if (all.length > 25000) {
      run.warnOnce('policy-skip', 'This page is very large, so sticky and fixed elements were not adjusted and may repeat.');
      return null;
    }

    let band = null;
    for (const node of all) {
      if (isOwnNode(node)) continue;
      const wasHidden = run.hidden.has(node);
      const cs = getComputedStyle(node);
      if (cs.position === 'sticky') {
        neutralizeSticky(run, node);
        continue;
      }
      if (cs.position !== 'fixed') {
        // A header that stopped being fixed (scripted toggles) must become visible again.
        if (wasHidden) showNode(run, node);
        continue;
      }
      if (cs.display === 'none' || (cs.visibility === 'hidden' && !wasHidden)) continue;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width >= view.w * 0.85 && r.height >= view.h * 0.85) continue;

      const lower = r.top + r.height / 2 > view.h / 2;
      const visible = lower ? last : first;
      if (visible) {
        showNode(run, node);
        if (lower && !first) {
          const rect = intersect({ x: r.left, y: r.top, w: r.width, h: r.height }, view);
          if (rect.w > 0 && rect.h > 0) {
            band = band
              ? {
                  x: 0,
                  y: Math.min(band.y, rect.y),
                  w: view.w,
                  h: Math.max(band.y + band.h, rect.y + rect.h) - Math.min(band.y, rect.y)
                }
              : { x: 0, y: rect.y, w: view.w, h: rect.h };
          }
        }
      } else {
        hideNode(run, node);
      }
    }
    return band;
  }

  /** Neutralises sticky descendants of a region so headers inside it appear once. */
  function neutralizeStickyInside(run, target) {
    const nodes = target.querySelectorAll('*');
    if (nodes.length > 8000) return;
    for (const node of nodes) {
      if (run.styles.has(node)) continue;
      if (getComputedStyle(node).position === 'sticky') neutralizeSticky(run, node);
    }
  }

  /**
   * Hides positioned elements drawn on top of `area` that do not belong to `target`
   * (floating buttons, page headers, chat widgets). Detection samples the area with
   * hit tests, so it also finds overlays that are absolutely positioned.
   */
  function hideOccluders(run, target, area) {
    if (area.w < 4 || area.h < 4) return;
    const step = Math.max(24, Math.sqrt((area.w * area.h) / 500));
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let y = area.y + 3; y < area.y + area.h - 1; y += step) {
        for (let x = area.x + 3; x < area.x + area.w - 1; x += step) {
          const stack = document.elementsFromPoint(x, y);
          for (const hit of stack) {
            if (isOwnNode(hit)) continue;
            if (hit === target || target.contains(hit)) break;
            if (hit.contains(target)) continue;
            let occluder = hit;
            for (let p = hit; p && !p.contains(target); p = p.parentElement) {
              if (getComputedStyle(p).position !== 'static') {
                occluder = p;
                break;
              }
            }
            if (!run.hidden.has(occluder)) {
              hideNode(run, occluder);
              changed = true;
            }
            break;
          }
        }
      }
      if (!changed) break;
    }
  }

  // ===========================================================================
  // 6. CAPTURE RUN (session lifecycle, cancellation, guaranteed cleanup)
  // ===========================================================================

  let activeRun = null;
  let lastSettings = { scrollDelay: 200, hideFixed: true, preflight: true };

  function send(message, timeoutMs = GRAB_TIMEOUT_MS) {
    return Promise.race([
      chrome.runtime.sendMessage(message),
      delay(timeoutMs).then(() => ({ error: 'The extension did not respond. Reload the page and try again.' }))
    ]).catch((err) => ({ error: err && err.message ? err.message : String(err) }));
  }

  class CaptureRun {
    constructor(mode, settings) {
      this.mode = mode;
      this.settings = settings;
      this.styles = new StyleLedger();
      this.scrolls = new ScrollLedger();
      this.hidden = new Set();
      this.frames = [];
      this.warnings = [];
      this.warned = new Set();
      this.cancelled = false;
      this.cleaned = false;
      this.target = null;
      this.hud = null;
      this.shot = null;
      this.onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.cancel();
        }
      };
      this.onPageHide = () => this.cleanup();
    }

    async begin() {
      // Listening starts before the session does, so Escape pressed while the capture
      // is still starting up is honoured instead of being lost.
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('pagehide', this.onPageHide);
      const response = await send({ action: 'SF_SESSION_BEGIN', mode: this.mode });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Could not start the capture.');
      }
      if (this.cleaned) this.cancelled = true;
      this.check();
    }

    setCaptureAttribute(kind) {
      document.documentElement.setAttribute(CAPTURE_ATTR, kind);
    }

    markTarget(node) {
      this.target = node;
      node.setAttribute(TARGET_ATTR, '');
    }

    warn(message) {
      this.warnings.push(message);
    }

    warnOnce(key, message) {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      this.warn(message);
    }

    cancel() {
      this.cancelled = true;
      if (this.onCancel) this.onCancel();
    }

    check() {
      if (this.cancelled) throw new CaptureCancelled();
    }

    /**
     * Requests one screenshot. Extension UI is hidden for the shot whenever it could
     * fall inside the captured area.
     *
     * @returns {Promise<{width:number,height:number}|null>} the bitmap size in device
     *          px, or null when the frame limit for one capture has been reached
     */
    async grab(frame, progress) {
      this.check();
      if (this.frames.length >= MAX_FRAMES) return null;

      const hideUi = this.hud && this.hud.mustHideFor(frame);
      if (hideUi) {
        ui.host.style.visibility = 'hidden';
        await nextFrame();
        await nextFrame();
      }

      const response = await send({ action: 'SF_GRAB', index: this.frames.length, progress });

      if (hideUi && ui) ui.host.style.visibility = '';
      if (!response || response.cancelled) throw new CaptureCancelled();
      if (response.error) throw new Error(response.error);

      const shot = { width: response.width, height: response.height };
      if (this.shot && (shot.width !== this.shot.width || shot.height !== this.shot.height)) {
        // Every frame is laid out on one device-pixel grid; a resize or zoom breaks it.
        throw new Error('The window size or zoom level changed during the capture. Please capture again.');
      }
      this.shot = shot;
      this.frames.push(frame);
      return shot;
    }

    async finish(plan, mode) {
      this.check();
      const response = await send({
        action: 'SF_FINISH',
        mode,
        plan,
        frames: this.frames,
        warnings: this.warnings,
        page: { title: document.title || 'Webpage', url: window.location.href }
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Could not save the capture.');
      }
    }

    /** Restores the page. Safe to call more than once and from any failure path. */
    cleanup() {
      if (this.cleaned) return;
      this.cleaned = true;
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('pagehide', this.onPageHide);
      if (this.dispose) {
        try { this.dispose(); } catch (_) {}
      }
      this.styles.restoreAll();
      this.hidden.clear();
      if (this.target) {
        try { this.target.removeAttribute(TARGET_ATTR); } catch (_) {}
      }
      // Scroll positions go back while smooth scrolling is still disabled.
      this.scrolls.restoreAll();
      document.documentElement.removeAttribute(CAPTURE_ATTR);
      removeUi();
      if (activeRun === this) activeRun = null;
    }
  }

  /**
   * Runs a capture function with a session, and guarantees cleanup plus a message to
   * the service worker and the user whatever happens.
   */
  async function withRun(mode, settings, work) {
    if (activeRun) {
      showToast('A capture is already in progress on this page.', true);
      return;
    }
    removeUi();
    const run = new CaptureRun(mode, settings);
    activeRun = run;
    let outcome = { message: null, error: false };
    try {
      await run.begin();
      await work(run);
    } catch (err) {
      const cancelled = !!(err && err.cancelled) || run.cancelled;
      await send({
        action: 'SF_ABORT',
        cancelled,
        error: cancelled ? null : (err && err.message) || String(err)
      }, 5000);
      outcome = cancelled
        ? { message: 'Capture cancelled. The page has been restored.', error: false }
        : { message: 'Capture failed: ' + ((err && err.message) || err), error: true };
    } finally {
      run.cleanup();
    }
    if (outcome.message) showToast(outcome.message, outcome.error);
  }

  // ===========================================================================
  // 7. FULL PAGE
  // ===========================================================================

  function scrollWindowTo(x, y) {
    try {
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(x, y);
    }
  }

  function scrollElementTo(node, x, y) {
    try {
      node.scrollTo({ left: x, top: y, behavior: 'instant' });
    } catch (_) {
      node.scrollLeft = x;
      node.scrollTop = y;
    }
  }

  /**
   * Scrolls through the page once so lazy-loaded media starts loading before the
   * real pass, which keeps the page height stable while frames are taken.
   */
  async function hydratePage(run) {
    const scroller = document.scrollingElement || document.documentElement;
    const step = Math.max(window.innerHeight, 400);
    let steps = 0;
    for (let y = 0; y < scroller.scrollHeight && steps < 80; y += step, steps++) {
      run.check();
      scrollWindowTo(0, y);
      await delay(50);
    }
    scrollWindowTo(0, scroller.scrollHeight);
    await delay(80);
    await waitForImages(null, 1500);
    scrollWindowTo(0, 0);
    await waitStable(() => [window.scrollX, window.scrollY]);
  }

  async function hydrateElement(run, node) {
    const step = Math.max(node.clientHeight, 200);
    let steps = 0;
    for (let y = 0; y < node.scrollHeight && steps < 80; y += step, steps++) {
      run.check();
      scrollElementTo(node, node.scrollLeft, y);
      await delay(50);
    }
    await waitForImages(null, 1500);
    scrollElementTo(node, node.scrollLeft, 0);
    await waitStable(() => [node.scrollLeft, node.scrollTop]);
  }

  async function runFullPage(run) {
    run.scrolls.record(window);
    run.setCaptureAttribute('document');
    await nextFrame();

    if (!documentScrolls()) {
      const inner = findDominantScroller();
      if (inner) return captureInnerScrollerPage(run, inner);
    }
    return captureDocument(run);
  }

  /** The page scrolls as a whole: step the window from top to bottom. */
  async function captureDocument(run) {
    const { settings } = run;
    const dpr = getDpr();
    const scroller = document.scrollingElement || document.documentElement;

    if (settings.preflight) await hydratePage(run);
    scrollWindowTo(0, 0);
    await waitStable(() => [window.scrollX, window.scrollY]);

    const initialHeight = scroller.scrollHeight;
    const growthLimit = (initialHeight * GROWTH_FACTOR + GROWTH_ALLOWANCE_PX) * dpr;
    const isLast = () => window.scrollY + window.innerHeight >= scroller.scrollHeight - 1;

    // origin / covered / requested are document rows in device px.
    let origin = 0;
    let covered = 0;
    let requested = 0;
    let truncated = false;
    let jumped = false;

    for (;;) {
      run.check();
      scrollWindowTo(0, requested / dpr);
      await waitStable(() => [window.scrollX, window.scrollY]);

      const first = run.frames.length === 0;
      let last = isLast();
      let band = settings.hideFixed ? applyDocumentPolicy(run, { first, last }) : null;
      await settle(document.documentElement, viewportRect(), settings);

      // Lazy content may have changed the layout while settling: re-read everything.
      if (isLast() !== last) {
        last = isLast();
        band = settings.hideFixed ? applyDocumentPolicy(run, { first, last }) : null;
        await nextFrame();
        await nextFrame();
      }

      const actual = Math.round(window.scrollY * dpr);
      if (first) {
        origin = actual;
        covered = actual;
      } else if (actual + run.shot.height <= covered) {
        break; // the browser would not scroll any further
      } else if (actual > covered) {
        jumped = true;
      }

      const frame = { paints: [] };
      const total = Math.round(scroller.scrollHeight * dpr);
      const shot = await run.grab(frame, { done: Math.min(actual + (run.shot ? run.shot.height : 0), total), total });
      if (!shot) { truncated = true; break; }

      // The frame shows document rows [actual, actual + shot.height). Only rows not
      // already written are taken from it.
      const fresh = ScrollStitcher.newRows(covered, actual, shot.height);
      if (fresh) {
        frame.paints.push({ sx: 0, sy: fresh.offset, sw: shot.width, sh: fresh.count, dx: 0, dy: fresh.dest });
      }
      if (band && last && !first) {
        const top = Math.max(0, Math.floor(band.y * dpr));
        const bottom = Math.min(shot.height, Math.ceil((band.y + band.h) * dpr));
        if (bottom > top) frame.paints.push({ sx: 0, sy: top, sw: shot.width, sh: bottom - top, dx: 0, dy: actual + top });
      }
      covered = actual + shot.height;

      if (last) break;
      if (covered > growthLimit) { truncated = true; break; }
      requested = covered;
    }

    if (!run.frames.length) throw new Error('Nothing could be captured from this page.');

    const finalHeight = scroller.scrollHeight;
    if (jumped) {
      run.warn('The page jumped while scrolling, so some rows could not be captured and are blank. Capture again if the result looks incomplete.');
    }
    if (truncated) {
      run.warn(
        `This page is longer than Snap Flow captures in one pass (it stopped after ${fmt((covered - origin) / dpr)} px of ${fmt(finalHeight)} px). The image is incomplete.`
      );
    } else if (Math.abs(finalHeight - initialHeight) > 2) {
      run.warn(
        `The page changed height while it was being captured (${fmt(initialHeight)} px to ${fmt(finalHeight)} px), which happens with content that loads as you scroll. Check the result for repeated or missing sections.`
      );
    }

    await run.finish(
      {
        kind: 'document',
        width: run.shot.width,
        height: covered - origin,
        originX: 0,
        originY: origin,
        dpr,
        background: '#ffffff'
      },
      'full'
    );
  }

  /**
   * The document does not scroll but one large element does (chat apps, mail
   * clients, dashboards). The result is the page as if that element were expanded
   * to its full height: the first screen as displayed, the element's whole content
   * in its column, and whatever sits below the element moved to the bottom.
   */
  async function captureInnerScrollerPage(run, target) {
    const { settings } = run;
    const dpr = getDpr();
    run.scrolls.record(target);
    run.markTarget(target);
    await nextFrame();

    if (settings.preflight) await hydrateElement(run, target);
    scrollElementTo(target, target.scrollLeft, 0);
    await waitStable(() => [target.scrollLeft, target.scrollTop]);

    const start = elementGeometry(target);
    const band = start.vis;
    const initialHeight = target.scrollHeight;
    const growthLimit = (initialHeight * GROWTH_FACTOR + GROWTH_ALLOWANCE_PX) * dpr;
    const body = getComputedStyle(document.body).backgroundColor;
    const background = body && body !== 'rgba(0, 0, 0, 0)' && body !== 'transparent' ? body : '#ffffff';

    // covered / requested are rows of the element's content in device px.
    let covered = 0;
    let requested = 0;
    let truncated = false;
    let jumped = false;

    for (;;) {
      run.check();
      scrollElementTo(target, target.scrollLeft, requested / (start.uy * dpr));
      await waitStable(() => [target.scrollLeft, target.scrollTop]);

      const first = run.frames.length === 0;
      if (settings.hideFixed) {
        neutralizeStickyInside(run, target);
        // The first screen is kept exactly as displayed; overlays are removed afterwards
        // so they are not repeated down the image.
        if (!first) hideOccluders(run, target, elementGeometry(target).visCss);
      }
      await settle(target, start.visCss, settings);

      const geo = elementGeometry(target);
      if (!first && geo.cBottom <= covered) break;
      if (!first && geo.cTop > covered) jumped = true;

      const frame = { paints: [] };
      const shot = await run.grab(frame, { done: Math.min(geo.cBottom, geo.contentH), total: geo.contentH });
      if (!shot) { truncated = true; break; }

      if (first) frame.paints.push({ sx: 0, sy: 0, sw: shot.width, sh: shot.height, dx: 0, dy: 0 });
      const fresh = ScrollStitcher.newRows(covered, geo.cTop, geo.vis.h);
      if (fresh) {
        frame.paints.push({
          sx: geo.vis.x,
          sy: geo.vis.y + fresh.offset,
          sw: geo.vis.w,
          sh: fresh.count,
          dx: band.x,
          dy: band.y + fresh.dest
        });
      }
      covered = geo.cBottom;

      if (atScrollEnd(target)) break;
      if (covered > growthLimit) { truncated = true; break; }
      requested = covered;
    }

    if (!run.frames.length) throw new Error('Nothing could be captured from this page.');

    // Whatever sits below the scrolling element (a message composer, a footer) is
    // taken from the last frame and placed after the element's content.
    const below = run.shot.height - (band.y + band.h);
    if (below > 0) {
      run.frames[run.frames.length - 1].paints.push({
        sx: band.x,
        sy: band.y + band.h,
        sw: band.w,
        sh: below,
        dx: band.x,
        dy: band.y + covered
      });
    }

    const finalHeight = target.scrollHeight;
    if (jumped) {
      run.warn('The scrolling area jumped while it was being captured, so some rows could not be captured and are blank.');
    }
    if (truncated) {
      run.warn(
        `The scrolling area is longer than Snap Flow captures in one pass (it stopped after ${fmt(covered / dpr)} px of ${fmt(finalHeight)} px). The image is incomplete.`
      );
    } else if (Math.abs(finalHeight - initialHeight) > 2) {
      run.warn(
        `The scrolling area changed height while it was being captured (${fmt(initialHeight)} px to ${fmt(finalHeight)} px). Check the result for repeated or missing sections.`
      );
    }
    run.warn(
      `This page scrolls inside a panel (${describeElement(target)}) rather than as a whole document. Snap Flow expanded that panel to its full height and kept the rest of the first screen around it.`
    );

    await run.finish(
      {
        kind: 'inner',
        width: run.shot.width,
        height: band.y + covered + Math.max(0, below),
        originX: 0,
        originY: 0,
        dpr,
        background
      },
      'full'
    );
  }

  // ===========================================================================
  // 8. SCROLLING REGION (automatic and manual)
  // ===========================================================================

  /** Scrolls the ancestors of a node (innermost first, then the window) by a CSS-px delta. */
  function scrollAncestorsBy(run, node, dx, dy) {
    for (let p = node.parentElement; p && p !== document.documentElement && p !== document.body; p = p.parentElement) {
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      if (p.scrollHeight - p.clientHeight < 1 && p.scrollWidth - p.clientWidth < 1) continue;
      run.scrolls.record(p);
      const beforeX = p.scrollLeft;
      const beforeY = p.scrollTop;
      scrollElementTo(p, beforeX + dx, beforeY + dy);
      dx -= p.scrollLeft - beforeX;
      dy -= p.scrollTop - beforeY;
    }
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
      run.scrolls.record(window);
      try {
        window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      } catch (_) {
        window.scrollBy(dx, dy);
      }
    }
  }

  /**
   * Brings content point (x, y) of the target (device px from its content origin)
   * into view: first by scrolling the target itself, then, if the target is larger
   * than the window or partly off screen, by scrolling whatever contains it.
   */
  async function revealContentPoint(run, target, x, y, scanX) {
    let geo = elementGeometry(target);
    const k = geo.dpr;
    scrollElementTo(target, scanX ? x / (geo.ux * k) : target.scrollLeft, y / (geo.uy * k));
    await waitStable(() => [target.scrollLeft, target.scrollTop]);

    for (let attempt = 0; attempt < 3; attempt++) {
      geo = elementGeometry(target);
      const px = geo.clip.x + (x - geo.sx);
      const py = geo.clip.y + (y - geo.sy);
      // A point at or past the end of the target's own box is the end of a row or of
      // the content, not something to bring into view. Scrolling the surroundings for
      // it would push the target itself off screen.
      if (px >= geo.clip.x + geo.clip.w || py >= geo.clip.y + geo.clip.h) break;

      const visBottom = geo.vis.y + geo.vis.h;
      const visRight = geo.vis.x + geo.vis.w;
      const empty = geo.vis.w < 1 || geo.vis.h < 1;
      // How much could be visible below / right of the point if the target were ideally placed.
      const potentialH = Math.min(geo.clip.y + geo.clip.h - py, geo.outer.h);
      const potentialW = Math.min(geo.clip.x + geo.clip.w - px, geo.outer.w);
      const badY = empty || py < geo.vis.y || py >= visBottom || visBottom - py < potentialH * 0.6;
      const badX = empty || px < geo.vis.x || px >= visRight || visRight - px < potentialW * 0.6;
      if (!badX && !badY) break;

      scrollAncestorsBy(run, target, badX ? (px - geo.outer.x) / k : 0, badY ? (py - geo.outer.y) / k : 0);
      await waitStable(() => [window.scrollX, window.scrollY]);
      const moved = elementGeometry(target);
      const nx = moved.clip.x + (x - moved.sx);
      const ny = moved.clip.y + (y - moved.sy);
      if (nx === px && ny === py) break;
    }
    return elementGeometry(target);
  }

  function recordAncestorScroll(run, target) {
    run.scrolls.record(target);
    for (let p = target.parentElement; p && p !== document.documentElement && p !== document.body; p = p.parentElement) {
      if (p.scrollHeight - p.clientHeight >= 1 || p.scrollWidth - p.clientWidth >= 1) run.scrolls.record(p);
    }
    run.scrolls.record(window);
  }

  function prepareRegion(run, target) {
    recordAncestorScroll(run, target);
    run.setCaptureAttribute('region');
    run.markTarget(target);
  }

  function applyRegionPolicy(run, target) {
    if (!run.settings.hideFixed) return;
    neutralizeStickyInside(run, target);
    hideOccluders(run, target, elementGeometry(target).visCss);
  }

  /**
   * Classifies what a frame at this geometry can contribute for content point (x, y).
   *   'ok'           new content is visible starting exactly at (x, y)
   *   'row-done'     the target cannot scroll further right: this row is finished
   *   'all-done'     the target cannot scroll further down: the capture is finished
   *   'unreachable'  the point exists but cannot be brought into view
   */
  function classifyFrame(geo, x, y) {
    if (geo.vis.w < 1 || geo.vis.h < 1) return 'unreachable';
    if (geo.cBottom <= y) return 'all-done';
    if (geo.cRight <= x) return 'row-done';
    if (geo.cTop > y || geo.cLeft > x) return 'unreachable';
    return 'ok';
  }

  // ---------------------------------------------------------------------------
  // End of content
  // ---------------------------------------------------------------------------
  //
  // A list that loads more as it is scrolled (conversation histories, feeds) has no
  // fixed end: its scroll height is only the height of what has loaded so far. The
  // functions below take the region to its bottom, watch what happens there, and
  // repeat until nothing more arrives. The decision rules are in end-detector.js.

  /**
   * True while something inside the region signals that it is still loading: an
   * aria-busy flag, or an endless animation on screen (in practice a spinner or a
   * skeleton placeholder). Only ever used to wait longer, never to finish sooner.
   */
  function regionLooksBusy(target) {
    try {
      if (target.closest('[aria-busy="true"]') || target.querySelector('[aria-busy="true"]')) return true;
      if (typeof target.getAnimations !== 'function') return false;
      const view = elementGeometry(target).visCss;
      return target.getAnimations({ subtree: true }).some((animation) => {
        if (animation.playState !== 'running' || !animation.effect) return false;
        if (Number.isFinite(animation.effect.getComputedTiming().endTime)) return false;
        const node = animation.effect.target;
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && overlaps({ x: r.left, y: r.top, w: r.width, h: r.height }, view);
      });
    } catch (_) {
      return false;
    }
  }

  /** Counts DOM changes inside a region and carries what is known about its end. */
  function watchRegion(target, settings) {
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    const limit = Number(settings.regionLoadLimitMs);
    return {
      detector: new EndDetector(),
      loadLimitMs: limit > 0 ? limit : REGION_LOAD_LIMIT_MS,
      loadSpentMs: 0,
      stopRequested: false,
      get mutations() { return mutations; },
      dispose: () => observer.disconnect()
    };
  }

  /** Where an element sits in the region's content, independent of the scroll position. */
  function contentOffset(target, node) {
    return node.getBoundingClientRect().top - target.getBoundingClientRect().top + target.scrollTop;
  }

  /** An element currently on screen inside the region, with its place in the content. */
  function contentAnchor(target) {
    const view = elementGeometry(target).visCss;
    if (view.w < 1 || view.h < 1) return null;
    for (const fraction of [0.25, 0.5, 0.75]) {
      const stack = document.elementsFromPoint(view.x + view.w / 2, view.y + view.h * fraction);
      const node = stack.find((n) => n !== target && target.contains(n));
      if (node) return { node, offset: contentOffset(target, node) };
    }
    return null;
  }

  /**
   * Parks the region at its bottom and watches it there until more content has
   * arrived or the bottom has stayed put long enough to be believed.
   * @returns {Promise<'grew'|'end'|'unsettled'|'stopped'>}
   */
  async function probeRegionEnd(run, target, watch) {
    const { detector } = watch;
    const park = async () => {
      scrollElementTo(target, target.scrollLeft, target.scrollHeight);
      await waitStable(() => [target.scrollLeft, target.scrollTop], 400);
    };

    await park();
    // Rows redrawn because of the scroll itself are not news.
    await waitForQuietDom(target, 70, 500);
    let seen = watch.mutations;
    detector.arrive(performance.now(), target.scrollHeight);

    for (;;) {
      await delay(detector.opts.pollMs);
      run.check();
      if (watch.stopRequested) return 'stopped';

      const atEnd = atScrollEnd(target);
      const changed = watch.mutations !== seen || !atEnd;
      seen = watch.mutations;
      const verdict = detector.observe({
        now: performance.now(),
        extent: target.scrollHeight,
        changed,
        busy: regionLooksBusy(target)
      });

      if (verdict === 'wait') {
        if (!atEnd) await park();
      } else if (verdict === 'nudge') {
        // One more scroll attempt, the way a person would try: up a screen and back down.
        scrollElementTo(target, target.scrollLeft, Math.max(0, target.scrollTop - target.clientHeight));
        await waitStable(() => [target.scrollLeft, target.scrollTop], 400);
        await park();
        await waitForQuietDom(target, 70, 500);
        seen = watch.mutations;
        detector.settled(performance.now());
      } else {
        return verdict;
      }
    }
  }

  /**
   * Scroll, wait, measure, repeat: takes the region to its bottom again and again
   * until nothing more loads, so the capture that follows sees the whole list.
   *
   * @returns {Promise<null|'time'|'size'|'stopped'|'unsettled'>} null when the end was
   *          confirmed, otherwise why loading ended before that
   */
  async function loadRegionToEnd(run, target, watch) {
    let announced = false;
    const stop = () => { watch.stopRequested = true; };
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      stop();
    };

    try {
      for (;;) {
        const started = performance.now();
        const verdict = await probeRegionEnd(run, target, watch);
        watch.loadSpentMs += performance.now() - started;
        if (verdict === 'end') return null;
        if (verdict !== 'grew') return verdict;

        if (!announced) {
          // Only a list that really loads more gets the loading panel and its choices.
          announced = true;
          run.hud = createHud({
            title: 'Loading the rest of this list…',
            detail: '',
            target,
            actions: [
              { label: 'Capture what has loaded (Enter)', kind: 'secondary', onClick: stop },
              { label: 'Cancel (Esc)', kind: 'ghost', onClick: () => run.cancel() }
            ]
          });
          window.addEventListener('keydown', onKey, true);
        }
        run.hud.update(0, `${fmt(target.scrollHeight)} px loaded so far`);

        if (watch.loadSpentMs >= watch.loadLimitMs) return 'time';
        const geo = elementGeometry(target);
        if (geo.contentH >= (MAX_FRAMES - 2) * Math.max(1, geo.vis.h)) return 'size';
      }
    } finally {
      window.removeEventListener('keydown', onKey, true);
      if (announced && !run.cancelled) {
        run.hud = createHud({ title: 'Capturing region…', detail: 'Press Esc to cancel.', target });
      }
    }
  }

  /**
   * Automatic capture: sweeps the target's content row by row (and column by column
   * when it also scrolls sideways), using the offsets the browser actually reached.
   *
   * A region that loads more as it is scrolled is first taken to its real end
   * (loadRegionToEnd), so the sweep runs over content that has stopped growing.
   * Reaching the bottom is then checked once more before the capture is finished;
   * if more has turned up, the last row is taken again (it may show a loading
   * placeholder) and the sweep carries on.
   */
  async function runRegionAuto(run, target) {
    const { settings } = run;
    prepareRegion(run, target);
    run.hud = createHud({ title: 'Capturing region…', detail: 'Press Esc to cancel.', target });
    await nextFrame();

    const startedAt = performance.now();
    const watch = watchRegion(target, settings);
    run.dispose = () => watch.dispose();

    // Why the region was not followed to a confirmed end, if it was not.
    let gaveUp = null;
    // Content row (device px) below which nothing is captured once loading was cut short.
    let limitY = Infinity;
    const cutShort = (reason) => {
      gaveUp = reason;
      if (reason !== 'unsettled') limitY = Math.min(limitY, elementGeometry(target).contentH);
    };

    if (settings.preflight) {
      const outcome = await loadRegionToEnd(run, target, watch);
      if (outcome) cutShort(outcome);
      await hydrateElement(run, target);
    }

    const info = scrollInfo(target) || { extentX: 0, extentY: 0, rtl: false };
    let geo = elementGeometry(target);
    const dpr = geo.dpr;
    const sideways = info.extentX * geo.ux >= MIN_HORIZONTAL_SCAN_PX;
    const scanX = sideways && !info.rtl;
    if (sideways && info.rtl) {
      run.warn('This region scrolls sideways in a right-to-left layout. Only the part that was visible horizontally was captured.');
    }

    // All coordinates below are content positions in device px.
    const startX = scanX ? 0 : geo.sx;
    const initialHeight = target.scrollHeight;

    let y = 0;
    let capturedWidth = 0;
    let stopped = null;
    let lastRowTop = null;

    // An element from the last frame and where it sat in the content. If the region
    // changes size, it shows whether rows already captured stayed where they were.
    let anchor = null;
    let extentAtAnchor = initialHeight;
    let moved = false;
    const verifyPositions = () => {
      if (!run.frames.length || Math.abs(target.scrollHeight - extentAtAnchor) <= 2) return;
      const held = anchor && anchor.node.isConnected &&
        Math.abs(contentOffset(target, anchor.node) - anchor.offset) <= 1.5;
      if (!held) moved = true;
    };

    /** At the bottom: true when more content has turned up below and the sweep should go on. */
    const followGrowth = async () => {
      const verdict = await probeRegionEnd(run, target, watch);
      if (verdict === 'unsettled') cutShort(verdict);
      if (verdict !== 'grew') return false;
      if (settings.preflight) {
        const outcome = await loadRegionToEnd(run, target, watch);
        if (outcome) cutShort(outcome);
      }
      verifyPositions();
      return true;
    };

    rows: for (;;) {
      if (y >= limitY) break;
      if (performance.now() - startedAt > REGION_TIME_LIMIT_MS) {
        stopped = `This region took longer than ${Math.round(REGION_TIME_LIMIT_MS / 60000)} minutes to capture, so it was stopped after ${fmt(y / dpr)} px. The image is incomplete.`;
        break;
      }
      const rowTop = y;
      let x = startX;
      let rowEnd = Infinity;

      for (;;) {
        run.check();
        geo = await revealContentPoint(run, target, x, y, scanX);
        let state = classifyFrame(geo, x, y);
        if (state === 'ok') {
          applyRegionPolicy(run, target);
          run.hud.place(geo.visCss);
          await settle(target, geo.visCss, settings);
          geo = elementGeometry(target);
          state = classifyFrame(geo, x, y);
        }

        if (state === 'all-done') {
          // The browser will not scroll further. That is the end only if nothing more loads.
          if (x === startX && lastRowTop !== null && !gaveUp && (await followGrowth())) {
            y = lastRowTop;
            continue rows;
          }
          break rows;
        }
        if (state === 'row-done') break;
        if (state === 'unreachable') {
          stopped = run.frames.length
            ? 'Part of this region could not be scrolled into view, so the capture stops where it became unreachable.'
            : 'The selected region is not visible on screen.';
          break rows;
        }

        verifyPositions();
        const total = Math.min(geo.contentH, limitY);
        const bottom = Math.min(geo.cBottom, limitY);
        const frame = { rect: geo.visCss, paints: [] };
        const shot = await run.grab(frame, { done: Math.min(bottom, total), total });
        if (!shot) {
          stopped = `This region is larger than Snap Flow captures in one pass (it stopped after ${fmt(y / dpr)} px of ${fmt(target.scrollHeight)} px). The image is incomplete.`;
          break rows;
        }
        frame.paints.push({
          sx: geo.vis.x + (x - geo.cLeft),
          sy: geo.vis.y + (y - geo.cTop),
          sw: geo.cRight - x,
          sh: bottom - y,
          dx: x - startX,
          dy: y
        });
        run.hud.update(
          bottom / Math.max(1, total),
          `${fmt(Math.min(bottom, total) / dpr)} of ${fmt(total / (geo.uy * dpr))} px · Esc to cancel`
        );
        anchor = contentAnchor(target);
        extentAtAnchor = target.scrollHeight;

        capturedWidth = Math.max(capturedWidth, geo.cRight - startX);
        rowEnd = Math.min(rowEnd, bottom);
        x = geo.cRight;
        if (!scanX) break;
      }

      if (rowEnd === Infinity) break;
      lastRowTop = rowTop;
      y = rowEnd;
    }

    if (!run.frames.length) throw new Error(stopped || 'Nothing could be captured from this region.');
    if (stopped) run.warn(stopped);

    const captured = `${fmt(y / dpr)} px`;
    if (gaveUp === 'time') {
      const waited = watch.loadLimitMs >= 120000
        ? `${Math.round(watch.loadLimitMs / 60000)} minutes`
        : `${Math.round(watch.loadLimitMs / 1000)} seconds`;
      run.warn(
        `This list was still loading more after ${waited} of scrolling, so Snap Flow stopped waiting and captured what had loaded by then (${captured}). Anything further down is missing.`
      );
    } else if (gaveUp === 'stopped') {
      run.warn(`Loading was stopped before the end of this list, so the capture holds what had loaded by then (${captured}). Anything further down is missing.`);
    } else if (gaveUp === 'size' && !stopped) {
      run.warn(`This list is longer than Snap Flow captures in one pass, so loading stopped at ${captured}. Anything further down is missing.`);
    } else if (gaveUp === 'unsettled') {
      run.warn('The end of this region kept changing while Snap Flow waited there, so it could not confirm that everything had loaded. Check the end of the capture.');
    }

    const finalHeight = target.scrollHeight;
    if (!stopped && moved && Math.abs(finalHeight - initialHeight) > 2) {
      run.warn(
        `This region changed height while it was being captured (${fmt(initialHeight)} px to ${fmt(finalHeight)} px), and rows that were already captured moved. That is typical of virtualised lists; check the result for repeated or missing rows.`
      );
    }

    await run.finish(
      { kind: 'region', width: capturedWidth, height: y, originX: 0, originY: 0, dpr, background: '#ffffff' },
      'element'
    );
  }

  /**
   * Manual capture: the user scrolls the region and each newly revealed part is
   * recorded against its real content offset. Scrolling back over captured content
   * records nothing. On Finish, any gap between the first and last captured row
   * (from scrolling faster than frames can be taken) is filled automatically, so the
   * image is always one continuous span.
   */
  async function runRegionManual(run, target) {
    prepareRegion(run, target);
    const IntervalSet = ScrollStitcher.IntervalSet;
    const covered = new IntervalSet();   // content rows, device px
    const dpr = getDpr();
    const lockedLeft = target.scrollLeft;
    // Where the region stood when the user started: the image always includes it.
    const startTop = elementGeometry(target).cTop;
    let width = 0;
    let busy = Promise.resolve();
    let failure = null;
    // Set once the user has finished: from then on only the gap-filling frames are taken.
    let closing = false;

    const record = async (limit) => {
      run.check();
      if (closing && !limit) return;
      if (target.scrollLeft !== lockedLeft) scrollElementTo(target, lockedLeft, target.scrollTop);
      const clamp = (geo) => (limit
        ? [Math.max(limit[0], geo.cTop), Math.min(limit[1], geo.cBottom)]
        : [geo.cTop, geo.cBottom]);

      let geo = elementGeometry(target);
      if (geo.vis.w < 1 || geo.vis.h < 1) return;
      let range = clamp(geo);
      if (!covered.missing(range[0], range[1]).length) return;

      applyRegionPolicy(run, target);
      run.hud.place(geo.visCss);
      await settle(target, geo.visCss, { scrollDelay: Math.min(run.settings.scrollDelay || 0, 150) });

      geo = elementGeometry(target);
      range = clamp(geo);
      const gaps = covered.missing(range[0], range[1]);
      if (!gaps.length) return;

      const frame = {
        rect: geo.visCss,
        paints: gaps.map(([a, b]) => ({
          sx: geo.vis.x,
          sy: geo.vis.y + (a - geo.cTop),
          sw: geo.vis.w,
          sh: b - a,
          dx: 0,
          dy: a
        }))
      };
      const shot = await run.grab(frame, { done: covered.total, total: geo.contentH });
      if (!shot) throw new Error('This region needs more frames than Snap Flow captures in one pass.');

      // The region was scrolled while the screenshot was being taken, so the picture
      // may not show the rows it was measured for. It is left out and taken again.
      const now = elementGeometry(target);
      if (now.cTop !== geo.cTop || now.cLeft !== geo.cLeft) {
        frame.paints = [];
        if (!closing) onScroll();
        return;
      }
      gaps.forEach(([a, b]) => covered.add(a, b));
      width = Math.max(width, geo.vis.w);
      run.hud.update(
        covered.total / Math.max(1, geo.contentH),
        `${fmt(covered.total / dpr)} of ${fmt(target.scrollHeight)} px captured`
      );
    };

    const enqueue = (limit) => {
      busy = busy.then(() => (failure ? null : record(limit))).catch((err) => { failure = failure || err; });
      return busy;
    };

    let scrollTimer = null;
    const onScroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => enqueue(null), 160);
    };

    const finished = new Promise((resolve) => {
      run.hud = createHud({
        title: 'Manual capture',
        detail: 'Scroll the outlined region. New content is recorded as it appears.',
        target,
        outline: true,
        actions: [
          { label: 'Finish (Enter)', kind: 'primary', onClick: () => resolve('finish') },
          { label: 'Cancel (Esc)', kind: 'ghost', onClick: () => run.cancel() }
        ]
      });
      run.onCancel = () => resolve('cancel');
      run.onFinishKey = (e) => {
        if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        resolve('finish');
      };
    });

    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', run.onFinishKey, true);
    run.dispose = () => {
      clearTimeout(scrollTimer);
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('keydown', run.onFinishKey, true);
    };

    await enqueue(null);
    await finished;
    closing = true;
    clearTimeout(scrollTimer);
    target.removeEventListener('scroll', onScroll);
    window.removeEventListener('keydown', run.onFinishKey, true);
    await busy;
    run.check();
    if (failure) throw failure;

    // Close any gaps so the result is a single unbroken span, starting no later than
    // the view the user began with (its frame is dropped if they were already scrolling).
    run.hud.setTitle('Finishing…');
    for (let guard = 0; guard < MAX_FRAMES; guard++) {
      if (covered.isEmpty) break;
      const gaps = covered.missing(Math.min(startTop, covered.min), covered.max);
      if (!gaps.length) break;
      const [a, b] = gaps[0];
      const before = covered.total;
      await revealContentPoint(run, target, elementGeometry(target).sx, a, false);
      await enqueue([a, b]);
      if (failure) throw failure;
      if (covered.total <= before) {
        run.warn('Part of the region between the first and last captured rows could not be reached, so the image has a blank band there.');
        break;
      }
    }

    if (covered.isEmpty) throw new Error('Nothing was captured from this region.');

    await run.finish(
      {
        kind: 'region',
        width,
        height: covered.max - covered.min,
        originX: 0,
        originY: covered.min,
        dpr,
        background: '#ffffff'
      },
      'element'
    );
  }

  /**
   * Progress panel for region captures. It is placed clear of the captured area when
   * there is room; otherwise it is hidden for the instant each screenshot is taken.
   */
  function createHud({ title, detail, target, outline = false, actions = [] }) {
    const { layer } = getUi();
    layer.textContent = '';
    const hud = el('div', 'hud');
    const titleEl = el('div', 'title', title);
    const detailEl = el('div', 'detail', detail);
    const bar = el('div', 'bar');
    const fill = el('div');
    bar.appendChild(fill);
    hud.append(titleEl, bar, detailEl);

    if (actions.length) {
      const row = el('div', 'row');
      for (const action of actions) {
        const button = el('button', action.kind, action.label);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          action.onClick();
        });
        row.appendChild(button);
      }
      hud.appendChild(row);
    }
    hud.style.display = 'block';
    layer.appendChild(hud);

    const outlineEl = outline ? el('div', 'outline') : null;
    if (outlineEl) layer.appendChild(outlineEl);

    let hudRect = { x: 0, y: 0, w: 0, h: 0 };
    let outlineRect = null;

    const api = {
      setTitle(text) { titleEl.textContent = text; },
      update(fraction, text) {
        fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
        if (text) detailEl.textContent = text;
      },
      /** Positions the panel beside, above or below the captured area. */
      place(area) {
        const view = viewportRect();
        const w = hud.offsetWidth || 260;
        const h = hud.offsetHeight || 90;
        const gap = HUD_CLEARANCE_PX + 8;
        const edge = 12;
        const clampX = (x) => Math.max(edge, Math.min(view.w - w - edge, x));
        const clampY = (y) => Math.max(edge, Math.min(view.h - h - edge, y));
        const withShadow = (r) => ({
          x: r.x - HUD_CLEARANCE_PX,
          y: r.y - HUD_CLEARANCE_PX,
          w: r.w + HUD_CLEARANCE_PX * 2,
          h: r.h + HUD_CLEARANCE_PX * 2
        });
        const options = [
          { x: clampX(area.x + area.w + gap), y: clampY(area.y) },
          { x: clampX(area.x - w - gap), y: clampY(area.y) },
          { x: clampX(area.x), y: clampY(area.y - h - gap) },
          { x: clampX(area.x), y: clampY(area.y + area.h + gap) },
          { x: clampX(view.w - w - edge), y: edge }
        ];
        const spot = options.find((o) => !overlaps(withShadow({ x: o.x, y: o.y, w, h }), area)) || options[4];
        hud.style.left = `${spot.x}px`;
        hud.style.top = `${spot.y}px`;
        hudRect = { x: spot.x, y: spot.y, w, h };

        if (outlineEl) {
          const box = paddingBox(target);
          // Drawn just outside the padding box so it can never be part of the capture.
          outlineRect = { x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 };
          outlineEl.style.cssText = `display:block;left:${outlineRect.x}px;top:${outlineRect.y}px;width:${outlineRect.w}px;height:${outlineRect.h}px;`;
        }
      },
      mustHideFor(frame) {
        if (!frame.rect) return true;
        return overlaps(
          {
            x: hudRect.x - HUD_CLEARANCE_PX,
            y: hudRect.y - HUD_CLEARANCE_PX,
            w: hudRect.w + HUD_CLEARANCE_PX * 2,
            h: hudRect.h + HUD_CLEARANCE_PX * 2
          },
          frame.rect
        );
      }
    };

    api.place(elementGeometry(target).visCss);
    return api;
  }

  // ===========================================================================
  // 9. SELECTED AREA (rectangle of the visible viewport)
  // ===========================================================================

  let activePicker = null;

  function closePicker() {
    if (activePicker) {
      activePicker();
      activePicker = null;
    }
  }

  function startAreaSelection() {
    closePicker();
    const { layer } = getUi();
    layer.textContent = '';

    const dim = el('div', 'dim');
    const banner = el('div', 'banner');
    banner.append(el('span', null, '📐'), el('span', null, 'Click and drag to select an area. Press '), el('kbd', null, 'Esc'), el('span', null, ' to cancel.'));
    const marquee = el('div', 'marquee');
    const tag = el('div', 'tag');
    tag.style.background = '#0f172a';
    marquee.appendChild(tag);
    layer.append(dim, marquee, banner);

    let startX = 0, startY = 0, dragging = false;
    const rectOf = (e) => ({
      x: Math.min(e.clientX, startX),
      y: Math.min(e.clientY, startY),
      w: Math.abs(e.clientX - startX),
      h: Math.abs(e.clientY - startY)
    });

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      marquee.style.display = 'block';
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const r = rectOf(e);
      marquee.style.left = `${r.x}px`;
      marquee.style.top = `${r.y}px`;
      marquee.style.width = `${r.w}px`;
      marquee.style.height = `${r.h}px`;
      const dpr = window.devicePixelRatio || 1;
      tag.textContent = `${Math.round(r.w * dpr)} × ${Math.round(r.h * dpr)} px`;
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
      activePicker = null;
      removeUi();
    };

    const onMouseUp = async (e) => {
      if (!dragging) return;
      dragging = false;
      const r = rectOf(e);
      cleanup();
      if (r.w < 10 || r.h < 10) return;

      // Two frames so the overlay is gone from the screen before the screenshot.
      await nextFrame();
      await nextFrame();
      const response = await send({
        action: 'EXECUTE_SELECTED_CAPTURE',
        rect: r,
        viewport: { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        page: { title: document.title || 'Webpage', url: window.location.href }
      });
      if (response && response.error) showToast('Capture failed: ' + response.error, true);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    };

    dim.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    activePicker = cleanup;
  }

  // ===========================================================================
  // 10. SCROLLING REGION PICKER
  // ===========================================================================

  function startElementSelection() {
    closePicker();
    const { layer } = getUi();
    layer.textContent = '';

    const banner = el('div', 'banner');
    banner.append(
      el('span', null, '🔍'),
      el('span', null, 'Hover a scrolling area and click it. '),
      el('kbd', null, '↑'), el('kbd', null, '↓'),
      el('span', null, ' widen or narrow · '),
      el('kbd', null, 'Esc'),
      el('span', null, ' cancel')
    );
    const highlight = el('div', 'highlight');
    const tag = el('div', 'tag');
    highlight.appendChild(tag);
    const pill = el('div', 'pill');
    layer.append(highlight, pill, banner);

    /** chain: scrollable candidates under the pointer, innermost first. */
    let chain = [];
    let index = -1;        // position in chain, or -1 for "not scrollable"
    let hovered = null;    // raw element under the pointer
    let locked = false;
    let trackTimer = null;

    const current = () => (index >= 0 ? chain[index] : null);
    const currentNode = () => (current() ? current().node : hovered);

    function render() {
      const node = currentNode();
      if (!node || !node.isConnected) {
        highlight.style.display = 'none';
        return;
      }
      const rect = node.getBoundingClientRect();
      const candidate = current();
      highlight.style.display = 'block';
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlight.classList.toggle('static', !candidate);
      highlight.classList.toggle('locked', locked);
      tag.classList.toggle('inside', rect.top < 30);

      if (candidate) {
        const size = `${fmt(node.scrollWidth)} × ${fmt(node.scrollHeight)} px`;
        const depth = chain.length > 1 ? ` · ${index + 1}/${chain.length}` : '';
        tag.textContent = `${candidate.native ? 'Scrollable' : 'Clipped content'}: ${size} (${describeElement(node)})${depth}`;
      } else {
        tag.textContent = `Not scrollable: ${Math.round(rect.width)} × ${Math.round(rect.height)} px (${describeElement(node)})`;
      }
    }

    function pickUnderPointer(x, y) {
      const stack = document.elementsFromPoint(x, y).filter((n) => !isOwnNode(n));
      const target = stack[0];
      if (!target) return;
      hovered = target;
      chain = scrollableChain(target);
      // Prefer the innermost candidate that is a meaningful scroll area, so a tiny
      // nested box does not win over the panel the user is pointing at.
      index = chain.findIndex(isMeaningful);
      render();
    }

    const onMouseMove = (e) => {
      if (locked) return;
      pickUnderPointer(e.clientX, e.clientY);
    };

    // Events from inside the closed shadow root are retargeted to the host.
    const fromOwnUi = (e) => !!ui && e.target === ui.host;

    const swallow = (e) => {
      if (fromOwnUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    function cleanup() {
      clearInterval(trackTimer);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('pointerdown', swallow, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('keydown', onKeyDown, true);
      activePicker = null;
      removeUi();
    }

    function addButton(row, label, kind, handler) {
      const button = el('button', kind, label);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
      });
      row.appendChild(button);
      return button;
    }

    function begin(mode, node) {
      cleanup();
      const settings = { ...lastSettings };
      if (mode === 'auto') withRun('element', settings, (run) => runRegionAuto(run, node));
      else if (mode === 'manual') withRun('element', settings, (run) => runRegionManual(run, node));
      else if (mode === 'page') withRun('full', settings, (run) => runFullPage(run));
      else captureStaticElement(node);
    }

    function lock() {
      const node = currentNode();
      if (!node) return;
      locked = true;
      const candidate = current();
      pill.textContent = '';
      const info = el('div', 'info');
      const hint = el('div', 'hint');
      const row = el('div', 'row');

      if (candidate) {
        const axes = candidate.extentX >= MIN_HORIZONTAL_SCAN_PX && candidate.extentY >= 2
          ? 'scrolls both ways'
          : candidate.extentX >= MIN_HORIZONTAL_SCAN_PX ? 'scrolls sideways' : 'scrolls vertically';
        info.textContent = `Scrolling region · ${fmt(node.scrollWidth)} × ${fmt(node.scrollHeight)} px · ${axes}`;
        hint.textContent = 'Automatic captures everything in this region from start to end (Enter). Manual records what you scroll through (M).';
        addButton(row, '📸 Capture automatically', 'primary', () => begin('auto', node));
        addButton(row, 'Scroll manually', 'secondary', () => begin('manual', node)).dataset.key = 'm';
      } else {
        const pageScrolls = documentScrolls();
        info.textContent = 'This area does not scroll on its own';
        hint.textContent = pageScrolls
          ? 'It moves with the whole page. Capture the full page, or just this element as it appears now.'
          : 'There is nothing more to reveal here. You can capture this element as it appears now.';
        if (pageScrolls) addButton(row, '📸 Capture full page', 'primary', () => begin('page', node));
        addButton(row, 'Capture this element', pageScrolls ? 'secondary' : 'primary', () => begin('static', node));
      }
      addButton(row, 'Cancel', 'ghost', cleanup);
      pill.append(info, hint, row);

      pill.style.display = 'block';
      // Beside the region when there is room, so the choice does not cover what was chosen.
      const rect = node.getBoundingClientRect();
      const area = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      const height = pill.offsetHeight || 96;
      const width = pill.offsetWidth || 420;
      const clampX = (x) => Math.max(10, Math.min(window.innerWidth - width - 10, x));
      const clampY = (y) => Math.max(10, Math.min(window.innerHeight - height - 10, y));
      const options = [
        { x: clampX(rect.left), y: clampY(rect.bottom + 10) },
        { x: clampX(rect.left), y: clampY(rect.top - height - 10) },
        { x: clampX(rect.right + 10), y: clampY(rect.top + 10) },
        { x: clampX(rect.left - width - 10), y: clampY(rect.top + 10) },
        { x: clampX(rect.left + 10), y: clampY(rect.top + 40) }
      ];
      const spot = options.find((o) => !overlaps({ x: o.x, y: o.y, w: width, h: height }, area)) || options[4];
      pill.style.top = `${spot.y}px`;
      pill.style.left = `${spot.x}px`;
      render();
      // The page can still move underneath (async layout); keep the frame attached.
      trackTimer = setInterval(render, 200);
    }

    const onClick = (e) => {
      if (fromOwnUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (locked) return;
      pickUnderPointer(e.clientX, e.clientY);
      lock();
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        return;
      }
      if (locked) {
        const shortcut = e.key === 'Enter'
          ? pill.querySelector('button.primary')
          : pill.querySelector(`button[data-key="${e.key.toLowerCase()}"]`);
        if (shortcut && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          shortcut.click();
        }
        return;
      }
      if (e.key === 'ArrowUp' || e.key === ']') {
        e.preventDefault();
        e.stopPropagation();
        if (index < chain.length - 1) index++;
        render();
      } else if (e.key === 'ArrowDown' || e.key === '[') {
        e.preventDefault();
        e.stopPropagation();
        if (index > 0) index--;
        else if (index === -1 && chain.length) index = 0;
        render();
      } else if (e.key === 'Enter' && currentNode()) {
        e.preventDefault();
        lock();
      }
    };

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('pointerdown', swallow, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('keydown', onKeyDown, true);
    activePicker = cleanup;
  }

  /** A non-scrolling element: one screenshot cropped to the element's visible box. */
  async function captureStaticElement(node) {
    const rect = node.getBoundingClientRect();
    const visible = intersect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, viewportRect());
    if (visible.w < 2 || visible.h < 2) {
      showToast('That element is not visible on screen.', true);
      return;
    }
    await nextFrame();
    await nextFrame();
    const response = await send({
      action: 'EXECUTE_SELECTED_CAPTURE',
      rect: visible,
      viewport: { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      page: { title: document.title || 'Webpage', url: window.location.href },
      label: 'Element'
    });
    if (response && response.error) showToast('Capture failed: ' + response.error, true);
  }

  // ===========================================================================
  // 11. RUNTIME MESSAGE DISPATCHER
  // ===========================================================================

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.settings) lastSettings = { ...lastSettings, ...message.settings };

    switch (message.action) {
      case 'SF_PING':
        sendResponse({ ok: true, busy: !!activeRun });
        break;

      case 'SF_START_FULL':
        if (activeRun) {
          sendResponse({ error: 'A capture is already in progress on this page.' });
          break;
        }
        closePicker();
        withRun('full', { ...lastSettings }, (run) => runFullPage(run));
        sendResponse({ started: true });
        break;

      case 'SF_CANCEL':
        if (activeRun) activeRun.cancel();
        closePicker();
        sendResponse({ ok: true });
        break;

      case 'START_AREA_SELECTION':
        if (activeRun) {
          sendResponse({ error: 'A capture is already in progress on this page.' });
          break;
        }
        startAreaSelection();
        sendResponse({ success: true });
        break;

      case 'START_ELEMENT_SELECTION':
        if (activeRun) {
          sendResponse({ error: 'A capture is already in progress on this page.' });
          break;
        }
        startElementSelection();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: 'Unknown action: ' + message.action });
        break;
    }
  });
})();
