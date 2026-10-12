# Chrome Web Store requirements and where they come from

Every requirement used in the submission kit, the official Google page it was taken from, and whether it is a rule or a recommendation. All pages were read on **12 October 2026**. The "page last updated" column is the date Google prints at the foot of the page; several are old, and where a page is silent on something this document says so instead of filling the gap.

Only pages on `developer.chrome.com` were treated as authoritative. One news report was used to cross-check dashboard wording that Google's pages do not reproduce; it is marked as such.

## Package and manifest

| Requirement | Kind | Source | Page last updated | How this project meets it |
| --- | --- | --- | --- | --- |
| `manifest_version` must be 3 ("The only supported value is 3"). | Rule | <https://developer.chrome.com/docs/extensions/reference/manifest> | 2012-09-18 as printed | The manifest declares 3. |
| `name` is at most 75 characters. | Rule | same page | | 48 characters. |
| `description` is at most 132 characters and is required by the store. | Rule | same page | | 129 characters. |
| `icons` is required by the store; a 128 × 128 PNG icon must be in the ZIP. | Rule | same page, and <https://developer.chrome.com/docs/webstore/images> | 2018-06-11 | `icons/icon128.png` is in the package. |
| `version` is one to four integers separated by dots, each 0 to 65535, with no leading zeros, and not all zero. | Rule | <https://developer.chrome.com/docs/extensions/reference/manifest/version> | 2013-05-12 | `1.0.0.0` in the store package, `1.1.0` in the source tree. |
| Versions are compared left to right and a missing number counts as zero ("1.2.0 is a newer version than 1.1.9.9999"). | Rule | same page | | This is why `1.1.0` outranks every `1.0.0.x`, and why the development archive must never be uploaded. `build-package.js` checks the ordering in `release.json` with the same comparison. |
| The upload must be a ZIP of at most 2 GB. | Rule | <https://developer.chrome.com/docs/webstore/publish> | 2014-02-28 as printed | The archive is about 106 KB. |
| Icon artwork should be about 96 × 96 in the 128 × 128 image, with transparent padding. | Recommendation | <https://developer.chrome.com/docs/webstore/images> | 2018-06-11 | Not followed by the current icon. Listed in the kit under "Things you may want to change". |

## Store listing

| Requirement | Kind | Source | Page last updated | How this project meets it |
| --- | --- | --- | --- | --- |
| A listing with a blank description, or with no icon or no screenshots, is rejected. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/listing-requirements> | 2024-07-10 | Description, icon and five screenshots are prepared. |
| Listing content must be accurate and up to date and must not mislead. This covers the description, category, title, icon, screenshots and promotional images. | Rule | same page | | Every feature in the description was checked against the current code. The screenshots are of the shipping package. |
| No keyword spam: no lists of sites or brands, and no unnatural repetition of a keyword more than five times. | Rule | same page | | The description names no other site or product and does not repeat a search term. |
| No unattributed or anonymous testimonials in the description. | Rule | same page | | None are used. |
| At least one screenshot, at most five, 1280 × 800 pixels; 640 × 400 is the only other size. Square corners, no padding. | Rule | <https://developer.chrome.com/docs/webstore/cws-dashboard-listing> (2020-12-07) and <https://developer.chrome.com/docs/webstore/images> (2018-06-11) | | Five files, each 1280 × 800, full bleed. |
| Screenshot file format. | Not stated on the pages above | | | The upload box in the dashboard has asked for "JPEG or 24-bit PNG (no alpha)". That comes from the dashboard, not from a help page, and could not be re-checked without a developer account. The files are 24-bit PNG with no alpha channel, which is the stricter of the possibilities. |
| Small promo tile, 440 × 280 pixels, PNG or JPEG. The image guidelines say one "must" be provided. | Rule according to the guidelines; the dashboard may show it as optional | <https://developer.chrome.com/docs/webstore/images> and <https://developer.chrome.com/docs/webstore/cws-dashboard-listing> | | `small-promo-tile-440x280.png` is provided, so the submission is covered either way. |
| Marquee promo tile, 1400 × 560 pixels. | Optional | same pages | | Not provided. |
| Promotional video (YouTube link). | Optional | <https://developer.chrome.com/docs/webstore/cws-dashboard-listing> | 2020-12-07 | Not provided. |
| Category: choose the most appropriate one from the current list. | Rule | <https://developer.chrome.com/docs/webstore/best-practices> | 2017-08-30 as printed; the text describes the 2023 category changes | "Art & Design", whose description covers viewing and editing images and gives capturing screenshots as an example. "Tools" is described as the category for extensions that fit no other. |
| Summary is plain text of 132 characters or fewer; avoid superlatives and references to other extensions. | Rule (length), recommendation (style) | <https://developer.chrome.com/docs/webstore/best-listing> | 2024-08-02 | 129 characters, descriptive, no superlatives. |
| Description should open with a statement of what the item does, followed by its main features. | Recommendation | same page | | Followed. |
| Homepage URL, Support URL and Official URL. | Optional | <https://developer.chrome.com/docs/webstore/cws-dashboard-listing> | 2020-12-07 | Homepage and support URLs are provided. Official URL needs a site verified in Google Search Console and is left as None. |
| Character limits for the description, single purpose and justification fields. | Not stated on any page read | | | The dashboard shows a counter. The description is about 3,200 characters; the other texts are between 200 and 450. |
| A release-notes field. | Does not exist for extensions | <https://developer.chrome.com/docs/webstore/publish> lists the tabs: Package, Store listing, Privacy, Distribution, Test instructions | | Nothing to fill in. |

## Privacy practices

| Requirement | Kind | Source | Page last updated | How this project meets it |
| --- | --- | --- | --- | --- |
| An extension must have a single purpose that is "narrow and easy to understand", stated on the Privacy tab. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines> (2024-07-10) and <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> (2020-06-12) | | Capturing a screenshot of the page being viewed, then annotating and exporting it. |
| Each declared permission needs a justification. Request "the narrowest permissions necessary"; do not request a permission for features that are not built. An unneeded permission must be removed from the manifest. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/permissions> (2022-11-01) and <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> | | The manifest declares `activeTab`, `scripting` and `storage`. The `downloads` permission was declared but never used by the code, so it was removed during this preparation. |
| Declare whether the extension runs remote code. Undeclared remote code leads to rejection, and Manifest V3 does not allow loading remotely hosted code. | Rule | <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> | 2020-06-12 | No remote code. |
| Disclose the types of user data handled, and certify the Limited Use statements. Both are needed before an item can be published or updated. | Rule | <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> and <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq> | FAQ footer prints 2016-04-23; its text refers to 2019 and 2021 | "Website content" is disclosed and the three statements are certified. |
| Data must be disclosed "even when data is processed or stored locally on a user's device". | Rule | <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>, question 3 | | This is why "Website content" is ticked although nothing is uploaded. |
| An extension that handles user data needs a privacy policy, linked in the dashboard, that says how data is collected, used and shared. Storing data only on the device does not remove the need. | Rule | same FAQ, questions 6, 7 and 14 | | <https://snapflow-studio-app.netlify.app/privacy.html> |
| Privacy fields must match the privacy policy and the extension's real behaviour; a contradiction can lead to removal. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/listing-requirements> | 2024-07-10 | The dashboard answers, the policy and the code say the same thing: stored locally, 10 most recent kept, nothing transmitted. |
| Limited Use: user data may be used only for the disclosed single purpose, not transferred except in narrow cases, not used for advertising, and not read by people. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/limited-use> | 2022-11-01 | Nothing leaves the device. |
| A public statement, on a site the developer owns, that the extension's use of data complies with the User Data Policy including the Limited Use requirements. | Rule | same page, and the FAQ | | Section 7 of the privacy policy. |
| Collecting browsing activity is prohibited unless needed for a user-facing feature that is described prominently. | Rule | <https://developer.chrome.com/docs/webstore/program-policies/limited-use> | 2022-11-01 | The extension does not record browsing. It keeps the address of each page the user chose to capture, as part of that capture. |
| The exact labels of the data-type boxes and of the three certification statements. | Not reproduced on Google's help pages | Cross-checked against a report of Google's announcement: <https://9to5google.com/2020/11/18/chrome-web-store-disclosure/> (not an official source) | 2020-11-18 | The kit uses the labels from the form as introduced and says to pick the matching item if a label differs. |

## Distribution, account and review

| Requirement | Kind | Source | Page last updated | Notes |
| --- | --- | --- | --- | --- |
| Visibility is Public, Unlisted or Private; all three get the same review. Regions default to all. | Rule | <https://developer.chrome.com/docs/webstore/cws-dashboard-distribution> | 2020-12-07 | The kit recommends Public and All regions. The page does not describe the payments setting. |
| A publisher name and a verified contact email are required on the developer account. | Rule | <https://developer.chrome.com/docs/webstore/set-up-account> | 2023-10-16 | Owner only. |
| Developers must register and pay a one-time registration fee before publishing. | Rule | <https://developer.chrome.com/docs/webstore/register> | seen as a search excerpt only | Owner only. The amount is shown by Google during registration. |
| Every developer must declare whether they are a trader or a non-trader (EU Digital Services Act). | Rule | <https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq> | seen as a search excerpt only | Owner only. Google says each publisher must decide this for themselves. The excerpt did not say whether publishing is blocked until the declaration is made. |
| The dashboard tabs are Package, Store listing, Privacy, Distribution and Test instructions. | Fact | <https://developer.chrome.com/docs/webstore/publish> | 2014-02-28 as printed | The kit follows this order. |
| Publishing can be deferred by unticking the checkbox in the submit dialog; a reviewed item must then be published within 30 days. | Rule | same page | | Described in the kit, step 6. |
| "For most extensions, review is completed within a few days, but it can take up to a few weeks." New developers, new extensions, broad host permissions and sensitive permissions such as `tabs` and `downloads` are listed as things that lengthen review. | Fact | <https://developer.chrome.com/docs/webstore/review-process> | 2021-12-10 | The package has no host permissions and no longer requests `downloads`. A first submission from a new account is still on that list. |
| New publishers may at first have at most two published extensions. | Rule | <https://developer.chrome.com/docs/webstore/publish> | | Not a constraint for one extension. |

## What was not found in official documentation

These points could not be confirmed from Google's pages and are flagged in the kit where they matter:

- The wording of the data-type and certification checkboxes on the Privacy tab.
- Character limits for the description, single purpose, permission justification and test instruction fields.
- Whether the current dashboard marks the small promo tile as required or optional. The guidelines say required; a tile is supplied.
- The accepted screenshot file formats.
- The label and options of the payments setting on the Distribution tab.
