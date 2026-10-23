/** @jest-environment jsdom */
const fs = require("fs");
const S = require("../src/shared");
const { createStore } = require("../src/background");
const { init, selectUsage, quantity, exportData } = require("../src/popup");
const html = fs.readFileSync(
  require("path").join(__dirname, "../src/popup.html"),
  "utf8",
);
const today = S.dateKey();
const yesterday = S.recentDays()[5];
const sample = () =>
  S.normalize({
    totalTokens: 9000,
    promptTokens: 3000,
    responseTokens: 6000,
    platforms: { "chatgpt.com": { prompt: 3000, response: 6000, total: 9000 } },
    dailyHistory: {
      [today]: {
        prompt: 1000,
        response: 2000,
        total: 3000,
        platforms: {
          "chatgpt.com": { prompt: 1000, response: 2000, total: 3000 },
        },
      },
      [yesterday]: { prompt: 500, response: 500, total: 1000 },
    },
  });
let data, api;
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function load(initial = sample()) {
  document.documentElement.innerHTML = html;
  data = initial;
  const store = createStore({
    get: async () => JSON.parse(JSON.stringify(data)),
    set: async (value) => {
      data = value;
    },
  });
  api = {
    runtime: {
      sendMessage: jest.fn(async (msg) => ({
        ok: true,
        state: await store.dispatch(msg),
      })),
      getManifest: () => ({ version: "1.3" }),
    },
    storage: { onChanged: { addListener: jest.fn() } },
  };
  init(document, api);
  await settle();
}
const text = (id) => document.getElementById(id).textContent;
const click = (id) => document.getElementById(id).click();
test("today, week and all time use the same period for totals and platform details", async () => {
  await load();
  expect(text("token-count")).toBe((3000).toLocaleString());
  expect(text("energy-val")).toBe(quantity(1.5, "Wh", "kWh").value);
  document.querySelector('[data-period="week"]').click();
  expect(text("token-count")).toBe((4000).toLocaleString());
  expect(text("legacy-note")).toContain("Earlier");
  expect(document.getElementById("legacy-note").hidden).toBe(false);
  document.querySelector('[data-period="all"]').click();
  expect(text("token-count")).toBe((9000).toLocaleString());
  expect(text("platform-period")).toBe("All time");
  expect(document.getElementById("legacy-note").hidden).toBe(true);
});
test("first-use state explains supported services and details start collapsed", async () => {
  await load(S.normalize());
  expect(document.getElementById("empty-state").hidden).toBe(false);
  expect(text("empty-copy")).toContain("ChatGPT");
  expect(document.querySelectorAll("details[open]")).toHaveLength(0);
  expect(text("energy-val")).toBe("0");
});
test("clearing data requires inline confirmation and clears every period", async () => {
  await load();
  click("reset-btn");
  expect(data.totalTokens).toBe(9000);
  click("cancel-reset-btn");
  expect(document.getElementById("reset-confirm").hidden).toBe(true);
  click("reset-btn");
  click("confirm-reset-btn");
  await settle();
  expect(data).toMatchObject({
    totalTokens: 0,
    dailyHistory: {},
    platforms: {},
    epoch: 1,
  });
  expect(text("token-count")).toBe("0");
  expect(text("feedback")).toContain("cleared");
});
test("pause and resume persist globally and update the visible state", async () => {
  await load();
  click("pause-btn");
  await settle();
  expect(data.paused).toBe(true);
  expect(text("pause-btn")).toBe("Resume");
  expect(text("tracking-status")).toContain("paused");
  click("pause-btn");
  await settle();
  expect(data.paused).toBe(false);
  expect(text("pause-btn")).toBe("Pause");
});
test("daily bars are keyboard-accessible buttons with explicit numeric labels", async () => {
  await load();
  const bars = document.querySelectorAll("#daily-chart button");
  expect(bars).toHaveLength(7);
  bars[6].click();
  expect(text("chart-readout")).toContain(
    `${quantity(1.5, "Wh", "kWh").value} Wh`,
  );
  expect(bars[6].getAttribute("aria-pressed")).toBe("true");
});
test("storage failures are visible and controls recover", async () => {
  await load();
  api.runtime.sendMessage.mockRejectedValueOnce(
    new Error("Storage unavailable"),
  );
  click("pause-btn");
  await settle();
  expect(text("feedback")).toBe("Storage unavailable");
  expect(document.getElementById("pause-btn").disabled).toBe(false);
});
test("export is self-describing, omits internal IDs and retains only recent history", () => {
  const state = sample();
  state.recentBatches = ["random-id"];
  state.dailyHistory["2000-01-01"] = { total: 1 };
  const data = exportData(state);
  expect(data.model.whPerToken).toBe(0.0005);
  expect(data.usage.totalTokens).toBe(9000);
  expect(data.usage.recentBatches).toBeUndefined();
  expect(data.usage.epoch).toBeUndefined();
  expect(data.usage.dailyHistory["2000-01-01"]).toBeUndefined();
});
test("export button downloads fresh data and includes assumptions", async () => {
  await load();
  global.URL.createObjectURL = jest.fn(() => "blob:mock");
  global.URL.revokeObjectURL = jest.fn();
  const anchor = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  click("export-btn");
  await settle();
  expect(URL.createObjectURL).toHaveBeenCalled();
  expect(anchor).toHaveBeenCalled();
  expect(text("feedback")).toContain("assumptions");
  anchor.mockRestore();
});
test("tiny nonzero estimates stay visible and large quantities switch units", () => {
  expect(quantity(0.0005, "Wh", "kWh")).toEqual({ value: "<0.01", unit: "Wh" });
  expect(quantity(2500, "mL", "L")).toEqual({
    value: new Intl.NumberFormat(undefined, {
      maximumSignificantDigits: 2,
    }).format(2.5),
    unit: "L",
  });
});
test("period boundaries use local days and exclude older activity from the week", () => {
  const result = selectUsage(
    S.normalize({
      totalTokens: 400,
      dailyHistory: {
        "2026-10-14": { total: 100 },
        "2026-10-08": { total: 200 },
        "2026-10-07": { total: 100 },
      },
    }),
    "week",
    new Date(2026, 9, 14),
  );
  expect(result.total).toBe(300);
});
