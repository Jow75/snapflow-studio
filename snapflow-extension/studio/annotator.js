/**
 * SnapFlow - Studio Annotator Engine (Production Grade)
 *
 * Capabilities:
 * - Deterministic, unbounded Linear History Stack with index pointer (History[0] -> History[N])
 * - Full Undo / Redo reliability (Ctrl+Z, Ctrl+Shift+Z, Cmd+Z, Cmd+Shift+Z)
 * - Vector annotation layer (Rectangle, Ellipse, Line, Arrow, Pen, Highlight, Text, Emoji, Step)
 * - Object selection, bounding box transform, drag moving, handle resizing
 * - Layer order management (Bring to Front, Send to Back, Bring Forward, Send Backward)
 * - Interactive Crop tool with undoable dimension and coordinate recalculation
 * - Canvas Padding / Border tool with background fill
 * - Metadata Banner injection (Browser header mockup, URL bar, Date, Date+Time, ISO timestamp)
 * - Destructive privacy operations (Blur, Pixelate, True Irreversible Redaction) with undoable raster snapshots
 * - Flattened canvas generator for PNG, JPEG, WebP, and multi-page PDF exports
 */

class StudioAnnotator {
  constructor(baseCanvas, overlayCanvas, options = {}) {
    this.baseCanvas = baseCanvas;
    this.overlayCanvas = overlayCanvas;
    this.baseCtx = baseCanvas.getContext('2d');
    this.overlayCtx = overlayCanvas.getContext('2d');

    // Tooling & Style State
    this.currentTool = 'select'; // 'select', 'crop', 'arrow', 'line', 'rect', 'circle', 'highlight', 'pen', 'text', 'emoji', 'step', 'blur', 'pixelate', 'redact'
    this.currentColor = '#ef4444'; // Stroke color
    this.fillColor = '#3b82f6';
    this.fillEnabled = false;
    this.fillOpacity = 0.25;
    this.strokeWidth = 4;
    this.fontSize = 20;
    this.stepCounter = 1;
    this.activeEmoji = '🔥';

    // Annotation Collection & Selection
    this.annotations = [];
    this.selectedId = null;
    this.hoverHandle = null;

    // Interaction State
    this.isDrawing = false;
    this.isDraggingObject = false;
    this.isResizingHandle = null; // 'nw', 'ne', 'se', 'sw', 'start', 'end'
    this.dragStartPos = null;
    this.dragInitialBounds = null;
    this.hasMovedDuringDrag = false;

    this.startX = 0;
    this.startY = 0;
    this.currentPath = [];

    // Interactive Crop Marquee: { x, y, width, height }
    this.cropMarquee = null;
    this.cropHandle = null;
    this.isDraggingCrop = false;
    this.cropDragStart = null;

    // Metadata Banner: { enabled, style: 'browser'|'url'|'datetime'|'iso', position: 'top'|'bottom', url, title, timestamp }
    this.metadataBanner = null;

    // Padding State: { size: number, color: string }
    this.padding = { size: 0, color: '#0f172a' };

    // Centralized History Model: Linear stack with index pointer
    this.history = [];
    this.historyIndex = -1;
    this.maxHistory = 150;

    // Callbacks
    this.onHistoryChange = options.onHistoryChange || (() => {});
    this.onSelectionChange = options.onSelectionChange || (() => {});

    // Inline text editor element
    this.textEditorEl = null;

    // Initialize baseline History[0]
    this.initHistory();
    this.initEventListeners();
  }

  // =========================================================================
  // 1. DETERMINISTIC HISTORY MODEL
  // =========================================================================

  /**
   * Clones a canvas into an independent offscreen canvas snapshot.
   */
  cloneCanvas(sourceCanvas) {
    const clone = document.createElement('canvas');
    clone.width = sourceCanvas.width;
    clone.height = sourceCanvas.height;
    const ctx = clone.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    return clone;
  }

  /**
   * Initializes History[0] with the un-annotated baseline canvas.
   */
  initHistory() {
    const initialRaster = this.cloneCanvas(this.baseCanvas);
    const initialState = {
      rasterSnapshot: initialRaster,
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
      annotations: [],
      metadataBanner: null,
      padding: { size: 0, color: '#0f172a' }
    };

    this.history = [initialState];
    this.historyIndex = 0;
    this.notifyHistoryChange();
  }

  /**
   * Records a history checkpoint.
   * If isRasterMutation is false, rasterSnapshot is null (zero pixel copy overhead!).
   */
  pushHistory(isRasterMutation = false) {
    // 1. Invalidate forward redo branch
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    // 2. Build snapshot
    const checkpoint = {
      rasterSnapshot: isRasterMutation ? this.cloneCanvas(this.baseCanvas) : null,
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
      annotations: JSON.parse(JSON.stringify(this.annotations)),
      metadataBanner: this.metadataBanner ? JSON.parse(JSON.stringify(this.metadataBanner)) : null,
      padding: { ...this.padding }
    };

    this.history.push(checkpoint);

    // 3. Limit history buffer if exceeding maxHistory
    if (this.history.length > this.maxHistory) {
      const dropped = this.history.shift();
      // Ensure the new oldest entry maintains a raster reference
      if (this.history[0] && !this.history[0].rasterSnapshot && dropped.rasterSnapshot) {
        this.history[0].rasterSnapshot = dropped.rasterSnapshot;
      }
    }
    this.historyIndex = this.history.length - 1;

    this.notifyHistoryChange();
  }

  /**
   * Reverts to the previous history state (History[N] -> History[N-1]).
   */
  undo() {
    if (this.historyIndex <= 0) return false;
    this.historyIndex--;
    this.applyHistoryState(this.history[this.historyIndex]);
    this.notifyHistoryChange();
    return true;
  }

  /**
   * Restores the next history state (History[N] -> History[N+1]).
   */
  redo() {
    if (this.historyIndex >= this.history.length - 1) return false;
    this.historyIndex++;
    this.applyHistoryState(this.history[this.historyIndex]);
    this.notifyHistoryChange();
    return true;
  }

  /**
   * Applies a specific history state to the editor canvases.
   */
  applyHistoryState(state) {
    if (!state) return;

    // 1. Locate nearest raster snapshot at or before this state
    let raster = state.rasterSnapshot;
    if (!raster) {
      for (let i = this.historyIndex; i >= 0; i--) {
        if (this.history[i] && this.history[i].rasterSnapshot) {
          raster = this.history[i].rasterSnapshot;
          break;
        }
      }
    }

    // 2. Restore raster canvas dimensions and image
    if (raster) {
      this.baseCanvas.width = state.width;
      this.baseCanvas.height = state.height;
      this.overlayCanvas.width = state.width;
      this.overlayCanvas.height = state.height;

      this.baseCtx.clearRect(0, 0, state.width, state.height);
      this.baseCtx.drawImage(raster, 0, 0);
    }

    // 3. Restore vector annotations and options
    this.annotations = JSON.parse(JSON.stringify(state.annotations));
    this.metadataBanner = state.metadataBanner ? JSON.parse(JSON.stringify(state.metadataBanner)) : null;
    this.padding = { ...state.padding };
    this.selectedId = null;

    if (this.textEditorEl) {
      this.textEditorEl.remove();
      this.textEditorEl = null;
    }

    this.renderOverlay();
    this.onSelectionChange(null);
  }

  /**
   * Permanently clears undo and redo history stacks.
   */
  purgeHistory() {
    const currentState = {
      rasterSnapshot: this.cloneCanvas(this.baseCanvas),
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
      annotations: JSON.parse(JSON.stringify(this.annotations)),
      metadataBanner: this.metadataBanner ? JSON.parse(JSON.stringify(this.metadataBanner)) : null,
      padding: { ...this.padding }
    };
    this.history = [currentState];
    this.historyIndex = 0;
    this.notifyHistoryChange();
  }

  notifyHistoryChange() {
    this.onHistoryChange({
      canUndo: this.historyIndex > 0,
      canRedo: this.historyIndex < this.history.length - 1,
      historyIndex: this.historyIndex,
      historyLength: this.history.length
    });
  }

  // =========================================================================
  // 2. TOOL & CONFIGURATION SETTERS
  // =========================================================================

  setTool(tool) {
    this.currentTool = tool;
    this.overlayCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';

    if (tool !== 'select') {
      this.selectedId = null;
      this.onSelectionChange(null);
    }

    if (tool !== 'crop' && this.cropMarquee) {
      this.cropMarquee = null;
      this.renderOverlay();
    }
  }

  setColor(color) {
    this.currentColor = color;
    if (this.selectedId) {
      const ann = this.getAnnotationById(this.selectedId);
      if (ann) {
        ann.strokeColor = color;
        ann.color = color;
        this.pushHistory(false);
        this.renderOverlay();
      }
    }
  }

  setFillColor(color) {
    this.fillColor = color;
    if (this.selectedId) {
      const ann = this.getAnnotationById(this.selectedId);
      if (ann) {
        ann.fillColor = color;
        this.pushHistory(false);
        this.renderOverlay();
      }
    }
  }

  setFillEnabled(enabled) {
    this.fillEnabled = !!enabled;
    if (this.selectedId) {
      const ann = this.getAnnotationById(this.selectedId);
      if (ann) {
        ann.fillEnabled = this.fillEnabled;
        this.pushHistory(false);
        this.renderOverlay();
      }
    }
  }

  setStrokeWidth(width) {
    this.strokeWidth = parseInt(width, 10) || 4;
    if (this.selectedId) {
      const ann = this.getAnnotationById(this.selectedId);
      if (ann) {
        ann.strokeWidth = this.strokeWidth;
        this.pushHistory(false);
        this.renderOverlay();
      }
    }
  }

  setFontSize(size) {
    this.fontSize = parseInt(size, 10) || 20;
    if (this.selectedId) {
      const ann = this.getAnnotationById(this.selectedId);
      if (ann && ann.type === 'text') {
        ann.fontSize = this.fontSize;
        this.pushHistory(false);
        this.renderOverlay();
      }
    }
  }

  setActiveEmoji(emoji) {
    this.activeEmoji = emoji || '🔥';
  }

  // =========================================================================
  // 3. EVENT LISTENERS & SHORTCUTS
  // =========================================================================

  initEventListeners() {
    this.overlayCanvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.overlayCanvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      // Allow native undo inside input and textarea
      const activeTag = document.activeElement ? document.activeElement.tagName.toUpperCase() : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }

      // Undo: Ctrl+Z / Cmd+Z (without shift)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        this.undo();
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y
      if (
        ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && e.shiftKey) ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y'))
      ) {
        e.preventDefault();
        this.redo();
        return;
      }

      // Delete selected annotation: Delete / Backspace
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedId) {
          e.preventDefault();
          this.deleteSelected();
        }
      }

      // Escape: cancel crop or deselect
      if (e.key === 'Escape') {
        if (this.cropMarquee) {
          this.cropMarquee = null;
          this.renderOverlay();
        } else if (this.selectedId) {
          this.selectedId = null;
          this.onSelectionChange(null);
          this.renderOverlay();
        }
      }

      // Enter: commit crop
      if (e.key === 'Enter') {
        if (this.currentTool === 'crop' && this.cropMarquee) {
          e.preventDefault();
          this.commitCrop();
        }
      }

      // Layer shortcuts: [ (backward), ] (forward)
      if (this.selectedId) {
        if (e.key === '[') {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) this.sendToBack();
          else this.sendBackward();
        } else if (e.key === ']') {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) this.bringToFront();
          else this.bringForward();
        }
      }
    });
  }

  getCanvasCoords(e) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const scaleX = this.overlayCanvas.width / rect.width;
    const scaleY = this.overlayCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  generateId() {
    return 'ann_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  getAnnotationById(id) {
    return this.annotations.find((a) => a.id === id);
  }

  // =========================================================================
  // 4. MOUSE INTERACTIONS (DRAW, SELECT, MOVE, RESIZE)
  // =========================================================================

  onMouseDown(e) {
    if (e.button !== 0) return; // Left button only
    const coords = this.getCanvasCoords(e);
    this.startX = coords.x;
    this.startY = coords.y;

    // A. SELECT TOOL MODE
    if (this.currentTool === 'select') {
      // 1. Check if clicking on a transform handle of currently selected element
      if (this.selectedId) {
        const selected = this.getAnnotationById(this.selectedId);
        if (selected) {
          const handle = this.getHandleAtCoords(selected, coords);
          if (handle) {
            this.isResizingHandle = handle;
            this.dragStartPos = coords;
            this.dragInitialBounds = this.cloneAnnotationBounds(selected);
            return;
          }
        }
      }

      // 2. Check if clicking an annotation (top-down z-index)
      const hit = this.hitTestAnnotation(coords);
      if (hit) {
        this.selectedId = hit.id;
        this.isDraggingObject = true;
        this.dragStartPos = coords;
        this.dragInitialBounds = this.cloneAnnotationBounds(hit);
        this.hasMovedDuringDrag = false;
        this.onSelectionChange(hit);
        this.renderOverlay();
        return;
      } else {
        // Deselect
        if (this.selectedId) {
          this.selectedId = null;
          this.onSelectionChange(null);
          this.renderOverlay();
        }
        return;
      }
    }

    // B. CROP TOOL MODE
    if (this.currentTool === 'crop') {
      if (this.cropMarquee) {
        const handle = this.getCropHandleAtCoords(coords);
        if (handle) {
          this.cropHandle = handle;
          this.isDraggingCrop = true;
          this.cropDragStart = coords;
          return;
        } else if (
          coords.x >= this.cropMarquee.x &&
          coords.x <= this.cropMarquee.x + this.cropMarquee.width &&
          coords.y >= this.cropMarquee.y &&
          coords.y <= this.cropMarquee.y + this.cropMarquee.height
        ) {
          this.cropHandle = 'move';
          this.isDraggingCrop = true;
          this.cropDragStart = coords;
          return;
        }
      }
      // Start fresh crop marquee
      this.isDrawing = true;
      this.cropMarquee = { x: coords.x, y: coords.y, width: 0, height: 0 };
      return;
    }

    // C. VECTOR ANNOTATION DRAWING
    this.isDrawing = true;

    if (this.currentTool === 'pen') {
      this.currentPath = [{ x: coords.x, y: coords.y }];
    } else if (this.currentTool === 'text') {
      this.isDrawing = false;
      this.createInlineTextEditor(coords.x, coords.y);
    } else if (this.currentTool === 'emoji') {
      this.isDrawing = false;
      const emojiAnn = {
        id: this.generateId(),
        type: 'emoji',
        x: coords.x,
        y: coords.y,
        emoji: this.activeEmoji || '🔥',
        size: 48
      };
      this.annotations.push(emojiAnn);
      this.selectedId = emojiAnn.id;
      this.onSelectionChange(emojiAnn);
      this.pushHistory(false);
      this.renderOverlay();
    } else if (this.currentTool === 'step') {
      this.isDrawing = false;
      const stepAnn = {
        id: this.generateId(),
        type: 'step',
        x: coords.x,
        y: coords.y,
        stepNumber: this.stepCounter++,
        color: this.currentColor
      };
      this.annotations.push(stepAnn);
      this.selectedId = stepAnn.id;
      this.onSelectionChange(stepAnn);
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  onMouseMove(e) {
    const coords = this.getCanvasCoords(e);

    // 1. Resizing selected object handle
    if (this.isResizingHandle && this.selectedId) {
      const selected = this.getAnnotationById(this.selectedId);
      if (selected && this.dragInitialBounds) {
        this.applyHandleResize(selected, this.isResizingHandle, coords);
        this.hasMovedDuringDrag = true;
        this.renderOverlay();
      }
      return;
    }

    // 2. Dragging selected object
    if (this.isDraggingObject && this.selectedId) {
      const selected = this.getAnnotationById(this.selectedId);
      if (selected && this.dragStartPos && this.dragInitialBounds) {
        const dx = coords.x - this.dragStartPos.x;
        const dy = coords.y - this.dragStartPos.y;
        this.applyObjectMove(selected, this.dragInitialBounds, dx, dy);
        this.hasMovedDuringDrag = true;
        this.renderOverlay();
      }
      return;
    }

    // 3. Dragging / Resizing crop box
    if (this.isDraggingCrop && this.cropMarquee && this.cropDragStart) {
      const dx = coords.x - this.cropDragStart.x;
      const dy = coords.y - this.cropDragStart.y;
      this.applyCropTransform(this.cropHandle, dx, dy);
      this.cropDragStart = coords;
      this.renderOverlay();
      return;
    }

    // 4. Drawing new annotation preview
    if (this.isDrawing) {
      if (this.currentTool === 'pen') {
        this.currentPath.push({ x: coords.x, y: coords.y });
      } else if (this.currentTool === 'crop') {
        this.cropMarquee = {
          x: Math.min(this.startX, coords.x),
          y: Math.min(this.startY, coords.y),
          width: Math.abs(coords.x - this.startX),
          height: Math.abs(coords.y - this.startY)
        };
      }
      this.renderOverlay(coords);
      return;
    }

    // 5. Update Hover Cursors in select mode
    if (this.currentTool === 'select') {
      this.updateSelectCursor(coords);
    }
  }

  onMouseUp(e) {
    const coords = this.getCanvasCoords(e);

    // 1. Finished resizing handle or dragging object
    if (this.isResizingHandle || this.isDraggingObject) {
      if (this.hasMovedDuringDrag) {
        this.pushHistory(false);
      }
      this.isResizingHandle = null;
      this.isDraggingObject = false;
      this.dragStartPos = null;
      this.dragInitialBounds = null;
      this.hasMovedDuringDrag = false;
      this.renderOverlay();
      return;
    }

    // 2. Finished crop drag
    if (this.isDraggingCrop) {
      this.isDraggingCrop = false;
      this.cropHandle = null;
      this.cropDragStart = null;
      this.renderOverlay();
      return;
    }

    if (!this.isDrawing) return;
    this.isDrawing = false;

    // Minimum drag threshold
    const width = coords.x - this.startX;
    const height = coords.y - this.startY;
    if (Math.abs(width) < 3 && Math.abs(height) < 3 && this.currentTool !== 'pen') {
      return;
    }

    // 3. Destructive base canvas operations (Blur, Pixelate, Redact)
    if (this.currentTool === 'redact' || this.currentTool === 'blur' || this.currentTool === 'pixelate') {
      const rx = Math.min(this.startX, coords.x);
      const ry = Math.min(this.startY, coords.y);
      const rw = Math.abs(width);
      const rh = Math.abs(height);

      if (this.currentTool === 'redact') {
        this.applyDestructiveRedaction(rx, ry, rw, rh);
      } else if (this.currentTool === 'blur') {
        this.applyBlur(rx, ry, rw, rh);
      } else if (this.currentTool === 'pixelate') {
        this.applyPixelate(rx, ry, rw, rh);
      }

      this.pushHistory(true); // Raster mutation checkpoint
      this.renderOverlay();
      return;
    }

    // 4. Crop marquee creation
    if (this.currentTool === 'crop') {
      this.cropMarquee = {
        x: Math.min(this.startX, coords.x),
        y: Math.min(this.startY, coords.y),
        width: Math.abs(width),
        height: Math.abs(height)
      };
      this.renderOverlay();
      return;
    }

    // 5. Vector Annotations
    let newAnn = null;

    if (this.currentTool === 'pen') {
      newAnn = {
        id: this.generateId(),
        type: 'pen',
        points: [...this.currentPath],
        strokeColor: this.currentColor,
        strokeWidth: this.strokeWidth
      };
      this.currentPath = [];
    } else {
      newAnn = {
        id: this.generateId(),
        type: this.currentTool,
        startX: this.startX,
        startY: this.startY,
        endX: coords.x,
        endY: coords.y,
        strokeColor: this.currentColor,
        strokeWidth: this.strokeWidth,
        fillColor: this.fillColor,
        fillEnabled: this.fillEnabled,
        fillOpacity: this.fillOpacity
      };
    }

    if (newAnn) {
      this.annotations.push(newAnn);
      this.selectedId = newAnn.id;
      this.onSelectionChange(newAnn);
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  onDoubleClick(e) {
    if (this.currentTool !== 'select') return;
    const coords = this.getCanvasCoords(e);
    const hit = this.hitTestAnnotation(coords);

    if (hit && hit.type === 'text') {
      this.editInlineText(hit);
    }
  }

  // =========================================================================
  // 5. INLINE TEXT EDITOR
  // =========================================================================

  createInlineTextEditor(x, y) {
    if (this.textEditorEl) this.textEditorEl.remove();

    const rect = this.overlayCanvas.getBoundingClientRect();
    const scaleX = rect.width / this.overlayCanvas.width;
    const scaleY = rect.height / this.overlayCanvas.height;

    const screenX = rect.left + x * scaleX;
    const screenY = rect.top + y * scaleY;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'studio-inline-text-input';
    input.placeholder = 'Type text here...';
    input.style.position = 'fixed';
    input.style.left = `${screenX}px`;
    input.style.top = `${screenY}px`;
    input.style.zIndex = '1000';
    input.style.color = this.currentColor;
    input.style.fontSize = `${Math.max(14, this.fontSize * scaleX)}px`;

    document.body.appendChild(input);
    input.focus();
    this.textEditorEl = input;

    const finalize = () => {
      const text = input.value.trim();
      input.remove();
      this.textEditorEl = null;

      if (text) {
        const textAnn = {
          id: this.generateId(),
          type: 'text',
          x: x,
          y: y,
          text: text,
          fontSize: this.fontSize,
          color: this.currentColor
        };
        this.annotations.push(textAnn);
        this.selectedId = textAnn.id;
        this.onSelectionChange(textAnn);
        this.pushHistory(false);
        this.renderOverlay();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        finalize();
      } else if (e.key === 'Escape') {
        input.remove();
        this.textEditorEl = null;
      }
    });

    input.addEventListener('blur', finalize);
  }

  editInlineText(textAnn) {
    if (this.textEditorEl) this.textEditorEl.remove();

    const rect = this.overlayCanvas.getBoundingClientRect();
    const scaleX = rect.width / this.overlayCanvas.width;
    const scaleY = rect.height / this.overlayCanvas.height;

    const screenX = rect.left + textAnn.x * scaleX;
    const screenY = rect.top + (textAnn.y - textAnn.fontSize) * scaleY;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'studio-inline-text-input';
    input.value = textAnn.text;
    input.style.position = 'fixed';
    input.style.left = `${screenX}px`;
    input.style.top = `${screenY}px`;
    input.style.zIndex = '1000';
    input.style.color = textAnn.color || this.currentColor;
    input.style.fontSize = `${Math.max(14, (textAnn.fontSize || 20) * scaleX)}px`;

    document.body.appendChild(input);
    input.select();
    this.textEditorEl = input;

    const finalize = () => {
      const newText = input.value.trim();
      input.remove();
      this.textEditorEl = null;

      if (newText && newText !== textAnn.text) {
        textAnn.text = newText;
        this.pushHistory(false);
        this.renderOverlay();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finalize();
      else if (e.key === 'Escape') {
        input.remove();
        this.textEditorEl = null;
      }
    });

    input.addEventListener('blur', finalize);
  }

  // =========================================================================
  // 6. OBJECT GEOMETRY, HIT TESTING, TRANSFORM & HANDLES
  // =========================================================================

  getAnnotationBounds(ann) {
    if (ann.type === 'pen') {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of ann.points || []) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX - 4, y: minY - 4, width: (maxX - minX) + 8, height: (maxY - minY) + 8 };
    }

    if (ann.type === 'text') {
      const fs = ann.fontSize || 20;
      const width = (ann.text.length * fs * 0.6) + 12;
      return { x: ann.x - 6, y: ann.y - fs - 4, width: width, height: fs + 12 };
    }

    if (ann.type === 'emoji') {
      const size = ann.size || 48;
      return { x: ann.x - size / 2, y: ann.y - size / 2, width: size, height: size };
    }

    if (ann.type === 'step') {
      const r = 16;
      return { x: ann.x - r, y: ann.y - r, width: r * 2, height: r * 2 };
    }

    // Shapes: rect, circle, line, arrow, highlight
    const minX = Math.min(ann.startX, ann.endX);
    const minY = Math.min(ann.startY, ann.endY);
    const width = Math.abs(ann.endX - ann.startX);
    const height = Math.abs(ann.endY - ann.startY);
    return { x: minX, y: minY, width, height };
  }

  cloneAnnotationBounds(ann) {
    if (ann.type === 'pen') {
      return { points: ann.points.map((p) => ({ ...p })) };
    }
    if (ann.type === 'text' || ann.type === 'step' || ann.type === 'emoji') {
      return { x: ann.x, y: ann.y, size: ann.size, fontSize: ann.fontSize };
    }
    return {
      startX: ann.startX,
      startY: ann.startY,
      endX: ann.endX,
      endY: ann.endY
    };
  }

  hitTestAnnotation(coords) {
    // Iterate in reverse (top-most z-index checked first)
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const ann = this.annotations[i];
      const bounds = this.getAnnotationBounds(ann);
      const pad = 8;
      if (
        coords.x >= bounds.x - pad &&
        coords.x <= bounds.x + bounds.width + pad &&
        coords.y >= bounds.y - pad &&
        coords.y <= bounds.y + bounds.height + pad
      ) {
        return ann;
      }
    }
    return null;
  }

  getHandleAtCoords(ann, coords) {
    const handleSize = 10;

    // Arrow / Line handles: 'start' tail and 'end' head
    if (ann.type === 'arrow' || ann.type === 'line') {
      if (Math.hypot(coords.x - ann.startX, coords.y - ann.startY) <= handleSize) return 'start';
      if (Math.hypot(coords.x - ann.endX, coords.y - ann.endY) <= handleSize) return 'end';
      return null;
    }

    // Emoji handles: 'scale' at bottom-right
    if (ann.type === 'emoji') {
      const bounds = this.getAnnotationBounds(ann);
      if (Math.hypot(coords.x - (bounds.x + bounds.width), coords.y - (bounds.y + bounds.height)) <= handleSize) {
        return 'scale';
      }
      return null;
    }

    // Rectangular bounds: 4 corners ('nw', 'ne', 'se', 'sw')
    const b = this.getAnnotationBounds(ann);
    if (Math.hypot(coords.x - b.x, coords.y - b.y) <= handleSize) return 'nw';
    if (Math.hypot(coords.x - (b.x + b.width), coords.y - b.y) <= handleSize) return 'ne';
    if (Math.hypot(coords.x - (b.x + b.width), coords.y - (b.y + b.height)) <= handleSize) return 'se';
    if (Math.hypot(coords.x - b.x, coords.y - (b.y + b.height)) <= handleSize) return 'sw';

    return null;
  }

  applyObjectMove(ann, initial, dx, dy) {
    if (ann.type === 'pen') {
      ann.points = initial.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (ann.type === 'text' || ann.type === 'step' || ann.type === 'emoji') {
      ann.x = initial.x + dx;
      ann.y = initial.y + dy;
    } else {
      ann.startX = initial.startX + dx;
      ann.startY = initial.startY + dy;
      ann.endX = initial.endX + dx;
      ann.endY = initial.endY + dy;
    }
  }

  applyHandleResize(ann, handle, coords) {
    if (ann.type === 'arrow' || ann.type === 'line') {
      if (handle === 'start') {
        ann.startX = coords.x;
        ann.startY = coords.y;
      } else if (handle === 'end') {
        ann.endX = coords.x;
        ann.endY = coords.y;
      }
      return;
    }

    if (ann.type === 'emoji') {
      if (handle === 'scale') {
        const newSize = Math.max(20, Math.hypot(coords.x - ann.x, coords.y - ann.y) * 1.5);
        ann.size = Math.round(newSize);
      }
      return;
    }

    // Rectangle / Circle / Highlight corners
    if (handle === 'nw') {
      ann.startX = coords.x;
      ann.startY = coords.y;
    } else if (handle === 'ne') {
      ann.endX = coords.x;
      ann.startY = coords.y;
    } else if (handle === 'se') {
      ann.endX = coords.x;
      ann.endY = coords.y;
    } else if (handle === 'sw') {
      ann.startX = coords.x;
      ann.endY = coords.y;
    }
  }

  updateSelectCursor(coords) {
    if (this.selectedId) {
      const selected = this.getAnnotationById(this.selectedId);
      if (selected) {
        const handle = this.getHandleAtCoords(selected, coords);
        if (handle === 'nw' || handle === 'se') {
          this.overlayCanvas.style.cursor = 'nwse-resize';
          return;
        } else if (handle === 'ne' || handle === 'sw') {
          this.overlayCanvas.style.cursor = 'nesw-resize';
          return;
        } else if (handle === 'start' || handle === 'end' || handle === 'scale') {
          this.overlayCanvas.style.cursor = 'pointer';
          return;
        }
      }
    }

    const hit = this.hitTestAnnotation(coords);
    if (hit) {
      this.overlayCanvas.style.cursor = 'move';
    } else {
      this.overlayCanvas.style.cursor = 'default';
    }
  }

  // =========================================================================
  // 7. LAYER MANAGEMENT
  // =========================================================================

  bringToFront() {
    if (!this.selectedId) return;
    const idx = this.annotations.findIndex((a) => a.id === this.selectedId);
    if (idx !== -1 && idx < this.annotations.length - 1) {
      const item = this.annotations.splice(idx, 1)[0];
      this.annotations.push(item);
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  sendToBack() {
    if (!this.selectedId) return;
    const idx = this.annotations.findIndex((a) => a.id === this.selectedId);
    if (idx > 0) {
      const item = this.annotations.splice(idx, 1)[0];
      this.annotations.unshift(item);
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  bringForward() {
    if (!this.selectedId) return;
    const idx = this.annotations.findIndex((a) => a.id === this.selectedId);
    if (idx !== -1 && idx < this.annotations.length - 1) {
      const temp = this.annotations[idx];
      this.annotations[idx] = this.annotations[idx + 1];
      this.annotations[idx + 1] = temp;
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  sendBackward() {
    if (!this.selectedId) return;
    const idx = this.annotations.findIndex((a) => a.id === this.selectedId);
    if (idx > 0) {
      const temp = this.annotations[idx];
      this.annotations[idx] = this.annotations[idx - 1];
      this.annotations[idx - 1] = temp;
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const idx = this.annotations.findIndex((a) => a.id === this.selectedId);
    if (idx !== -1) {
      this.annotations.splice(idx, 1);
      this.selectedId = null;
      this.onSelectionChange(null);
      this.pushHistory(false);
      this.renderOverlay();
    }
  }

  // =========================================================================
  // 8. INTERACTIVE CROP ENGINE
  // =========================================================================

  getCropHandleAtCoords(coords) {
    if (!this.cropMarquee) return null;
    const hs = 12;
    const m = this.cropMarquee;
    if (Math.hypot(coords.x - m.x, coords.y - m.y) <= hs) return 'nw';
    if (Math.hypot(coords.x - (m.x + m.width), coords.y - m.y) <= hs) return 'ne';
    if (Math.hypot(coords.x - (m.x + m.width), coords.y - (m.y + m.height)) <= hs) return 'se';
    if (Math.hypot(coords.x - m.x, coords.y - (m.y + m.height)) <= hs) return 'sw';
    return null;
  }

  applyCropTransform(handle, dx, dy) {
    const m = this.cropMarquee;
    if (handle === 'move') {
      m.x = Math.max(0, Math.min(this.baseCanvas.width - m.width, m.x + dx));
      m.y = Math.max(0, Math.min(this.baseCanvas.height - m.height, m.y + dy));
    } else if (handle === 'nw') {
      m.x += dx;
      m.y += dy;
      m.width -= dx;
      m.height -= dy;
    } else if (handle === 'ne') {
      m.y += dy;
      m.width += dx;
      m.height -= dy;
    } else if (handle === 'se') {
      m.width += dx;
      m.height += dy;
    } else if (handle === 'sw') {
      m.x += dx;
      m.width -= dx;
      m.height += dy;
    }

    if (m.width < 20) m.width = 20;
    if (m.height < 20) m.height = 20;
  }

  commitCrop() {
    if (!this.cropMarquee) return false;
    let { x, y, width, height } = this.cropMarquee;
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    width = Math.min(this.baseCanvas.width - x, Math.round(width));
    height = Math.min(this.baseCanvas.height - y, Math.round(height));

    if (width < 20 || height < 20) return false;

    // 1. Create cropped base canvas
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(this.baseCanvas, x, y, width, height, 0, 0, width, height);

    // 2. Update base and overlay canvas dimensions
    this.baseCanvas.width = width;
    this.baseCanvas.height = height;
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;

    this.baseCtx.drawImage(croppedCanvas, 0, 0);

    // 3. Offset vector annotations by (-x, -y)
    for (const ann of this.annotations) {
      if (ann.x !== undefined) ann.x -= x;
      if (ann.y !== undefined) ann.y -= y;
      if (ann.startX !== undefined) ann.startX -= x;
      if (ann.startY !== undefined) ann.startY -= y;
      if (ann.endX !== undefined) ann.endX -= x;
      if (ann.endY !== undefined) ann.endY -= y;
      if (ann.points) {
        ann.points.forEach((p) => {
          p.x -= x;
          p.y -= y;
        });
      }
    }

    this.cropMarquee = null;
    this.pushHistory(true); // Raster mutation checkpoint
    this.renderOverlay();
    return true;
  }

  cancelCrop() {
    this.cropMarquee = null;
    this.renderOverlay();
  }

  // =========================================================================
  // 9. PADDING & BORDER ENGINE
  // =========================================================================

  applyPadding(padPx, bgColor = '#0f172a') {
    const pad = Math.max(0, parseInt(padPx, 10) || 0);
    if (pad === 0 && this.padding.size === 0) return;

    const delta = pad - this.padding.size;
    if (delta === 0) {
      this.padding.color = bgColor;
      this.pushHistory(true);
      this.renderOverlay();
      return;
    }

    const newW = this.baseCanvas.width + delta * 2;
    const newH = this.baseCanvas.height + delta * 2;

    const paddedCanvas = document.createElement('canvas');
    paddedCanvas.width = newW;
    paddedCanvas.height = newH;
    const pCtx = paddedCanvas.getContext('2d');

    // Fill background
    pCtx.fillStyle = bgColor;
    pCtx.fillRect(0, 0, newW, newH);

    // Draw previous base image centered
    pCtx.drawImage(this.baseCanvas, delta, delta);

    // Update active canvases
    this.baseCanvas.width = newW;
    this.baseCanvas.height = newH;
    this.overlayCanvas.width = newW;
    this.overlayCanvas.height = newH;

    this.baseCtx.drawImage(paddedCanvas, 0, 0);

    // Shift annotations by delta
    for (const ann of this.annotations) {
      if (ann.x !== undefined) ann.x += delta;
      if (ann.y !== undefined) ann.y += delta;
      if (ann.startX !== undefined) ann.startX += delta;
      if (ann.startY !== undefined) ann.startY += delta;
      if (ann.endX !== undefined) ann.endX += delta;
      if (ann.endY !== undefined) ann.endY += delta;
      if (ann.points) {
        ann.points.forEach((p) => {
          p.x += delta;
          p.y += delta;
        });
      }
    }

    this.padding = { size: pad, color: bgColor };
    this.pushHistory(true);
    this.renderOverlay();
  }

  // =========================================================================
  // =========================================================================
  // 10. METADATA BANNER INJECTION (INDEPENDENT URL, DATE, TIME, BROWSER HEADER)
  // =========================================================================

  setMetadataBanner(config) {
    if (!config || !config.enabled) {
      this.metadataBanner = null;
    } else {
      const style = config.style || (config.urlPosition ? 'banner' : 'browser');
      const urlPosition = config.urlPosition || (style === 'url' ? (config.position || 'top') : (style === 'browser' ? 'top' : 'none'));
      const datePosition = config.datePosition || ((style === 'datetime' || style === 'iso' || style === 'date') ? (config.position || 'bottom') : 'none');
      const dateFormat = config.dateFormat || (style === 'iso' ? 'iso' : (style === 'date' ? 'date' : (style === 'datetime' ? 'datetime' : 'none')));

      this.metadataBanner = {
        enabled: true,
        style: style,
        position: config.position || (urlPosition === 'top' || style === 'browser' ? 'top' : 'bottom'),
        urlPosition: urlPosition,
        datePosition: datePosition,
        dateFormat: dateFormat,
        url: config.url || '',
        title: config.title || 'Web Capture',
        timestamp: config.timestamp || new Date().toISOString()
      };
    }
    this.pushHistory(false);
    this.renderOverlay();
  }

  formatDateMetadata(timestamp, format) {
    if (!format || format === 'none') return '';
    const dateObj = new Date(timestamp || Date.now());
    if (format === 'date') {
      return dateObj.toLocaleDateString();
    } else if (format === 'datetime') {
      return dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
    } else if (format === 'iso') {
      return typeof timestamp === 'string' && timestamp.includes('T') ? timestamp : dateObj.toISOString();
    }
    return dateObj.toLocaleString();
  }

  truncateText(ctx, text, maxWidth) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 4 && ctx.measureText(truncated + '...').width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + '...';
  }

  drawMetadataBanner(ctx, targetWidth = null, targetHeight = null, topZoneH = 0, bottomZoneH = 0) {
    if (!this.metadataBanner) return;
    const { style, urlPosition, datePosition, dateFormat, url, title, timestamp } = this.metadataBanner;
    const w = targetWidth || this.overlayCanvas.width;
    const totalH = targetHeight || this.overlayCanvas.height;

    ctx.save();

    // A. Browser Window Mockup (Top)
    if (style === 'browser') {
      const bannerH = 44;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, w, bannerH);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, bannerH);
      ctx.lineTo(w, bannerH);
      ctx.stroke();

      // Traffic light buttons
      const btnY = bannerH / 2;
      const dots = [
        { x: 18, color: '#ef4444' }, // Red
        { x: 34, color: '#f59e0b' }, // Yellow
        { x: 50, color: '#10b981' }  // Green
      ];
      dots.forEach((d) => {
        ctx.beginPath();
        ctx.arc(d.x, btnY, 5, 0, Math.PI * 2);
        ctx.fillStyle = d.color;
        ctx.fill();
      });

      // Browser URL pill
      const pillW = Math.max(100, Math.min(680, w - 160));
      const pillX = Math.max(70, (w - pillW) / 2);
      const pillH = 26;
      const pillY = (bannerH - pillH) / 2;

      ctx.fillStyle = '#0f172a';
      this.roundRect(ctx, pillX, pillY, pillW, pillH, 6);
      ctx.fill();

      // Lock icon & URL text
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const cleanUrl = this.truncateText(ctx, url || 'https://snapflowstudio.app', pillW - 36);
      ctx.fillText(`🔒  ${cleanUrl}`, pillX + 12, pillY + pillH / 2);
      ctx.restore();
      return;
    }

    // B. Independent URL and Date Banners
    const formattedDate = this.formatDateMetadata(timestamp, dateFormat);
    const hasUrl = urlPosition && urlPosition !== 'none' && url;
    const hasDate = datePosition && datePosition !== 'none' && formattedDate;

    const bannerH = 34;

    // Helper to draw a single header or footer row
    const drawRow = (y, leftText, rightText, iconLeft = '🔗', iconRight = '📅') => {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      ctx.fillRect(0, y, w, bannerH);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y === 0 ? bannerH : y);
      ctx.lineTo(w, y === 0 ? bannerH : y);
      ctx.stroke();

      const centerY = y + bannerH / 2;
      ctx.textBaseline = 'middle';

      if (leftText && rightText) {
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'left';
        const truncatedLeft = this.truncateText(ctx, `${iconLeft} ${leftText}`, w * 0.6);
        ctx.fillText(truncatedLeft, 14, centerY);

        ctx.font = '500 11px -apple-system, monospace';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'right';
        const truncatedRight = this.truncateText(ctx, `${iconRight} ${rightText}`, w * 0.35);
        ctx.fillText(truncatedRight, w - 14, centerY);
      } else if (leftText) {
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'left';
        const truncated = this.truncateText(ctx, `${iconLeft} ${leftText}`, w - 28);
        ctx.fillText(truncated, 14, centerY);
      } else if (rightText) {
        ctx.font = '500 12px -apple-system, monospace';
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'left';
        const truncated = this.truncateText(ctx, `${iconRight} ${rightText}`, w - 28);
        ctx.fillText(truncated, 14, centerY);
      }
    };

    // Case 1: Both on Top
    if (urlPosition === 'top' && datePosition === 'top') {
      drawRow(0, url, formattedDate, '🔗', dateFormat === 'iso' ? '⏱️' : '📅');
    }
    // Case 2: Both on Bottom
    else if (urlPosition === 'bottom' && datePosition === 'bottom') {
      const bY = bottomZoneH > 0 ? totalH - bottomZoneH : totalH - bannerH;
      drawRow(bY, url, formattedDate, '🔗', dateFormat === 'iso' ? '⏱️' : '📅');
    }
    // Case 3: URL on Top, Date on Bottom
    else if (urlPosition === 'top' && datePosition === 'bottom') {
      drawRow(0, url, null, '🔗', '');
      const bY = bottomZoneH > 0 ? totalH - bottomZoneH : totalH - bannerH;
      drawRow(bY, null, formattedDate, '', dateFormat === 'iso' ? '⏱️' : '📅');
    }
    // Case 4: Date on Top, URL on Bottom
    else if (datePosition === 'top' && urlPosition === 'bottom') {
      drawRow(0, null, formattedDate, '', dateFormat === 'iso' ? '⏱️' : '📅');
      const bY = bottomZoneH > 0 ? totalH - bottomZoneH : totalH - bannerH;
      drawRow(bY, url, null, '🔗', '');
    }
    // Case 5: Only URL
    else if (hasUrl) {
      const y = urlPosition === 'top' ? 0 : (bottomZoneH > 0 ? totalH - bottomZoneH : totalH - bannerH);
      drawRow(y, url, null, '🔗', '');
    }
    // Case 6: Only Date
    else if (hasDate) {
      const y = datePosition === 'top' ? 0 : (bottomZoneH > 0 ? totalH - bottomZoneH : totalH - bannerH);
      drawRow(y, null, formattedDate, '', dateFormat === 'iso' ? '⏱️' : '📅');
    }

    ctx.restore();
  }

  // =========================================================================
  // 11. DESTRUCTIVE PRIVACY TOOLS (BLUR, PIXELATE, REDACTION)
  // =========================================================================

  applyDestructiveRedaction(x, y, w, h) {
    this.baseCtx.save();
    // Solid opaque black fill
    this.baseCtx.fillStyle = '#000000';
    this.baseCtx.fillRect(x, y, w, h);

    // Inject high-entropy noise to prevent digital edge recovery
    const imgData = this.baseCtx.getImageData(x, y, Math.max(1, w), Math.max(1, h));
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.random() > 0.6) {
        const gray = Math.floor(Math.random() * 30);
        d[i] = gray;
        d[i + 1] = gray;
        d[i + 2] = gray;
      }
    }
    this.baseCtx.putImageData(imgData, x, y);
    this.baseCtx.restore();
  }

  applyBlur(x, y, w, h) {
    this.baseCtx.save();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(2, Math.floor(w / 12));
    tempCanvas.height = Math.max(2, Math.floor(h / 12));
    const tempCtx = tempCanvas.getContext('2d');

    // Downscale
    tempCtx.drawImage(this.baseCanvas, x, y, w, h, 0, 0, tempCanvas.width, tempCanvas.height);
    // Upscale with smoothing
    this.baseCtx.imageSmoothingEnabled = true;
    this.baseCtx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, w, h);
    this.baseCtx.restore();
  }

  applyPixelate(x, y, w, h) {
    this.baseCtx.save();
    const blockSize = Math.max(10, Math.floor(Math.min(w, h) / 10));
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(1, Math.floor(w / blockSize));
    tempCanvas.height = Math.max(1, Math.floor(h / blockSize));
    const tempCtx = tempCanvas.getContext('2d');

    tempCtx.imageSmoothingEnabled = false;
    this.baseCtx.imageSmoothingEnabled = false;

    // Downsample
    tempCtx.drawImage(this.baseCanvas, x, y, w, h, 0, 0, tempCanvas.width, tempCanvas.height);
    // Upsample without smoothing
    this.baseCtx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, x, y, w, h);
    this.baseCtx.restore();
  }

  // =========================================================================
  // 12. OVERLAY RENDERING & DRAWING
  // =========================================================================

  renderOverlay(activeCoords = null) {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    // 1. Render permanent annotations
    for (const ann of this.annotations) {
      this.drawAnnotation(this.overlayCtx, ann);
    }

    // 2. Render active in-progress drawing preview
    if (this.isDrawing && activeCoords) {
      const activeAnn = {
        type: this.currentTool,
        startX: this.startX,
        startY: this.startY,
        endX: activeCoords.x,
        endY: activeCoords.y,
        strokeColor: this.currentColor,
        strokeWidth: this.strokeWidth,
        fillColor: this.fillColor,
        fillEnabled: this.fillEnabled,
        fillOpacity: this.fillOpacity,
        points: this.currentPath
      };
      this.drawAnnotation(this.overlayCtx, activeAnn, true);
    }

    // 3. Render selection outline and handles if an object is selected
    if (this.selectedId && this.currentTool === 'select') {
      const selected = this.getAnnotationById(this.selectedId);
      if (selected) {
        this.drawSelectionOutline(this.overlayCtx, selected);
      }
    }

    // 4. Render Crop marquee if active
    if (this.cropMarquee) {
      this.drawCropMarquee(this.overlayCtx, this.cropMarquee);
    }

    // 5. Render Metadata Banner if active
    if (this.metadataBanner) {
      this.drawMetadataBanner(this.overlayCtx);
    }
  }

  drawAnnotation(ctx, ann, isPreview = false) {
    ctx.save();
    ctx.strokeStyle = ann.strokeColor || ann.color || this.currentColor;
    ctx.fillStyle = ann.fillColor || ann.color || this.currentColor;
    ctx.lineWidth = ann.strokeWidth || 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (ann.type) {
      case 'arrow':
        this.drawArrow(ctx, ann.startX, ann.startY, ann.endX, ann.endY, ann.strokeWidth);
        break;

      case 'line':
        ctx.beginPath();
        ctx.moveTo(ann.startX, ann.startY);
        ctx.lineTo(ann.endX, ann.endY);
        ctx.stroke();
        break;

      case 'rect': {
        const x = Math.min(ann.startX, ann.endX);
        const y = Math.min(ann.startY, ann.endY);
        const w = Math.abs(ann.endX - ann.startX);
        const h = Math.abs(ann.endY - ann.startY);
        if (ann.fillEnabled && ann.fillColor) {
          ctx.save();
          ctx.fillStyle = this.hexToRgba(ann.fillColor, ann.fillOpacity || 0.25);
          ctx.fillRect(x, y, w, h);
          ctx.restore();
        }
        ctx.strokeRect(x, y, w, h);
        break;
      }

      case 'circle': {
        const rx = Math.abs(ann.endX - ann.startX) / 2;
        const ry = Math.abs(ann.endY - ann.startY) / 2;
        const cx = Math.min(ann.startX, ann.endX) + rx;
        const cy = Math.min(ann.startY, ann.endY) + ry;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (ann.fillEnabled && ann.fillColor) {
          ctx.save();
          ctx.fillStyle = this.hexToRgba(ann.fillColor, ann.fillOpacity || 0.25);
          ctx.fill();
          ctx.restore();
        }
        ctx.stroke();
        break;
      }

      case 'highlight': {
        ctx.fillStyle = this.hexToRgba(ann.color || '#facc15', 0.35);
        ctx.fillRect(
          Math.min(ann.startX, ann.endX),
          Math.min(ann.startY, ann.endY),
          Math.abs(ann.endX - ann.startX),
          Math.abs(ann.endY - ann.startY)
        );
        break;
      }

      case 'pen': {
        if (ann.points && ann.points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(ann.points[0].x, ann.points[0].y);
          for (let i = 1; i < ann.points.length; i++) {
            ctx.lineTo(ann.points[i].x, ann.points[i].y);
          }
          ctx.stroke();
        }
        break;
      }

      case 'text': {
        const fs = ann.fontSize || 20;
        ctx.font = `bold ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const metrics = ctx.measureText(ann.text);
        const pad = 6;
        // Background pill
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        this.roundRect(
          ctx,
          ann.x - pad,
          ann.y - fs - pad / 2,
          metrics.width + pad * 2,
          fs + pad * 1.5,
          4
        );
        ctx.fill();
        ctx.fillStyle = ann.color || ann.strokeColor || '#ffffff';
        ctx.fillText(ann.text, ann.x, ann.y);
        break;
      }

      case 'emoji': {
        const size = ann.size || 48;
        ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ann.emoji, ann.x, ann.y);
        break;
      }

      case 'step': {
        const r = 16;
        ctx.beginPath();
        ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2);
        ctx.fillStyle = ann.color || '#ef4444';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 13px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ann.stepNumber), ann.x, ann.y);
        break;
      }

      case 'redact':
      case 'blur':
      case 'pixelate':
        if (isPreview) {
          ctx.fillStyle = ann.type === 'redact' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(56, 189, 248, 0.3)';
          ctx.fillRect(
            Math.min(ann.startX, ann.endX),
            Math.min(ann.startY, ann.endY),
            Math.abs(ann.endX - ann.startX),
            Math.abs(ann.endY - ann.startY)
          );
          ctx.strokeRect(
            Math.min(ann.startX, ann.endX),
            Math.min(ann.startY, ann.endY),
            Math.abs(ann.endX - ann.startX),
            Math.abs(ann.endY - ann.startY)
          );
        }
        break;
    }

    ctx.restore();
  }

  drawArrow(ctx, x1, y1, x2, y2, strokeWidth = 4) {
    const headLen = Math.max(16, strokeWidth * 3.5);
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  drawSelectionOutline(ctx, ann) {
    ctx.save();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    if (ann.type === 'arrow' || ann.type === 'line') {
      // Draw endpoint handles
      ctx.setLineDash([]);
      this.drawHandle(ctx, ann.startX, ann.startY);
      this.drawHandle(ctx, ann.endX, ann.endY);
    } else {
      const b = this.getAnnotationBounds(ann);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.setLineDash([]);

      if (ann.type === 'emoji') {
        this.drawHandle(ctx, b.x + b.width, b.y + b.height);
      } else {
        this.drawHandle(ctx, b.x, b.y);
        this.drawHandle(ctx, b.x + b.width, b.y);
        this.drawHandle(ctx, b.x + b.width, b.y + b.height);
        this.drawHandle(ctx, b.x, b.y + b.height);
      }
    }
    ctx.restore();
  }

  drawHandle(ctx, x, y) {
    const s = 8;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.strokeRect(x - s / 2, y - s / 2, s, s);
  }

  drawCropMarquee(ctx, crop) {
    // Darken exterior
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, this.overlayCanvas.width, crop.y);
    ctx.fillRect(0, crop.y + crop.height, this.overlayCanvas.width, this.overlayCanvas.height - (crop.y + crop.height));
    ctx.fillRect(0, crop.y, crop.x, crop.height);
    ctx.fillRect(crop.x + crop.width, crop.y, this.overlayCanvas.width - (crop.x + crop.width), crop.height);

    // Border
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    ctx.setLineDash([]);

    // Corner handle blocks
    const hs = 10;
    ctx.fillStyle = '#6366f1';
    [
      [crop.x - hs / 2, crop.y - hs / 2],
      [crop.x + crop.width - hs / 2, crop.y - hs / 2],
      [crop.x - hs / 2, crop.y + crop.height - hs / 2],
      [crop.x + crop.width - hs / 2, crop.y + crop.height - hs / 2]
    ].forEach(([hx, hy]) => {
      ctx.fillRect(hx, hy, hs, hs);
    });

    // Confirmation pill
    ctx.fillStyle = '#0f172a';
    this.roundRect(ctx, crop.x, Math.max(8, crop.y - 28), 240, 24, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillText('Press Enter to Apply • Esc to Cancel', crop.x + 8, Math.max(24, crop.y - 12));
  }

  // =========================================================================
  // 13. UTILITIES & FLATTENED EXPORT PIPELINE
  // =========================================================================

  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  hexToRgba(hex, alpha = 1) {
    if (!hex || hex === 'transparent') return 'transparent';
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Generates a single flattened canvas combining base canvas + metadata banner + vector annotations.
   * Ensures metadata banners do not obscure underlying screenshot pixels.
   * Feeds directly into PNG, JPEG, WebP, and Multi-Page PDF Exporters.
   */
  getFlattenedCanvas() {
    const flat = document.createElement('canvas');
    let topH = 0;
    let bottomH = 0;

    if (this.metadataBanner) {
      if (this.metadataBanner.style === 'browser') {
        topH = 44;
      } else {
        if (this.metadataBanner.urlPosition === 'top' || this.metadataBanner.datePosition === 'top') {
          topH = 34;
        }
        if (this.metadataBanner.urlPosition === 'bottom' || this.metadataBanner.datePosition === 'bottom') {
          bottomH = 34;
        }
      }
    }

    flat.width = this.baseCanvas.width;
    flat.height = this.baseCanvas.height + topH + bottomH;
    const ctx = flat.getContext('2d');

    // 1. Draw base raster image offset by topH so content is never covered
    ctx.drawImage(this.baseCanvas, 0, topH);

    // 2. Draw vector annotations in exact layer order offset by topH
    ctx.save();
    ctx.translate(0, topH);
    for (const ann of this.annotations) {
      this.drawAnnotation(ctx, ann);
    }
    ctx.restore();

    // 3. Draw Metadata Banners in designated header and footer zones
    if (this.metadataBanner) {
      this.drawMetadataBanner(ctx, flat.width, flat.height, topH, bottomH);
    }

    return flat;
  }
}

// Module export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StudioAnnotator;
} else if (typeof globalThis !== 'undefined') {
  globalThis.StudioAnnotator = StudioAnnotator;
}
