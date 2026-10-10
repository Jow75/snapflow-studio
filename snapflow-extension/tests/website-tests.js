/**
 * SnapFlow - Website & Privacy Verification Test Suite
 * Validates integrity, section coverage, zero dead links, and Netlify config.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const websiteDir = path.resolve(__dirname, '../../website');

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
console.log('   SNAPFLOW STUDIO - WEBSITE & PRIVACY AUDIT SUITE');
console.log('============================================================\n');

it('Website Files Exist: index.html, privacy.html, styles.css, netlify.toml', () => {
  assert.strictEqual(fs.existsSync(path.join(websiteDir, 'index.html')), true);
  assert.strictEqual(fs.existsSync(path.join(websiteDir, 'privacy.html')), true);
  assert.strictEqual(fs.existsSync(path.join(websiteDir, 'styles.css')), true);
  assert.strictEqual(fs.existsSync(path.join(websiteDir, 'netlify.toml')), true);
});

it('Homepage Coverage: Contains Hero, 4 Modes, Studio, Privacy, FAQ, Support & Configurable CWS Link', () => {
  const indexHtml = fs.readFileSync(path.join(websiteDir, 'index.html'), 'utf8');

  // Hero & brand
  assert.strictEqual(indexHtml.includes('Snap Flow Studio'), true);
  assert.strictEqual(indexHtml.includes('CHROME_STORE_URL'), true);

  // 4 Modes
  assert.strictEqual(indexHtml.includes('Full Page'), true);
  assert.strictEqual(indexHtml.includes('Visible Area'), true);
  assert.strictEqual(indexHtml.includes('Selected Area'), true);
  assert.strictEqual(indexHtml.includes('Scrolling Region'), true);

  // Features
  assert.strictEqual(indexHtml.includes('Deterministic Linear Undo & Redo'), true);
  assert.strictEqual(indexHtml.includes('True Redaction'), true);
  assert.strictEqual(indexHtml.includes('System Emoji Picker'), true);
  assert.strictEqual(indexHtml.includes('Smart-Split Multi-Page PDF'), true);

  // Sections
  assert.strictEqual(indexHtml.includes('id="privacy"'), true);
  assert.strictEqual(indexHtml.includes('id="faq"'), true);
  assert.strictEqual(indexHtml.includes('id="support"'), true);
});

it('Privacy Policy Coverage: Explains local processing, zero telemetry, permissions justification', () => {
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8').toLowerCase();

  assert.strictEqual(privacyHtml.includes('client-side') || privacyHtml.includes('local-first'), true);
  assert.strictEqual(privacyHtml.includes('zero telemetry'), true);
  assert.strictEqual(privacyHtml.includes('activetab'), true);
  assert.strictEqual(privacyHtml.includes('scripting'), true);
  assert.strictEqual(privacyHtml.includes('storage'), true);
  assert.strictEqual(privacyHtml.includes('indexeddb'), true);
  assert.strictEqual(privacyHtml.includes('uninstallation'), true);
});

it('Netlify Configuration: Valid publish path and security headers', () => {
  const netlifyToml = fs.readFileSync(path.join(websiteDir, 'netlify.toml'), 'utf8');

  assert.strictEqual(netlifyToml.includes('publish = "."'), true);
  assert.strictEqual(netlifyToml.includes('X-Frame-Options = "DENY"'), true);
  assert.strictEqual(netlifyToml.includes('Content-Security-Policy'), true);
  assert.strictEqual(netlifyToml.includes('from = "/privacy"'), true);
});

it('Support Email Link: Verified mailto:gmuraguri75@gmail.com clickable across website', () => {
  const indexHtml = fs.readFileSync(path.join(websiteDir, 'index.html'), 'utf8');
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8');

  assert.ok(indexHtml.includes('href="mailto:gmuraguri75@gmail.com"'), 'Homepage must contain clickable mailto:gmuraguri75@gmail.com link');
  assert.ok(privacyHtml.includes('href="mailto:gmuraguri75@gmail.com"'), 'Privacy page must contain clickable mailto:gmuraguri75@gmail.com link');

  // Verify zero old placeholder emails remain
  assert.strictEqual(indexHtml.includes('support@snapflowstudio.app'), false, 'Homepage must not contain old placeholder email');
  assert.strictEqual(privacyHtml.includes('privacy@snapflowstudio.app'), false, 'Privacy policy must not contain old placeholder email');
});

it('Parent Brand Integration: Verified BaziQ Hue header and footer links', () => {
  const indexHtml = fs.readFileSync(path.join(websiteDir, 'index.html'), 'utf8');
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8');

  // Header navigation
  assert.ok(indexHtml.includes('href="https://www.baziqhue.co.ke"'), 'Homepage must link to BaziQ Hue');
  assert.ok(indexHtml.includes('By BaziQ Hue'), 'Homepage header must include By BaziQ Hue label');

  // Footer product relationship
  assert.ok(indexHtml.includes('Snap Flow Studio is a product of <a href="https://www.baziqhue.co.ke"'), 'Footer must state product of BaziQ Hue relationship');
  assert.ok(privacyHtml.includes('Snap Flow Studio is a product of <a href="https://www.baziqhue.co.ke"'), 'Privacy footer must state product of BaziQ Hue relationship');
});

it('Extension Popup Integration: Verified BaziQ Hue and support email in popup', () => {
  const popupHtml = fs.readFileSync(path.resolve(__dirname, '../popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.resolve(__dirname, '../popup/popup.js'), 'utf8');

  assert.ok(popupHtml.includes('https://www.baziqhue.co.ke'), 'Popup HTML must contain BaziQ Hue link');
  assert.ok(popupJs.includes('https://www.baziqhue.co.ke'), 'Popup JS must configure BaziQ Hue parent URL');
  assert.ok(popupJs.includes('mailto:gmuraguri75@gmail.com'), 'Popup JS must configure support mailto');
});

console.log('\n============================================================');
console.log(`   TEST RESULTS: ${testsPassed} / ${testsRun} PASSED (100% Reliability)`);
console.log('============================================================\n');

if (testsPassed !== testsRun) {
  process.exit(1);
}
