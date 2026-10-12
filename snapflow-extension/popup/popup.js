/**
 * SnapFlow - Popup Controller
 * Coordinates user triggers, restricted URL detection, progress feedback, and settings.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const btnCaptureFull = document.getElementById('btn-capture-full');
  const btnCaptureVisible = document.getElementById('btn-capture-visible');
  const btnCaptureSelected = document.getElementById('btn-capture-selected');
  const btnCaptureElement = document.getElementById('btn-capture-element');
  const btnOpenWebsite = document.getElementById('btn-open-website');
  const btnOpenStudio = document.getElementById('btn-open-studio');
  const btnOpenPrivacy = document.getElementById('btn-open-privacy');
  const btnOpenSupport = document.getElementById('btn-open-support');
  const btnCancelCapture = document.getElementById('btn-cancel-capture');
  const btnSettingsToggle = document.getElementById('btn-settings-toggle');
  const btnCloseSettings = document.getElementById('btn-close-settings');

  const errorBanner = document.getElementById('error-banner');
  const errorMessage = document.getElementById('error-message');
  const captureActions = document.getElementById('capture-actions');
  const captureProgressView = document.getElementById('capture-progress-view');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const progressPercent = document.getElementById('progress-percent');
  const progressStateLabel = document.getElementById('progress-state-label');
  const progressStepInfo = document.getElementById('progress-step-info');
  const settingsDrawer = document.getElementById('settings-drawer');

  // Settings inputs
  const settingScrollDelay = document.getElementById('setting-scroll-delay');
  const settingHideFixed = document.getElementById('setting-hide-fixed');
  const settingPreflight = document.getElementById('setting-preflight');
  const settingDefaultFormat = document.getElementById('setting-default-format');

  let activeTab = null;

  // 1. Load persisted settings
  try {
    const stored = await chrome.storage.local.get([
      'scrollDelay',
      'hideFixed',
      'preflight',
      'defaultFormat'
    ]);
    if (stored.scrollDelay) settingScrollDelay.value = stored.scrollDelay;
    if (typeof stored.hideFixed === 'boolean') settingHideFixed.checked = stored.hideFixed;
    if (typeof stored.preflight === 'boolean') settingPreflight.checked = stored.preflight;
    if (stored.defaultFormat) settingDefaultFormat.value = stored.defaultFormat;
  } catch (err) {
    console.warn('[SnapFlow] Could not load stored settings:', err);
  }

  // 2. Validate Active Tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
      showError('No active browser tab found.');
      return;
    }
    activeTab = tabs[0];
    validateTabUrl(activeTab.url);
  } catch (err) {
    showError('Unable to inspect active tab: ' + err.message);
    return;
  }

  function validateTabUrl(url) {
    if (!url) {
      showError('Blank or empty tab URL.');
      disableActions();
      return;
    }

    const restrictedPrefixes = [
      'chrome://',
      'chrome-extension://',
      'https://chromewebstore.google.com',
      'https://chrome.google.com/webstore',
      'edge://',
      'about:',
      'view-source:',
      'devtools://'
    ];

    for (const prefix of restrictedPrefixes) {
      if (url.startsWith(prefix)) {
        showError('Browser security policy prevents capturing internal or Web Store pages.');
        disableActions();
        return;
      }
    }

    if (url.startsWith('file://')) {
      // Check if file access is allowed
      chrome.extension.isAllowedFileSchemeAccess((isAllowed) => {
        if (!isAllowed) {
          showError('To capture local files, enable "Allow access to file URLs" in chrome://extensions.');
          disableActions();
        }
      });
    }
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function disableActions() {
    [btnCaptureFull, btnCaptureVisible, btnCaptureSelected, btnCaptureElement].forEach((btn) => {
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.4';
        btn.style.pointerEvents = 'none';
      }
    });
  }

  // 3. Initiate Capture Flow
  async function triggerCapture(mode) {
    if (!activeTab || !activeTab.id) {
      showError('No valid target tab.');
      return;
    }

    const settings = {
      scrollDelay: parseInt(settingScrollDelay.value, 10) || 200,
      hideFixed: settingHideFixed.checked,
      preflight: settingPreflight.checked,
      defaultFormat: settingDefaultFormat.value || 'png'
    };

    errorBanner.classList.add('hidden');

    // Full-page captures take several frames, so show progress
    if (mode === 'full') {
      captureActions.classList.add('hidden');
      captureProgressView.classList.remove('hidden');
      updateProgress(0, 'Preparing capture engine...', 'Initializing');
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'START_CAPTURE',
        mode: mode,
        tabId: activeTab.id,
        settings: settings
      });

      if (response && response.error) {
        showError(response.error);
        resetProgressView();
      } else if (mode === 'selected' || mode === 'element') {
        // Selection happens interactively in the page - close popup to reveal page
        window.close();
      }
    } catch (err) {
      showError('Failed to start capture: ' + err.message);
      resetProgressView();
    }
  }

  function updateProgress(percent, stateLabel, stepInfo) {
    progressBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    progressPercent.textContent = `${Math.round(percent)}%`;
    if (stateLabel) progressStateLabel.textContent = stateLabel;
    if (stepInfo) progressStepInfo.textContent = stepInfo;
  }

  function resetProgressView() {
    captureActions.classList.remove('hidden');
    captureProgressView.classList.add('hidden');
    updateProgress(0, 'Ready', '');
  }

  // 4. Runtime Message Listener for Live Progress
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'CAPTURE_PROGRESS') {
      updateProgress(message.percent, message.state, message.stepInfo);
    } else if (message.action === 'CAPTURE_COMPLETE') {
      updateProgress(100, 'Capture complete!', 'Opening Studio...');
      setTimeout(() => {
        window.close();
      }, 500);
    } else if (message.action === 'CAPTURE_ERROR') {
      showError(message.error || 'An error occurred during capture.');
      resetProgressView();
    } else if (message.action === 'CAPTURE_CANCELLED') {
      resetProgressView();
    }
  });

  // 5. Button Event Listeners
  btnCaptureFull.addEventListener('click', () => triggerCapture('full'));
  btnCaptureVisible.addEventListener('click', () => triggerCapture('visible'));
  btnCaptureSelected.addEventListener('click', () => triggerCapture('selected'));
  btnCaptureElement.addEventListener('click', () => triggerCapture('element'));

  btnCancelCapture.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'CANCEL_CAPTURE', tabId: activeTab.id });
    } catch (_) {}
    resetProgressView();
  });

  // Navigation Actions
  const SITE_CONFIG = {
    WEBSITE_URL: 'https://snapflow-studio-app.netlify.app/',
    PRIVACY_URL: 'https://snapflow-studio-app.netlify.app/privacy.html',
    SUPPORT_URL: 'mailto:gmuraguri75@gmail.com',
    PARENT_URL: 'https://www.baziqhue.co.ke'
  };

  const btnParentBrand = document.getElementById('btn-parent-brand');

  btnOpenStudio.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('studio/viewer.html') });
  });

  if (btnOpenWebsite) {
    btnOpenWebsite.addEventListener('click', () => {
      chrome.tabs.create({ url: SITE_CONFIG.WEBSITE_URL });
    });
  }

  if (btnOpenPrivacy) {
    btnOpenPrivacy.addEventListener('click', () => {
      chrome.tabs.create({ url: SITE_CONFIG.PRIVACY_URL });
    });
  }

  if (btnOpenSupport) {
    btnOpenSupport.addEventListener('click', () => {
      chrome.tabs.create({ url: SITE_CONFIG.SUPPORT_URL });
    });
  }

  if (btnParentBrand) {
    btnParentBrand.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: SITE_CONFIG.PARENT_URL });
    });
  }

  // Settings drawer toggle
  btnSettingsToggle.addEventListener('click', () => {
    settingsDrawer.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', async () => {
    settingsDrawer.classList.add('hidden');
    // Save settings
    await chrome.storage.local.set({
      scrollDelay: parseInt(settingScrollDelay.value, 10) || 200,
      hideFixed: settingHideFixed.checked,
      preflight: settingPreflight.checked,
      defaultFormat: settingDefaultFormat.value
    });
  });
});
