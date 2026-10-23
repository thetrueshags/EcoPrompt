# EcoPrompt media kit

A coordinated set of **9 ready-to-use PNGs** for the Chrome Web Store and social advertising. The palette, leaf mark, typography, and messages follow the extension's interface.

[View the complete preview](preview.jpg) · [Asset dimensions and alt text](manifest.json)

| File                                                    | Dimensions  | Use                                |
| ------------------------------------------------------- | ----------- | ---------------------------------- |
| [Overview](store/01-overview-1280x800.png)              | 1280 × 800  | First store screenshot             |
| [Activity details](store/02-details-1280x800.png)       | 1280 × 800  | Second store screenshot            |
| [Privacy and controls](store/03-privacy-1280x800.png)   | 1280 × 800  | Third store screenshot             |
| [Small promotional tile](store/promo-small-440x280.png) | 440 × 280   | Chrome Web Store small promo       |
| [Marquee](store/promo-marquee-1400x560.png)             | 1400 × 560  | Chrome Web Store marquee           |
| [Square ad](ads/awareness-square-1080x1080.png)         | 1080 × 1080 | Square social placement            |
| [Portrait ad](ads/awareness-portrait-1080x1350.png)     | 1080 × 1350 | 4:5 social feed placement          |
| [Story ad](ads/awareness-story-1080x1920.png)           | 1080 × 1920 | 9:16 story or vertical placement   |
| [Landscape ad](ads/awareness-landscape-1200x628.png)    | 1200 × 628  | Landscape social or link placement |

All exports are opaque RGB PNGs, with exact dimensions checked during rendering. The story layout leaves 190 px at the top and bottom free of essential copy. Social placements differ in their overlays, so choose the matching format instead of cropping a different export.

The store dimensions follow [Chrome's image specifications](https://developer.chrome.com/docs/webstore/images). The three screenshots show the real extension or focused sections of its real interface, captured in a disposable Chromium profile with example usage. The store views are ordered from the simple overview to optional details and local data controls.

The ad call to action is **“Meet EcoPrompt”**, so the images do not depend on an existing public store listing. Set the destination URL in your ad platform when using them. No ad campaign has been launched and no store assets have been uploaded.

## Artwork and editable source

- [`brand/chat-leaf.png`](brand/chat-leaf.png): original campaign illustration generated using the **built-in image_gen tool**. It depicts a forest-green chat bubble folding into a leaf.
- [`source/generation-prompt.json`](source/generation-prompt.json): the complete generation prompt and tool provenance.
- [`source/layout.html`](source/layout.html), [`source/styles.css`](source/styles.css), and [`source/layouts.js`](source/layouts.js): editable layouts, typography, and copy. Open the HTML file in a browser and add `?id=ad-square`, `?id=store-overview`, or another ID from `layouts.js` to preview a specific image.
- `source/popup-*.png`: actual application captures used in the store layouts. The AI illustration is used for promotional tiles and ads, not to invent product screenshots.

Typography, the existing leaf mark, product screenshots, and export dimensions are rendered natively with HTML/CSS and Chromium. The illustration is included intact as a layout asset. Environmental messaging describes illustrative estimates and awareness; the kit makes no claim of measured carbon or water savings.

## Re-export from the repository

With project dependencies installed:

```sh
npx playwright install chromium
npm run media:build
```

The command refreshes the actual UI captures, renders all nine layouts, verifies dimensions and opaque PNG output, and rebuilds `preview.jpg` and `manifest.json`. It uses a disposable browser profile and never connects to AI services. You can set `ECOPROMPT_BROWSER` to an existing compatible Chromium executable.

On Windows, bundle the complete directory from the repository root with:

```powershell
Compress-Archive -Path media -DestinationPath ecoprompt-media-kit.zip -Force
```
