/** @jest-environment jsdom */

// Exercise the content script through real DOM mutations, including streaming.
const NativeMutationObserver = window.MutationObserver;
let observers;
let storage;
let tracker;

beforeEach(() => {
  jest.useFakeTimers();
  delete window.location;
  window.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/c/test" };
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  document.body.innerHTML = "";
  storage = {};
  global.chrome = {
    storage: { local: {
      get: jest.fn((_, callback) => callback({ ...storage })),
      set: jest.fn((updates) => Object.assign(storage, updates)),
    } },
  };
  observers = [];
  global.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  jest.isolateModules(() => { tracker = require("../src/content.js"); });
  jest.advanceTimersByTime(2000);
});

afterEach(() => {
  observers.forEach((observer) => observer.disconnect());
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(1);
}

describe("ChatGPT layout compatibility", () => {
  it.each(["data-message-author-role", "data-content-search-unit-key", "data-chatgpt-search-unit-key"])(
    "tracks prompts and streaming replies with %s",
    async (attribute) => {
      const roleValue = (role) => attribute === "data-message-author-role" ? role : `turn:0:${role}`;
      document.body.innerHTML = `<div ${attribute}="${roleValue("user")}">Explain solar power</div>
        <div ${attribute}="${roleValue("assistant")}"><p>Solar</p></div>`;
      await flush();
      document.querySelector("p").firstChild.data = "Solar panels convert sunlight into electricity";
      await flush();

      expect(storage.promptTokens).toBe(tracker.countTokens("Explain solar power"));
      expect(storage.responseTokens).toBe(tracker.countTokens("Solar panels convert sunlight into electricity"));
      expect(storage.platforms["chatgpt.com"].total).toBe(storage.totalTokens);
      expect(storage.dailyHistory[tracker.getTodayKey()].total).toBe(storage.totalTokens);
    },
  );

  it("counts overlapping legacy and new markers once per message", async () => {
    document.body.innerHTML = `
      <div data-turn-key="turn-1">
        <div data-content-search-unit-key="turn-1:0:user">
          <div data-chatgpt-search-unit-key="turn-1:0:user">
            <div data-message-author-role="user"><div data-user-message-bubble="true">Explain solar power</div></div>
          </div>
        </div>
        <div data-content-search-unit-key="turn-1:0:assistant">
          <div data-chatgpt-search-unit-key="turn-1:0:assistant">
            <div data-message-author-role="assistant">Solar panels convert sunlight</div>
          </div>
        </div>
      </div>`;
    await flush();
    expect(storage.promptTokens).toBe(tracker.countTokens("Explain solar power"));
    expect(storage.responseTokens).toBe(tracker.countTokens("Solar panels convert sunlight"));
  });

  it("recognizes a user bubble without legacy role attributes", async () => {
    document.body.innerHTML = '<div data-turn-key="turn-1"><div data-user-message-bubble="true">Hello world</div></div>';
    await flush();
    expect(storage.promptTokens).toBe(tracker.countTokens("Hello world"));
  });

  it("detects role markers assigned after an element is mounted", async () => {
    const user = document.createElement("div");
    user.textContent = "Hello world";
    document.body.appendChild(user);
    await flush();
    user.setAttribute("data-content-search-unit-key", "turn-1:0:user");
    await flush();
    expect(storage.promptTokens).toBe(tracker.countTokens("Hello world"));
  });

  it("does not count existing history or its later streaming mutations", async () => {
    document.body.innerHTML = '<div data-content-search-unit-key="old:0:user">Old question</div><div data-content-search-unit-key="old:0:assistant"><p>Old reply</p></div>';
    tracker.markPreExistingMessages();
    await flush();
    document.querySelector("p").firstChild.data = "Old reply loaded later";
    await flush();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("ignores history mounted during navigation, then counts a new exchange", async () => {
    tracker.onNavigate();
    document.body.innerHTML = '<div data-content-search-unit-key="old:0:user">Old question</div><div data-content-search-unit-key="old:0:assistant">Old reply</div>';
    await flush();
    jest.advanceTimersByTime(500);
    document.body.insertAdjacentHTML("beforeend", '<div data-content-search-unit-key="new:0:user">New question</div><div data-content-search-unit-key="new:0:assistant">New reply</div>');
    await flush();
    expect(storage.promptTokens).toBe(tracker.countTokens("New question"));
    expect(storage.responseTokens).toBe(tracker.countTokens("New reply"));
  });
});
