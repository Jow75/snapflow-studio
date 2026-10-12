# Real-browser tests

These tests load the unpacked extension into Chrome, run real captures against local fixture pages, and check what the Studio editor actually renders and what the export buttons actually download. They complement the fast Node tests in `snapflow-extension/tests/`, which check the arithmetic without a browser.

## Running

```
cd e2e
npm install          # first time only
npm test             # everything: about 20 minutes
```

Useful variations:

```
node run-all.js --dpr=1                 # one device pixel ratio
node run-all.js --only=region           # one suite: full | region | dynamic | exports | studio | tools | storage
node run-all.js --dpr=1.25 --all        # every test at a ratio that normally runs the short list
node real-sites.js                      # capture live sites for visual review
node real-sites.js https://example.com  # any URL
node store-screenshots.js               # Chrome Web Store screenshots, from the built archive
node website-check.js                   # the live website, in Chrome: pages, console errors, wording, links
node website-check.js https://<draft>   # the same for a Netlify draft deploy
```

Chrome is found automatically in its default location; set `CHROME_PATH` to use another build. Images, PDFs and `report.json` are written to `e2e/output/`.

Run the suites on their own. Several tests drive the picker with timed key presses, and a busy machine (another test run, a second browser under automation) can make them miss.

To test a built package instead of the source tree, unpack it and point the suites at the folder:

```
SNAPFLOW_EXTENSION_DIR=/path/to/unpacked-archive node run-all.js
```

## What is checked

| Suite | How correctness is established |
|---|---|
| `tests/full-page.js` | Fixture pages carry a ruler strip whose colour encodes the row number. The stitched image is decoded row by row: every source row must appear once, in order. Fixed, sticky and scripted headers are counted. |
| `tests/region.js` | The same ruler inside each scroll container of an app-shell page. The picker is driven with real mouse and keyboard input. Covers automatic and manual capture, nested and virtualised containers, two-axis scrolling, cancellation, and restoring the page. |
| `tests/dynamic.js` | A history list that loads more rows when its bottom is reached (`fixtures/history.html`), with the same ruler. Covers one and several loads, slow loads with and without a loading placeholder, a loader driven by scroll events, a virtualised list that grows, a list nested in another scrolling panel, a list that never stops loading (time limit), stopping the load with Enter, and Escape while loading. The placeholder is not ruler-coloured, so photographing it fails the row check. |
| `tests/exports.js` | PNG is compared pixel for pixel with the editor. JPEG and WebP are decoded and compared by geometry. Each PDF is parsed directly (page boxes, placement matrices, embedded image data) and also rendered with pdf.js; a square and a circle in the fixture are measured to prove nothing was stretched. |
| `tests/studio-layout.js` | Opens the Studio at five window sizes and measures the left tool panel: every control, Stroke Thickness included, must be inside the window or reachable by scrolling the panel, the scroll cue is read from screenshot pixels, and the canvas area must be unchanged. The header is measured at the same sizes and at 1024 px wide: every control, Export PDF included, must be inside the window, on one line and not covered. |
| `tests/studio-tools.js` | Uses every editing tool with real pointer and keyboard input and reads the result from the editor: each drag tool adds exactly one edit that Undo removes pixel for pixel, an arrow's head has the colour of its line, and a text note can be typed, kept, cancelled with Esc and is added once without scrolling the canvas. |
| `tests/storage.js` | Reads the extension's IndexedDB directly after 13 captures (only the 10 most recent may remain, with their frames), reopens a kept capture after the Studio tab is closed, and watches the page, the service worker and the Studio through the DevTools protocol for any request to a remote address. |

Device pixel ratio 1 runs every test. Ratios 1.25, 1.5 and 2 re-run the geometry-sensitive captures; the export, Studio layout, editing tools and storage suites do not depend on the ratio and run once.

## What the fixtures cannot show

`fixtures/history.html` behaves like a conversation-history sidebar, but it is not one. A site that needs a signed-in account, such as the ChatGPT sidebar, is not reached by these tests and has to be checked by hand in a real session.

## One difference from production

The extension uses the `activeTab` permission, which Chrome grants only when a person clicks the toolbar button or presses the shortcut. The test suites start hundreds of captures without that click, so the harness tests a temporary copy of the extension whose manifest also has a host permission. No other file differs.

`store-screenshots.js` does not make that change. It unpacks the archive in `dist/chrome-web-store/`, loads it with its manifest untouched, opens the real toolbar popup through Chrome's "trigger extension action" command (which grants `activeTab` as a click does), and starts a Full Page and a Scrolling Region capture by clicking the popup's buttons. It stops with an error if those captures or the PDF and PNG downloads do not work, so a run of it is also a check of the popup and of the `activeTab` flow on the exact package that ships. The keyboard shortcuts are not exercised by any automated test.

## Chrome Web Store screenshots

```
node ../build-package.js
node store-screenshots.js
```

writes five 1280 × 800 screenshots and the 440 × 280 promo tile to `store-submission/assets/` as 24-bit PNGs without an alpha channel, then reads each file back and checks its size. The pages captured are the invented demonstration pages in `fixtures/store/`. `01-product-overview.png` is a composition of two real screenshots (the popup, which Chrome draws in its own window, placed unscaled over the page it was opened on); the other four are single unedited screenshots.
