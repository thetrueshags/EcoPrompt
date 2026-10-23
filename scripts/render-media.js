/* Export native layouts around original AI artwork and real UI captures. */
const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const S = require("../src/shared");
const media = require("../media/source/layouts");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "media");

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ecoprompt-media-"));
  let context;
  try {
    const extension = path.join(root, "src");
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: "chromium",
      executablePath: process.env.ECOPROMPT_BROWSER || undefined,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      locale: "en-US",
      colorScheme: "light",
      viewport: { width: 374, height: 800 },
    });
    const errors = [];
    context.on("weberror", (error) => errors.push(error.error().message));
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const history = Object.fromEntries(
      S.recentDays().map((day, index) => {
        const total = [3200, 6100, 2000, 7800, 4400, 2900, 2400][index];
        const prompt = Math.round(total / 3),
          response = total - prompt;
        return [
          day,
          {
            prompt,
            response,
            total,
            platforms: { "chatgpt.com": { prompt, response, total } },
          },
        ];
      }),
    );
    const sample = S.normalize({
      totalTokens: 28800,
      promptTokens: 9600,
      responseTokens: 19200,
      platforms: {
        "chatgpt.com": { prompt: 9600, response: 19200, total: 28800 },
      },
      dailyHistory: history,
    });
    await worker.evaluate((state) => chrome.storage.local.set(state), sample);
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup.html`,
    );
    await popup.locator("#energy-val").filter({ hasText: "1.2" }).waitFor();
    await popup
      .locator("body")
      .screenshot({
        path: path.join(output, "source/popup-overview.png"),
        animations: "disabled",
      });
    await popup.locator("#data-details").evaluate((element) => {
      element.open = true;
    });
    await popup
      .locator("body")
      .screenshot({
        path: path.join(output, "source/popup-data.png"),
        animations: "disabled",
      });
    await popup
      .locator("#data-details")
      .screenshot({
        path: path.join(output, "source/popup-data-section.png"),
        animations: "disabled",
      });
    await popup.locator("#data-details").evaluate((element) => {
      element.open = false;
    });
    await popup.emulateMedia({ colorScheme: "dark" });
    await popup.locator("#activity-details").evaluate((element) => {
      element.open = true;
    });
    await popup.locator("#daily-chart button").last().click();
    await popup
      .locator("#activity-details")
      .screenshot({
        path: path.join(output, "source/popup-activity.png"),
        animations: "disabled",
      });
    await popup.close();
    const page = await context.newPage();
    const manifest = [];
    for (const item of media) {
      await page.setViewportSize({ width: item.width, height: item.height });
      await page.goto(
        `${pathToFileURL(path.join(output, "source/layout.html")).href}?id=${item.id}`,
      );
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          Array.from(document.images, (image) => image.decode()),
        );
      });
      const overflow = await page.evaluate(() => {
        const canvas = document
          .getElementById("canvas")
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(
            ".brand, .copy-block, .ad-bottom, .disclosure",
          ),
        ]
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left < 0 ||
              rect.top < 0 ||
              rect.right > canvas.right ||
              rect.bottom > canvas.bottom
            );
          })
          .map((node) => node.className);
      });
      assert.deepEqual(
        overflow,
        [],
        `${item.id} text must fit inside its canvas`,
      );
      const target = path.join(output, item.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await page.screenshot({
        path: target,
        animations: "disabled",
        omitBackground: false,
      });
      const png = fs.readFileSync(target);
      assert.equal(png.readUInt32BE(16), item.width);
      assert.equal(png.readUInt32BE(20), item.height);
      assert.equal(
        png[25],
        2,
        "Store and ad PNGs must be opaque RGB without alpha",
      );
      manifest.push({
        file: item.file,
        width: item.width,
        height: item.height,
        alt: item.alt,
        type: "image/png",
        color: "RGB, no alpha",
        illustrativeData: item.kind === "store",
      });
    }
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          brand: "EcoPrompt",
          generatedWith:
            "Built-in image_gen for original illustration; native HTML/CSS and Chromium for exact typography, real screenshots, and final export.",
          assets: manifest,
        },
        null,
        2,
      ) + "\n",
    );
    const previews = manifest
      .map(
        (item) =>
          `<figure><div class="thumb"><img src="${pathToFileURL(path.join(output, item.file)).href}"></div><figcaption>${item.file}<span>${item.width} × ${item.height}</span></figcaption></figure>`,
      )
      .join("");
    await page.setViewportSize({ width: 1600, height: 1600 });
    await page.setContent(
      `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#e9eedf;font-family:'Segoe UI',Arial,sans-serif;color:#243b30;padding:52px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}h1{font-size:40px;font-weight:500;letter-spacing:-1px;margin:0}header p{font-size:16px;color:#617064}main{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}figure{margin:0;min-width:0}.thumb{height:355px;display:flex;align-items:center;justify-content:center;background:#dce4d1;border:1px solid #d1dbc8;border-radius:13px;overflow:hidden}.thumb img{display:block;max-width:100%;max-height:100%;object-fit:contain}figcaption{font-size:13px;margin-top:10px}figcaption span{display:block;color:#617064;margin-top:4px}footer{font-size:14px;color:#617064;margin-top:36px}</style></head><body><header><h1>EcoPrompt · Media kit</h1><p>Chrome Web Store + social ads</p></header><main>${previews}</main><footer>Real product screenshots with example usage. Original campaign artwork. All environmental figures are illustrative estimates.</footer></body></html>`,
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode()));
    });
    await page
      .locator("body")
      .screenshot({
        path: path.join(output, "preview.jpg"),
        type: "jpeg",
        quality: 92,
      });
    assert.deepEqual(errors, []);
    console.log(
      `Exported and dimension-checked ${manifest.length} opaque media images plus media/preview.jpg.`,
    );
  } finally {
    await context?.close();
    if (profile.startsWith(path.join(os.tmpdir(), "ecoprompt-media-")))
      fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
