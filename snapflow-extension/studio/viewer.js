/**
 * SnapFlow - Studio Viewer Controller (Production Grade)
 *
 * Coordinates:
 * - IndexedDB capture record loading and multi-slice stitching
 * - StudioAnnotator lifecycle with unbounded deterministic undo/redo
 * - Pan and zoom viewport navigation (mouse wheel, spacebar drag, dropdown presets)
 * - Complete suite of editing tools: Selection, Crop, Arrow, Line, Rect, Circle, Highlight, Pen, Text, Emoji, Step, Blur, Pixelate, Redact
 * - Interactive Crop confirmation pill and layer ordering controls
 * - Metadata header/footer injection (Browser window mockup, URL bar, Date/Time, ISO)
 * - Canvas padding & border custom background color tool
 * - Export pipeline: 1-Click Clipboard, PNG, JPEG, WebP, and PDF with explicit page layout
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM References
  const baseCanvas = document.getElementById('base-canvas');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const canvasWrapper = document.getElementById('canvas-wrapper');
  const viewportContainer = document.getElementById('viewport-container');

  const docTitle = document.getElementById('doc-title');
  const docDims = document.getElementById('doc-dims');
  const docSize = document.getElementById('doc-size');

  // Zoom controls
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomLevel = document.getElementById('btn-zoom-level');
  const btnZoomFitWidth = document.getElementById('btn-zoom-fit-width');
  const btnZoomFitScreen = document.getElementById('btn-zoom-fit-screen');
  const btnZoom100 = document.getElementById('btn-zoom-100');
  const zoomDropdown = document.getElementById('zoom-dropdown');

  // History controls
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnPurgeHistory = document.getElementById('btn-purge-history');

  // Metadata & Padding Dropdowns
  const btnMetadataMenu = document.getElementById('btn-metadata-menu');
  const metadataDropdown = document.getElementById('metadata-dropdown');
  const btnPaddingMenu = document.getElementById('btn-padding-menu');
  const paddingDropdown = document.getElementById('padding-dropdown');
  const paddingColorInput = document.getElementById('padding-color-input');

  // Export buttons
  const btnCopyClipboard = document.getElementById('btn-copy-clipboard');
  const btnExportPng = document.getElementById('btn-export-png');
  const btnExportJpeg = document.getElementById('btn-export-jpeg');
  const btnExportWebp = document.getElementById('btn-export-webp');
  const btnExportPdf = document.getElementById('btn-export-pdf');

  // Modals, Popovers & Toasts
  const toast = document.getElementById('toast');
  const pdfModal = document.getElementById('pdf-modal');
  const btnClosePdfModal = document.getElementById('btn-close-pdf-modal');
  const btnPdfCancel = document.getElementById('btn-pdf-cancel');
  const btnPdfConfirm = document.getElementById('btn-pdf-confirm');
  const pdfPageSize = document.getElementById('pdf-page-size');
  const pdfOrientation = document.getElementById('pdf-orientation');
  const pdfLayout = document.getElementById('pdf-layout');
  const pdfMargin = document.getElementById('pdf-margin');
  const pdfSummary = document.getElementById('pdf-summary');
  const captureNotices = document.getElementById('capture-notices');

  // Toolbar & Inspector Controls
  const toolButtons = document.querySelectorAll('.floating-toolbar .tool-btn');
  const toolColor = document.getElementById('tool-color');
  const toolStrokeWidth = document.getElementById('tool-stroke-width');
  const toolFontSize = document.getElementById('tool-font-size');
  const btnFillToggle = document.getElementById('btn-fill-toggle');
  const toolFillColor = document.getElementById('tool-fill-color');
  const layerControls = document.getElementById('layer-controls');
  const btnLayerFront = document.getElementById('btn-layer-front');
  const btnLayerForward = document.getElementById('btn-layer-forward');
  const btnLayerBackward = document.getElementById('btn-layer-backward');
  const btnLayerBack = document.getElementById('btn-layer-back');
  const btnDeleteSelected = document.getElementById('btn-delete-selected');

  // Emoji Popover
  const btnEmojiTool = document.getElementById('btn-emoji-tool');
  const emojiPopover = document.getElementById('emoji-popover');
  const btnCloseEmojiPicker = document.getElementById('btn-close-emoji-picker');
  const emojiSearchInput = document.getElementById('emoji-search-input');
  const emojiTabsBar = document.getElementById('emoji-tabs-bar');
  const emojiResultsContainer = document.getElementById('emoji-results-container');

  // Crop Action Bar
  const cropActionBar = document.getElementById('crop-action-bar');
  const btnCropConfirm = document.getElementById('btn-crop-confirm');
  const btnCropCancel = document.getElementById('btn-crop-cancel');

  let annotator = null;
  let zoom = 1.0;
  let captureRecord = null;
  let activePadding = 0;

  // 1. Capture notices (shown beside the image, never drawn into it)
  function showNotices(messages) {
    captureNotices.textContent = '';
    if (!messages.length) {
      captureNotices.classList.add('hidden');
      return;
    }
    for (const message of messages) {
      const item = document.createElement('div');
      item.className = 'capture-notice';
      const text = document.createElement('span');
      text.textContent = message;
      const dismiss = document.createElement('button');
      dismiss.className = 'icon-btn-sm';
      dismiss.title = 'Dismiss';
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => {
        item.remove();
        if (!captureNotices.childElementCount) captureNotices.classList.add('hidden');
      });
      item.append(text, dismiss);
      captureNotices.appendChild(item);
    }
    captureNotices.classList.remove('hidden');
  }

  function drawOntoBase(source) {
    baseCanvas.width = source.width;
    baseCanvas.height = source.height;
    if (baseCanvas.width !== source.width || baseCanvas.height !== source.height) {
      throw new Error(`The browser could not allocate a ${source.width} × ${source.height} px canvas.`);
    }
    baseCanvas.getContext('2d').drawImage(source, 0, 0);
  }

  // 2. Load & Render Capture
  const urlParams = new URLSearchParams(window.location.search);
  const captureId = urlParams.get('id');

  try {
    if (!captureId) {
      console.log('[SnapFlow Studio] No captureId provided, initializing demo canvas.');
      captureRecord = {
        title: 'Demo Webpage Capture',
        url: 'https://snapflow-studio-app.netlify.app/',
        mode: 'visible'
      };
      docTitle.textContent = captureRecord.title;
      document.title = `${captureRecord.title} - SnapFlow Studio`;

      baseCanvas.width = 1200;
      baseCanvas.height = 800;
      const ctx = baseCanvas.getContext('2d');

      // Draw high-aesthetic webpage mockup
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1200, 800);

      // Hero banner
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 1200, 70);
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 20px -apple-system, sans-serif';
      ctx.fillText('SnapFlow Cloud Platform', 40, 42);

      // Card 1
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(60, 120, 500, 280);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(60, 120, 500, 280);
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.fillText('System Architecture & Metrics', 90, 170);
      ctx.font = '15px -apple-system, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('Private client-side processing pipeline active.', 90, 210);
      ctx.fillText('Full Manifest V3 security discipline verified.', 90, 240);

      // Card 2
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(640, 120, 500, 280);
      ctx.strokeRect(640, 120, 500, 280);
      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.fillText('Capture Engine Metrics', 670, 170);
      ctx.font = '15px -apple-system, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText('High-DPI DPR 2.0 Normalization: ACTIVE', 670, 210);
      ctx.fillText('Smart Whitespace Splitting: READY', 670, 240);

      // Footer bar
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(0, 720, 1200, 80);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillText('© 2026 SnapFlow Studio • Local & Private Workspace', 420, 765);
    } else {
      captureRecord = await CaptureStore.getCapture(captureId);
      if (!captureRecord) {
        throw new Error('Capture record not found in local database.');
      }
      if (captureRecord.format !== 2) {
        throw new Error('This capture was made with an older version of SnapFlow. Please capture the page again.');
      }

      const title = captureRecord.title || 'Webpage Capture';
      document.title = `${captureRecord.title || 'Capture'} - SnapFlow Studio`;
      const notices = (captureRecord.warnings || []).slice();

      if (captureRecord.mode === 'full' || captureRecord.mode === 'element') {
        // Frames are decoded one at a time and released, so memory stays flat on long pages.
        const stitched = await ScrollStitcher.composeFrames(captureRecord.frames, captureRecord.plan, {
          loadFrameImage: async (index) => {
            const blob = await CaptureStore.getFrame(captureRecord.id, index);
            if (!blob) throw new Error('A captured frame is missing from local storage.');
            return createImageBitmap(blob);
          },
          releaseFrameImage: (bitmap) => bitmap.close(),
          onProgress: (done, total) => {
            docTitle.textContent = `Stitching frame ${done} of ${total}…`;
          }
        });
        drawOntoBase(stitched.canvas);
        stitched.canvas.width = 0; // release the intermediate buffer

        if (stitched.shrink < 1) {
          notices.unshift(
            `At full resolution this capture is ${stitched.nativeWidth.toLocaleString()} × ${stitched.nativeHeight.toLocaleString()} px, ` +
            `more than the browser can hold in one image. It was scaled to ${Math.round(stitched.shrink * 100)}% so nothing is cut off.`
          );
        }
      } else if (captureRecord.mode === 'visible' || captureRecord.mode === 'selected') {
        const img = await ScrollStitcher.loadImage(captureRecord.rawImage);
        if (captureRecord.mode === 'selected' && captureRecord.cropCss) {
          // The selection was drawn in CSS pixels; map it onto the bitmap's pixels.
          const viewport = captureRecord.viewport || {};
          const k = ScrollStitcher.resolveScale(viewport.dpr, img.width, viewport.vw);
          const crop = captureRecord.cropCss;
          drawOntoBase(ScrollStitcher.cropToCanvas(img, {
            x: crop.x * k,
            y: crop.y * k,
            width: crop.w * k,
            height: crop.h * k
          }));
        } else {
          drawOntoBase(img);
        }
      } else {
        throw new Error('Unknown capture type: ' + captureRecord.mode);
      }

      docTitle.textContent = title;
      showNotices(notices);
    }

    // Match overlay dimensions
    overlayCanvas.width = baseCanvas.width;
    overlayCanvas.height = baseCanvas.height;

    // Update metadata info
    updateDocDimensions();

    // Initialize Annotator with history and selection callbacks
    annotator = new StudioAnnotator(baseCanvas, overlayCanvas, {
      onHistoryChange: ({ canUndo, canRedo }) => {
        if (btnUndo) btnUndo.disabled = !canUndo;
        if (btnRedo) btnRedo.disabled = !canRedo;
        updateDocDimensions();
      },
      onSelectionChange: (selected) => {
        if (selected) {
          layerControls.classList.remove('hidden');
          if (selected.strokeColor) toolColor.value = selected.strokeColor;
          if (selected.strokeWidth) toolStrokeWidth.value = String(selected.strokeWidth);
          if (selected.fontSize) toolFontSize.value = String(selected.fontSize);
        } else {
          layerControls.classList.add('hidden');
        }
      }
    });

    // Auto fit to width on initial load
    fitToWidth();

  } catch (err) {
    console.error('[SnapFlow Studio] Error loading capture:', err);
    docTitle.textContent = 'Error: ' + err.message;
    return;
  }

  function updateDocDimensions() {
    docDims.textContent = `${baseCanvas.width} × ${baseCanvas.height} px`;
    const estimatedKb = Math.round((baseCanvas.width * baseCanvas.height * 4) / 1024);
    docSize.textContent = `${estimatedKb > 1024 ? (estimatedKb / 1024).toFixed(1) + ' MB' : estimatedKb + ' KB'}`;
  }

  // 3. Zoom & Pan Viewport Logic
  function applyZoom(newZoom) {
    zoom = Math.max(0.1, Math.min(newZoom, 4.0));
    canvasWrapper.style.transform = `scale(${zoom})`;
    btnZoomLevel.textContent = `${Math.round(zoom * 100)}%`;
    zoomDropdown.classList.add('hidden');
  }

  function fitToWidth() {
    if (!baseCanvas.width) return;
    const availableWidth = viewportContainer.clientWidth - 80;
    applyZoom(availableWidth / baseCanvas.width);
  }

  function fitToScreen() {
    if (!baseCanvas.width || !baseCanvas.height) return;
    const availW = viewportContainer.clientWidth - 80;
    const availH = viewportContainer.clientHeight - 80;
    const scaleW = availW / baseCanvas.width;
    const scaleH = availH / baseCanvas.height;
    applyZoom(Math.min(scaleW, scaleH));
  }

  btnZoomIn.addEventListener('click', () => applyZoom(zoom + 0.15));
  btnZoomOut.addEventListener('click', () => applyZoom(zoom - 0.15));
  btnZoom100.addEventListener('click', () => applyZoom(1.0));
  btnZoomFitWidth.addEventListener('click', fitToWidth);
  btnZoomFitScreen.addEventListener('click', fitToScreen);

  // Zoom Dropdown presets
  btnZoomLevel.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomDropdown.classList.toggle('hidden');
  });

  document.querySelectorAll('.zoom-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const z = parseFloat(btn.getAttribute('data-zoom'));
      applyZoom(z);
    });
  });

  // Mouse wheel zoom (Ctrl + Wheel)
  viewportContainer.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      applyZoom(zoom + delta);
    }
  }, { passive: false });

  // Spacebar pan navigation
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let scrollStartX = 0, scrollStartY = 0;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') {
      viewportContainer.classList.add('panning');
      overlayCanvas.style.pointerEvents = 'none';
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      viewportContainer.classList.remove('panning');
      overlayCanvas.style.pointerEvents = 'auto';
      isPanning = false;
    }
  });

  viewportContainer.addEventListener('mousedown', (e) => {
    if (viewportContainer.classList.contains('panning') || e.button === 1) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = viewportContainer.scrollLeft;
      scrollStartY = viewportContainer.scrollTop;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (isPanning) {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      viewportContainer.scrollLeft = scrollStartX - dx;
      viewportContainer.scrollTop = scrollStartY - dy;
    }
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
  });

  // 4. Toolbar & Tool Selection
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      toolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tool = btn.getAttribute('data-tool');

      if (annotator) annotator.setTool(tool);

      // Crop pill display
      if (tool === 'crop') {
        cropActionBar.classList.remove('hidden');
      } else {
        cropActionBar.classList.add('hidden');
      }

      // Close emoji popover if opening another tool
      if (tool !== 'emoji') {
        emojiPopover.classList.add('hidden');
      }
    });
  });

  // Tool Style Properties
  toolColor.addEventListener('input', (e) => {
    if (annotator) annotator.setColor(e.target.value);
  });

  toolStrokeWidth.addEventListener('change', (e) => {
    if (annotator) annotator.setStrokeWidth(e.target.value);
  });

  toolFontSize.addEventListener('change', (e) => {
    if (annotator) annotator.setFontSize(e.target.value);
  });

  // Fill Toggle
  btnFillToggle.addEventListener('click', () => {
    const isNowActive = btnFillToggle.classList.toggle('active');
    toolFillColor.style.display = isNowActive ? 'block' : 'none';
    if (annotator) annotator.setFillEnabled(isNowActive);
  });

  toolFillColor.addEventListener('input', (e) => {
    if (annotator) annotator.setFillColor(e.target.value);
  });

  // Layer & Selection Actions
  btnLayerFront.addEventListener('click', () => {
    if (annotator) annotator.bringToFront();
  });

  if (btnLayerForward) {
    btnLayerForward.addEventListener('click', () => {
      if (annotator) annotator.bringForward();
    });
  }

  if (btnLayerBackward) {
    btnLayerBackward.addEventListener('click', () => {
      if (annotator) annotator.sendBackward();
    });
  }

  btnLayerBack.addEventListener('click', () => {
    if (annotator) annotator.sendToBack();
  });

  btnDeleteSelected.addEventListener('click', () => {
    if (annotator) annotator.deleteSelected();
  });

  // 5. Crop Actions
  btnCropConfirm.addEventListener('click', () => {
    if (annotator) {
      const ok = annotator.commitCrop();
      if (ok) {
        cropActionBar.classList.add('hidden');
        setActiveTool('select');
        showToast('Canvas cropped successfully!');
      } else {
        showToast('Please drag a valid crop box first.');
      }
    }
  });

  btnCropCancel.addEventListener('click', () => {
    if (annotator) {
      annotator.cancelCrop();
      cropActionBar.classList.add('hidden');
      setActiveTool('select');
    }
  });

  function setActiveTool(toolName) {
    toolButtons.forEach((b) => {
      if (b.getAttribute('data-tool') === toolName) b.classList.add('active');
      else b.classList.remove('active');
    });
    if (annotator) annotator.setTool(toolName);
  }

  // 6. Comprehensive System-Style Emoji & Sticker Library (9 Standard Unicode Categories)
  const EMOJI_CATEGORIES = [
    {
      id: 'smileys',
      name: 'Smileys & Emotion',
      icon: '😀',
      emojis: [
        { char: '😀', name: 'grinning face happy smile' },
        { char: '😃', name: 'grinning big eyes smile' },
        { char: '😄', name: 'grinning smiling eyes' },
        { char: '😁', name: 'beaming smiling eyes' },
        { char: '😆', name: 'laughing squint' },
        { char: '😅', name: 'sweat smile relief' },
        { char: '🤣', name: 'rofl rolling laughing' },
        { char: '😂', name: 'tears of joy laughing' },
        { char: '🙂', name: 'slightly smiling' },
        { char: '🙃', name: 'upside down' },
        { char: '😉', name: 'winking' },
        { char: '😊', name: 'smiling blush' },
        { char: '😇', name: 'angel halo' },
        { char: '🥰', name: 'smiling hearts love' },
        { char: '😍', name: 'heart eyes love' },
        { char: '🤩', name: 'star struck excited' },
        { char: '😘', name: 'face blowing kiss' },
        { char: '😋', name: 'yum delicious savouring' },
        { char: '😛', name: 'tongue out' },
        { char: '😜', name: 'winking tongue playful' },
        { char: '🤪', name: 'zany goofy crazy' },
        { char: '😝', name: 'squinting tongue' },
        { char: '🤗', name: 'hugging face warmth' },
        { char: '🤭', name: 'face with hand over mouth oops' },
        { char: '🤫', name: 'shushing face quiet secret' },
        { char: '🤔', name: 'thinking face hmm wonder' },
        { char: '🤐', name: 'zipper mouth silent' },
        { char: '🤨', name: 'raised eyebrow skeptic' },
        { char: '😐', name: 'neutral face expressionless' },
        { char: '😑', name: 'expressionless blank' },
        { char: '😶', name: 'no mouth quiet' },
        { char: '😏', name: 'smirking sly' },
        { char: '😒', name: 'unamused grumpy' },
        { char: '🙄', name: 'rolling eyes whatever' },
        { char: '😬', name: 'grimacing awkward yikes' },
        { char: '🤥', name: 'lying pinocchio' },
        { char: '😌', name: 'relieved peaceful' },
        { char: '😔', name: 'pensive sad' },
        { char: '😪', name: 'sleepy tear' },
        { char: '🤤', name: 'drooling hungry' },
        { char: '😴', name: 'sleeping zzz' },
        { char: '😷', name: 'medical mask sick' },
        { char: '🤒', name: 'thermometer sick fever' },
        { char: '🤕', name: 'head bandage hurt' },
        { char: '🤢', name: 'nauseated green sick' },
        { char: '🤮', name: 'vomiting puking' },
        { char: '🥵', name: 'hot face sweating' },
        { char: '🥶', name: 'cold face freezing' },
        { char: '🥴', name: 'woozy tipsy' },
        { char: '😵', name: 'dizzy dead eyes' },
        { char: '🤯', name: 'exploding head mind blown' },
        { char: '🤠', name: 'cowboy hat' },
        { char: '🥳', name: 'partying celebration party' },
        { char: '😎', name: 'sunglasses cool' },
        { char: '🤓', name: 'nerd glasses geek' },
        { char: '🧐', name: 'monocle classy inspector' },
        { char: '😕', name: 'confused huh' },
        { char: '😟', name: 'worried concern' },
        { char: '🙁', name: 'frowning sad' },
        { char: '😮', name: 'open mouth wow surprise' },
        { char: '😯', name: 'hushed surprised' },
        { char: '😲', name: 'astonished shocked' },
        { char: '😳', name: 'flushed embarrassed wide eyes' },
        { char: '🥺', name: 'pleading begging please puppy' },
        { char: '😦', name: 'frowning open mouth' },
        { char: '😧', name: 'anguished' },
        { char: '😨', name: 'fearful scared' },
        { char: '😰', name: 'anxious sweat blue' },
        { char: '😥', name: 'sad relieved' },
        { char: '😢', name: 'crying tear' },
        { char: '😭', name: 'loudly crying sobbing' },
        { char: '😱', name: 'screaming fear panic scream' },
        { char: '😖', name: 'confounded frustration' },
        { char: '😣', name: 'persevering struggle' },
        { char: '😞', name: 'disappointed' },
        { char: '😓', name: 'downcast face with sweat' },
        { char: '😩', name: 'weary tired' },
        { char: '😫', name: 'tired exhausted' },
        { char: '🥱', name: 'yawning bored sleep' },
        { char: '😤', name: 'face with steam triumph proud' },
        { char: '😡', name: 'pouting rage angry red' },
        { char: '😠', name: 'angry mad' },
        { char: '🤬', name: 'cursing swearing symbols' },
        { char: '😈', name: 'smiling devil horn purple' },
        { char: '👿', name: 'angry devil demon' },
        { char: '💀', name: 'skull dead skeleton' },
        { char: '💩', name: 'poop poo dung' },
        { char: '🤡', name: 'clown circus' },
        { char: '👻', name: 'ghost spooky halloween' },
        { char: '👽', name: 'alien ufo' },
        { char: '🤖', name: 'robot bot droid' },
        { char: '🎃', name: 'jack o lantern pumpkin halloween' }
      ]
    },
    {
      id: 'people',
      name: 'People & Body',
      icon: '🧑',
      emojis: [
        { char: '👋', name: 'waving hand hello bye' },
        { char: '🤚', name: 'raised back of hand' },
        { char: '🖐️', name: 'hand with fingers splayed' },
        { char: '✋', name: 'raised hand stop high five' },
        { char: '🖖', name: 'vulcan salute spock' },
        { char: '👌', name: 'ok hand perfect' },
        { char: '🤌', name: 'pinched fingers italian chef' },
        { char: '🤏', name: 'pinching hand small little tiny' },
        { char: '✌️', name: 'victory hand peace' },
        { char: '🤞', name: 'crossed fingers luck hope' },
        { char: '🤟', name: 'love you gesture rock' },
        { char: '🤘', name: 'sign of the horns rock metal' },
        { char: '🤙', name: 'call me shaka' },
        { char: '👈', name: 'backhand index pointing left' },
        { char: '👉', name: 'backhand index pointing right' },
        { char: '👆', name: 'backhand index pointing up' },
        { char: '👇', name: 'backhand index pointing down' },
        { char: '☝️', name: 'index pointing up point number 1' },
        { char: '👍', name: 'thumbs up like good yes approve' },
        { char: '👎', name: 'thumbs down dislike bad no' },
        { char: '✊', name: 'raised fist solidarity punch' },
        { char: '👊', name: 'oncoming fist bump brofist' },
        { char: '👏', name: 'clapping hands applause bravo' },
        { char: '🙌', name: 'raising hands celebrate praise' },
        { char: '👐', name: 'open hands' },
        { char: '🤲', name: 'palms up together' },
        { char: '🤝', name: 'handshake deal agreement partner' },
        { char: '🙏', name: 'folded hands pray please thank you' },
        { char: '✍️', name: 'writing hand note pen' },
        { char: '💪', name: 'flexed biceps muscle strong power' },
        { char: '👀', name: 'eyes look see inspect glance' },
        { char: '👁️', name: 'eye vision watch' },
        { char: '🧠', name: 'brain smart think mind' },
        { char: '🧑', name: 'person adult' },
        { char: '👱', name: 'blond person' },
        { char: '👨', name: 'man male' },
        { char: '🧔', name: 'person with beard' },
        { char: '👩', name: 'woman female' },
        { char: '🧓', name: 'older person elder' },
        { char: '👴', name: 'old man grandfather' },
        { char: '👵', name: 'old woman grandmother' },
        { char: '👮', name: 'police officer cop security' },
        { char: '🕵️', name: 'detective spy investigator inspect' },
        { char: '👷', name: 'construction worker build engineer' },
        { char: '🤴', name: 'prince royal king' },
        { char: '👸', name: 'princess royal queen' },
        { char: '🧙', name: 'mage wizard magic witch' },
        { char: '🧚', name: 'fairy magic pixie' },
        { char: '🧛', name: 'vampire dracula' },
        { char: '🦸', name: 'superhero hero marvel' },
        { char: '🦹', name: 'supervillain villain evil' }
      ]
    },
    {
      id: 'animals',
      name: 'Animals & Nature',
      icon: '🐶',
      emojis: [
        { char: '🐶', name: 'dog face puppy pet bark' },
        { char: '🐱', name: 'cat face kitten pet meow' },
        { char: '🐭', name: 'mouse face rodent' },
        { char: '🐹', name: 'hamster face rodent pet' },
        { char: '🐰', name: 'rabbit face bunny easter' },
        { char: '🦊', name: 'fox face sneaky clever' },
        { char: '🐻', name: 'bear face grizzly' },
        { char: '🐼', name: 'panda face bamboo china' },
        { char: '🐨', name: 'koala australia bear' },
        { char: '🐯', name: 'tiger face wild beast' },
        { char: '🦁', name: 'lion face king safari roar' },
        { char: '🐮', name: 'cow face farm moo' },
        { char: '🐷', name: 'pig face farm pork oink' },
        { char: '🐸', name: 'frog face toad ribbit green' },
        { char: '🐵', name: 'monkey face chimp banana' },
        { char: '🐔', name: 'chicken poultry farm hen' },
        { char: '🐧', name: 'penguin bird antarctica cold' },
        { char: '🐦', name: 'bird tweet avian' },
        { char: '🐤', name: 'baby chick' },
        { char: '🦆', name: 'duck quack mallard' },
        { char: '🦅', name: 'eagle raptor bird' },
        { char: '🦉', name: 'owl nocturnal wise' },
        { char: '🦄', name: 'unicorn magic horn fantasy' },
        { char: '🐝', name: 'honeybee insect honey buzz bug' },
        { char: '🐛', name: 'bug caterpillar insect' },
        { char: '🦋', name: 'butterfly insect pretty winged' },
        { char: '🐞', name: 'lady beetle ladybug insect' },
        { char: '🐢', name: 'turtle tortoise slow shell' },
        { char: '🐍', name: 'snake serpent python danger' },
        { char: '🐙', name: 'octopus sea creature kraken tentacles' },
        { char: '🐬', name: 'dolphin ocean mammal sea' },
        { char: '🐳', name: 'spouting whale ocean giant' },
        { char: '🦈', name: 'shark ocean predator danger' },
        { char: '🌲', name: 'evergreen tree pine forest' },
        { char: '🌳', name: 'deciduous tree nature park' },
        { char: '🌴', name: 'palm tree beach tropical island' },
        { char: '🌵', name: 'cactus desert succulent' },
        { char: '🌿', name: 'herb plant green leaf nature' },
        { char: '🍀', name: 'four leaf clover luck lucky irish' },
        { char: '🍁', name: 'maple leaf autumn fall canada' },
        { char: '🌸', name: 'cherry blossom flower sakura pink' },
        { char: '🌹', name: 'rose flower love red romance' },
        { char: '🌻', name: 'sunflower yellow floral summer' },
        { char: '🔥', name: 'fire flame lit hot blaze heat burn' },
        { char: '⚡', name: 'high voltage lightning bolt flash electric thunder' },
        { char: '✨', name: 'sparkles shiny glitter magic star' },
        { char: '⭐', name: 'star gold favorite rating' },
        { char: '🌟', name: 'glowing star sparkle shine' },
        { char: '🌈', name: 'rainbow colorful weather hope' }
      ]
    },
    {
      id: 'food',
      name: 'Food & Drink',
      icon: '🍔',
      emojis: [
        { char: '🍏', name: 'green apple fruit fresh' },
        { char: '🍎', name: 'red apple fruit crisp' },
        { char: '🍐', name: 'pear fruit' },
        { char: '🍊', name: 'tangerine orange citrus' },
        { char: '🍋', name: 'lemon sour citrus yellow' },
        { char: '🍌', name: 'banana fruit monkey yellow' },
        { char: '🍉', name: 'watermelon fruit summer melon' },
        { char: '🍇', name: 'grapes fruit wine purple' },
        { char: '🍓', name: 'strawberry berry red sweet' },
        { char: '🍒', name: 'cherries fruit red twin' },
        { char: '🍑', name: 'peach fruit' },
        { char: '🍍', name: 'pineapple tropical fruit' },
        { char: '🥑', name: 'avocado healthy guacamole' },
        { char: '🌽', name: 'ear of corn maize grain' },
        { char: '🌶️', name: 'hot pepper chili spicy red heat' },
        { char: '🍞', name: 'bread loaf toast bakery' },
        { char: '🥐', name: 'croissant pastry french bakery' },
        { char: '🧀', name: 'cheese wedge swiss dairy yellow' },
        { char: '🍳', name: 'cooking egg breakfast pan fry' },
        { char: '🥓', name: 'bacon meat breakfast crispy' },
        { char: '🍔', name: 'hamburger burger fast food beef bun' },
        { char: '🍟', name: 'french fries chips fast food potato' },
        { char: '🍕', name: 'pizza slice cheese pepperoni crust' },
        { char: '🌭', name: 'hot dog sausage mustard bun' },
        { char: '🥪', name: 'sandwich lunch sub' },
        { char: '🌮', name: 'taco mexican food shell tortilla' },
        { char: '🌯', name: 'burrito mexican wrap tortilla' },
        { char: '🥗', name: 'green salad healthy veggies bowl' },
        { char: '🍝', name: 'spaghetti pasta noodles italian' },
        { char: '🍜', name: 'steaming bowl ramen soup noodles' },
        { char: '🍣', name: 'sushi raw fish rice japanese' },
        { char: '🍱', name: 'bento box lunch japanese' },
        { char: '🍦', name: 'soft ice cream cone dairy summer' },
        { char: '🍰', name: 'shortcake cake dessert sweet birthday' },
        { char: '🎂', name: 'birthday cake celebration candles party' },
        { char: '🍩', name: 'doughnut donut dessert glaze sweet' },
        { char: '🍪', name: 'cookie chocolate chip baked sweet' },
        { char: '🍫', name: 'chocolate bar sweet cacao candy' },
        { char: '🍿', name: 'popcorn movie cinema snack theater' },
        { char: '☕', name: 'hot beverage coffee tea espresso morning cup' },
        { char: '🍵', name: 'teacup without handle green tea matcha' },
        { char: '🧃', name: 'beverage box juice straw box' },
        { char: '🥤', name: 'cup with straw soda drink drink' },
        { char: '🧋', name: 'bubble tea boba milk tea tapioca' },
        { char: '🍺', name: 'beer mug drink alcohol pub bar' },
        { char: '🍻', name: 'clinking beer mugs cheers toast pub party' },
        { char: '🍷', name: 'wine glass red wine drink alcohol vineyard' },
        { char: '🍸', name: 'cocktail glass martini olive drink bar' },
        { char: '🍹', name: 'tropical drink cocktail beach vacation tiki' },
        { char: '🍾', name: 'bottle with popping cork champagne sparkling celebration celebrate' }
      ]
    },
    {
      id: 'travel',
      name: 'Travel & Places',
      icon: '✈️',
      emojis: [
        { char: '🚗', name: 'automobile car vehicle drive commute' },
        { char: '🚕', name: 'taxi cab car transport yellow' },
        { char: '🚙', name: 'sport utility vehicle suv car' },
        { char: '🚌', name: 'bus public transport transit school' },
        { char: '🏎️', name: 'racing car speed race f1 fast' },
        { char: '🚓', name: 'police car siren vehicle cop' },
        { char: '🚑', name: 'ambulance emergency medical hospital siren' },
        { char: '🚒', name: 'fire engine truck emergency rescue' },
        { char: '🚚', name: 'delivery truck cargo logistics transport' },
        { char: '🚛', name: 'articulated lorry semi freight' },
        { char: '🚜', name: 'tractor farm vehicle agricultural' },
        { char: '🛵', name: 'motor scooter moped vespa bike' },
        { char: '🏍️', name: 'motorcycle motorbike bike ride fast' },
        { char: '🚲', name: 'bicycle bike cycle pedals pedal ride' },
        { char: '🚨', name: 'police car light siren warning alert emergency beacon' },
        { char: '🛑', name: 'stop sign octagonal red signal halt' },
        { char: '🚧', name: 'construction sign barrier warning hazard cones' },
        { char: '⛽', name: 'fuel pump gas petrol station diesel' },
        { char: '🚥', name: 'horizontal traffic light signal traffic lights' },
        { char: '🚦', name: 'vertical traffic light signal green red stop' },
        { char: '🚆', name: 'train locomotive railway transit tracks' },
        { char: '🚄', name: 'high-speed train bullet shinkansen fast' },
        { char: '🚇', name: 'metro subway underground transit train' },
        { char: '✈️', name: 'airplane flight travel fly airport holiday' },
        { char: '🛫', name: 'airplane departure takeoff flight fly' },
        { char: '🛬', name: 'airplane arrival landing flight airport' },
        { char: '🚀', name: 'rocket space launch blastoff ship moon star' },
        { char: '🛸', name: 'flying saucer ufo alien extraterrestrial sci-fi' },
        { char: '🚁', name: 'helicopter chopper flight aerial rescue' },
        { char: '⛵', name: 'sailboat yacht ocean wind water lake' },
        { char: '🛳️', name: 'passenger ship cruise liner vessel ocean' },
        { char: '⚓', name: 'anchor navy harbor port nautical boat' },
        { char: '🗺️', name: 'world map geography navigation travel atlas' },
        { char: '🗽', name: 'statue of liberty new york landmark america usa' },
        { char: '🗼', name: 'tokyo tower japan landmark tower red' },
        { char: '🏰', name: 'castle fortress medieval kingdom fortress' },
        { char: '🏟️', name: 'stadium arena sports field venue match' },
        { char: '🏖️', name: 'beach with umbrella summer vacation sand sea' },
        { char: '🏝️', name: 'desert island tropical island palm paradise' },
        { char: '⛰️', name: 'mountain peak summit nature hiking trek' },
        { char: '🏔️', name: 'snow-capped mountain alps nature cold summit' },
        { char: '🏕️', name: 'camping tent campsite outdoor nature wilderness' },
        { char: '🏠', name: 'house home building property residence roof' },
        { char: '🏢', name: 'office building skyscraper company work agency' },
        { char: '🏥', name: 'hospital clinic medical doctor healthcare clinic' }
      ]
    },
    {
      id: 'activities',
      name: 'Activities',
      icon: '⚽',
      emojis: [
        { char: '⚽', name: 'soccer ball football sports match game' },
        { char: '🏀', name: 'basketball sports hoop slam dunk court' },
        { char: '🏈', name: 'american football sports touchdown super bowl' },
        { char: '⚾', name: 'baseball sports strike out ball hit' },
        { char: '🎾', name: 'tennis ball racket court match game' },
        { char: '🏐', name: 'volleyball ball beach sports net court' },
        { char: '🏉', name: 'rugby football sports match scrum' },
        { char: '🥏', name: 'flying disc frisbee park disc sports' },
        { char: '🎱', name: 'pool 8 ball billiards cue game eight' },
        { char: '🏓', name: 'ping pong table tennis paddle sports' },
        { char: '🏸', name: 'badminton racket birdie shuttlecock court' },
        { char: '🥊', name: 'boxing glove sports fight punch jab ring' },
        { char: '🥋', name: 'martial arts uniform karate judo taekwondo black belt' },
        { char: '🛹', name: 'skateboard board skating skate park flip' },
        { char: '🏋️', name: 'person lifting weights gym fitness crossfit workout' },
        { char: '🧘', name: 'person in lotus position yoga meditation zen peace' },
        { char: '🏄', name: 'person surfing wave surfboard surf ocean water' },
        { char: '🏊', name: 'person swimming pool lap swim water athlete' },
        { char: '🧗', name: 'person climbing rock bouldering summit wall climb' },
        { char: '🚴', name: 'person biking cycling bicycle tour ride cyclist' },
        { char: '🏆', name: 'trophy champion win winner cup award 1st first gold' },
        { char: '🥇', name: '1st place medal gold winner champion first award' },
        { char: '🥈', name: '2nd place medal silver second runner up' },
        { char: '🥉', name: '3rd place medal bronze third medal award' },
        { char: '🏅', name: 'sports medal military honor ribbon award win' },
        { char: '🎖️', name: 'military medal medal ribbon army honor' },
        { char: '🎫', name: 'ticket cinema concert admission movie entry' },
        { char: '🎟️', name: 'admission tickets movie raffle event pass' },
        { char: '🎭', name: 'performing arts theater drama comedy tragedy acting' },
        { char: '🎨', name: 'artist palette art painting creative colors brush draw' },
        { char: '🎬', name: 'clapper board movie film action director cut take cinema' },
        { char: '🎤', name: 'microphone sing karaoke music vocal audio speech' },
        { char: '🎧', name: 'headphone audio music listen podcast earphones' },
        { char: '🎼', name: 'musical score notes sheet staff melody song' },
        { char: '🎹', name: 'musical keyboard piano keys synthesizer tune' },
        { char: '🥁', name: 'drum drumsticks rhythm beat percussion' },
        { char: '🎷', name: 'saxophone jazz wind instrument melody brass' },
        { char: '🎺', name: 'trumpet brass fanfar fanfare horns' },
        { char: '🎸', name: 'guitar rock electric acoustic instrument chords' },
        { char: '🎻', name: 'violin strings orchestra classical bow fiddle' },
        { char: '🎲', name: 'game die dice rolling board game casino luck chance' },
        { char: '♟️', name: 'chess pawn game strategy tactics board piece' },
        { char: '🎯', name: 'bullseye target dartboard aim focus goal accuracy hit' },
        { char: '🎳', name: 'bowling strike alley ball pins frame' },
        { char: '🎮', name: 'video game controller joystick gamepad play gamer' }
      ]
    },
    {
      id: 'objects',
      name: 'Objects',
      icon: '💡',
      emojis: [
        { char: '💡', name: 'light bulb idea bright inspiration creative smart' },
        { char: '🔦', name: 'flashlight torch dark beam light search' },
        { char: '📱', name: 'mobile phone smartphone iphone android cell screen' },
        { char: '💻', name: 'laptop computer notebook pc macbook tech code' },
        { char: '🖥️', name: 'desktop computer monitor display screen pc workstation' },
        { char: '🖨️', name: 'printer document print paper office hardware' },
        { char: '⌨️', name: 'keyboard typing keys input computer mechanical' },
        { char: '🖱️', name: 'computer mouse click pointer hardware scroll' },
        { char: '💾', name: 'floppy disk save diskette 3.5 storage retro backup' },
        { char: '💿', name: 'optical disk cd dvd disk optical storage media' },
        { char: '📷', name: 'camera photo snapshot picture photograph lens capture' },
        { char: '📸', name: 'camera with flash snapshot photo picture flash capture' },
        { char: '📹', name: 'video camera recorder film camcorder vlog recording' },
        { char: '🎥', name: 'movie camera film cinema video director shoot' },
        { char: '📺', name: 'television tv screen broadcast monitor video retro' },
        { char: '⏱️', name: 'stopwatch timer clock race precision count' },
        { char: '⏲️', name: 'timer clock countdown kitchen minutes seconds' },
        { char: '⏰', name: 'alarm clock time wake up morning ringing alert' },
        { char: '🕰️', name: 'mantelpiece clock vintage antique hours' },
        { char: '⌛', name: 'hourglass done time sand expired finished over' },
        { char: '⏳', name: 'hourglass not done loading waiting pending sand clock' },
        { char: '📡', name: 'satellite antenna dish radar communication signal broadcast' },
        { char: '🔋', name: 'battery power charge electric energy fuel life' },
        { char: '🔌', name: 'electric plug socket cable adapter power connect' },
        { char: '💸', name: 'money with wings cash dollar flying spending waste wealth' },
        { char: '💵', name: 'dollar banknote cash money paper bill usd funds' },
        { char: '💰', name: 'money bag dollar rich currency treasure gold wealth' },
        { char: '💳', name: 'credit card debit visa mastercard payment swipe bank' },
        { char: '💎', name: 'gem stone diamond jewelry precious crystal valuable brilliant' },
        { char: '⚖️', name: 'balance scale justice law court attorney legal equality' },
        { char: '🧰', name: 'toolbox tools fix repair maintenance kit case' },
        { char: '🔧', name: 'wrench tool fix spanner repair mechanic hardware' },
        { char: '🔨', name: 'hammer tool build construction hit pound nail hardware' },
        { char: '🛠️', name: 'hammer and wrench tools fix repair craft settings build' },
        { char: '⚙️', name: 'gear cog settings options system configure mechanism engine' },
        { char: '🧱', name: 'brick wall building foundation build barrier mortar' },
        { char: '🧲', name: 'magnet attraction magnetic physics polarity pull' },
        { char: '💣', name: 'bomb explosive dynamite danger fuse explosion blast' },
        { char: '🛡️', name: 'shield security defense protection guard safe secure armor' },
        { char: '🔮', name: 'crystal ball magic fortune future clairvoyant psychic' },
        { char: '🩹', name: 'adhesive bandage plaster first aid heal wound patch bandaid' },
        { char: '🩺', name: 'stethoscope doctor medical clinic physician heart health' },
        { char: '💊', name: 'pill capsule medicine pharmacy drug tablet health vitamin' },
        { char: '💉', name: 'syringe injection vaccine needle medical doctor clinic' },
        { char: '🧬', name: 'dna genetics biology science helix evolution medical' },
        { char: '🧪', name: 'test tube chemistry science laboratory experiment research' },
        { char: '🔬', name: 'microscope science laboratory biology research inspect examine' },
        { char: '🔭', name: 'telescope astronomy stars space cosmos optics examine' },
        { char: '🔑', name: 'key security access unlock lock password secret credential' },
        { char: '🗝️', name: 'old key antique vintage mystery access clue lock' },
        { char: '🔒', name: 'locked padlock security closed safe privacy encrypted ssl' },
        { char: '🔓', name: 'unlocked padlock open insecure access released decrypted' },
        { char: '📦', name: 'package parcel cardboard box delivery shipping amazon mail' },
        { char: '🏷️', name: 'label tag price ticket meta category badge' },
        { char: '📜', name: 'scroll parchment ancient paper document history certificate' },
        { char: '📄', name: 'page facing up document paper sheet file text contract' },
        { char: '📑', name: 'bookmark tabs document markers pages tags notes' },
        { char: '📊', name: 'bar chart graph insights stats data metrics growth analysis' },
        { char: '📈', name: 'chart increasing upward trend growth stocks metrics profit bull' },
        { char: '📉', name: 'chart decreasing downward trend loss stats drop bear metrics' },
        { char: '📋', name: 'clipboard document checklist notes test audit task' },
        { char: '📁', name: 'file folder directory documents files archive storage' },
        { char: '📂', name: 'open file folder directory browser view files storage' },
        { char: '📅', name: 'calendar date schedule month event deadline reminder' },
        { char: '📆', name: 'tear-off calendar date appointment day timetable' },
        { char: '📌', name: 'pushpin thumbtack pin location map sticky note important' },
        { char: '📍', name: 'round pushpin pin marker map location gps place point' },
        { char: '📎', name: 'paperclip attach attachment stationery office clip fastener' },
        { char: '📏', name: 'straight ruler measure length distance geometry school tool' },
        { char: '📐', name: 'triangular ruler set square geometry drafting angle measure' },
        { char: '✂️', name: 'scissors cut snip shear trim tool stationery' },
        { char: '🖊️', name: 'pen ballpoint write ink stationery signature document' },
        { char: '🖋️', name: 'fountain pen write luxury ink calligraphy signature letter' },
        { char: '✏️', name: 'pencil write sketch draw graphite stationery edit draft' },
        { char: '🔍', name: 'magnifying glass tilted left search look find zoom inspect examine' },
        { char: '🔎', name: 'magnifying glass tilted right search find look inspect examine' }
      ]
    },
    {
      id: 'symbols',
      name: 'Symbols',
      icon: '🔣',
      emojis: [
        { char: '❤️', name: 'red heart love passion romance favorite like' },
        { char: '🧡', name: 'orange heart warmth affection friendship' },
        { char: '💛', name: 'yellow heart friendship happiness loyalty' },
        { char: '💚', name: 'green heart nature health jealousy env' },
        { char: '💙', name: 'blue heart trust peace loyalty cool' },
        { char: '💜', name: 'purple heart royalty luxury compassion' },
        { char: '🖤', name: 'black heart dark gothic sorrow grief' },
        { char: '🤍', name: 'white heart pure clean peace innocence' },
        { char: '💔', name: 'broken heart heartbreak sad grief dump break' },
        { char: '💯', name: 'hundred points 100 percent perfect full score keep it real' },
        { char: '💢', name: 'anger symbol vein mad pop anime frustration' },
        { char: '💬', name: 'speech balloon bubble talk comment message chat say speak' },
        { char: '🗯️', name: 'right anger bubble mad scream shout outburst' },
        { char: '💭', name: 'thought balloon think dream ponder wonder bubble' },
        { char: '💤', name: 'zzz sleeping sleep tired bore snooze rest' },
        { char: '💮', name: 'white flower excellent stamp well done award' },
        { char: '♨️', name: 'hot springs steam spa bath heat onsen' },
        { char: '🛑', name: 'stop sign red halt octagon' },
        { char: '⛔', name: 'no entry road sign barrier prohibited forbidden' },
        { char: '📛', name: 'name badge tulip kindergarten label tag' },
        { char: '🚫', name: 'prohibited sign no forbidden blocked ban cancel restrict' },
        { char: '⭕', name: 'hollow red circle correct right mark o' },
        { char: '❌', name: 'cross mark x wrong incorrect false cancel failure delete no' },
        { char: '❗', name: 'red exclamation mark punctuation surprise warning attention alert' },
        { char: '❕', name: 'white exclamation mark punctuation alert' },
        { char: '❓', name: 'red question mark punctuation ask inquiry help query what' },
        { char: '❔', name: 'white question mark inquiry ask what' },
        { char: '‼️', name: 'double exclamation mark emphasis shock alert' },
        { char: '⁉️', name: 'exclamation question mark interrobang shock what really' },
        { char: '⚠️', name: 'warning triangle caution alert danger hazard hazard notification' },
        { char: '♻️', name: 'recycling symbol recycle environment green renew eco' },
        { char: '✅', name: 'check mark button green white ok verify success approved done pass' },
        { char: '✔️', name: 'check mark heavy verify tick true ok done' },
        { char: '☑️', name: 'ballot box with check checked box voted form select option' },
        { char: '❎', name: 'cross mark button green box squared x deny false' },
        { char: '🌐', name: 'globe with meridians world earth internet web online network' },
        { char: '💠', name: 'diamond with a dot kawaii cute gem crystal' },
        { char: 'Ⓜ️', name: 'circled m metro subway logo transport mark' },
        { char: 'ℹ️', name: 'information info help guide detail tooltip about notice' },
        { char: '🆗', name: 'ok button agree accept yes good confirm' },
        { char: '🆕', name: 'new button fresh update recent badge' },
        { char: '🆙', name: 'up button upgrade increase raise level' },
        { char: '🆒', name: 'cool button nice stylish modern' },
        { char: '🆓', name: 'free button gratis zero cost complimentary' },
        { char: '🆖', name: 'ng button no good blooper fail bad' },
        { char: '🔢', name: 'input numbers numeric 1234 digits math' },
        { char: '🔣', name: 'input symbols &%# special characters keys' },
        { char: '🔤', name: 'input latin letters abc alphabet text' },
        { char: '▶️', name: 'play button media start resume video audio right arrow' },
        { char: '⏸️', name: 'pause button media hold break wait' },
        { char: '⏹️', name: 'stop button media finish end halt square' },
        { char: '🔄', name: 'counterclockwise arrows sync refresh reload cycle loop repeat' },
        { char: '🔴', name: 'red circle dot record live bullet point color' },
        { char: '🟠', name: 'orange circle dot bullet point color' },
        { char: '🟡', name: 'yellow circle dot bullet point color' },
        { char: '🟢', name: 'green circle dot status online active live bullet' },
        { char: '🔵', name: 'blue circle dot bullet point color info' },
        { char: '🟣', name: 'purple circle dot bullet point color' },
        { char: '⚫', name: 'black circle dot bullet point dark color' },
        { char: '⚪', name: 'white circle dot bullet point light color' },
        { char: '🟥', name: 'red square box block color stop' },
        { char: '🟩', name: 'green square box block color pass' },
        { char: '🟦', name: 'blue square box block color' },
        { char: '🟧', name: 'orange square box block color' },
        { char: '🟨', name: 'yellow square box block color caution' },
        { char: '🟪', name: 'purple square box block color' },
        { char: '⬛', name: 'black large square block dark' },
        { char: '⬜', name: 'white large square block light' }
      ]
    },
    {
      id: 'flags',
      name: 'Flags',
      icon: '🚩',
      emojis: [
        { char: '🚩', name: 'triangular flag post red mark banner marker' },
        { char: '🏁', name: 'chequered flag race finish rally formula 1 winner end' },
        { char: '🎌', name: 'crossed flags celebration japan festival national' },
        { char: '🏴', name: 'black flag waving dark banner pirating' },
        { char: '🏳️', name: 'white flag surrender truce peace yield' },
        { char: '🏳️‍🌈', name: 'rainbow flag pride lgbtq diversity freedom' },
        { char: '🏳️‍⚧️', name: 'transgender flag pride trans identity diversity' },
        { char: '🏴‍☠️', name: 'pirate flag jolly roger skull crossbones buccaneer' },
        { char: '🇺🇸', name: 'flag United States USA America stars and stripes' },
        { char: '🇬🇧', name: 'flag United Kingdom UK Great Britain Union Jack' },
        { char: '🇨🇦', name: 'flag Canada Canadian maple leaf' },
        { char: '🇦🇺', name: 'flag Australia Australian commonwealth' },
        { char: '🇩🇪', name: 'flag Germany German Deutschland' },
        { char: '🇫🇷', name: 'flag France French tricolor' },
        { char: '🇪🇸', name: 'flag Spain Spanish Espana' },
        { char: '🇮🇹', name: 'flag Italy Italian tricolore Italia' },
        { char: '🇯🇵', name: 'flag Japan Japanese sun Nippon' },
        { char: '🇰🇷', name: 'flag South Korea Korean Taegeukgi' },
        { char: '🇨🇳', name: 'flag China Chinese five stars' },
        { char: '🇮🇳', name: 'flag India Indian tricolor Tiranga' },
        { char: '🇧🇷', name: 'flag Brazil Brazilian order progress' },
        { char: '🇲🇽', name: 'flag Mexico Mexican tricolor' },
        { char: '🇳🇱', name: 'flag Netherlands Dutch Holland' },
        { char: '🇸🇪', name: 'flag Sweden Swedish Scandinavian' },
        { char: '🇨🇭', name: 'flag Switzerland Swiss cross red' }
      ]
    }
  ];

  // Recently used emojis state
  let recentEmojis = ['🎯', '🚀', '⭐', '💡', '📌', '✅', '❌', '⚠️', '🔥', '💯', '👍', '👀'];
  try {
    const storedRecent = localStorage.getItem('snapflow_recent_emojis');
    if (storedRecent) {
      const parsed = JSON.parse(storedRecent);
      if (Array.isArray(parsed) && parsed.length) recentEmojis = parsed;
    }
  } catch (_) {}

  let activeEmojiCategory = 'all';

  function handleEmojiSelected(emojiChar) {
    btnEmojiTool.querySelector('span').textContent = emojiChar;
    if (annotator) annotator.setActiveEmoji(emojiChar);

    // Save to recents
    recentEmojis = [emojiChar, ...recentEmojis.filter((e) => e !== emojiChar)].slice(0, 18);
    try {
      localStorage.setItem('snapflow_recent_emojis', JSON.stringify(recentEmojis));
    } catch (_) {}

    emojiPopover.classList.add('hidden');
    setActiveTool('emoji');
    showToast(`Sticker ${emojiChar} active! Click canvas to place.`);
  }

  function createEmojiButton(char, title) {
    const btn = document.createElement('button');
    btn.className = 'emoji-cell';
    btn.textContent = char;
    btn.title = title || char;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleEmojiSelected(char);
    });
    return btn;
  }

  function renderEmojiGrid(categoryFilter = 'all', searchQuery = '') {
    emojiResultsContainer.innerHTML = '';
    const query = searchQuery.trim().toLowerCase();

    // 1. Search Mode: Across all emojis
    if (query) {
      const matchSection = document.createElement('div');
      matchSection.className = 'emoji-category-section';

      const secTitle = document.createElement('div');
      secTitle.className = 'emoji-section-title';
      secTitle.textContent = `Search Results for "${query}"`;
      matchSection.appendChild(secTitle);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';

      let count = 0;
      for (const cat of EMOJI_CATEGORIES) {
        for (const item of cat.emojis) {
          if (item.name.toLowerCase().includes(query) || item.char === query) {
            grid.appendChild(createEmojiButton(item.char, item.name));
            count++;
          }
        }
      }

      if (count === 0) {
        const noMatch = document.createElement('div');
        noMatch.style.padding = '12px 4px';
        noMatch.style.color = '#94a3b8';
        noMatch.style.fontSize = '12px';
        noMatch.textContent = 'No emojis found matching your query.';
        matchSection.appendChild(noMatch);
      } else {
        matchSection.appendChild(grid);
      }

      emojiResultsContainer.appendChild(matchSection);
      return;
    }

    // 2. Recents Only Category
    if (categoryFilter === 'recent') {
      const sec = document.createElement('div');
      sec.className = 'emoji-category-section';
      const secTitle = document.createElement('div');
      secTitle.className = 'emoji-section-title';
      secTitle.textContent = 'Recently Used';
      sec.appendChild(secTitle);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      recentEmojis.forEach((char) => {
        grid.appendChild(createEmojiButton(char, 'Recent sticker'));
      });
      sec.appendChild(grid);
      emojiResultsContainer.appendChild(sec);
      return;
    }

    // 3. Category View or "All"
    const categoriesToRender = categoryFilter === 'all'
      ? EMOJI_CATEGORIES
      : EMOJI_CATEGORIES.filter((c) => c.id === categoryFilter);

    // If 'all', also show recents at top
    if (categoryFilter === 'all' && recentEmojis.length > 0) {
      const recSec = document.createElement('div');
      recSec.className = 'emoji-category-section';
      const recTitle = document.createElement('div');
      recTitle.className = 'emoji-section-title';
      recTitle.textContent = 'Recently Used';
      recSec.appendChild(recTitle);

      const recGrid = document.createElement('div');
      recGrid.className = 'emoji-grid';
      recentEmojis.slice(0, 12).forEach((char) => {
        recGrid.appendChild(createEmojiButton(char, 'Recent sticker'));
      });
      recSec.appendChild(recGrid);
      emojiResultsContainer.appendChild(recSec);
    }

    categoriesToRender.forEach((cat) => {
      const sec = document.createElement('div');
      sec.className = 'emoji-category-section';

      const secTitle = document.createElement('div');
      secTitle.className = 'emoji-section-title';
      secTitle.textContent = `${cat.icon} ${cat.name}`;
      sec.appendChild(secTitle);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      cat.emojis.forEach((item) => {
        grid.appendChild(createEmojiButton(item.char, item.name));
      });
      sec.appendChild(grid);

      emojiResultsContainer.appendChild(sec);
    });
  }

  // Initial render of emojis
  renderEmojiGrid('all', '');

  // Tab switching
  if (emojiTabsBar) {
    emojiTabsBar.querySelectorAll('.emoji-tab-btn').forEach((tab) => {
      tab.addEventListener('click', () => {
        emojiTabsBar.querySelectorAll('.emoji-tab-btn').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeEmojiCategory = tab.getAttribute('data-cat');
        if (emojiSearchInput) emojiSearchInput.value = '';
        renderEmojiGrid(activeEmojiCategory, '');
      });
    });
  }

  // Live search filtering
  if (emojiSearchInput) {
    emojiSearchInput.addEventListener('input', (e) => {
      renderEmojiGrid(activeEmojiCategory, e.target.value);
    });
  }

  // Open/Close Emoji Popover
  btnEmojiTool.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = emojiPopover.classList.toggle('hidden');
    if (!isHidden) {
      if (emojiSearchInput) {
        emojiSearchInput.value = '';
        emojiSearchInput.focus();
      }
      renderEmojiGrid(activeEmojiCategory, '');
    }
  });

  if (btnCloseEmojiPicker) {
    btnCloseEmojiPicker.addEventListener('click', (e) => {
      e.stopPropagation();
      emojiPopover.classList.add('hidden');
    });
  }

  // 7. Independent Metadata Header/Footer Injection Controls
  let metadataConfig = {
    isBrowserMockup: false,
    urlPosition: 'none',   // 'none', 'top', 'bottom'
    dateFormat: 'none',    // 'none', 'date', 'datetime', 'iso'
    datePosition: 'none'   // 'none', 'top', 'bottom'
  };

  const metaUrlPosBtns = document.querySelectorAll('#meta-url-pos-group button');
  const metaDateFmtBtns = document.querySelectorAll('#meta-date-fmt-group button');
  const metaDatePosBtns = document.querySelectorAll('#meta-date-pos-group button');
  const btnMetaPresetBrowser = document.getElementById('btn-meta-preset-browser');
  const btnMetaClear = document.getElementById('btn-meta-clear');

  function syncMetadataToAnnotator() {
    if (metadataConfig.isBrowserMockup) {
      annotator.setMetadataBanner({
        enabled: true,
        style: 'browser',
        position: 'top',
        url: captureRecord?.url || captureRecord?.sourcePage?.url || '',
        title: captureRecord?.title || 'Webpage Capture',
        timestamp: captureRecord?.timestamp ? new Date(captureRecord.timestamp).toISOString() : new Date().toISOString()
      });
      showToast('Applied Browser Window Mockup!');
      return;
    }

    const { urlPosition, dateFormat, datePosition } = metadataConfig;
    const hasUrl = urlPosition && urlPosition !== 'none';
    const hasDate = dateFormat && dateFormat !== 'none' && datePosition && datePosition !== 'none';

    if (!hasUrl && !hasDate) {
      annotator.setMetadataBanner(null);
      showToast('Removed metadata banner.');
      return;
    }

    annotator.setMetadataBanner({
      enabled: true,
      style: 'banner',
      urlPosition: urlPosition,
      datePosition: hasDate ? datePosition : 'none',
      dateFormat: dateFormat,
      url: captureRecord?.url || captureRecord?.sourcePage?.url || '',
      title: captureRecord?.title || 'Webpage Capture',
      timestamp: captureRecord?.timestamp ? new Date(captureRecord.timestamp).toISOString() : new Date().toISOString()
    });
    showToast('Updated metadata banner!');
  }

  // A. URL Position Toggles
  metaUrlPosBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      metaUrlPosBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      metadataConfig.urlPosition = btn.getAttribute('data-url-pos');
      metadataConfig.isBrowserMockup = false;
      syncMetadataToAnnotator();
    });
  });

  // B. Date Format Toggles
  metaDateFmtBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      metaDateFmtBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      metadataConfig.dateFormat = btn.getAttribute('data-date-fmt');
      metadataConfig.isBrowserMockup = false;

      // Auto-set date position to bottom if not already selected
      if (metadataConfig.dateFormat !== 'none' && metadataConfig.datePosition === 'none') {
        metadataConfig.datePosition = 'bottom';
        metaDatePosBtns.forEach((b) => {
          if (b.getAttribute('data-date-pos') === 'bottom') b.classList.add('active');
          else b.classList.remove('active');
        });
      }
      syncMetadataToAnnotator();
    });
  });

  // C. Date Position Toggles
  metaDatePosBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      metaDatePosBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      metadataConfig.datePosition = btn.getAttribute('data-date-pos');
      metadataConfig.isBrowserMockup = false;

      // Auto-set date format to datetime if format is none
      if (metadataConfig.datePosition !== 'none' && metadataConfig.dateFormat === 'none') {
        metadataConfig.dateFormat = 'datetime';
        metaDateFmtBtns.forEach((b) => {
          if (b.getAttribute('data-date-fmt') === 'datetime') b.classList.add('active');
          else b.classList.remove('active');
        });
      }
      syncMetadataToAnnotator();
    });
  });

  // D. Browser Preset
  if (btnMetaPresetBrowser) {
    btnMetaPresetBrowser.addEventListener('click', () => {
      metadataConfig.isBrowserMockup = true;
      metadataConfig.urlPosition = 'top';
      metadataConfig.dateFormat = 'none';
      metadataConfig.datePosition = 'none';

      metaUrlPosBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-url-pos') === 'top'));
      metaDateFmtBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-date-fmt') === 'none'));
      metaDatePosBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-date-pos') === 'none'));

      metadataDropdown.classList.add('hidden');
      syncMetadataToAnnotator();
    });
  }

  // E. Clear All Metadata
  if (btnMetaClear) {
    btnMetaClear.addEventListener('click', () => {
      metadataConfig = { isBrowserMockup: false, urlPosition: 'none', dateFormat: 'none', datePosition: 'none' };
      metaUrlPosBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-url-pos') === 'none'));
      metaDateFmtBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-date-fmt') === 'none'));
      metaDatePosBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-date-pos') === 'none'));

      metadataDropdown.classList.add('hidden');
      syncMetadataToAnnotator();
    });
  }

  btnMetadataMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    metadataDropdown.classList.toggle('hidden');
    paddingDropdown.classList.add('hidden');
  });

  // 8. Canvas Padding & Border Tool
  btnPaddingMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    paddingDropdown.classList.toggle('hidden');
    metadataDropdown.classList.add('hidden');
  });

  document.querySelectorAll('#padding-dropdown .chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#padding-dropdown .chip-btn').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activePadding = parseInt(chip.getAttribute('data-pad'), 10);
      annotator.applyPadding(activePadding, paddingColorInput.value);
      showToast(`Applied ${activePadding}px canvas padding!`);
    });
  });

  paddingColorInput.addEventListener('input', (e) => {
    annotator.applyPadding(activePadding, e.target.value);
  });

  document.querySelectorAll('.swatch-circle').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      const color = swatch.getAttribute('data-color');
      paddingColorInput.value = color;
      annotator.applyPadding(activePadding, color);
    });
  });

  // Close open dropdowns on exterior click
  window.addEventListener('click', (e) => {
    if (!e.target.closest('#btn-metadata-menu') && !e.target.closest('#metadata-dropdown')) {
      metadataDropdown.classList.add('hidden');
    }
    if (!e.target.closest('#btn-padding-menu') && !e.target.closest('#padding-dropdown')) {
      paddingDropdown.classList.add('hidden');
    }
    if (!e.target.closest('#btn-emoji-tool') && !e.target.closest('#emoji-popover')) {
      emojiPopover.classList.add('hidden');
    }
    if (!e.target.closest('#btn-zoom-level') && !e.target.closest('#zoom-dropdown')) {
      zoomDropdown.classList.add('hidden');
    }
  });

  // 9. History Actions
  if (btnUndo) {
    btnUndo.addEventListener('click', () => {
      if (annotator) annotator.undo();
    });
  }

  if (btnRedo) {
    btnRedo.addEventListener('click', () => {
      if (annotator) annotator.redo();
    });
  }

  if (btnPurgeHistory) {
    btnPurgeHistory.addEventListener('click', () => {
      if (annotator) {
        annotator.purgeHistory();
        showToast('History purged! Overwritten pixels permanently wiped.');
      }
    });
  }

  // 10. Toast Notification Helper
  let toastTimer = null;
  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, isError ? 7000 : 2400);
  }

  function getCleanFilename(ext) {
    const raw = captureRecord?.title || 'capture';
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10);
    return `${sanitized}_snapflow_${dateStr}.${ext}`;
  }

  // 11. Exports
  // Every format is produced from the same flattened canvas (image + annotations +
  // banners) at that canvas's own pixel size. The editor's zoom never affects output.

  // A. 1-Click Clipboard Copy
  btnCopyClipboard.addEventListener('click', async () => {
    try {
      const blob = await ImageExporter.encode(annotator.getFlattenedCanvas(), 'png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied edited PNG to clipboard!');
    } catch (err) {
      console.error('[SnapFlow] Clipboard copy failed:', err);
      showToast('Clipboard error: ' + err.message, true);
    }
  });

  // B-D. PNG, JPEG and WebP downloads
  async function exportImage(formatKey, successMessage) {
    try {
      const format = ImageExporter.FORMATS[formatKey];
      const blob = await ImageExporter.encode(annotator.getFlattenedCanvas(), formatKey);
      ImageExporter.download(blob, getCleanFilename(format.extension));
      showToast(successMessage);
    } catch (err) {
      console.error(`[SnapFlow] ${formatKey} export failed:`, err);
      showToast(err.message, true);
    }
  }

  btnExportPng.addEventListener('click', () => exportImage('png', 'Downloaded Lossless PNG!'));
  btnExportJpeg.addEventListener('click', () => exportImage('jpeg', 'Downloaded JPEG!'));
  btnExportWebp.addEventListener('click', () => exportImage('webp', 'Downloaded WebP!'));

  // E. PDF
  function readPdfOptions() {
    return {
      size: pdfPageSize.value,
      orientation: pdfOrientation.value,
      layout: pdfLayout.value,
      marginMm: parseFloat(pdfMargin.value) || 0
    };
  }

  /** Describes, before exporting, what the chosen settings will produce. */
  function updatePdfSummary() {
    const options = readPdfOptions();
    const sizedToImage = options.size === 'image';
    pdfOrientation.disabled = sizedToImage;
    pdfLayout.disabled = sizedToImage;

    try {
      const flat = annotator.getFlattenedCanvas();
      const plan = SmartPdfExporter.planLayout(flat.width, flat.height, options);
      const pages = plan.pages.length;
      const percent = plan.percent >= 99.5
        ? '100%'
        : `${plan.percent < 10 ? plan.percent.toFixed(1) : Math.round(plan.percent)}%`;
      const count = pages === 1 ? '1 page' : `About ${pages} pages`;
      let note = '';
      if (!sizedToImage && options.layout === 'fit' && plan.percent < 45) {
        note = ' Text will be small: the whole image is being fitted onto one sheet.';
      }
      pdfSummary.textContent = `${count} · image at ${percent} of actual size. Proportions are always preserved.${note}`;
      pdfSummary.classList.remove('error');
      btnPdfConfirm.disabled = false;
    } catch (err) {
      pdfSummary.textContent = err.message;
      pdfSummary.classList.add('error');
      btnPdfConfirm.disabled = true;
    }
  }

  [pdfPageSize, pdfOrientation, pdfLayout, pdfMargin].forEach((control) => {
    control.addEventListener('change', updatePdfSummary);
  });

  btnExportPdf.addEventListener('click', () => {
    updatePdfSummary();
    pdfModal.classList.remove('hidden');
  });

  btnClosePdfModal.addEventListener('click', () => pdfModal.classList.add('hidden'));
  btnPdfCancel.addEventListener('click', () => pdfModal.classList.add('hidden'));

  btnPdfConfirm.addEventListener('click', async () => {
    pdfModal.classList.add('hidden');
    showToast('Building PDF...');

    try {
      const pdfBlob = await SmartPdfExporter.exportToPdf(annotator.getFlattenedCanvas(), readPdfOptions());
      ImageExporter.download(pdfBlob, getCleanFilename('pdf'));
      showToast('PDF Downloaded!');
    } catch (err) {
      console.error('[SnapFlow] PDF export failed:', err);
      showToast('PDF export error: ' + err.message, true);
    }
  });

});
