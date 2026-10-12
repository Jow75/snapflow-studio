/**
 * Pixel ruler used by the fixtures.
 *
 * Paints a narrow strip in which every CSS row y is a solid colour encoding y:
 *   R = y >> 8, G = y & 255, B = channel id
 * A stitched screenshot can then be decoded row by row to prove that each source
 * row appears exactly once, in order, with nothing duplicated or missing.
 */
(function () {
  const WIDTH = 16;

  function makeRuler(height, channel, horizontal) {
    const canvas = document.createElement('canvas');
    canvas.className = 'sf-ruler';
    canvas.width = horizontal ? height : WIDTH;
    canvas.height = horizontal ? WIDTH : height;
    canvas.style.cssText =
      `display:block;width:${canvas.width}px;height:${canvas.height}px;` +
      'image-rendering:pixelated;flex:none;';
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < WIDTH; j++) {
        const x = horizontal ? i : j;
        const y = horizontal ? j : i;
        const o = (y * canvas.width + x) * 4;
        img.data[o] = (i >> 8) & 255;
        img.data[o + 1] = i & 255;
        img.data[o + 2] = channel;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Numbered text rows so a human can also read the capture for duplicates. */
  function makeRows(count, rowHeight, label) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'sf-row';
      row.style.cssText =
        `height:${rowHeight}px;line-height:${rowHeight}px;box-sizing:border-box;` +
        'padding:0 12px;white-space:nowrap;overflow:hidden;font:14px/1 Arial,sans-serif;' +
        `line-height:${rowHeight}px;background:${i % 2 ? '#f1f5f9' : '#ffffff'};` +
        'border-bottom:1px solid #cbd5e1;color:#0f172a;';
      row.textContent = `${label} row ${String(i + 1).padStart(4, '0')} — the quick brown fox jumps over the lazy dog`;
      frag.appendChild(row);
    }
    return frag;
  }

  /**
   * Fills `host` with a ruler column plus numbered rows totalling exactly `height` px.
   */
  function fill(host, { height, channel, label, rowHeight = 40 }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;align-items:flex-start;height:${height}px;overflow:hidden;`;
    wrap.appendChild(makeRuler(height, channel, false));
    const rows = document.createElement('div');
    rows.style.cssText = 'flex:1;min-width:0;';
    rows.appendChild(makeRows(Math.ceil(height / rowHeight), rowHeight, label));
    wrap.appendChild(rows);
    host.appendChild(wrap);
    return wrap;
  }

  window.SFRuler = { makeRuler, makeRows, fill, WIDTH };
})();
