/* Render the existing vector brand mark as crisp, transparent extension PNGs. */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const sizes = [16, 32, 48, 128];
const source = fs.readFileSync(path.join(root, "src/icons/icon.svg"), "utf8");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ECOPROMPT_BROWSER || undefined,
  });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const size of sizes) {
      // Toolbar sizes use more of the canvas to preserve the leaf at 16 px.
      const padding = size === 16 ? 0 : size === 32 ? 2 : size === 48 ? 4 : 16;
      const inner = size - padding * 2;
      const svg = source.replace(
        'viewBox="0 0 128 128"',
        'viewBox="16 16 96 96"',
      );
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;background:transparent}#icon{width:${size}px;height:${size}px;display:grid;place-items:center}svg{display:block;width:${inner}px;height:${inner}px}</style></head><body><div id="icon">${svg}</div></body></html>`,
      );
      const file = path.join(root, `src/icons/icon${size}.png`);
      await page
        .locator("#icon")
        .screenshot({ path: file, omitBackground: true });
      const png = fs.readFileSync(file);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      assert.equal(png[25], 6, "Icons must preserve transparency");
      const alpha = await page.evaluate(
        async (uri) => {
          const image = new Image();
          image.src = uri;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          return [
            ctx.getImageData(0, 0, 1, 1).data[3],
            ctx.getImageData(
              Math.floor(image.width / 2),
              Math.floor(image.height / 2),
              1,
              1,
            ).data[3],
          ];
        },
        `data:image/png;base64,${png.toString("base64")}`,
      );
      assert.equal(alpha[0], 0, "Outside corners must be transparent");
      assert.equal(alpha[1], 255, "Icon center must be opaque");
    }
    const icons = sizes
      .map(
        (size) =>
          `<figure><div class="sample"><img src="data:image/png;base64,${fs.readFileSync(path.join(root, `src/icons/icon${size}.png`)).toString("base64")}" width="${size}" height="${size}"></div><figcaption>${size} × ${size}</figcaption></figure>`,
      )
      .join("");
    await page.setViewportSize({ width: 760, height: 460 });
    await page.setContent(
      `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Arial,sans-serif;background:#f7f8f2;color:#243b30}header{padding:22px 32px;font-size:20px;font-weight:600}.row{display:flex;justify-content:space-around;padding:10px 24px 16px}.dark{background:#17231d;color:#e1e9dc}figure{margin:0;flex:1;text-align:center}.sample{height:140px;display:flex;align-items:center;justify-content:center}figcaption{font-size:12px;opacity:.8}</style></head><body><header>EcoPrompt · Extension icons</header><div class="row">${icons}</div><div class="row dark">${icons}</div></body></html>`,
    );
    await page.evaluate(() =>
      Promise.all(Array.from(document.images, (image) => image.decode())),
    );
    await page
      .locator("body")
      .screenshot({ path: path.join(root, "docs/icon-preview.png") });
    console.log(
      "Rendered and verified 16, 32, 48, and 128 px transparent icons. Preview: docs/icon-preview.png.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
