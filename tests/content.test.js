/** @jest-environment jsdom */
const { createTracker, countTokens, CONFIGS } = require("../src/content");
const { createStore } = require("../src/background");
let tracker, data, listeners, runtime, win;
function message(role, text, id, platform = "chatgpt.com") {
  const node = document.createElement("div");
  if (platform === "chatgpt.com")
    node.dataset.messageAuthorRole = role === "user" ? "user" : "assistant";
  else if (platform === "claude.ai")
    node.dataset.testid =
      role === "user" ? "user-message" : "assistant-message";
  else node.className = role === "user" ? "user-query" : "model-response-text";
  if (id) node.dataset.messageId = id;
  node.textContent = text;
  document.body.append(node);
  return node;
}
async function start(platform = "chatgpt.com") {
  data = {};
  listeners = [];
  const storage = {
    local: {
      get: async () => JSON.parse(JSON.stringify(data)),
      set: async (values) => {
        const changes = Object.fromEntries(
          Object.entries(values)
            .filter(
              ([key, value]) =>
                JSON.stringify(data[key]) !== JSON.stringify(value),
            )
            .map(([key, value]) => [
              key,
              { oldValue: data[key], newValue: value },
            ]),
        );
        data = { ...data, ...JSON.parse(JSON.stringify(values)) };
        for (const listener of listeners) listener(changes, "local");
      },
    },
    onChanged: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => {
        listeners = listeners.filter((item) => item !== fn);
      },
    },
  };
  const store = createStore(storage.local);
  runtime = {
    sendMessage: jest.fn(async (batch) => ({
      ok: true,
      state: await store.dispatch(batch),
    })),
  };
  win = {
    location: { hostname: platform, href: `https://${platform}/new` },
    crypto: { randomUUID: () => "session" },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  tracker = createTracker({ doc: document, win, runtime, storage });
  await tracker.start();
}
async function collect() {
  tracker.scan();
  await tracker.flush();
}
beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  tracker?.stop();
  jest.clearAllTimers();
  jest.useRealTimers();
});
test("token heuristic handles blank text, whitespace, code and unspaced text", () => {
  expect(countTokens("  ")).toBe(0);
  expect(countTokens("hello world")).toBe(3);
  expect(countTokens("hello  \n world")).toBe(3);
  expect(countTokens("x".repeat(400))).toBe(100);
  expect(countTokens("中文".repeat(20))).toBe(10);
});
test.each(Object.keys(CONFIGS))(
  "tracks a new exchange on %s without counting initial history",
  async (platform) => {
    message("user", "old history", "old", platform);
    await start(platform);
    tracker.submitIntent();
    message("user", "hello world", "new", platform);
    message("ai", "useful reply", "reply", platform);
    await collect();
    expect(data.promptTokens).toBe(countTokens("hello world"));
    expect(data.responseTokens).toBe(countTokens("useful reply"));
  },
);
test("late history hydration is excluded until a send action", async () => {
  await start();
  message("user", "history arriving much later");
  await collect();
  expect(data.totalTokens).toBeUndefined();
  tracker.submitIntent();
  message("user", "new question");
  await collect();
  expect(data.totalTokens).toBe(countTokens("new question"));
});
test("scrolling older history into the same conversation does not inflate an active exchange", async () => {
  const anchor = message("ai", "existing answer", "old");
  await start();
  tracker.submitIntent();
  message("user", "new question", "new");
  await collect();
  const total = data.totalTokens;
  const old = message(
    "user",
    "a long historical message that just scrolled into view",
    "older",
  );
  anchor.before(old);
  await collect();
  expect(data.totalTokens).toBe(total);
});
test("streamed text, replacements with stable IDs and nested selectors count once", async () => {
  await start("claude.ai");
  tracker.submitIntent();
  const node = message("ai", "hello", "reply", "claude.ai");
  const child = document.createElement("span");
  child.className = "font-claude-response";
  child.textContent = " there";
  node.append(child);
  await collect();
  const first = data.totalTokens;
  node.textContent = "hello there with more useful detail";
  await collect();
  const final = data.totalTokens;
  expect(final).toBe(countTokens(node.textContent));
  expect(final).toBeGreaterThan(first);
  const clone = node.cloneNode(true);
  node.replaceWith(clone);
  await collect();
  expect(data.totalTokens).toBe(final);
  clone.textContent = "short";
  await collect();
  expect(data.totalTokens).toBe(final);
});
test("DOM mutation observer detects text updates without a manual scan", async () => {
  await start();
  tracker.submitIntent();
  const node = message("ai", "hello");
  await Promise.resolve();
  jest.advanceTimersByTime(100);
  await tracker.flush();
  node.firstChild.data = "hello with a longer response";
  await Promise.resolve();
  jest.advanceTimersByTime(100);
  await tracker.flush();
  expect(data.responseTokens).toBe(countTokens(node.textContent));
});
test("conversation navigation stops counting and ignores hydrated history", async () => {
  await start();
  tracker.submitIntent();
  message("user", "new question");
  await collect();
  const first = data.totalTokens;
  win.location.href = "https://chatgpt.com/c/first";
  tracker.navigation();
  message("ai", "first reply");
  await collect();
  expect(data.totalTokens).toBeGreaterThan(first);
  const total = data.totalTokens;
  win.location.href = "https://chatgpt.com/c/old";
  tracker.navigation();
  message("user", "a historical prompt");
  message("ai", "an old answer");
  await collect();
  expect(data.totalTokens).toBe(total);
});
test("Enter sends, Shift+Enter and composition do not activate tracking", async () => {
  await start();
  const input = document.createElement("textarea");
  document.body.append(input);
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
    }),
  );
  message("user", "excluded");
  await collect();
  expect(data.totalTokens).toBeUndefined();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    }),
  );
  message("user", "also excluded");
  await collect();
  expect(data.totalTokens).toBeUndefined();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  message("user", "counted");
  await collect();
  expect(data.totalTokens).toBe(countTokens("counted"));
});
test("pause and reset notifications discard pending work and baseline visible text", async () => {
  await start();
  tracker.submitIntent();
  message("user", "not yet saved");
  tracker.scan();
  listeners[0]({ epoch: { newValue: 1 } }, "local");
  await tracker.flush();
  expect(data.totalTokens).toBeUndefined();
  listeners[0]({ paused: { newValue: true } }, "local");
  tracker.submitIntent();
  message("ai", "while paused");
  await collect();
  expect(data.totalTokens).toBeUndefined();
});
test("retries use the same batch ID and messages never contain chat text or URLs", async () => {
  await start();
  tracker.submitIntent();
  message("user", "a private secret");
  runtime.sendMessage.mockRejectedValueOnce(new Error("worker restarted"));
  await collect();
  const calls = runtime.sendMessage.mock.calls
    .filter(([msg]) => msg.type === "TRACK")
    .map(([msg]) => msg);
  expect(calls).toHaveLength(2);
  expect(calls[0].id).toBe(calls[1].id);
  expect(Object.keys(calls[0]).sort()).toEqual([
    "epoch",
    "id",
    "platform",
    "prompt",
    "response",
    "type",
  ]);
  expect(JSON.stringify(calls)).not.toContain("private");
});
