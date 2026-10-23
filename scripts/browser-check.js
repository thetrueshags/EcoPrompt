/* Real Chromium + unpacked extension, using local fixtures instead of AI accounts. */
const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const S = require("../src/shared");
const { countTokens } = require("../src/content");
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function openFixture(context, page, url, extensionId) {
  // document_idle injection and the initial worker request can take longer than
  // a fixed sleep on a cold profile. Wait for the actual content-script listeners.
  const session = await context.newCDPSession(page);
  let contextId;
  session.on("Runtime.executionContextCreated", ({ context }) => {
    if (context.origin === `chrome-extension://${extensionId}`)
      contextId = context.id;
  });
  try {
    await session.send("Runtime.enable");
    await page.goto(url);
    await waitFor(() => contextId !== undefined, "content-script injection");
    const { result } = await session.send("Runtime.evaluate", {
      expression: "document",
      contextId,
    });
    await waitFor(async () => {
      const { listeners } = await session.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId,
      });
      return ["keydown", "click", "submit"].every((type) =>
        listeners.some((listener) => listener.type === type),
      );
    }, "content-script send listeners");
  } finally {
    await session.detach();
  }
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ecoprompt-browser-"));
  const extension = path.resolve(__dirname, "../src");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: "chromium",
      executablePath: process.env.ECOPROMPT_BROWSER || undefined,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
      viewport: { width: 374, height: 800 },
      locale: "en-US",
      colorScheme: "light",
    });
    const errors = [];
    context.on("weberror", (error) => errors.push(error.error().message));
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const read = () => worker.evaluate(() => chrome.storage.local.get(null));
    await context.route(
      /^https:\/\/(chatgpt\.com|gemini\.google\.com|claude\.ai)\//,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html><body><main id="chat"></main><form><textarea aria-label="Message"></textarea><button type="button" data-testid="send-button">Send</button></form></body></html>',
        }),
    );
    const pages = [];
    for (const host of Object.keys(S.PLATFORMS)) {
      const page = await context.newPage();
      pages.push(page);
      await openFixture(context, page, `https://${host}/new`, extensionId);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.evaluate((host) => {
        for (const role of ["user", "assistant"]) {
          const node = document.createElement("div");
          if (host === "chatgpt.com") node.dataset.messageAuthorRole = role;
          else if (host === "claude.ai")
            node.dataset.testid =
              role === "user" ? "user-message" : "assistant-message";
          else
            node.className =
              role === "user" ? "user-query" : "model-response-text";
          node.textContent = role === "user" ? "hello world" : "a useful reply";
          document.getElementById("chat").append(node);
        }
      }, host);
      await waitFor(
        async () => (await read()).platforms?.[host]?.total > 0,
        `${host} tracking`,
      );
    }
    let state = await read();
    assert.equal(Object.keys(state.platforms).length, 3);
    assert.equal(state.totalTokens, state.promptTokens + state.responseTokens);
    const firstTotal = state.totalTokens;
    await pages[0].evaluate(() => {
      history.pushState({}, "", "/c/assigned");
      const node = document.createElement("div");
      node.dataset.messageAuthorRole = "assistant";
      node.textContent =
        "a reply arriving after the first conversation gets its URL";
      document.getElementById("chat").append(node);
    });
    await waitFor(
      async () => (await read()).totalTokens > firstTotal,
      "new-chat URL assignment",
    );
    state = await read();
    await pages[0].evaluate(() => {
      history.pushState({}, "", "/c/historical");
      const node = document.createElement("div");
      node.dataset.messageAuthorRole = "user";
      node.textContent = "historical text that should not be counted";
      document.getElementById("chat").replaceChildren(node);
    });
    await pages[0].waitForTimeout(450);
    assert.equal(
      (await read()).totalTokens,
      state.totalTokens,
      "SPA navigation must exclude historical text",
    );
    // Exercise the newer ChatGPT layouts through actual content-script events,
    // worker messages and storage, including contenteditable Enter submission.
    await pages[0].evaluate(() => {
      const composer = document.createElement("div");
      composer.contentEditable = "true";
      composer.setAttribute("role", "textbox");
      document.querySelector("textarea").replaceWith(composer);
    });
    for (const attribute of [
      "data-content-search-unit-key",
      "data-chatgpt-search-unit-key",
    ]) {
      const before = await read();
      await pages[0].getByRole("textbox").fill("Explain solar power");
      await pages[0].getByRole("textbox").press("Enter");
      await pages[0].evaluate((attribute) => {
        const turn = document.createElement("section");
        turn.dataset.turnKey = attribute;
        turn.innerHTML = `<div ${attribute}="${attribute}:0:user"><div data-user-message-bubble>Explain solar power</div></div><div ${attribute}="${attribute}:0:assistant"><p>Solar</p></div>`;
        document.getElementById("chat").append(turn);
      }, attribute);
      await waitFor(
        async () => (await read()).responseTokens > before.responseTokens,
        `${attribute} first response`,
      );
      await pages[0].evaluate((attribute) => {
        document.querySelector(`[data-turn-key="${attribute}"] p`).firstChild.data =
          "Solar panels convert sunlight into electricity";
      }, attribute);
      await waitFor(
        async () => (await read()).responseTokens === before.responseTokens + countTokens("Solar panels convert sunlight into electricity"),
        `${attribute} streaming response`,
      );
      assert.equal((await read()).promptTokens, before.promptTokens + countTokens("Explain solar power"));
    }
    const beforeLateMarker = await read();
    await pages[0].getByRole("button", { name: "Send", exact: true }).click();
    await pages[0].evaluate(() => {
      const node = document.createElement("div");
      node.id = "late-role";
      node.textContent = "A prompt with a late role marker";
      document.getElementById("chat").append(node);
    });
    await pages[0].waitForTimeout(450);
    assert.equal((await read()).totalTokens, beforeLateMarker.totalTokens);
    await pages[0].evaluate(() => {
      document.getElementById("late-role").setAttribute("data-content-search-unit-key", "late:0:user");
    });
    await waitFor(
      async () => (await read()).promptTokens === beforeLateMarker.promptTokens + countTokens("A prompt with a late role marker"),
      "ChatGPT role marker assigned after mounting",
    );
    state = await read();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup
      .locator("#token-summary")
      .filter({ hasText: /[1-9]/ })
      .waitFor();
    await popup.locator("#pause-btn").click();
    await waitFor(async () => (await read()).paused === true, "pause");
    await pages[0].getByRole("button", { name: "Send", exact: true }).click();
    await pages[0].evaluate(() => {
      const node = document.createElement("div");
      node.dataset.messageAuthorRole = "user";
      node.textContent = "excluded while paused";
      document.getElementById("chat").append(node);
    });
    await popup.waitForTimeout(450);
    assert.equal((await read()).totalTokens, state.totalTokens);
    await popup.locator("#pause-btn").click();
    await waitFor(async () => (await read()).paused === false, "resume");
    await pages[0].getByRole("button", { name: "Send", exact: true }).click();
    await pages[0].evaluate(() => {
      const node = document.createElement("div");
      node.dataset.messageAuthorRole = "user";
      node.textContent = "a fresh exchange after resuming";
      document.getElementById("chat").append(node);
    });
    await waitFor(
      async () => (await read()).totalTokens > state.totalTokens,
      "new usage after resume",
    );
    state = await read();
    await popup.locator("#data-details").evaluate((element) => {
      element.open = true;
    });
    const downloadEvent = popup.waitForEvent("download");
    await popup.locator("#export-btn").click();
    const download = await downloadEvent;
    const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.equal(exported.model.id, S.MODEL.id);
    assert.equal(exported.usage.totalTokens, state.totalTokens);
    await popup.locator("#reset-btn").click();
    assert.equal((await read()).totalTokens, state.totalTokens);
    await popup.locator("#confirm-reset-btn").click();
    await waitFor(async () => (await read()).totalTokens === 0, "reset");
    assert.deepEqual((await read()).dailyHistory, {});
    // Seed demonstrative data only inside this disposable test profile.
    const days = S.recentDays();
    const dailyHistory = {};
    const amounts = [3200, 6100, 2000, 7800, 4400, 2900, 2400];
    for (const [i, day] of days.entries()) {
      const total = amounts[i],
        prompt = Math.round(total / 3),
        response = total - prompt;
      dailyHistory[day] = {
        prompt,
        response,
        total,
        platforms: { "chatgpt.com": { prompt, response, total } },
      };
    }
    await worker.evaluate(
      async (dailyHistory) =>
        chrome.storage.local.set({
          totalTokens: 28800,
          promptTokens: 9600,
          responseTokens: 19200,
          dailyHistory,
          platforms: {
            "chatgpt.com": { prompt: 6000, response: 12000, total: 18000 },
            "claude.ai": { prompt: 3600, response: 7200, total: 10800 },
          },
        }),
      dailyHistory,
    );
    await popup.reload();
    await popup.locator("#energy-val").filter({ hasText: "1.2" }).waitFor();
    await popup.evaluate(() => document.fonts.ready);
    await popup.locator("body").screenshot({
      path: path.resolve(__dirname, "../docs/popup.png"),
      animations: "disabled",
    });
    const overviewHeight = await popup
      .locator("body")
      .evaluate((body) => body.getBoundingClientRect().height);
    assert.ok(
      overviewHeight <= 600,
      `everyday view should fit a 600px browser popup, got ${overviewHeight}px`,
    );
    for (const scheme of ["light", "dark"]) {
      await popup.emulateMedia({ colorScheme: scheme });
      await popup.locator("#activity-details").evaluate((element) => {
        element.open = true;
      });
      await popup.locator("#daily-chart button").last().click();
      assert.match(await popup.locator("#chart-readout").innerText(), /1.2 Wh/);
      assert.equal(
        await popup.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        "popup must not overflow horizontally",
      );
      await popup.locator("body").screenshot({
        path: path.resolve(__dirname, `../docs/popup-${scheme}-details.png`),
        animations: "disabled",
      });
    }
    assert.deepEqual(errors, []);
    console.log(
      "Browser checks passed: real extension loading, all three platform fixtures, pause/resume, JSON download, reset, accessible chart controls, and light/dark layouts.",
    );
  } finally {
    await context?.close();
    // This path is created above under the OS temp directory, never user data.
    if (profile.startsWith(path.join(os.tmpdir(), "ecoprompt-browser-")))
      fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
