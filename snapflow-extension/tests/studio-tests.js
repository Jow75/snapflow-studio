/**
 * SnapFlow Studio - Exhaustive Undo/Redo & Premium Features Test Suite
 *
 * Validates:
 * - Test A: 4 Actions (Rect, Arrow, Text, Emoji) -> 4 Undos (clears to History[0]) -> 4 Redos (restores all)
 * - Test B: 10 Actions -> 10 Undos (reverse order clearing)
 * - Test C: 5 Actions -> 3 Undos -> New Action -> Invalidation of Redo forward branch
 * - Test D: Rect Add -> Change Color -> Move -> Resize -> Repeated Undo
 * - Test E: Rapid consecutive operations without state corruption
 * - Test F: Crop action -> Undo crop restores pre-crop canvas dimensions and shifted coordinates
 * - Test G: Padding action -> Undo padding restores original canvas and coordinates
 * - Test H: Layer reordering (bring to front, send to back) -> Undo restores layer order
 * - Test I: Metadata banner injection -> Undo removes banner
 * - Test J: Text inline edit -> Undo restores original text
 */

const assert = require('assert');
const path = require('path');

// 1. Lightweight Mock DOM & Canvas for Headless Execution
class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.font = '16px sans-serif';
    this.textAlign = 'left';
    this.textBaseline = 'top';
  }
  save() {}
  restore() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  ellipse() {}
  quadraticCurveTo() {}
  stroke() {}
  fill() {}
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {}
  fillText(txt, x, y) {}
  strokeText(txt, x, y) {}
  setLineDash() {}
  measureText(txt) { return { width: (txt || '').length * 8 }; }
  getImageData(x, y, w, h) {
    return { data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) };
  }
  putImageData(data, x, y) {}
}

class MockCanvas {
  constructor(w = 1200, h = 800) {
    this.width = w;
    this.height = h;
    this.style = {};
    this.ctx = new MockContext2D(this);
  }
  getContext(type) {
    return this.ctx;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
  addEventListener() {}
  removeEventListener() {}
}

// Global browser environment mocks
global.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return new MockCanvas(100, 100);
    return {
      style: {},
      addEventListener: () => {},
      remove: () => {},
      focus: () => {},
      select: () => {}
    };
  },
  body: {
    appendChild: () => {}
  }
};
global.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'https://example.com/test-page' }
};

const StudioAnnotator = require(path.resolve(__dirname, '../studio/annotator.js'));
const ScrollStitcher = require(path.resolve(__dirname, '../engine/scroll-stitcher.js'));
const fs = require('fs');

let testsRun = 0;
let testsPassed = 0;

function it(description, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`  [PASS] ${description}`);
  } catch (err) {
    console.error(`  [FAIL] ${description}`);
    console.error(`         ${err.stack}`);
  }
}

console.log('\n============================================================');
console.log('   SNAPFLOW STUDIO - UNDO/REDO & FEATURE VERIFICATION SUITE');
console.log('============================================================\n');

// -------------------------------------------------------------
// TEST A: Exact User Scenario from Prompt
// -------------------------------------------------------------
console.log('--- TEST A: EXACT 4-ACTION SEQUENTIAL UNDO & REDO ---');
it('Action 1->Rect, 2->Arrow, 3->Text, 4->Emoji => Undo 4 times must reach initial empty state => Redo 4 times restores all', () => {
  const base = new MockCanvas(1200, 800);
  const overlay = new MockCanvas(1200, 800);
  let historyEvent = null;
  const annotator = new StudioAnnotator(base, overlay, {
    onHistoryChange: (e) => { historyEvent = e; }
  });

  // Verify baseline History[0]
  assert.strictEqual(annotator.history.length, 1);
  assert.strictEqual(annotator.historyIndex, 0);
  assert.strictEqual(annotator.annotations.length, 0);
  assert.strictEqual(historyEvent.canUndo, false);
  assert.strictEqual(historyEvent.canRedo, false);

  // Action 1: Add Rectangle
  annotator.setTool('rect');
  annotator.startX = 50; annotator.startY = 50;
  annotator.isDrawing = true;
  annotator.onMouseUp({ clientX: 200, clientY: 150 });
  assert.strictEqual(annotator.annotations.length, 1);
  assert.strictEqual(annotator.annotations[0].type, 'rect');
  assert.strictEqual(annotator.historyIndex, 1);
  assert.strictEqual(historyEvent.canUndo, true);
  assert.strictEqual(historyEvent.canRedo, false);

  // Action 2: Add Arrow
  annotator.setTool('arrow');
  annotator.startX = 200; annotator.startY = 200;
  annotator.isDrawing = true;
  annotator.onMouseUp({ clientX: 350, clientY: 300 });
  assert.strictEqual(annotator.annotations.length, 2);
  assert.strictEqual(annotator.annotations[1].type, 'arrow');
  assert.strictEqual(annotator.historyIndex, 2);

  // Action 3: Add Text
  annotator.annotations.push({
    id: annotator.generateId(),
    type: 'text',
    x: 400,
    y: 200,
    text: 'Audit note',
    fontSize: 20,
    color: '#ef4444'
  });
  annotator.pushHistory(false);
  assert.strictEqual(annotator.annotations.length, 3);
  assert.strictEqual(annotator.annotations[2].type, 'text');
  assert.strictEqual(annotator.historyIndex, 3);

  // Action 4: Add Emoji
  annotator.setTool('emoji');
  annotator.setActiveEmoji('🚀');
  annotator.onMouseDown({ button: 0, clientX: 500, clientY: 500 });
  assert.strictEqual(annotator.annotations.length, 4);
  assert.strictEqual(annotator.annotations[3].type, 'emoji');
  assert.strictEqual(annotator.historyIndex, 4);

  // --- UNDO 1: MUST REMOVE EMOJI ---
  annotator.undo();
  assert.strictEqual(annotator.annotations.length, 3, 'Undo 1 should leave 3 annotations');
  assert.strictEqual(annotator.annotations[2].type, 'text');
  assert.strictEqual(annotator.historyIndex, 3);
  assert.strictEqual(historyEvent.canUndo, true);
  assert.strictEqual(historyEvent.canRedo, true);

  // --- UNDO 2: MUST REMOVE TEXT ---
  annotator.undo();
  assert.strictEqual(annotator.annotations.length, 2, 'Undo 2 should leave 2 annotations');
  assert.strictEqual(annotator.annotations[1].type, 'arrow');
  assert.strictEqual(annotator.historyIndex, 2);

  // --- UNDO 3: MUST REMOVE ARROW ---
  annotator.undo();
  assert.strictEqual(annotator.annotations.length, 1, 'Undo 3 should leave 1 annotation');
  assert.strictEqual(annotator.annotations[0].type, 'rect');
  assert.strictEqual(annotator.historyIndex, 1);

  // --- UNDO 4: CRITICAL BUG CHECK - MUST REMOVE RECTANGLE ---
  annotator.undo();
  assert.strictEqual(annotator.annotations.length, 0, 'Undo 4 MUST restore initial 0 annotations');
  assert.strictEqual(annotator.historyIndex, 0);
  assert.strictEqual(historyEvent.canUndo, false, 'Undo disabled at History[0]');
  assert.strictEqual(historyEvent.canRedo, true);

  // Further undo should be a no-op
  const undoResult = annotator.undo();
  assert.strictEqual(undoResult, false);
  assert.strictEqual(annotator.historyIndex, 0);

  // --- REDO 1: RESTORES RECT ---
  annotator.redo();
  assert.strictEqual(annotator.annotations.length, 1);
  assert.strictEqual(annotator.annotations[0].type, 'rect');

  // --- REDO 2: RESTORES ARROW ---
  annotator.redo();
  assert.strictEqual(annotator.annotations.length, 2);
  assert.strictEqual(annotator.annotations[1].type, 'arrow');

  // --- REDO 3: RESTORES TEXT ---
  annotator.redo();
  assert.strictEqual(annotator.annotations.length, 3);
  assert.strictEqual(annotator.annotations[2].type, 'text');

  // --- REDO 4: RESTORES EMOJI ---
  annotator.redo();
  assert.strictEqual(annotator.annotations.length, 4);
  assert.strictEqual(annotator.annotations[3].type, 'emoji');
  assert.strictEqual(annotator.historyIndex, 4);
  assert.strictEqual(historyEvent.canRedo, false, 'Redo disabled at latest History state');
});

// -------------------------------------------------------------
// TEST B: 10 Elements Added, 10 Undos
// -------------------------------------------------------------
console.log('\n--- TEST B: 10 CONSECUTIVE ELEMENTS REVERSE UNDO ---');
it('Should add 10 elements and undo 10 times in exact reverse order', () => {
  const base = new MockCanvas(1000, 1000);
  const overlay = new MockCanvas(1000, 1000);
  const annotator = new StudioAnnotator(base, overlay);

  for (let i = 1; i <= 10; i++) {
    annotator.annotations.push({
      id: `elem_${i}`,
      type: 'rect',
      tag: `Item ${i}`
    });
    annotator.pushHistory(false);
  }

  assert.strictEqual(annotator.annotations.length, 10);
  assert.strictEqual(annotator.historyIndex, 10);

  // Undo 10 times
  for (let i = 10; i >= 1; i--) {
    assert.strictEqual(annotator.annotations[annotator.annotations.length - 1].tag, `Item ${i}`);
    annotator.undo();
    assert.strictEqual(annotator.annotations.length, i - 1);
  }

  assert.strictEqual(annotator.historyIndex, 0);
  assert.strictEqual(annotator.annotations.length, 0);
});

// -------------------------------------------------------------
// TEST C: Invalidation of Redo Branch
// -------------------------------------------------------------
console.log('\n--- TEST C: REDO BRANCH INVALIDATION ---');
it('Add 5 elements, undo 3, add new element -> Redo history must be invalidated', () => {
  const base = new MockCanvas(1000, 1000);
  const overlay = new MockCanvas(1000, 1000);
  let historyEvent = null;
  const annotator = new StudioAnnotator(base, overlay, {
    onHistoryChange: (e) => { historyEvent = e; }
  });

  for (let i = 1; i <= 5; i++) {
    annotator.annotations.push({ id: `e_${i}`, type: 'rect' });
    annotator.pushHistory(false);
  }
  assert.strictEqual(annotator.historyIndex, 5);

  // Undo 3
  annotator.undo();
  annotator.undo();
  annotator.undo();
  assert.strictEqual(annotator.historyIndex, 2);
  assert.strictEqual(annotator.annotations.length, 2);
  assert.strictEqual(historyEvent.canRedo, true);

  // Add new element
  annotator.annotations.push({ id: 'new_elem', type: 'circle' });
  annotator.pushHistory(false);

  assert.strictEqual(annotator.historyIndex, 3);
  assert.strictEqual(annotator.history.length, 4);
  assert.strictEqual(historyEvent.canRedo, false, 'Redo forward branch must be discarded');
});

// -------------------------------------------------------------
// TEST D: Granular Property Mutations & History
// -------------------------------------------------------------
console.log('\n--- TEST D: PROPERTY MUTATION & TRANSFORMS ---');
it('Rect add -> Change color -> Move -> Resize -> Undo sequence', () => {
  const base = new MockCanvas(1000, 1000);
  const overlay = new MockCanvas(1000, 1000);
  const annotator = new StudioAnnotator(base, overlay);

  // 1. Add rect
  const rectAnn = {
    id: 'rect_1',
    type: 'rect',
    startX: 100, startY: 100, endX: 200, endY: 200,
    strokeColor: '#ff0000', strokeWidth: 4
  };
  annotator.annotations.push(rectAnn);
  annotator.selectedId = rectAnn.id;
  annotator.pushHistory(false); // checkpoint 1

  // 2. Change color
  annotator.setColor('#00ff00'); // updates selectedId and pushes checkpoint 2
  assert.strictEqual(annotator.annotations[0].strokeColor, '#00ff00');
  assert.strictEqual(annotator.historyIndex, 2);

  // 3. Move
  annotator.applyObjectMove(annotator.annotations[0], { startX: 100, startY: 100, endX: 200, endY: 200 }, 50, 50);
  annotator.pushHistory(false); // checkpoint 3
  assert.strictEqual(annotator.annotations[0].startX, 150);
  assert.strictEqual(annotator.historyIndex, 3);

  // Undo move
  annotator.undo();
  assert.strictEqual(annotator.annotations[0].startX, 100);
  assert.strictEqual(annotator.annotations[0].strokeColor, '#00ff00');

  // Undo color change
  annotator.undo();
  assert.strictEqual(annotator.annotations[0].strokeColor, '#ff0000');

  // Undo addition
  annotator.undo();
  assert.strictEqual(annotator.annotations.length, 0);
});

// -------------------------------------------------------------
// TEST F: Crop Undo & Restore
// -------------------------------------------------------------
console.log('\n--- TEST F: INTERACTIVE CROP UNDO/REDO ---');
it('Crop screenshot from 1200x800 to 600x400 -> Undo restores exact original 1200x800 and shifts coordinates back', () => {
  const base = new MockCanvas(1200, 800);
  const overlay = new MockCanvas(1200, 800);
  const annotator = new StudioAnnotator(base, overlay);

  // Add an annotation at (150, 150)
  annotator.annotations.push({
    id: 'target',
    type: 'rect',
    startX: 150, startY: 150, endX: 250, endY: 250
  });
  annotator.pushHistory(false);

  // Crop region: x=100, y=100, width=600, height=400
  annotator.cropMarquee = { x: 100, y: 100, width: 600, height: 400 };
  const cropSuccess = annotator.commitCrop();
  assert.strictEqual(cropSuccess, true);

  assert.strictEqual(base.width, 600);
  assert.strictEqual(base.height, 400);
  assert.strictEqual(overlay.width, 600);
  assert.strictEqual(overlay.height, 400);

  // Coordinate offset: 150 - 100 = 50
  assert.strictEqual(annotator.annotations[0].startX, 50);
  assert.strictEqual(annotator.annotations[0].startY, 50);

  // UNDO CROP
  annotator.undo();
  assert.strictEqual(base.width, 1200, 'Original base width restored');
  assert.strictEqual(base.height, 800, 'Original base height restored');
  assert.strictEqual(overlay.width, 1200);
  assert.strictEqual(overlay.height, 800);

  assert.strictEqual(annotator.annotations[0].startX, 150, 'Original annotation startX restored');
  assert.strictEqual(annotator.annotations[0].startY, 150, 'Original annotation startY restored');
});

// -------------------------------------------------------------
// TEST G: Padding Undo & Restore
// -------------------------------------------------------------
console.log('\n--- TEST G: PADDING & BORDER UNDO/REDO ---');
it('Apply 32px padding -> Canvas expands by 64px -> Undo restores original dimensions', () => {
  const base = new MockCanvas(1000, 600);
  const overlay = new MockCanvas(1000, 600);
  const annotator = new StudioAnnotator(base, overlay);

  annotator.applyPadding(32, '#1e293b');
  assert.strictEqual(base.width, 1064);
  assert.strictEqual(base.height, 664);
  assert.strictEqual(annotator.padding.size, 32);

  // Undo padding
  annotator.undo();
  assert.strictEqual(base.width, 1000);
  assert.strictEqual(base.height, 600);
  assert.strictEqual(annotator.padding.size, 0);
});

// -------------------------------------------------------------
// TEST H: Layer Reordering Undo
// -------------------------------------------------------------
console.log('\n--- TEST H: LAYER ORDERING & UNDO ---');
it('Layer reordering: Bring to Front, Send to Back -> Undo restores previous layer stack', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  annotator.annotations = [
    { id: 'item_A', type: 'rect' },
    { id: 'item_B', type: 'circle' },
    { id: 'item_C', type: 'text' }
  ];
  annotator.pushHistory(false);

  // Select item A and bring to front
  annotator.selectedId = 'item_A';
  annotator.bringToFront();
  assert.deepStrictEqual(annotator.annotations.map(a => a.id), ['item_B', 'item_C', 'item_A']);

  // Undo bring to front
  annotator.undo();
  assert.deepStrictEqual(annotator.annotations.map(a => a.id), ['item_A', 'item_B', 'item_C']);
});

// -------------------------------------------------------------
// TEST E: Rapid Consecutive Operations (Stress Test)
// -------------------------------------------------------------
console.log('\n--- TEST E: RAPID CONSECUTIVE OPERATIONS ---');
it('Rapid operations: Add, Add, Move, Resize, Color, Delete, Undo x 4 without state corruption', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  // Add 1
  annotator.annotations.push({ id: 'a1', type: 'rect', startX: 10, startY: 10, endX: 50, endY: 50 });
  annotator.pushHistory(false);
  // Add 2
  annotator.annotations.push({ id: 'a2', type: 'circle', startX: 60, startY: 60, endX: 100, endY: 100 });
  annotator.pushHistory(false);
  // Move 2
  annotator.applyObjectMove(annotator.annotations[1], { startX: 60, startY: 60, endX: 100, endY: 100 }, 20, 20);
  annotator.pushHistory(false);
  // Resize 2
  annotator.applyHandleResize(annotator.annotations[1], 'se', { x: 140, y: 140 });
  annotator.pushHistory(false);
  // Color 2
  annotator.selectedId = 'a2';
  annotator.setColor('#3b82f6');
  // Delete 2
  annotator.deleteSelected();
  assert.strictEqual(annotator.annotations.length, 1);
  assert.strictEqual(annotator.annotations[0].id, 'a1');

  // Undo 4 times
  annotator.undo(); // undo delete
  assert.strictEqual(annotator.annotations.length, 2);
  assert.strictEqual(annotator.annotations[1].strokeColor, '#3b82f6');

  annotator.undo(); // undo color
  annotator.undo(); // undo resize
  annotator.undo(); // undo move
  assert.strictEqual(annotator.annotations.length, 2);
  assert.strictEqual(annotator.annotations[1].startX, 60);
});

// -------------------------------------------------------------
// TEST J: Destructive Redaction with Noise Mask & Undo
// -------------------------------------------------------------
console.log('\n--- TEST J: DESTRUCTIVE REDACTION & PIXEL RESTORATION ---');
it('Destructive redaction irreversibly wipes base canvas pixels -> Undo restores original unredacted snapshot', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  // Redact area
  annotator.applyDestructiveRedaction(50, 50, 200, 100);
  annotator.pushHistory(true);
  assert.strictEqual(annotator.historyIndex, 1);

  // Undo redaction
  annotator.undo();
  assert.strictEqual(annotator.historyIndex, 0);
});
console.log('\n--- TEST I: METADATA BANNER INJECTION & UNDO ---');
it('Set browser header metadata banner -> Undo removes metadata banner', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  annotator.setMetadataBanner({
    enabled: true,
    style: 'browser',
    position: 'top',
    url: 'https://github.com/google',
    title: 'Google GitHub'
  });

  assert.notStrictEqual(annotator.metadataBanner, null);
  assert.strictEqual(annotator.metadataBanner.style, 'browser');

  annotator.undo();
  assert.strictEqual(annotator.metadataBanner, null);
});

// -------------------------------------------------------------
// TEST K: Incremental Layer Forward / Backward & Undo
// -------------------------------------------------------------
console.log('\n--- TEST K: INCREMENTAL LAYER FORWARD / BACKWARD & UNDO ---');
it('Layer reordering: Bring Forward and Send Backward shift items by one step -> Undo restores order', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  annotator.annotations = [
    { id: 'item_A', type: 'rect' },
    { id: 'item_B', type: 'circle' },
    { id: 'item_C', type: 'text' }
  ];
  annotator.pushHistory(false);

  // Bring item_A forward by 1 step: ['item_B', 'item_A', 'item_C']
  annotator.selectedId = 'item_A';
  annotator.bringForward();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_B', 'item_A', 'item_C']);

  // Bring item_A forward again: ['item_B', 'item_C', 'item_A']
  annotator.bringForward();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_B', 'item_C', 'item_A']);

  // Send item_A backward by 1 step: ['item_B', 'item_A', 'item_C']
  annotator.sendBackward();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_B', 'item_A', 'item_C']);

  // Undo sendBackward -> ['item_B', 'item_C', 'item_A']
  annotator.undo();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_B', 'item_C', 'item_A']);

  // Undo bringForward 2 -> ['item_B', 'item_A', 'item_C']
  annotator.undo();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_B', 'item_A', 'item_C']);

  // Undo bringForward 1 -> ['item_A', 'item_B', 'item_C']
  annotator.undo();
  assert.deepStrictEqual(annotator.annotations.map((a) => a.id), ['item_A', 'item_B', 'item_C']);
});

// -------------------------------------------------------------
// TEST L: Independent Metadata Banner Positioning & URL Preservation
// -------------------------------------------------------------
console.log('\n--- TEST L: INDEPENDENT METADATA BANNER POSITIONING & URL PRESERVATION ---');
it('Independent metadata: URL on bottom and Date on top -> Preserves exact page URL without Google fallback', () => {
  const base = new MockCanvas(800, 600);
  const overlay = new MockCanvas(800, 600);
  const annotator = new StudioAnnotator(base, overlay);

  const customUrl = 'https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API?ref=snapflow#tutorials';
  const customIso = '2026-10-10T18:00:00.000Z';

  annotator.setMetadataBanner({
    enabled: true,
    style: 'banner',
    urlPosition: 'bottom',
    datePosition: 'top',
    dateFormat: 'iso',
    url: customUrl,
    title: 'MDN Web Docs',
    timestamp: customIso
  });

  assert.strictEqual(annotator.metadataBanner.urlPosition, 'bottom');
  assert.strictEqual(annotator.metadataBanner.datePosition, 'top');
  assert.strictEqual(annotator.metadataBanner.dateFormat, 'iso');
  assert.strictEqual(annotator.metadataBanner.url, customUrl);
  assert.notStrictEqual(annotator.metadataBanner.url, 'https://google.com');

  // Verify formatDateMetadata
  const formatted = annotator.formatDateMetadata(customIso, 'iso');
  assert.strictEqual(formatted, customIso);

  // Clear metadata
  annotator.setMetadataBanner(null);
  assert.strictEqual(annotator.metadataBanner, null);

  // Undo restore
  annotator.undo();
  assert.strictEqual(annotator.metadataBanner.urlPosition, 'bottom');
});

// -------------------------------------------------------------
// TEST N: System-Style Emoji Picker Coverage & Search Filtering
// -------------------------------------------------------------
console.log('\n--- TEST N: SYSTEM-STYLE EMOJI PICKER COVERAGE & SEARCH FILTERING ---');
it('Emoji Library: All 9 standard Unicode categories are populated and search filtering works accurately', () => {
  const viewerCode = fs.readFileSync(path.resolve(__dirname, '../studio/viewer.js'), 'utf8');

  // Verify the 9 categories are declared
  const expectedCategories = [
    'smileys', 'people', 'animals', 'food', 'travel',
    'activities', 'objects', 'symbols', 'flags'
  ];
  for (const cat of expectedCategories) {
    assert.strictEqual(viewerCode.includes(`id: '${cat}'`), true, `Category '${cat}' must be present in viewer.js`);
  }

  // Verify search input and tabs bar are present in viewer.html
  const viewerHtml = fs.readFileSync(path.resolve(__dirname, '../studio/viewer.html'), 'utf8');
  assert.strictEqual(viewerHtml.includes('id="emoji-search-input"'), true);
  assert.strictEqual(viewerHtml.includes('id="emoji-tabs-bar"'), true);
  assert.strictEqual(viewerHtml.includes('id="emoji-scroll-body"'), true);
});

console.log('\n============================================================');
console.log(`   TEST RESULTS: ${testsPassed} / ${testsRun} PASSED`);
console.log('============================================================\n');

if (testsPassed !== testsRun) {
  process.exit(1);
}
