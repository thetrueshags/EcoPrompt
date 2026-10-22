/**
 * @jest-environment jsdom
 *
 * Tests for the popup UI (popup.js + popup.html).
 */

const fs = require("fs");
const path = require("path");

// ── jsdom innerText polyfill ─────────────────────────────────────────────────
if (!HTMLElement.prototype.hasOwnProperty("innerText")) {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    set(value) { this.textContent = value; },
    configurable: true,
  });
}

// ── Chrome storage mock ──────────────────────────────────────────────────────

let mockStorage = {};
let onChangedListeners = [];

global.chrome = {
  storage: {
    local: {
      get: jest.fn((keys, cb) => cb({ ...mockStorage })),
      set: jest.fn((updates, cb) => {
        const changes = {};
        for (const [key, val] of Object.entries(updates)) {
          changes[key] = { oldValue: mockStorage[key], newValue: val };
        }
        Object.assign(mockStorage, updates);
        for (const listener of onChangedListeners) {
          listener(changes, "local");
        }
        if (cb) cb();
      }),
    },
    onChanged: {
      addListener: jest.fn((fn) => onChangedListeners.push(fn)),
    },
  },
};

let animStartTime = 0;
global.performance = { now: jest.fn(() => animStartTime) };
global.requestAnimationFrame = jest.fn((cb) => {
  cb(animStartTime + 10000);
});

// Stub URL.createObjectURL / revokeObjectURL for export button test
global.URL.createObjectURL = jest.fn(() => "blob:mock-url");
global.URL.revokeObjectURL = jest.fn();
global.Blob = class Blob {
  constructor(parts, opts) { this.parts = parts; this.opts = opts; }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const popupHtml = fs.readFileSync(path.resolve(__dirname, "../src/popup.html"), "utf-8");
const popupJs = fs.readFileSync(path.resolve(__dirname, "../src/popup.js"), "utf-8");

function loadPopup(storage = {}) {
  const defaults = { totalTokens: 0, promptTokens: 0, responseTokens: 0, platforms: {}, dailyHistory: {} };
  mockStorage = { ...defaults, ...storage };
  onChangedListeners = [];
  chrome.storage.local.get.mockClear();
  chrome.storage.local.set.mockClear();
  chrome.storage.onChanged.addListener.mockClear();
  chrome.storage.local.get.mockImplementation((_, cb) => cb({ ...mockStorage }));
  global.requestAnimationFrame.mockClear();
  animStartTime = Date.now();

  document.documentElement.innerHTML = popupHtml;

  const origAEL = document.addEventListener.bind(document);
  document.addEventListener = (event, handler, ...rest) => {
    if (event === "DOMContentLoaded") {
      handler();
    } else {
      origAEL(event, handler, ...rest);
    }
  };
  eval(popupJs);
  document.addEventListener = origAEL;
}

function parseDisplayedInt(id) {
  return parseInt(document.getElementById(id).textContent.replace(/[^\d]/g, ""), 10) || 0;
}

// ── Constants matching popup.js (prefixed to avoid collision with eval scope) ─

const TEST_WH = 0.0005;
const TEST_GCO2 = TEST_WH / 1000 * 450; // 0.000225

// ════════════════════════════════════════════════════════════════════════════
// 1. Initial state
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: initial state with zero tokens", () => {
  beforeEach(() => loadPopup());

  it("shows 0 total tokens", () => {
    expect(parseDisplayedInt("token-count")).toBe(0);
  });

  it("shows 0 input tokens", () => {
    expect(parseDisplayedInt("input-count")).toBe(0);
  });

  it("shows 0 output tokens", () => {
    expect(parseDisplayedInt("output-count")).toBe(0);
  });

  it("shows '0 mins' for bulb time", () => {
    expect(document.getElementById("bulb-time").textContent).toBe("0 mins");
  });

  it("shows 0.000 for energy", () => {
    expect(document.getElementById("energy-val").textContent).toBe("0.000");
  });

  it("shows 0 for CO₂", () => {
    expect(parseFloat(document.getElementById("co2-val").textContent)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Formula accuracy
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: formula accuracy", () => {
  it("displays correct token counts for input and output", () => {
    loadPopup({ totalTokens: 1500, promptTokens: 500, responseTokens: 1000 });

    expect(parseDisplayedInt("token-count")).toBe(1500);
    expect(parseDisplayedInt("input-count")).toBe(500);
    expect(parseDisplayedInt("output-count")).toBe(1000);
  });

  it("energy formula: tokens × 0.0005 Wh", () => {
    loadPopup({ totalTokens: 10000, promptTokens: 5000, responseTokens: 5000 });
    expect(document.getElementById("energy-val").textContent).toBe("5.000");
  });

  it("water formula: switches to liters at 1000 ml", () => {
    loadPopup({ totalTokens: 1000000, promptTokens: 500000, responseTokens: 500000 });
    expect(document.getElementById("water-unit").textContent).toContain("Liter");
  });

  it("CO₂ formula: tokens × TEST_GCO2", () => {
    const tokens = 10000;
    loadPopup({ totalTokens: tokens, promptTokens: 5000, responseTokens: 5000 });
    const expected = tokens * TEST_GCO2;
    const displayed = parseFloat(document.getElementById("co2-val").textContent);
    expect(displayed).toBeCloseTo(expected, 1);
  });

  it("CO₂ switches to kg at 1000g", () => {
    // 1000g CO₂ ≈ 4,444,444 tokens
    loadPopup({ totalTokens: 5000000, promptTokens: 2500000, responseTokens: 2500000 });
    expect(document.getElementById("co2-unit").textContent).toContain("kg");
  });

  it("bulb time shows seconds when under 1 minute", () => {
    loadPopup({ totalTokens: 150, promptTokens: 75, responseTokens: 75 });
    expect(document.getElementById("bulb-time").textContent).toContain("seconds");
  });

  it("bulb time shows hours for heavy usage", () => {
    loadPopup({ totalTokens: 100000, promptTokens: 50000, responseTokens: 50000 });
    expect(document.getElementById("bulb-time").textContent).toContain("hours");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Reset button
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: reset button", () => {
  it("resets global totals and platforms to zero, keeps dailyHistory", () => {
    loadPopup({
      totalTokens: 5000, promptTokens: 2000, responseTokens: 3000,
      platforms: { "claude.ai": { prompt: 2000, response: 3000, total: 5000 } },
      dailyHistory: { "2026-04-05": { prompt: 100, response: 200, total: 300 } },
    });
    chrome.storage.local.set.mockClear();

    document.getElementById("reset-btn").click();

    const setCall = chrome.storage.local.set.mock.calls[0][0];
    expect(setCall.totalTokens).toBe(0);
    expect(setCall.promptTokens).toBe(0);
    expect(setCall.responseTokens).toBe(0);
    expect(setCall.platforms).toEqual({});
    // dailyHistory should NOT be cleared by reset
    expect(setCall.dailyHistory).toBeUndefined();
  });

  it("UI shows zeros after reset", () => {
    loadPopup({ totalTokens: 5000, promptTokens: 2000, responseTokens: 3000 });
    document.getElementById("reset-btn").click();

    expect(parseDisplayedInt("token-count")).toBe(0);
    expect(parseDisplayedInt("input-count")).toBe(0);
    expect(parseDisplayedInt("output-count")).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Platform breakdown
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: platform breakdown", () => {
  it("hides platform section when no platform data exists", () => {
    loadPopup({ totalTokens: 100, promptTokens: 50, responseTokens: 50 });
    expect(document.getElementById("platform-section").style.display).toBe("none");
  });

  it("shows platform section when platform data exists", () => {
    loadPopup({
      totalTokens: 1000, promptTokens: 500, responseTokens: 500,
      platforms: { "claude.ai": { prompt: 500, response: 500, total: 1000 } },
    });
    expect(document.getElementById("platform-section").style.display).not.toBe("none");
  });

  it("renders a row for each platform with data", () => {
    loadPopup({
      totalTokens: 2000, promptTokens: 1000, responseTokens: 1000,
      platforms: {
        "claude.ai": { prompt: 300, response: 400, total: 700 },
        "chatgpt.com": { prompt: 200, response: 100, total: 300 },
      },
    });

    const rows = document.querySelectorAll("#platform-bars .platform-row");
    expect(rows.length).toBe(2);
  });

  it("sorts platforms by total tokens descending", () => {
    loadPopup({
      totalTokens: 2000, promptTokens: 1000, responseTokens: 1000,
      platforms: {
        "chatgpt.com": { prompt: 100, response: 100, total: 200 },
        "claude.ai": { prompt: 500, response: 500, total: 1000 },
        "gemini.google.com": { prompt: 300, response: 300, total: 600 },
      },
    });

    const names = Array.from(document.querySelectorAll("#platform-bars .platform-name"))
      .map((el) => el.textContent);
    expect(names).toEqual(["Claude", "Gemini", "ChatGPT"]);
  });

  it("displays the correct label for each platform", () => {
    loadPopup({
      totalTokens: 500, promptTokens: 250, responseTokens: 250,
      platforms: { "gemini.google.com": { prompt: 250, response: 250, total: 500 } },
    });

    const name = document.querySelector("#platform-bars .platform-name").textContent;
    expect(name).toBe("Gemini");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Daily chart
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: 7-day chart", () => {
  it("renders 7 chart columns", () => {
    loadPopup();
    const cols = document.querySelectorAll("#daily-chart .chart-col");
    expect(cols.length).toBe(7);
  });

  it("renders 7 day labels", () => {
    loadPopup();
    const labels = document.querySelectorAll("#chart-labels .chart-label");
    expect(labels.length).toBe(7);
  });

  it("today's bar reflects today's daily history data", () => {
    const today = new Date();
    const todayKey = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');

    loadPopup({
      totalTokens: 500, promptTokens: 200, responseTokens: 300,
      dailyHistory: {
        [todayKey]: { prompt: 200, response: 300, total: 500 },
      },
    });

    // The last chart column (index 6) should be today
    const cols = document.querySelectorAll("#daily-chart .chart-col");
    const lastCol = cols[6];
    const bars = lastCol.querySelectorAll(".chart-bar");
    // Should have prompt + response bars
    expect(bars.length).toBe(2);
    // At least one should have non-zero height
    const hasHeight = Array.from(bars).some((b) => parseFloat(b.style.height) > 0);
    expect(hasHeight).toBe(true);
  });

  it("shows empty bars for days with no data", () => {
    loadPopup({ dailyHistory: {} });

    const cols = document.querySelectorAll("#daily-chart .chart-col");
    cols.forEach((col) => {
      const bars = col.querySelectorAll(".chart-bar");
      bars.forEach((bar) => {
        expect(parseFloat(bar.style.height)).toBe(0);
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Export button
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: export button", () => {
  it("export button exists in the UI", () => {
    loadPopup();
    expect(document.getElementById("export-btn")).not.toBeNull();
  });

  it("clicking export triggers a storage read", () => {
    loadPopup();
    chrome.storage.local.get.mockClear();
    document.getElementById("export-btn").click();
    expect(chrome.storage.local.get).toHaveBeenCalledWith(null, expect.any(Function));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Live updates
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: live updates via chrome.storage.onChanged", () => {
  it("registers a storage change listener", () => {
    loadPopup();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it("updates token counts when storage changes", () => {
    loadPopup();

    mockStorage = { totalTokens: 100, promptTokens: 40, responseTokens: 60, platforms: {}, dailyHistory: {} };
    chrome.storage.local.get.mockImplementation((_, cb) => cb({ ...mockStorage }));
    for (const listener of onChangedListeners) listener({ totalTokens: {} }, "local");

    expect(parseDisplayedInt("token-count")).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Disclaimer toggle
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: disclaimer toggle", () => {
  it("disclaimer hidden by default", () => {
    loadPopup();
    expect(document.getElementById("disclaimer-text").style.display).not.toBe("block");
  });

  it("clicking toggle shows disclaimer", () => {
    loadPopup();
    document.getElementById("disclaimer-toggle").click();
    expect(document.getElementById("disclaimer-text").style.display).toBe("block");
  });

  it("clicking toggle twice hides disclaimer", () => {
    loadPopup();
    document.getElementById("disclaimer-toggle").click();
    document.getElementById("disclaimer-toggle").click();
    expect(document.getElementById("disclaimer-text").style.display).toBe("none");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Display consistency
// ════════════════════════════════════════════════════════════════════════════

describe("Popup: display consistency", () => {
  it("total displayed equals input + output", () => {
    loadPopup({ totalTokens: 7500, promptTokens: 3000, responseTokens: 4500 });
    expect(parseDisplayedInt("token-count")).toBe(
      parseDisplayedInt("input-count") + parseDisplayedInt("output-count")
    );
  });

  it("energy display matches tokens × TEST_WH", () => {
    loadPopup({ totalTokens: 50000, promptTokens: 25000, responseTokens: 25000 });
    const displayed = parseFloat(document.getElementById("energy-val").textContent);
    expect(displayed).toBeCloseTo(50000 * TEST_WH, 3);
  });

  it("CO₂ display matches tokens × TEST_GCO2", () => {
    loadPopup({ totalTokens: 50000, promptTokens: 25000, responseTokens: 25000 });
    const displayed = parseFloat(document.getElementById("co2-val").textContent);
    expect(displayed).toBeCloseTo(50000 * TEST_GCO2, 0);
  });
});
