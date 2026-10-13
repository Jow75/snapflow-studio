# Release checklist

A list to tick through on the day of submission. The values to paste are in [CHROME-WEB-STORE-SUBMISSION-KIT.md](CHROME-WEB-STORE-SUBMISSION-KIT.md).

## Files

| File | Use |
| --- | --- |
| `dist/chrome-web-store/snapflow-studio-webstore-1.0.0.0.zip` | **The upload.** Manifest version `1.0.0.0`. |
| `dist/development/snapflow-studio-dev-1.1.0.zip` | Testing and archiving only. **Never upload.** |
| `store-submission/assets/store-icon-128.png` | Store icon. |
| `store-submission/assets/01-product-overview.png` to `05-export-options.png` | Screenshots, uploaded in number order. |
| `store-submission/assets/small-promo-tile-440x280.png` | Small promo tile (required). |
| `store-submission/assets/marquee-promo-tile-1400x560.png` | Marquee promo tile (optional). |

`dist/` is rebuilt with `node build-package.js`; it is not kept in Git.

## Before uploading

- [ ] `node build-package.js` run, and the store archive it reports is version `1.0.0.0`.
- [ ] Developer account: registration complete, publisher name set, contact email verified, trader declaration made.
- [ ] The extension loaded once from the unpacked store archive in your own Chrome (`chrome://extensions`, Developer mode, Load unpacked) and a capture tried on a real page.
- [ ] Both keyboard shortcuts pressed once: Alt+Shift+S and Alt+Shift+V.
- [ ] If you intend to mention it anywhere: Scrolling Region tried on the ChatGPT sidebar while signed in. This has not been tested by anyone yet.
- [ ] <https://snapflow-studio-app.netlify.app/privacy.html> and <https://snapflow-studio-app.netlify.app/support.html> open and show the current text.
- [ ] (For verified publisher status, optional) In Google Search Console press **Verify** for `https://snapflow-studio-app.netlify.app/`; the file `googleaaf32d87514e216c.html` is already live at the site root.

## In the dashboard

- [ ] **Package:** version shown is `1.0.0.0`.
- [ ] **Store listing:** description pasted; category `Art & Design`; language `English`; store icon; five screenshots in order; small promo tile; marquee promo tile (optional); homepage URL; support URL; mature content off.
- [ ] **Privacy:** single purpose pasted; three permission boxes (`activeTab`, `scripting`, `storage`) and no others; remote code `No`; data usage `Website content` only; all three certifications ticked; privacy policy URL pasted.
- [ ] **Distribution:** free; visibility chosen; all regions.
- [ ] **Test instructions:** text pasted; username and password empty.
- [ ] **Submit for review** pressed, with the automatic-publish checkbox set the way you want.

## After approval

- [ ] Listing address copied into `CHROME_STORE_URL` in `website/index.html`, and the website deployed.
- [ ] Next upload number reserved before the next build: `node build-package.js --next-submission` (gives `1.0.0.1`; the next development version is `1.2.0`).

## Milestones, kept separate

| Milestone | Who | State when this kit was written |
| --- | --- | --- |
| Code tested and packaged | Repository | Done |
| Changes committed and pushed to GitHub | Repository | Done in the commit that contains this kit |
| Website deployed | Netlify | Done separately, after the push. The two links under "Before uploading" confirm it |
| ZIP uploaded to the dashboard | Owner | Not done |
| Listing and privacy fields completed | Owner | Not done |
| Submitted for review | Owner | Not done |
| Review passed | Google | Not started |
| Published | Owner or automatic | Not done |
