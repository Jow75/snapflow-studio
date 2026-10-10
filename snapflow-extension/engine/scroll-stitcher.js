/**
 * SnapFlow - Scroll Stitcher & Coordinate Mathematics Engine (Reliability 1.0)
 * Manages viewport step calculations, high-DPI (DPR) scaling, slice coordinate offsets,
 * footer remainder math, large-canvas memory bounds protection, and tiled buffers.
 */

class ScrollStitcher {
  /**
   * Chromium safe limits for HTML5 canvas dimensions & memory
   */
  static MAX_CANVAS_DIMENSION = 30000; // Safe threshold under 32,767px limit
  static MAX_CANVAS_AREA = 250000000;  // Safe threshold under ~268M pixel ceiling
  static BYTES_PER_PIXEL = 4;          // RGBA 32-bit
  static MEMORY_SAFETY_FACTOR = 1.5;   // Browser canvas buffer overhead
  static MAX_SAFE_BUFFER_BYTES = 250 * 1024 * 1024; // 250MB threshold for tiling

  /**
   * Calculates estimated memory required for a canvas buffer in bytes.
   */
  static estimateMemoryBytes(width, height) {
    return Math.round(width * height * this.BYTES_PER_PIXEL * this.MEMORY_SAFETY_FACTOR);
  }

  /**
   * Plans the discrete 2D slice steps required to cover the scrollable page or region.
   * Handles footer/right remainder offsets to avoid duplicate content rendering.
   *
   * @param {Object} metrics Page geometry { scrollWidth, scrollHeight, viewportWidth, viewportHeight, dpr }
   * @returns {Object} Slicing plan with steps, canvas dimensions, memory estimate, and tiling flags
   */
  static planSlices(metrics) {
    const {
      scrollWidth,
      scrollHeight,
      viewportWidth,
      viewportHeight,
      dpr = 1,
      scrollX = 0,
      scrollY = 0,
      isElement = false
    } = metrics;

    const totalWidthDevice = Math.round(scrollWidth * dpr);
    const totalHeightDevice = Math.round(scrollHeight * dpr);
    const viewportWidthDevice = Math.round(viewportWidth * dpr);
    const viewportHeightDevice = Math.round(viewportHeight * dpr);

    const slices = [];
    let currentY = 0;
    let canvasY = 0;

    while (currentY < scrollHeight) {
      const remainingHeight = scrollHeight - currentY;

      if (remainingHeight <= viewportHeight) {
        // Last slice: remainder offset
        // Scroll so the bottom aligns with bottom of viewport
        const scrollTargetY = Math.max(0, scrollHeight - viewportHeight);
        const remainderHeightCss = scrollHeight - currentY;
        // Ensure destY + remainderHeightDevice exactly reaches totalHeightDevice
        const remainderHeightDevice = Math.max(1, totalHeightDevice - canvasY);

        // In captured viewport, new content starts from bottom minus remainder
        const sourceClipY = Math.max(0, viewportHeightDevice - remainderHeightDevice);

        slices.push({
          index: slices.length,
          scrollX: 0,
          scrollY: scrollTargetY,
          sourceX: 0,
          sourceY: sourceClipY,
          sourceWidth: viewportWidthDevice,
          sourceHeight: remainderHeightDevice,
          destX: 0,
          destY: canvasY,
          destWidth: viewportWidthDevice,
          destHeight: remainderHeightDevice,
          isRemainder: true,
          remainderCss: remainderHeightCss
        });

        canvasY += remainderHeightDevice;
        break;
      } else {
        // Standard full viewport slice
        slices.push({
          index: slices.length,
          scrollX: 0,
          scrollY: currentY,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: viewportWidthDevice,
          sourceHeight: viewportHeightDevice,
          destX: 0,
          destY: canvasY,
          destWidth: viewportWidthDevice,
          destHeight: viewportHeightDevice,
          isRemainder: false,
          remainderCss: viewportHeight
        });

        currentY += viewportHeight;
        canvasY += viewportHeightDevice;
      }
    }

    // Memory assessment
    const estimatedMemoryBytes = this.estimateMemoryBytes(viewportWidthDevice, canvasY);
    const requiresTiling =
      canvasY > this.MAX_CANVAS_DIMENSION ||
      viewportWidthDevice > this.MAX_CANVAS_DIMENSION ||
      (viewportWidthDevice * canvasY) > this.MAX_CANVAS_AREA ||
      estimatedMemoryBytes > this.MAX_SAFE_BUFFER_BYTES;

    // Tiling plan if memory protection engaged
    let tiles = [];
    if (requiresTiling) {
      const tileHeight = Math.min(this.MAX_CANVAS_DIMENSION / 2, 10000);
      let tileStart = 0;
      while (tileStart < canvasY) {
        const currentTileHeight = Math.min(tileHeight, canvasY - tileStart);
        tiles.push({
          tileIndex: tiles.length,
          startY: tileStart,
          height: currentTileHeight,
          width: viewportWidthDevice
        });
        tileStart += currentTileHeight;
      }
    }

    return {
      slices,
      totalWidth: viewportWidthDevice,
      totalHeight: canvasY,
      scrollWidthCss: scrollWidth,
      scrollHeightCss: scrollHeight,
      viewportWidthCss: viewportWidth,
      viewportHeightCss: viewportHeight,
      dpr,
      estimatedMemoryBytes,
      requiresTiling,
      tiles
    };
  }

  /**
   * Plans slicing steps for a specific scrollable element container (Scrolling Region mode).
   */
  static planElementSlices(elementMetrics) {
    const {
      x,
      y,
      width,
      height,
      scrollWidth,
      scrollHeight,
      clientWidth,
      clientHeight,
      dpr = 1
    } = elementMetrics;

    const totalWidthDevice = Math.round(scrollWidth * dpr);
    const totalHeightDevice = Math.round(scrollHeight * dpr);
    const clientWidthDevice = Math.round(clientWidth * dpr);
    const clientHeightDevice = Math.round(clientHeight * dpr);
    const elemXDevice = Math.round(x * dpr);
    const elemYDevice = Math.round(y * dpr);

    const slices = [];
    let currentScrollY = 0;
    let canvasY = 0;

    while (currentScrollY < scrollHeight) {
      const remainingHeight = scrollHeight - currentScrollY;

      if (remainingHeight <= clientHeight) {
        // Last remainder step for element
        const targetScrollY = Math.max(0, scrollHeight - clientHeight);
        const remainderHeightCss = scrollHeight - currentScrollY;
        const remainderHeightDevice = Math.max(1, totalHeightDevice - canvasY);
        const sourceClipY = Math.max(0, clientHeightDevice - remainderHeightDevice);

        slices.push({
          index: slices.length,
          scrollTop: targetScrollY,
          scrollLeft: 0,
          cropX: elemXDevice,
          cropY: elemYDevice,
          cropWidth: clientWidthDevice,
          cropHeight: clientHeightDevice,
          sourceX: 0,
          sourceY: sourceClipY,
          sourceWidth: clientWidthDevice,
          sourceHeight: remainderHeightDevice,
          destX: 0,
          destY: canvasY,
          destWidth: clientWidthDevice,
          destHeight: remainderHeightDevice,
          isRemainder: true,
          remainderCss: remainderHeightCss
        });

        canvasY += remainderHeightDevice;
        break;
      } else {
        slices.push({
          index: slices.length,
          scrollTop: currentScrollY,
          scrollLeft: 0,
          cropX: elemXDevice,
          cropY: elemYDevice,
          cropWidth: clientWidthDevice,
          cropHeight: clientHeightDevice,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: clientWidthDevice,
          sourceHeight: clientHeightDevice,
          destX: 0,
          destY: canvasY,
          destWidth: clientWidthDevice,
          destHeight: clientHeightDevice,
          isRemainder: false,
          remainderCss: clientHeight
        });

        currentScrollY += clientHeight;
        canvasY += clientHeightDevice;
      }
    }

    return {
      slices,
      totalWidth: clientWidthDevice,
      totalHeight: canvasY,
      scrollWidthCss: scrollWidth,
      scrollHeightCss: scrollHeight,
      clientWidthCss: clientWidth,
      clientHeightCss: clientHeight,
      dpr,
      isElement: true
    };
  }

  /**
   * Helper to load an image from data URL into an HTMLImageElement with safety timeout.
   */
  static loadImage(dataUrl, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Image decode timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve(img);
        }
      };
      img.onerror = (err) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(new Error('Failed to decode captured slice image: ' + err));
        }
      };
      img.src = dataUrl;
    });
  }

  /**
   * Stitches an array of captured slice images onto an HTML5 Canvas.
   * Completely eliminates white seam gaps through pixel-exact blitting,
   * edge clamping, and seamless slice alignment.
   *
   * @param {Array<{ dataUrl: string, sliceInfo: Object }>} capturedSlices
   * @param {Object} plan Slicing plan generated by planSlices()
   * @returns {Promise<HTMLCanvasElement>} Stitched result canvas
   */
  static async stitchToCanvas(capturedSlices, plan) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.totalWidth;
    canvas.height = plan.totalHeight;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // Pixel-perfect blitting: disable image smoothing to prevent bilinear edge interpolation
    ctx.imageSmoothingEnabled = false;

    const dpr = plan.dpr || 1;
    const scrollHeightCss = plan.scrollHeightCss || Math.round(plan.totalHeight / dpr);

    let docYRepresented = 0;
    let canvasYWritten = 0;

    for (let i = 0; i < capturedSlices.length; i++) {
      const sliceItem = capturedSlices[i];
      const sliceInfo = sliceItem.sliceInfo || {};
      const img = await this.loadImage(sliceItem.dataUrl);

      // Determine actual document scroll coordinate for this frame
      const hasActualY = (sliceItem.actualY !== undefined && sliceItem.actualY !== null);
      const frameActualY = hasActualY
        ? sliceItem.actualY
        : (sliceInfo.scrollY !== undefined ? sliceInfo.scrollY : docYRepresented);

      const frameHeightDevice = img.height;
      let sourceClipY = 0;
      let retainedHeightDevice = frameHeightDevice;
      let destY = canvasYWritten;

      if (i === 0) {
        // First frame: represents document [0, frameHeightCss)
        sourceClipY = sliceInfo.sourceY || 0;
        retainedHeightDevice = (sliceInfo.sourceHeight && !sliceInfo.isRemainder)
          ? sliceInfo.sourceHeight
          : Math.min(frameHeightDevice, plan.totalHeight);
        destY = 0;

        docYRepresented = frameActualY + (retainedHeightDevice / dpr);
        canvasYWritten = retainedHeightDevice;
      } else {
        // If actual scroll position is tracked or consecutive frame overlaps
        if (hasActualY) {
          // Frame covers document [frameActualY, frameActualY + (frameHeightDevice / dpr))
          const overlapCss = Math.max(0, docYRepresented - frameActualY);
          const overlapDevice = Math.round(overlapCss * dpr);

          sourceClipY = Math.min(frameHeightDevice - 1, overlapDevice);

          // Calculate remaining document extent to cover
          const remainingDocHeightDevice = Math.max(0, plan.totalHeight - canvasYWritten);
          retainedHeightDevice = Math.min(
            frameHeightDevice - sourceClipY,
            remainingDocHeightDevice
          );

          destY = canvasYWritten;
          docYRepresented += (retainedHeightDevice / dpr);
          canvasYWritten += retainedHeightDevice;
        } else if (sliceInfo.isRemainder) {
          // Pre-planned remainder slice
          sourceClipY = sliceInfo.sourceY;
          retainedHeightDevice = sliceInfo.sourceHeight;
          destY = sliceInfo.destY;
          docYRepresented += (retainedHeightDevice / dpr);
          canvasYWritten = destY + retainedHeightDevice;
        } else {
          // Standard full viewport slice
          sourceClipY = sliceInfo.sourceY || 0;
          retainedHeightDevice = sliceInfo.sourceHeight || frameHeightDevice;
          destY = sliceInfo.destY !== undefined ? sliceInfo.destY : canvasYWritten;
          docYRepresented += (retainedHeightDevice / dpr);
          canvasYWritten = destY + retainedHeightDevice;
        }
      }

      // Clamp source bounds within actual decoded image dimensions
      const sourceX = Math.max(0, Math.min(img.width - 1, sliceInfo.sourceX || 0));
      const sourceY = Math.max(0, Math.min(img.height - 1, sourceClipY));
      const sourceWidth = Math.min(sliceInfo.sourceWidth || img.width, img.width - sourceX);
      const sourceHeight = Math.min(retainedHeightDevice, img.height - sourceY);

      const destX = sliceInfo.destX || 0;
      const destWidth = sliceInfo.destWidth || sourceWidth;
      const destHeight = sourceHeight;

      if (sourceWidth > 0 && sourceHeight > 0 && destWidth > 0 && destHeight > 0) {
        ctx.drawImage(
          img,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          destX,
          destY,
          destWidth,
          destHeight
        );
      }
    }

    return canvas;
  }

  /**
   * Stitches scrolling region element slices into a complete image of the scrollable container.
   *
   * @param {Array<{ dataUrl: string, sliceInfo: Object, elementRect?: Object }>} capturedSlices
   * @param {Object} plan Element slicing plan from planElementSlices()
   * @returns {Promise<HTMLCanvasElement>} Stitched element canvas
   */
  static async stitchElementToCanvas(capturedSlices, plan) {
    const canvas = document.createElement('canvas');
    canvas.width = plan.totalWidth;
    canvas.height = plan.totalHeight;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    for (let i = 0; i < capturedSlices.length; i++) {
      const { dataUrl, sliceInfo } = capturedSlices[i];
      const img = await this.loadImage(dataUrl);

      // 1. Crop element rectangle from visible tab screenshot
      const cropX = Math.max(0, Math.min(img.width - 1, sliceInfo.cropX));
      const cropY = Math.max(0, Math.min(img.height - 1, sliceInfo.cropY));
      const cropW = Math.min(sliceInfo.cropWidth, img.width - cropX);
      const cropH = Math.min(sliceInfo.cropHeight, img.height - cropY);

      // Create temporary offscreen slice canvas
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = cropW;
      sliceCanvas.height = cropH;
      const sCtx = sliceCanvas.getContext('2d');
      sCtx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      // 2. Draw relevant portion (handling remainder if last slice) onto destination canvas
      const sX = sliceInfo.sourceX || 0;
      const sY = sliceInfo.sourceY || 0;
      const sW = Math.min(sliceInfo.sourceWidth, cropW - sX);
      const sH = Math.min(sliceInfo.sourceHeight, cropH - sY);

      ctx.drawImage(
        sliceCanvas,
        sX,
        sY,
        sW,
        sH,
        sliceInfo.destX,
        sliceInfo.destY,
        sliceInfo.destWidth,
        sliceInfo.destHeight
      );
    }

    return canvas;
  }

  /**
   * Crops a specific region from a captured full-viewport image.
   *
   * @param {string} dataUrl Viewport image data URL
   * @param {Object} cropArea { x, y, width, height } in device pixels
   * @returns {Promise<HTMLCanvasElement>} Cropped canvas
   */
  static async cropImage(dataUrl, cropArea) {
    const img = await this.loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropArea.width));
    canvas.height = Math.max(1, Math.round(cropArea.height));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const sx = Math.max(0, Math.min(img.width - 1, Math.round(cropArea.x)));
    const sy = Math.max(0, Math.min(img.height - 1, Math.round(cropArea.y)));
    const sw = Math.min(img.width - sx, Math.max(1, Math.round(cropArea.width)));
    const sh = Math.min(img.height - sy, Math.max(1, Math.round(cropArea.height)));

    ctx.drawImage(
      img,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvas;
  }
}

// Export for module/worker or window context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrollStitcher;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ScrollStitcher = ScrollStitcher;
}
