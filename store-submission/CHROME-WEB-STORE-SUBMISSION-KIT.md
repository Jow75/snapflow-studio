# Snap Flow Studio: Chrome Web Store submission kit

This is the working document for the first Chrome Web Store submission. It follows the Developer Dashboard in the order you meet it. For each field it gives the value to use; anything inside a grey box is meant to be pasted exactly as it is.

Nothing here has been submitted. Uploading the ZIP, filling in the dashboard and pressing **Submit for review** are yours to do, and Google's review comes after that.

Where a rule comes from, and the date it was checked, is recorded in [REQUIREMENTS-AND-SOURCES.md](REQUIREMENTS-AND-SOURCES.md). The tick list to work through on the day is [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).

## The file to upload

| | |
| --- | --- |
| **Upload this** | `dist/chrome-web-store/snapflow-studio-webstore-1.0.0.0.zip` |
| Version inside it | `1.0.0.0` |
| SHA-256 of the archive that was tested | `7cac4df452348ccf2f6a7f1665ceea95efaa83688439d466626281f6bd9ff4cc` |
| **Never upload this** | `dist/development/snapflow-studio-dev-1.1.0.zip` |

The two archives hold the same code. The only difference is the version number in the manifest. Chrome compares versions number by number, so `1.1.0` ranks above every `1.0.0.x`: if the development archive were uploaded, no `1.0.0.x` could ever be uploaded after it.

The `dist/` folder is not stored in Git because it can be rebuilt at any time. To rebuild both archives, run this in the project folder:

```text
node build-package.js
```

It prints the path, version and SHA-256 of each archive and always leaves exactly one file in each folder. The same source always produces the same archive, so if the SHA-256 it prints for the store archive differs from the one above, something in `snapflow-extension/` has changed since the tests and screenshots were made.

## Before you open the dashboard

These are settings on your Chrome Web Store developer account. Only the account owner can complete them, so they are not filled in here.

| Item | What to do |
| --- | --- |
| Developer registration | Register at <https://chrome.google.com/webstore/devconsole> and pay Google's one-time registration fee if you have not already. |
| Publisher name | Required. Shown under the extension's title. Suggested: `BaziQ Hue`. |
| Contact email | Required, and it must be verified through the link Google sends. Suggested: `gmuraguri75@gmail.com`. |
| Trader declaration | Google asks every developer to declare whether they are a trader or a non-trader under EU rules. This is a legal statement about you, so it is your decision. If you declare as a trader, Google asks for and displays contact details. |

## Step 1: Upload

1. In the dashboard choose **Add new item**.
2. Choose `dist/chrome-web-store/snapflow-studio-webstore-1.0.0.0.zip` and upload it.
3. The item opens on its **Package** tab. Check that it shows version `1.0.0.0`.

The title and the summary shown on the Store listing tab are read from the uploaded package. They are not typed into the dashboard, so they are already set:

**Dashboard field:** Title (from package)

**Required or optional:** Required. Limit 75 characters. This one is 48.

**Value (already in the package):**

```text
Snap Flow Studio - Full Page Screenshot & Editor
```

**Dashboard field:** Summary (from package)

**Required or optional:** Required. Limit 132 characters. This one is 129.

**Value (already in the package):**

```text
Capture a full page, the visible area, a selected area or a scrolling region, then annotate and export as PNG, JPEG, WebP or PDF.
```

**Notes:** To change either of these you would edit `name` or `description` in `snapflow-extension/manifest.json`, rebuild and upload again.

## Step 2: Store listing tab

### Description

**Dashboard field:** Description

**Required or optional:** Required. A listing with a blank description is rejected.

**Value to paste:**

```text
Snap Flow Studio takes screenshots of web pages and opens them in a built-in editor, where you can mark them up and export them. Everything is done in your browser, on your own computer.

FOUR WAYS TO CAPTURE
• Full Page: scrolls the page from top to bottom and joins the pieces into one image.
• Visible Area: just what is on screen now.
• Selected Area: drag a rectangle over the part you want.
• Scrolling Region: click a panel that scrolls on its own, such as a message thread, a table or a code block, to get its whole length. The extension can scroll it for you, or you can scroll it yourself.

Keyboard shortcuts: Alt+Shift+S for Full Page and Alt+Shift+V for Visible Area. You can change them at chrome://extensions/shortcuts.

LONG AND CHANGING PAGES
• Fixed and sticky headers are handled so they are not repeated down the image. This can be switched off in the settings.
• An optional first pass scrolls through the page so that pictures which load late have a chance to appear.
• In a scrolling region, a list that loads more items when you reach its end is followed until it stops growing, up to a time limit. You can stop early and keep what has loaded.
• You can cancel at any time, and the page is put back as it was.

THE STUDIO EDITOR
• Arrows, lines, rectangles, ellipses, a freehand pen and a highlighter
• Text notes, numbered step markers and emoji
• Blur, pixelate and redact, for hiding information
• Crop, padding with a background color, and an optional banner showing the page address and the date
• Move, resize and reorder what you have added, with undo and redo
• Zoom controls for long images

EXPORT
• PNG, JPEG or WebP at the full size of the image
• PDF in A4 or US Letter, portrait or landscape, split across pages or fitted to one page, with a choice of margins. You can also make a single page the same size as the image. Page breaks are placed in gaps between lines where there is one.
• Copy the image to the clipboard

PRIVACY
• Screenshots are processed and stored in your browser. Nothing is uploaded, and the extension makes no network requests of its own.
• No account, no analytics, no ads.
• The extension can access a page only after you click its button or use one of its shortcuts on that page.
• Your 10 most recent screenshots are kept so that you can reopen them. Older ones are deleted automatically, and uninstalling the extension removes them all.

GOOD TO KNOW
• Chrome does not allow extensions to work on its own pages (chrome://), the pages of other extensions or the Chrome Web Store.
• For a file opened from your computer, turn on "Allow access to file URLs" for the extension at chrome://extensions.
• Keep the tab in front while a Full Page or Scrolling Region capture is running.
• A page that changes while it is being scrolled, or one that is extremely long, may come out incomplete. The Studio tells you when that happened.
• The Studio does not save your edits. Export before you close the tab.

Support: gmuraguri75@gmail.com
Website: https://snapflow-studio-app.netlify.app
Privacy policy: https://snapflow-studio-app.netlify.app/privacy.html

Snap Flow Studio is a product of BaziQ Hue.
```

**Notes:** The description field takes plain text only, so the headings are in capitals and the lists use bullet characters. Every feature named here is in the current build. It does not mention ChatGPT or any other named website, and it should stay that way until a named site has been checked by hand.

### Category

**Dashboard field:** Category

**Required or optional:** Required.

**Value to select:** `Art & Design`

**Notes:** Google's description of this category is tools for viewing, editing, organizing and sharing images, and it gives capturing screenshots as an example. If you would rather be listed with general utilities, `Tools` is the fallback (Google describes it as the category for extensions that fit nowhere else). The dropdown may show the categories under group headings.

### Language

**Dashboard field:** Language

**Required or optional:** Required.

**Value to select:** `English`

**Notes:** If the list offers regional variants, choose `English (United States)`: the extension's own labels use US spelling. No other language is needed, because the extension is not translated.

### Graphic assets

All of these files are in `store-submission/assets/`.

**Dashboard field:** Store icon

**Required or optional:** Required. 128 × 128 pixels, PNG.

**File to upload:** `store-icon-128.png`

**Notes:** This is a copy of `icons/icon128.png` from the package. See "Things you may want to change" at the end about its contrast on a white page.

**Dashboard field:** Screenshots

**Required or optional:** At least one is required and up to five are allowed. 1280 × 800 pixels (640 × 400 is the only other size accepted). JPEG or 24-bit PNG with no alpha channel.

**Files to upload, in this order:**

| Order | File | What it shows |
| --- | --- | --- |
| 1 | `01-product-overview.png` | The popup open on a page, with the four capture modes. |
| 2 | `02-full-page-capture.png` | A whole 2,720-pixel-tall page captured from an 800-pixel-tall window, shown complete in the Studio. |
| 3 | `03-scrolling-region.png` | The Scrolling Region picker locked onto a message thread, with the choice to capture automatically or scroll manually. |
| 4 | `04-studio-editor.png` | The Studio with a rectangle, arrow, text note, highlighter, pixelated area and numbered markers on a capture. |
| 5 | `05-export-options.png` | The Export PDF dialog: page size, orientation, layout, margins and the page-count summary. |

**Notes:** The dashboard shows screenshots in the order they are uploaded, and the first one is the one most people see. All five are 1280 × 800, 24-bit PNG, no alpha. How they were made is described under "How the screenshots were made" below.

**Dashboard field:** Small promo tile

**Required or optional:** Google's image guidelines say one must be provided; the dashboard may label it optional. 440 × 280 pixels, JPEG or 24-bit PNG with no alpha channel.

**File to upload:** `small-promo-tile-440x280.png`

**Notes:** This is artwork, not a screenshot: the extension's icon and name on a dark background.

**Dashboard field:** Marquee promo tile

**Required or optional:** Optional. 1400 × 560 pixels, JPEG or 24-bit PNG with no alpha channel.

**File to upload:** `marquee-promo-tile-1400x560.png`

**Notes:** Artwork, not a screenshot: the icon, the name and the four capture modes on a dark background. It is used only if Google chooses to feature the extension, so there is no harm in providing it. You may also leave it empty and add it later.

**Dashboard field:** Global promo video (YouTube link)

**Required or optional:** Optional.

**Value:** Leave empty. There is no video.

### Additional fields

**Dashboard field:** Official URL

**Required or optional:** Optional.

**Value to select:** the website, once it appears in the list; otherwise `None` for now.

**Notes:** The list only offers sites you have verified as yours in Google Search Console. Verification for `https://snapflow-studio-app.netlify.app/` is being set up with Search Console's HTML-file method: the file `googleaaf32d87514e216c.html` is in the website and is live at the site root, so you can press **Verify** in Search Console. After it verifies, this dropdown will offer the site and choosing it shows your verified publisher status under the listing title. Leave the file in place; Search Console re-checks it. If you have not verified yet, leave this field as `None` and set it later.

**Dashboard field:** Homepage URL

**Required or optional:** Optional, recommended.

**Value to paste:**

```text
https://snapflow-studio-app.netlify.app/
```

**Dashboard field:** Support URL

**Required or optional:** Optional, recommended.

**Value to paste:**

```text
https://snapflow-studio-app.netlify.app/support.html
```

**Dashboard field:** Mature content

**Required or optional:** Required choice.

**Value to select:** Off (the extension does not contain mature content).

### Release notes

The Chrome Web Store dashboard has no release-notes field for extensions, so there is nothing to paste. If you want a "what's new" line for the website or for GitHub, this is accurate for a first release:

```text
First release. Full Page, Visible Area, Selected Area and Scrolling Region capture, the Studio editor, and export to PNG, JPEG, WebP and PDF.
```

## Step 3: Privacy tab

### Single purpose

**Dashboard field:** Single purpose description

**Required or optional:** Required.

**Value to paste:**

```text
Snap Flow Studio captures a screenshot of the web page the user is viewing (the full page, the visible area, a selected area or a scrolling region) and lets the user annotate the captured image and export it.
```

### Permission justification

The dashboard shows one box for each permission in the uploaded package. This package declares three permissions and no host permissions, so three boxes should appear. If the dashboard shows a box for a permission that is not listed here, stop: the wrong package was uploaded.

**Dashboard field:** activeTab justification

**Required or optional:** Required.

**Value to paste:**

```text
Needed to take the screenshot. activeTab gives temporary access to the one tab the user is viewing, and only after the user clicks the extension's toolbar button or presses one of its keyboard shortcuts. With that access the extension calls chrome.tabs.captureVisibleTab to capture the page and adds its capture script to it. The extension requests no host permissions, so it cannot access any other tab or any site the user has not invoked it on.
```

**Dashboard field:** scripting justification

**Required or optional:** Required.

**Value to paste:**

```text
Needed to capture more than the visible area. After the user starts a capture, the extension uses chrome.scripting.executeScript and insertCSS to add its own packaged script and one style rule to the active tab. The script measures and scrolls the page for Full Page and Scrolling Region captures, shows the overlay used to select an area or a region, and restores the page when the capture ends. Only files inside the extension package are injected.
```

**Dashboard field:** storage justification

**Required or optional:** Required.

**Value to paste:**

```text
chrome.storage.local saves the user's capture settings on their device: scroll delay, sticky-header handling, the lazy-load pass and the default export format. chrome.storage.session holds the state of a capture that is in progress (tab id and frame count) so that it is not lost if Chrome suspends the service worker part-way through. Nothing in storage is transmitted.
```

### Remote code

**Dashboard field:** Are you using remote code?

**Required or optional:** Required.

**Value to select:** `No, I am not using remote code`

**Notes:** Every script is inside the package and the manifest's content security policy allows scripts from the package only. No justification text is needed when the answer is No.

### Data usage

**Dashboard field:** What user data do you plan to collect from users now or in the future?

**Required or optional:** Required.

**Value to select:** Tick **Website content** only. Leave every other box unticked.

| Data type | Tick? | Why |
| --- | --- | --- |
| Personally identifiable information | No | The extension has no accounts and asks for no personal details. |
| Health information | No | Not handled. |
| Financial and payment information | No | Not handled. The extension is free and takes no payments. |
| Authentication information | No | Not handled. |
| Personal communications | No | Not handled as such. |
| Location | No | Not handled. |
| Web history | No | The extension does not record the pages a user visits. See the note below. |
| User activity | No | Clicks and key presses are used only to operate the selection tools. They are not recorded. |
| **Website content** | **Yes** | A screenshot is an image of a page's text and pictures, and it is stored on the user's device so the editor can open it. |

**Notes:**

- Google's policy says data must be disclosed even when it is only processed or stored on the user's own device. That is why Website content is ticked although nothing is uploaded. Ticking nothing would be inaccurate.
- A screenshot can show personal information if the page showed it. That is covered by Website content; the extension does not pick out or use such information.
- With each capture the extension stores the address and title of the page that was captured, for the 10 captures it keeps. That is a detail of a capture the user asked for, not a record of the pages they visit, so Web history is left unticked. If you prefer the most cautious reading you may tick Web history as well; it is not wrong, but it makes the listing say that the extension handles web history.
- The labels above are the ones the dashboard used when Google introduced this form. Google's documentation does not reproduce them, so if a label on your screen differs slightly, choose the one that matches.

**Dashboard field:** I certify that the following disclosures are true

**Required or optional:** Required. All three must be ticked to publish.

**Value to select:** Tick all three.

| Statement | Tick? | Why it is true |
| --- | --- | --- |
| I do not sell or transfer user data to third parties, outside of the approved use cases | Yes | No data leaves the device. |
| I do not use or transfer user data for purposes that are unrelated to my item's single purpose | Yes | Captures are used only to show, edit and export the screenshot. |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | Yes | Not applicable to this extension. |

### Privacy policy

**Dashboard field:** Privacy policy URL

**Required or optional:** Required, because the extension handles user data (Website content).

**Value to paste:**

```text
https://snapflow-studio-app.netlify.app/privacy.html
```

**Notes:** The policy names what is captured, where it is stored, the 10-capture rule, each permission, how to remove stored data, and it carries the Limited Use statement Google requires.

## Step 4: Distribution tab

**Dashboard field:** Payments

**Required or optional:** Required choice.

**Value to select:** Free of charge, with no in-app purchases.

**Dashboard field:** Visibility

**Required or optional:** Required choice. This is your decision.

**Value to select:** `Public`

**Notes:** Public lists the extension for everyone. If you would like to try the store listing yourself first, `Unlisted` gives it a page that only people with the link can find; it goes through the same review and can be switched to Public later.

**Dashboard field:** Distribution (regions)

**Required or optional:** Required choice.

**Value to select:** `All regions`

## Step 5: Test instructions tab

**Dashboard field:** Test instructions (username, password and additional instructions)

**Required or optional:** Optional. Leave the username and password empty: the extension has no sign-in. The additional instructions box holds at most 500 characters, so the value below is kept short; the permission detail that used to be here now lives in the permission justifications on the Privacy tab.

**Value to paste into the additional instructions box:**

```text
No account needed. Use any ordinary web page (not chrome:// pages or the Chrome Web Store).

1. Click the toolbar button to open the popup (four capture modes).
2. Click "Full Page": the page scrolls once and opens in the Studio editor.
3. Annotate with the left-hand tools, then download with PNG, JPEG, WebP or Export PDF (top right).
4. "Scrolling Region": open a page with its own scrollable panel, pick the mode, click the panel, then "Capture automatically".
```

## Step 6: Submit

1. Press **Submit for review**.
2. The confirmation dialog has a checkbox for publishing automatically once review passes. Leave it ticked to go live as soon as Google approves, or untick it to publish by hand afterwards. If you untick it, you have 30 days after approval to publish before the submission lapses.
3. Google's documentation says most reviews finish within a few days and some take a few weeks. A first submission from a new developer account is one of the cases it lists as taking longer.

## After Google approves it

1. Copy the listing's address from the store. It does not exist until Google creates it.
2. In `website/index.html`, replace the placeholder in `CHROME_STORE_URL` with that address, then deploy the website. Until then the "Add to Chrome" buttons on the website show a "not on the store yet" message.
3. When you next change the extension, reserve the next upload number before building:

```text
node build-package.js --next-submission
node build-package.js
```

The first command adds `1.0.0.1` to `release.json`. The plan is development version `1.2.0` for the next round of work, uploaded to the store as `1.0.0.1`.

## How the screenshots were made

The screenshots come from the upload file itself. `e2e/store-screenshots.js` unpacks `dist/chrome-web-store/snapflow-studio-webstore-1.0.0.0.zip`, loads it into Chrome with its manifest unchanged, opens the toolbar popup through Chrome's own "trigger extension action" command, and clicks the popup's buttons to run the captures. The pages captured are two invented demonstration pages kept in `e2e/fixtures/store/`: a walking guide and a team workspace. They contain no real people, accounts or third-party sites.

- Screenshots 2 to 5 are single screenshots of the browser tab, saved without any editing.
- Screenshot 1 is a composition of two real screenshots. Chrome draws the toolbar popup in its own small window, which a screenshot of the tab does not include, so the popup's screenshot was placed, at its real size, over the screenshot of the page it had been opened on. A shadow and rounded corners were added around the popup. Nothing inside either screenshot was changed.
- Each file was read back from disk and checked: 1280 × 800 pixels, 8 bits per channel, RGB with no alpha channel. Each was also opened and looked at.

The two promo tiles are artwork rather than screenshots. They are drawn from the extension's own icon and name by `e2e/promo-tiles.js`, rendered in Chrome at 440 × 280 and 1400 × 560, and saved and checked the same way (24-bit PNG, no alpha).

To make them again after a change to the extension:

```text
node build-package.js
node e2e/store-screenshots.js
node e2e/promo-tiles.js
```

## What has not been verified

- **Named third-party sites.** Scrolling Region capture of a list that loads more as it scrolls is tested on local demonstration pages. It has not been tested on the ChatGPT sidebar, which needs a signed-in session. Please try it in your own browser before telling anyone it works there, and do not name ChatGPT in the listing until you have.
- **Keyboard shortcuts.** Alt+Shift+S and Alt+Shift+V are declared and handled in the code, but no automated test presses them. Press each once after installing.
- **The dashboard's exact wording.** Google's help pages describe the Privacy tab without reproducing its labels, so the data-type and certification labels above are from the form as Google introduced it. Field limits for the description, single purpose and justification boxes are not published; the dashboard shows a counter.
- **Review outcome.** Nothing here guarantees approval.

## Things you may want to change

These are your decisions. None of them blocks submission.

- **Icon contrast.** The 128-pixel icon is a white camera on a pale, partly transparent tile. It reads well on the dark popup, but the store shows it on a white page, where it is faint. Google's guidance is artwork of about 96 × 96 pixels centred in the 128-pixel square with clear padding, legible on light and dark backgrounds. The icon was left as it is because it is your brand mark.
- **Name inside the extension.** The store title and the website say "Snap Flow Studio". The popup header says "SnapFlow" and the editor header says "SnapFlow Studio". The screenshots show the extension as it is.
- **A delete button.** The extension has no way to delete stored captures other than uninstalling it. The privacy policy says so plainly. A "delete my captures" control would be a good addition for a later version.
