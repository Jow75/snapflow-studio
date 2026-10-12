/**
 * SnapFlow - Raster Image Exporter
 *
 * Encodes the flattened Studio canvas to PNG, JPEG or WebP at its own pixel size.
 * Nothing here resizes: the file has exactly the dimensions of the canvas it was
 * given. Every failure is reported; a file is never saved under a format it is not.
 */

class ImageExporter {
  /**
   * maxSide is the largest width or height the format itself can store.
   * `opaque` formats cannot store transparency and are composited onto white.
   */
  static FORMATS = {
    png: { label: 'PNG', mime: 'image/png', extension: 'png', quality: undefined, maxSide: 65535, opaque: false },
    jpeg: { label: 'JPEG', mime: 'image/jpeg', extension: 'jpg', quality: 0.92, maxSide: 65535, opaque: true },
    webp: { label: 'WebP', mime: 'image/webp', extension: 'webp', quality: 0.92, maxSide: 16383, opaque: false }
  };

  static OPAQUE_BACKGROUND = '#ffffff';

  /** Returns a user-facing reason this canvas cannot be saved in the format, or null. */
  static checkLimits(formatKey, width, height) {
    const format = this.FORMATS[formatKey];
    if (!format) return `Unknown image format: ${formatKey}`;
    if (!(width > 0) || !(height > 0)) return 'There is no image to export.';
    if (Math.max(width, height) > format.maxSide) {
      return `${format.label} files cannot be larger than ${format.maxSide.toLocaleString()} px on a side ` +
        `(this image is ${width.toLocaleString()} × ${height.toLocaleString()} px). Export as PNG or PDF instead.`;
    }
    return null;
  }

  /** Copies a canvas onto a solid background, 1:1, for formats without transparency. */
  static flatten(canvas, color = this.OPAQUE_BACKGROUND) {
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const ctx = flat.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return flat;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {'png'|'jpeg'|'webp'} formatKey
   * @returns {Promise<Blob>} resolves only with a blob of exactly the requested type
   */
  static encode(canvas, formatKey) {
    const format = this.FORMATS[formatKey];
    const limit = this.checkLimits(formatKey, canvas.width, canvas.height);
    if (limit) return Promise.reject(new Error(limit));

    const source = format.opaque ? this.flatten(canvas) : canvas;
    return new Promise((resolve, reject) => {
      source.toBlob((blob) => {
        if (!blob) {
          reject(new Error(`The browser could not create a ${format.label} of this size. Try PNG, or crop the image.`));
        } else if (blob.type !== format.mime) {
          // Browsers fall back to PNG for encoders they lack. That must not be saved as .webp/.jpg.
          reject(new Error(`This browser cannot encode ${format.label} images.`));
        } else {
          resolve(blob);
        }
      }, format.mime, format.quality);
    });
  }

  /** Starts a download of a blob. The object URL is released once the browser has it. */
  static download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// Export for module/worker or window context
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ImageExporter;
} else if (typeof globalThis !== 'undefined') {
  globalThis.ImageExporter = ImageExporter;
}
