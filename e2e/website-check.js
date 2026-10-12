/**
 * Snap Flow Studio - website check in a real browser.
 *
 *   node website-check.js                       the live site
 *   node website-check.js https://<draft-url>   a Netlify draft deploy
 *
 * Opens every page in Chrome and fails on anything a visitor would notice: a page
 * or asset that does not load, an error in the console (which is where a blocked
 * script or style shows up), a link to a page or anchor that does not exist, or
 * wording the extension does not live up to. Screenshots go to e2e/output/.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { OUTPUT_DIR } = require('./lib/harness');

const BASE = (process.argv[2] || 'https://snapflow-studio-app.netlify.app').replace(/\/$/, '');
const PAGES = ['/', '/privacy.html', '/support.html', '/privacy', '/support'];
const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean).find((p) => fs.existsSync(p));

/**
 * What each page must and must not say, and which pages it must link to. Links are
 * matched by path without the extension, because Netlify rewrites privacy.html to /privacy.
 */
const WORDING = {
  '/': {
    must: ['10 most recent captures', 'mailto:gmuraguri75@gmail.com', 'https://www.baziqhue.co.ke'],
    mustLink: ['/privacy', '/support'],
    mustNot: [/cleared when (it is |the tab is )?closed/i, /chatgpt/i]
  },
  '/privacy.html': {
    must: ['10 most recent captures', 'Closing the Studio tab does not delete a capture', 'SnapFlowCaptureDB', 'does not currently have its own delete button', 'Limited Use', 'mailto:gmuraguri75@gmail.com', 'https://www.baziqhue.co.ke'],
    mustLink: ['/support'],
    mustNot: [/cleared when (it is |the tab is )?closed/i, /chatgpt/i]
  },
  '/support.html': {
    must: ['mailto:gmuraguri75@gmail.com', '10 most recent captures', 'https://www.baziqhue.co.ke'],
    mustLink: ['/privacy'],
    mustNot: [/chatgpt/i]
  }
};

(async () => {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME_PATH.');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const problems = [];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });

  try {
    console.log(`Checking ${BASE}\n`);
    const headers = await (await fetch(BASE + '/')).headers;
    for (const name of ['x-frame-options', 'x-content-type-options', 'content-security-policy', 'referrer-policy']) {
      console.log(`  header ${name}: ${headers.get(name) || '(not set)'}`);
    }
    console.log('');

    const links = new Map(); // absolute URL -> pages that link to it

    for (const route of PAGES) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
      const found = [];
      page.on('console', (msg) => { if (msg.type() === 'error') found.push('console error: ' + msg.text()); });
      page.on('pageerror', (err) => found.push('script error: ' + err.message));
      page.on('requestfailed', (req) => found.push(`request failed: ${req.url()} (${req.failure() && req.failure().errorText})`));
      page.on('response', (res) => { if (res.status() >= 400) found.push(`HTTP ${res.status()}: ${res.url()}`); });

      const response = await page.goto(BASE + route, { waitUntil: 'networkidle0', timeout: 60000 });
      const status = response ? response.status() : 0;
      if (status !== 200) found.push(`page returned HTTP ${status}`);

      const info = await page.evaluate(() => ({
        title: document.title,
        h1: (document.querySelector('h1') || {}).innerText || '',
        html: document.documentElement.outerHTML,
        brokenImages: Array.from(document.images).filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.src),
        styled: getComputedStyle(document.body).fontFamily !== 'Times New Roman' && document.styleSheets.length > 0,
        links: Array.from(document.querySelectorAll('a[href]')).map((a) => a.href),
        sideScroll: document.documentElement.scrollWidth > window.innerWidth
      }));
      for (const src of info.brokenImages) found.push('image did not load: ' + src);
      if (!info.styled) found.push('the stylesheet did not apply');
      if (info.sideScroll) found.push('the page scrolls sideways at 1280 px');

      const canonical = route === '/privacy' ? '/privacy.html' : route === '/support' ? '/support.html' : route;
      const wording = WORDING[canonical];
      for (const text of wording.must) if (!info.html.includes(text)) found.push(`missing: "${text}"`);
      for (const pattern of wording.mustNot) if (pattern.test(info.html)) found.push(`must not appear: ${pattern}`);
      const linked = info.links.filter((href) => href.startsWith(BASE)).map((href) => new URL(href).pathname.replace(/\.html$/, ''));
      for (const target of wording.mustLink) if (!linked.includes(target)) found.push(`no link to ${target}`);

      for (const href of info.links) {
        if (!links.has(href)) links.set(href, new Set());
        links.get(href).add(route);
      }

      const name = `website-${canonical === '/' ? 'home' : canonical.replace(/[/.]/g, '-').replace(/^-/, '')}${route === canonical ? '' : '-short-url'}.png`;
      await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
      console.log(`  ${found.length ? 'FAIL' : 'OK  '} ${route}  "${info.title}"`);
      for (const item of found) { console.log('         ' + item); problems.push(`${route}: ${item}`); }
      await page.close();
    }

    // The install button must not send anyone to a listing that does not exist yet.
    const home = await browser.newPage();
    let dialogText = null;
    home.on('dialog', async (dialog) => { dialogText = dialog.message(); await dialog.dismiss(); });
    await home.goto(BASE + '/', { waitUntil: 'load' });
    const storeUrl = await home.evaluate(() => (typeof CHROME_STORE_URL === 'string' ? CHROME_STORE_URL : null));
    await home.click('.cws-install-btn');
    await new Promise((r) => setTimeout(r, 500));
    if (storeUrl && storeUrl.includes('PLACEHOLDER')) {
      const ok = !!dialogText && home.url().startsWith(BASE);
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} install button, no listing yet: says "${dialogText}"`);
      if (!ok) problems.push('install button: no message shown, or the page navigated away');
    } else {
      console.log(`  OK   install button points to ${storeUrl}`);
    }
    await home.close();

    console.log('\n  Links');
    for (const [href, from] of links) {
      const where = [...from].join(', ');
      if (href.startsWith('mailto:')) {
        const ok = href === 'mailto:gmuraguri75@gmail.com';
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${href}`);
        if (!ok) problems.push(`unexpected email link ${href} on ${where}`);
        continue;
      }
      const url = new URL(href);
      const internal = url.origin === new URL(BASE).origin;
      let status = 0;
      let body = '';
      try {
        const res = await fetch(url.origin + url.pathname + url.search, { redirect: 'follow' });
        status = res.status;
        if (internal && url.hash) body = await res.text();
      } catch (err) {
        status = 0;
      }
      let ok = status === 200;
      let note = `HTTP ${status}`;
      if (ok && internal && url.hash.length > 1 && !body.includes(`id="${url.hash.slice(1)}"`)) {
        ok = false;
        note = `no element with id "${url.hash.slice(1)}"`;
      }
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${href}  (${note})`);
      if (!ok) problems.push(`link ${href} on ${where}: ${note}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${problems.length ? problems.length + ' PROBLEM(S) FOUND' : 'WEBSITE CHECK PASSED'} for ${BASE}`);
  if (problems.length) process.exitCode = 1;
})().catch((err) => {
  console.error('Website check failed to run:', err);
  process.exit(1);
});
