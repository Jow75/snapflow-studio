# Snap Flow Studio

A Chrome extension that captures a full page, the visible area, a selected area or a scrolling region of a web page, opens the capture in a built-in editor (the Studio), and exports it as PNG, JPEG, WebP or PDF. All processing is local. A product of [BaziQ Hue](https://www.baziqhue.co.ke).

- Website: <https://snapflow-studio-app.netlify.app>
- Privacy policy: <https://snapflow-studio-app.netlify.app/privacy.html>
- Support: <https://snapflow-studio-app.netlify.app/support.html> or <gmuraguri75@gmail.com>

## Layout

| Path | Contents |
| --- | --- |
| `snapflow-extension/` | The extension. Load this folder unpacked in `chrome://extensions` to develop. |
| `snapflow-extension/tests/` | Node tests: arithmetic, layout planning, packaging and website checks. No browser. |
| `e2e/` | Real-browser tests that drive the extension in Chrome. See [e2e/README.md](e2e/README.md). |
| `website/` | The public website, deployed to Netlify. |
| `store-submission/` | Chrome Web Store listing text, privacy answers, screenshots and checklist. |
| `build-package.js`, `release.json` | Package builder and the list of store submission numbers. |

## Tests

```text
node snapflow-extension/tests/unit-tests.js
node snapflow-extension/tests/engine-tests.js
node snapflow-extension/tests/export-tests.js
node snapflow-extension/tests/studio-tests.js
node snapflow-extension/tests/visual-fidelity-tests.js
node snapflow-extension/tests/website-tests.js
node snapflow-extension/tests/release-tests.js

cd e2e
npm install
npm test
```

The Node tests take seconds. The browser tests take about 20 minutes and should be run with nothing else driving a browser on the machine.

## Packages and versions

```text
node build-package.js
```

writes two archives:

| Archive | Manifest version | Use |
| --- | --- | --- |
| `dist/chrome-web-store/snapflow-studio-webstore-<submission>.zip` | four parts, from `release.json` (currently `1.0.0.0`) | The only file to upload to the Chrome Web Store. |
| `dist/development/snapflow-studio-dev-<development>.zip` | three parts, from `manifest.json` (currently `1.1.0`) | Testing and archiving. Never upload it: Chrome ranks `1.1.0` above every `1.0.0.x`. |

The source manifest is never changed by a build. After a submission has been uploaded, reserve the next number before building again:

```text
node build-package.js --next-submission
```

## Store submission

Everything needed to fill in the Chrome Web Store Developer Dashboard is in [store-submission/CHROME-WEB-STORE-SUBMISSION-KIT.md](store-submission/CHROME-WEB-STORE-SUBMISSION-KIT.md). The screenshots there are regenerated from the built archive with `node e2e/store-screenshots.js`, and the two promo tiles with `node e2e/promo-tiles.js`.

## Website

The site is the `website/` folder as it stands; there is no build step, and Netlify is not connected to this repository, so a push does not deploy it. It is deployed with the Netlify CLI from inside that folder so that `website/netlify.toml` (security headers and short URLs) is applied. Deploy a draft, check it, then deploy to production and check that:

```text
cd website
netlify deploy --no-build --dir . --site 7e4e3433-956e-4f09-9580-daf4b89cd74b
node ../e2e/website-check.js https://<draft-url-printed-above>
netlify deploy --no-build --prod --dir . --site 7e4e3433-956e-4f09-9580-daf4b89cd74b
node ../e2e/website-check.js
```
