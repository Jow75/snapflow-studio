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

it('Capture Retention Wording: Website states the 10-capture rule the extension actually enforces', () => {
  const indexHtml = fs.readFileSync(path.join(websiteDir, 'index.html'), 'utf8');
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8');
  const CaptureStore = require(path.resolve(__dirname, '../engine/capture-store.js'));

  assert.strictEqual(CaptureStore.KEEP_RECENT, 10, 'The retention rule is ten captures');
  for (const [name, html] of [['Homepage', indexHtml], ['Privacy policy', privacyHtml]]) {
    assert.ok(html.includes(`${CaptureStore.KEEP_RECENT} most recent captures`), `${name} must state how many captures are kept`);
    assert.strictEqual(/cleared when (it is |the tab is )?closed/i.test(html), false, `${name} must not claim captures are cleared when the Studio closes`);
  }
  assert.ok(privacyHtml.includes('Closing the Studio tab does not delete a capture'), 'Privacy policy must say what closing the Studio does');
});

it('Privacy Policy Permissions: Justifies exactly the permissions the manifest declares', () => {
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
  const section = privacyHtml.slice(privacyHtml.indexOf('id="permissions"'), privacyHtml.indexOf('id="retention"'));
  const justified = [...section.matchAll(/<li>\s*<code>([^<]+)<\/code>:/g)].map((m) => m[1]);

  assert.deepStrictEqual(justified.sort(), [...manifest.permissions].sort());
  assert.strictEqual(manifest.host_permissions, undefined, 'The policy says no site access is requested');
});

it('Privacy Policy Honesty: States what is stored, how to remove it, and the Limited Use disclosure', () => {
  const privacyHtml = fs.readFileSync(path.join(websiteDir, 'privacy.html'), 'utf8');
  const CaptureStore = require(path.resolve(__dirname, '../engine/capture-store.js'));

  assert.ok(privacyHtml.includes(CaptureStore.DB_NAME), 'Names the local database');
  assert.ok(privacyHtml.includes('does not currently have its own delete button'), 'Does not promise a delete button');
  assert.ok(privacyHtml.includes('chrome://extensions'), 'Explains removal through Chrome');
  assert.ok(/Chrome Web Store User Data Policy<\/a>, including the Limited Use requirements/.test(privacyHtml), 'Limited Use statement');
  assert.strictEqual(/encrypted at rest|end-to-end encrypt/i.test(privacyHtml), false, 'Must not claim encryption that is not implemented');
});

it('Support Page: Exists with the support email and links to the privacy policy', () => {
  const supportHtml = fs.readFileSync(path.join(websiteDir, 'support.html'), 'utf8');
  const netlifyToml = fs.readFileSync(path.join(websiteDir, 'netlify.toml'), 'utf8');

  assert.ok(supportHtml.includes('href="mailto:gmuraguri75@gmail.com"'));
  assert.ok(supportHtml.includes('href="privacy.html"'));
  assert.ok(supportHtml.includes('Snap Flow Studio is a product of <a href="https://www.baziqhue.co.ke"'));
  assert.ok(netlifyToml.includes('to = "/support.html"'), '/support must resolve to the support page');
});

it('Website Links: Every local link and asset on every page exists', () => {
  for (const page of ['index.html', 'privacy.html', 'support.html']) {
    const html = fs.readFileSync(path.join(websiteDir, page), 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"#]+)(#[^"]*)?"/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      assert.ok(fs.existsSync(path.join(websiteDir, target)), `${page} links to missing ${target}`);
      if (match[2] && target.endsWith('.html')) {
        const linked = fs.readFileSync(path.join(websiteDir, target), 'utf8');
        assert.ok(linked.includes(`id="${match[2].slice(1)}"`), `${page} links to missing anchor ${target}${match[2]}`);
      }
    }
    assert.strictEqual(html.includes('href="https://github.com"'), false, `${page} must not link to a bare github.com`);
  }
});

console.log('\n============================================================');
console.log(`   TEST RESULTS: ${testsPassed} / ${testsRun} PASSED`);
console.log('============================================================\n');

if (testsPassed !== testsRun) {
  process.exit(1);
}
