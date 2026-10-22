/**
 * @jest-environment jsdom
 *
 * Comprehensive test suite for EcoPrompt content script.
 *
 * Tests are written around OBSERVABLE BEHAVIOUR — what ends up in
 * chrome.storage.  Internal-state checks are used only where no storage-level
 * observable exists.
 *
 * The content script now batches storage writes: updateStorage() accumulates
 * deltas in memory and flushes them in a single chrome.storage read-modify-write
 * on the next tick (setTimeout 0).  Tests call flushStorageWrites() to trigger
 * the flush before asserting on storage state.
 */

// ── Mocks (before require so module-level code sees them) ────────────────────

delete window.location;
window.location = { hostname: "claude.ai", href: "https://claude.ai/new" };

// Accumulate per-write storage so tests can inspect the running total.
let mockStorage = {};
global.chrome = {
  storage: {
    local: {
      get: jest.fn((_, cb) => cb({ ...mockStorage })),
      set: jest.fn((updates, cb) => {
        Object.assign(mockStorage, updates);
        if (cb) cb();
      }),
    },
  },
};

// Controllable MutationObserver.  Call .trigger(mutations) to simulate DOM changes.
let observers = [];
global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.connected = false;
    observers.push(this);
  }
  observe(target) { this.target = target; this.connected = true; }
  disconnect() { this.connected = false; }
  trigger(mutations) { this.cb(mutations, this); }
};

jest.useFakeTimers();

const {
  countTokens,
  CONFIGS,
  monitorUserMessage,
  monitorAIResponse,
  markPreExistingMessages,
  handleNode,
  onNavigate,
  checkUrlChange,
  flushPendingDeltas,
  getPlatformKey,
  getTodayKey,
  AI_IDLE_TIMEOUT,
  DAILY_HISTORY_RETENTION_DAYS,
  _getSessionInitialized,
  _setSessionInitialized,
  _getLastUrl,
  _setLastUrl,
  _resetFlush,
} = require("../src/content.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Advance fake timers enough to trigger the batched storage flush (setTimeout 0). */
function flushStorageWrites() {
  jest.advanceTimersByTime(1);
}

function userEl(text = "hello world") {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "user-message");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

function aiEl(text = "hello world") {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "assistant-message");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** ChatGPT-style user message element. */
function chatgptUserEl(text = "hello world") {
  const el = document.createElement("div");
  el.setAttribute("data-message-author-role", "user");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** ChatGPT-style AI message element. */
function chatgptAiEl(text = "hello world") {
  const el = document.createElement("div");
  el.setAttribute("data-message-author-role", "assistant");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** Gemini-style user message element. */
function geminiUserEl(text = "hello world") {
  const el = document.createElement("div");
  el.classList.add("query-text");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** Gemini-style AI message element. */
function geminiAiEl(text = "hello world") {
  const el = document.createElement("div");
  el.classList.add("model-response-text");
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

/** Read the cumulative prompt tokens from the last storage set call. */
function storedPromptTokens() {
  return mockStorage.promptTokens || 0;
}

/** Read the cumulative response tokens from the last storage set call. */
function storedResponseTokens() {
  return mockStorage.responseTokens || 0;
}

/** Read the cumulative total tokens from the last storage set call. */
function storedTotalTokens() {
  return mockStorage.totalTokens || 0;
}

/** Count how many times chrome.storage.local.set was called. */
function storageSetCallCount() {
  return chrome.storage.local.set.mock.calls.length;
}

// ── Reset between tests ──────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllTimers();
  _resetFlush();

  mockStorage = {};
  chrome.storage.local.get.mockClear();
  chrome.storage.local.set.mockClear();
  chrome.storage.local.get.mockImplementation((_, cb) => cb({ ...mockStorage }));

  document.body.innerHTML = "";
  observers = [];

  _setSessionInitialized(true);
  _setLastUrl("https://claude.ai/new");
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Token counting formula
// ════════════════════════════════════════════════════════════════════════════

describe("countTokens — token estimation formula", () => {
  it("returns 0 for blank / missing input", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("   ")).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  it("estimates ceil(words × 1.3)", () => {
    expect(countTokens("Hello")).toBe(2);              // ceil(1 × 1.3) = 2
    expect(countTokens("Hello world")).toBe(3);        // ceil(2 × 1.3) = 3
    expect(countTokens("one two three four")).toBe(6); // ceil(4 × 1.3) = 6
  });

  it("is not sensitive to extra whitespace", () => {
    expect(countTokens("  hello   world  ")).toBe(countTokens("hello world"));
  });

  it("handles single-character input", () => {
    expect(countTokens("x")).toBe(2); // ceil(1 × 1.3) = 2
  });

  it("handles a long paragraph", () => {
    const longText = "word ".repeat(100).trim(); // 100 words
    expect(countTokens(longText)).toBe(Math.ceil(100 * 1.3)); // 130
  });

  it("handles text with special characters and emoji", () => {
    const text = "Hello 🌍! How's it going? #test";
    const words = text.trim().split(/\s+/).length; // 5
    expect(countTokens(text)).toBe(Math.ceil(words * 1.3));
  });

  it("handles text with code-like content", () => {
    const code = "function foo() { return bar; }";
    const words = code.trim().split(/\s+/).length; // 5
    expect(countTokens(code)).toBe(Math.ceil(words * 1.3));
  });

  it("handles newlines as whitespace", () => {
    expect(countTokens("hello\nworld")).toBe(countTokens("hello world"));
    expect(countTokens("hello\n\n\nworld")).toBe(countTokens("hello world"));
  });

  it("handles tabs as whitespace", () => {
    expect(countTokens("hello\tworld")).toBe(countTokens("hello world"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Platform selector coverage
// ════════════════════════════════════════════════════════════════════════════

describe("CONFIGS — platform selectors", () => {
  it("covers all three supported platforms", () => {
    ["gemini.google.com", "chatgpt.com", "claude.ai"].forEach((host) => {
      expect(CONFIGS[host]).toBeDefined();
      expect(typeof CONFIGS[host].user).toBe("string");
      expect(typeof CONFIGS[host].ai).toBe("string");
    });
  });

  it("each platform has non-empty user and ai selectors", () => {
    for (const [host, config] of Object.entries(CONFIGS)) {
      expect(config.user.length).toBeGreaterThan(0);
      expect(config.ai.length).toBeGreaterThan(0);
    }
  });

  it("Claude selectors match [data-testid='user-message'] and [data-testid='assistant-message']", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "user-message");
    expect(el.matches(CONFIGS["claude.ai"].user)).toBe(true);

    const ai = document.createElement("div");
    ai.setAttribute("data-testid", "assistant-message");
    expect(ai.matches(CONFIGS["claude.ai"].ai)).toBe(true);
  });

  it("ChatGPT selectors match data-message-author-role attributes", () => {
    const el = document.createElement("div");
    el.setAttribute("data-message-author-role", "user");
    expect(el.matches(CONFIGS["chatgpt.com"].user)).toBe(true);

    const ai = document.createElement("div");
    ai.setAttribute("data-message-author-role", "assistant");
    expect(ai.matches(CONFIGS["chatgpt.com"].ai)).toBe(true);
  });

  it("Gemini selectors match class-based elements", () => {
    const user = document.createElement("div");
    user.classList.add("query-text");
    expect(user.matches(CONFIGS["gemini.google.com"].user)).toBe(true);

    const ai = document.createElement("div");
    ai.classList.add("model-response-text");
    expect(ai.matches(CONFIGS["gemini.google.com"].ai)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. New user messages are counted once, in full
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: new user messages are counted", () => {
  it("counts tokens and writes them to storage when a user sends a message", () => {
    const el = userEl("Explain quantum entanglement");
    monitorUserMessage(el);
    flushStorageWrites();

    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(storedPromptTokens()).toBeGreaterThan(0);
  });

  it("the stored prompt token count matches the estimated token count for that text", () => {
    const text = "Why is the sky blue";
    const el = userEl(text);
    monitorUserMessage(el);
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens(text));
  });

  it("an empty message node does not write anything to storage", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "user-message");
    el.textContent = "";
    document.body.appendChild(el);

    monitorUserMessage(el);
    flushStorageWrites();

    expect(storageSetCallCount()).toBe(0);
  });

  it("calling monitorUserMessage twice on the same node does not double-count", () => {
    const el = userEl("Hello world");
    monitorUserMessage(el);
    monitorUserMessage(el);
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens("Hello world"));
    expect(storageSetCallCount()).toBe(1);
  });

  it("counts tokens when text content arrives after a short delay (streaming user message)", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "user-message");
    el.textContent = "";
    document.body.appendChild(el);

    monitorUserMessage(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);

    el.textContent = "Hello from the user";
    // Trigger the per-node MutationObserver that was set up for late-arriving text
    const nodeObserver = observers[observers.length - 1];
    nodeObserver.trigger([{ type: "characterData" }]);
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens("Hello from the user"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. AI streaming responses accumulate deltas only
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: AI streaming responses count only new tokens each update", () => {
  it("stores tokens when the AI starts a response", () => {
    const el = aiEl("The answer is 42");
    monitorAIResponse(el);
    flushStorageWrites();

    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(storedResponseTokens()).toBeGreaterThan(0);
  });

  it("total response tokens stored equals the final response token count, not the sum of each update", () => {
    const el = aiEl("Hello");
    monitorAIResponse(el);

    el.textContent = "Hello there";
    observers[observers.length - 1].trigger([{ type: "characterData" }]);

    el.textContent = "Hello there friend";
    observers[observers.length - 1].trigger([{ type: "characterData" }]);

    flushStorageWrites();

    expect(storedResponseTokens()).toBe(countTokens("Hello there friend"));
  });

  it("does not re-count tokens that were already stored in a previous streaming update", () => {
    const el = aiEl("First part");
    monitorAIResponse(el);
    flushStorageWrites();
    const afterFirstUpdate = storedResponseTokens();

    el.textContent = "First part second part";
    observers[observers.length - 1].trigger([{ type: "characterData" }]);
    flushStorageWrites();

    const delta = storedResponseTokens() - afterFirstUpdate;
    expect(delta).toBe(
      countTokens("First part second part") - countTokens("First part")
    );
  });

  it("does not double-count if monitorAIResponse is called again on the same node", () => {
    const el = aiEl("The answer");
    monitorAIResponse(el);
    monitorAIResponse(el);
    flushStorageWrites();

    expect(storedResponseTokens()).toBe(countTokens("The answer"));
    expect(storageSetCallCount()).toBe(1);
  });

  it("handles a multi-step streaming response accurately", () => {
    const el = aiEl("A");
    monitorAIResponse(el);

    const steps = ["A B", "A B C", "A B C D", "A B C D E"];
    for (const step of steps) {
      el.textContent = step;
      observers[observers.length - 1].trigger([{ type: "characterData" }]);
    }

    flushStorageWrites();

    // Total should be the final text counted once
    expect(storedResponseTokens()).toBe(countTokens("A B C D E"));
  });

  it("does not count negative deltas if text shrinks (AI edit/rewrite)", () => {
    const el = aiEl("Hello world foo bar");
    monitorAIResponse(el);
    flushStorageWrites();
    const before = storedResponseTokens();

    el.textContent = "Hello"; // text shrinks
    observers[observers.length - 1].trigger([{ type: "characterData" }]);
    flushStorageWrites();

    // Should not decrease
    expect(storedResponseTokens()).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Pre-existing messages (already in DOM) are never counted
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: messages present when the extension loads are ignored", () => {
  it("user messages in the DOM before markPreExistingMessages() are not counted", () => {
    const el = userEl("Old conversation message");
    markPreExistingMessages();

    monitorUserMessage(el);
    flushStorageWrites();

    expect(storageSetCallCount()).toBe(0);
  });

  it("AI messages in the DOM before markPreExistingMessages() are not counted", () => {
    const el = aiEl("Old AI response");
    markPreExistingMessages();

    monitorAIResponse(el);
    flushStorageWrites();

    expect(storageSetCallCount()).toBe(0);
  });

  it("a message added AFTER markPreExistingMessages() IS counted", () => {
    markPreExistingMessages();
    const el = userEl("Brand new question");

    monitorUserMessage(el);
    flushStorageWrites();

    expect(storedPromptTokens()).toBeGreaterThan(0);
  });

  it("does not count messages when sessionInitialized is false (startup grace period)", () => {
    _setSessionInitialized(false);
    monitorUserMessage(userEl("too early"));
    monitorAIResponse(aiEl("too early"));
    flushStorageWrites();

    expect(storageSetCallCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Batch DOM updates — all messages in a container must be processed
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: all messages in a batch DOM update are processed", () => {
  it("counts tokens for every user message in a container, not just the first", () => {
    const container = document.createElement("div");

    ["First question", "Second question", "Third question"].forEach((text) => {
      const msg = document.createElement("div");
      msg.setAttribute("data-testid", "user-message");
      msg.textContent = text;
      container.appendChild(msg);
    });
    document.body.appendChild(container);

    handleNode(container);
    flushStorageWrites();

    const expectedTotal =
      countTokens("First question") +
      countTokens("Second question") +
      countTokens("Third question");

    expect(storedPromptTokens()).toBe(expectedTotal);
  });

  it("counts tokens for every AI message in a container, not just the first", () => {
    const container = document.createElement("div");

    ["Reply one", "Reply two"].forEach((text) => {
      const msg = document.createElement("div");
      msg.setAttribute("data-testid", "assistant-message");
      msg.textContent = text;
      container.appendChild(msg);
    });
    document.body.appendChild(container);

    handleNode(container);
    flushStorageWrites();

    const expectedTotal =
      countTokens("Reply one") + countTokens("Reply two");

    expect(storedResponseTokens()).toBe(expectedTotal);
  });

  it("counts both user and AI messages in a mixed container correctly", () => {
    const container = document.createElement("div");

    const userMsg = document.createElement("div");
    userMsg.setAttribute("data-testid", "user-message");
    userMsg.textContent = "My question";
    container.appendChild(userMsg);

    const aiMsg = document.createElement("div");
    aiMsg.setAttribute("data-testid", "assistant-message");
    aiMsg.textContent = "My answer";
    container.appendChild(aiMsg);

    document.body.appendChild(container);

    handleNode(container);
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens("My question"));
    expect(storedResponseTokens()).toBe(countTokens("My answer"));
    expect(storedTotalTokens()).toBe(
      countTokens("My question") + countTokens("My answer")
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. SPA navigation resets correctly
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: SPA navigation correctly resets token tracking", () => {
  it("pauses tracking immediately when navigation is detected", () => {
    onNavigate();
    const el = userEl("Message during navigation");
    monitorUserMessage(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });

  it("messages in the DOM at navigation time are marked pre-existing and not counted", () => {
    const historicalMsg = userEl("Old message from target chat");
    onNavigate();

    monitorUserMessage(historicalMsg);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });

  it("messages that arrive during the settle window are marked pre-existing by the navigationObserver", () => {
    onNavigate();

    const lateHistory = userEl("Old message that loaded a bit slowly");

    // Simulate the navigationObserver seeing this DOM addition
    observers[0].trigger([{ type: "childList", addedNodes: [lateHistory] }]);

    // Settle fires → tracking re-enabled, lateHistory is pre-existing
    jest.advanceTimersByTime(500);

    handleNode(lateHistory);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });

  it("resumes tracking after 500 ms of DOM quiet (settle)", () => {
    onNavigate();
    jest.advanceTimersByTime(500);

    const newMsg = userEl("My actual new question");
    monitorUserMessage(newMsg);
    flushStorageWrites();
    expect(storedPromptTokens()).toBeGreaterThan(0);
  });

  it("resumes tracking after the hard-cap maximum wait even with continuous mutations", () => {
    onNavigate();
    jest.advanceTimersByTime(4000);

    const newMsg = userEl("Finally, a real question");
    monitorUserMessage(newMsg);
    flushStorageWrites();
    expect(storedPromptTokens()).toBeGreaterThan(0);
  });

  it("does not trigger onNavigate when the URL has not changed", () => {
    window.location.href = "https://claude.ai/new";
    _setLastUrl("https://claude.ai/new");

    checkUrlChange();

    expect(_getSessionInitialized()).toBe(true);
  });

  it("triggers onNavigate and updates lastUrl when the URL changes", () => {
    _setLastUrl("https://claude.ai/chat/aaa");
    window.location.href = "https://claude.ai/chat/bbb";
    checkUrlChange();

    expect(_getLastUrl()).toBe("https://claude.ai/chat/bbb");
    expect(_getSessionInitialized()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Timeout abandonment — per-node observer cleanup
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: a user message that arrives after the per-node timeout is still counted", () => {
  it("counts the message even if text content arrives after the 10 s observer timeout", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "user-message");
    el.textContent = "";
    document.body.appendChild(el);

    monitorUserMessage(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);

    // Timeout fires, observer disconnects, userMessageStates entry is deleted
    jest.advanceTimersByTime(10001);

    // Text finally arrives
    el.textContent = "My very slow message";

    // Re-trigger by whatever mechanism (e.g. mainObserver re-processes the node)
    monitorUserMessage(el);
    flushStorageWrites();

    expect(storedPromptTokens()).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Storage persistence — tokens accumulate across multiple messages
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: tokens persist and accumulate across multiple messages", () => {
  it("prompt tokens from two separate user messages sum correctly in storage", () => {
    const text1 = "First message to Claude";
    const text2 = "Second message to Claude";

    monitorUserMessage(userEl(text1));
    flushStorageWrites();

    monitorUserMessage(userEl(text2));
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens(text1) + countTokens(text2));
  });

  it("response tokens from two separate AI responses sum correctly in storage", () => {
    const text1 = "First AI reply";
    const text2 = "Second AI reply";

    monitorAIResponse(aiEl(text1));
    flushStorageWrites();

    monitorAIResponse(aiEl(text2));
    flushStorageWrites();

    expect(storedResponseTokens()).toBe(countTokens(text1) + countTokens(text2));
  });

  it("totalTokens equals promptTokens + responseTokens after a mixed conversation", () => {
    const q1 = "What is gravity";
    const a1 = "Gravity is a fundamental force";
    const q2 = "Tell me more";
    const a2 = "It was described by Einstein";

    monitorUserMessage(userEl(q1));
    flushStorageWrites();

    monitorAIResponse(aiEl(a1));
    flushStorageWrites();

    monitorUserMessage(userEl(q2));
    flushStorageWrites();

    monitorAIResponse(aiEl(a2));
    flushStorageWrites();

    const expectedPrompt = countTokens(q1) + countTokens(q2);
    const expectedResponse = countTokens(a1) + countTokens(a2);

    expect(storedPromptTokens()).toBe(expectedPrompt);
    expect(storedResponseTokens()).toBe(expectedResponse);
    expect(storedTotalTokens()).toBe(expectedPrompt + expectedResponse);
  });

  it("accumulates correctly after 10 sequential messages", () => {
    let expectedPrompt = 0;
    for (let i = 1; i <= 10; i++) {
      const text = `Message number ${i} from the user`;
      monitorUserMessage(userEl(text));
      flushStorageWrites();
      expectedPrompt += countTokens(text);
    }

    expect(storedPromptTokens()).toBe(expectedPrompt);
    expect(storedTotalTokens()).toBe(expectedPrompt);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Batched storage write correctness (race condition fix)
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: batched storage writes prevent token loss from concurrent updates", () => {
  it("multiple synchronous updateStorage calls produce a single set() call", () => {
    const container = document.createElement("div");

    ["A B C", "D E F", "G H I"].forEach((text) => {
      const msg = document.createElement("div");
      msg.setAttribute("data-testid", "user-message");
      msg.textContent = text;
      container.appendChild(msg);
    });
    document.body.appendChild(container);

    handleNode(container);
    // Before flush: no set calls yet
    expect(storageSetCallCount()).toBe(0);

    flushStorageWrites();

    // Exactly one batched set call
    expect(storageSetCallCount()).toBe(1);

    // And the total is correct (not just the last message)
    const expected =
      countTokens("A B C") + countTokens("D E F") + countTokens("G H I");
    expect(storedPromptTokens()).toBe(expected);
  });

  it("interleaved prompt and response updates are both preserved in one flush", () => {
    const userMsg = userEl("My question here");
    const aiMsg = aiEl("My answer here");

    monitorUserMessage(userMsg);
    monitorAIResponse(aiMsg);
    flushStorageWrites();

    expect(storageSetCallCount()).toBe(1);
    expect(storedPromptTokens()).toBe(countTokens("My question here"));
    expect(storedResponseTokens()).toBe(countTokens("My answer here"));
    expect(storedTotalTokens()).toBe(
      countTokens("My question here") + countTokens("My answer here")
    );
  });

  it("a flush with zero pending deltas does not write to storage", () => {
    flushPendingDeltas();
    expect(storageSetCallCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. AI observer idle timeout (memory leak fix)
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: AI response observer disconnects after idle timeout", () => {
  it("the stream observer disconnects after AI_IDLE_TIMEOUT ms of inactivity", () => {
    const el = aiEl("Initial response");
    monitorAIResponse(el);

    // The stream observer is the last one created
    const streamObs = observers[observers.length - 1];
    expect(streamObs.connected).toBe(true);

    flushStorageWrites();

    // Advance past the idle timeout
    jest.advanceTimersByTime(AI_IDLE_TIMEOUT + 1);

    expect(streamObs.connected).toBe(false);
  });

  it("a streaming update resets the idle timer, keeping the observer alive", () => {
    const el = aiEl("Start");
    monitorAIResponse(el);
    const streamObs = observers[observers.length - 1];

    // Advance almost to idle timeout
    jest.advanceTimersByTime(AI_IDLE_TIMEOUT - 100);
    expect(streamObs.connected).toBe(true);

    // A streaming update arrives and resets the timer
    el.textContent = "Start of the response continues";
    streamObs.trigger([{ type: "characterData" }]);

    // Advance again — should NOT disconnect because timer was reset
    jest.advanceTimersByTime(AI_IDLE_TIMEOUT - 100);
    expect(streamObs.connected).toBe(true);

    // Now advance past the new idle timeout
    jest.advanceTimersByTime(200);
    expect(streamObs.connected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. End-to-end flow: navigation → new messages → verify totals
// ════════════════════════════════════════════════════════════════════════════

describe("End-to-end: navigate to chat, send messages, verify accurate totals", () => {
  it("old history ignored, new exchange counted accurately", () => {
    // Simulate a chat page with existing history
    userEl("Old user message from yesterday");
    aiEl("Old AI response from yesterday");

    // Navigation triggers
    onNavigate();
    jest.advanceTimersByTime(500); // settle → tracking re-enabled

    // Now the user sends a new message
    const q = "What is the meaning of life";
    monitorUserMessage(userEl(q));
    flushStorageWrites();

    // AI responds with streaming
    const aiNode = aiEl("The meaning");
    monitorAIResponse(aiNode);
    const streamObs = observers[observers.length - 1];

    aiNode.textContent = "The meaning of life is";
    streamObs.trigger([{ type: "characterData" }]);

    aiNode.textContent = "The meaning of life is 42";
    streamObs.trigger([{ type: "characterData" }]);

    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens(q));
    expect(storedResponseTokens()).toBe(countTokens("The meaning of life is 42"));
    expect(storedTotalTokens()).toBe(
      countTokens(q) + countTokens("The meaning of life is 42")
    );
  });

  it("navigating between chats does not double-count history", () => {
    // First chat session
    onNavigate();
    jest.advanceTimersByTime(500);

    monitorUserMessage(userEl("Hello in chat A"));
    flushStorageWrites();
    const afterChatA = storedPromptTokens();

    // Navigate to chat B
    _setLastUrl("https://claude.ai/chat/aaa");
    window.location.href = "https://claude.ai/chat/bbb";
    checkUrlChange();

    // History from chat B appears during settle
    const historyMsg = userEl("Old message in chat B");
    observers[0].trigger([{ type: "childList", addedNodes: [historyMsg] }]);
    jest.advanceTimersByTime(500);

    // Attempt to monitor the history message — should be blocked
    monitorUserMessage(historyMsg);
    flushStorageWrites();

    // New message in chat B
    monitorUserMessage(userEl("New message in chat B"));
    flushStorageWrites();

    const expectedTotal = afterChatA + countTokens("New message in chat B");
    expect(storedPromptTokens()).toBe(expectedTotal);
  });

  it("multiple rapid navigations do not corrupt tracking", () => {
    // Navigate 3 times in quick succession
    onNavigate();
    jest.advanceTimersByTime(100);
    onNavigate();
    jest.advanceTimersByTime(100);
    onNavigate();

    // Let final navigation settle
    jest.advanceTimersByTime(500);

    expect(_getSessionInitialized()).toBe(true);

    // New message should be counted
    monitorUserMessage(userEl("After all navigations"));
    flushStorageWrites();
    expect(storedPromptTokens()).toBe(countTokens("After all navigations"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Deeply nested containers
// ════════════════════════════════════════════════════════════════════════════

describe("Behavior: deeply nested message elements are found and counted", () => {
  it("finds messages nested multiple levels deep in a container", () => {
    const outer = document.createElement("div");
    const middle = document.createElement("div");
    const inner = document.createElement("div");
    inner.setAttribute("data-testid", "user-message");
    inner.textContent = "Deeply nested question";
    middle.appendChild(inner);
    outer.appendChild(middle);
    document.body.appendChild(outer);

    handleNode(outer);
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(countTokens("Deeply nested question"));
  });

  it("a node that directly matches the selector is also processed", () => {
    const el = userEl("Direct match");
    handleNode(el);
    flushStorageWrites();
    expect(storedPromptTokens()).toBe(countTokens("Direct match"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Token count accuracy for realistic prompts
// ════════════════════════════════════════════════════════════════════════════

describe("Token accuracy: realistic prompt sizes", () => {
  const testCases = [
    { label: "short prompt", text: "Hi", expectedWords: 1 },
    { label: "medium prompt", text: "Explain how photosynthesis works in plants", expectedWords: 6 },
    {
      label: "long prompt",
      text: "I would like you to write a comprehensive essay about the history of artificial intelligence, starting from the early days of computing through modern large language models. Please include key milestones, important researchers, and the major breakthroughs that shaped the field.",
      expectedWords: 41,
    },
  ];

  testCases.forEach(({ label, text, expectedWords }) => {
    it(`${label}: ${expectedWords} words → ${Math.ceil(expectedWords * 1.3)} estimated tokens`, () => {
      monitorUserMessage(userEl(text));
      flushStorageWrites();

      const expected = Math.ceil(expectedWords * 1.3);
      expect(storedPromptTokens()).toBe(expected);
    });
  });

  it("stored prompt tokens exactly match countTokens for the same input", () => {
    const texts = [
      "Hello",
      "What is 2+2",
      "Write me a haiku about programming",
      "The quick brown fox jumps over the lazy dog",
    ];

    let expectedTotal = 0;
    for (const text of texts) {
      monitorUserMessage(userEl(text));
      flushStorageWrites();
      expectedTotal += countTokens(text);
    }

    expect(storedPromptTokens()).toBe(expectedTotal);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 15. Streaming accuracy: final stored count matches the final text
// ════════════════════════════════════════════════════════════════════════════

describe("Streaming accuracy: stored response equals countTokens of final text", () => {
  it("word-by-word streaming arrives at the correct total", () => {
    const words = ["The", "The quick", "The quick brown", "The quick brown fox"];

    const el = aiEl(words[0]);
    monitorAIResponse(el);
    const obs = observers[observers.length - 1];

    for (let i = 1; i < words.length; i++) {
      el.textContent = words[i];
      obs.trigger([{ type: "characterData" }]);
    }

    flushStorageWrites();
    expect(storedResponseTokens()).toBe(countTokens("The quick brown fox"));
  });

  it("chunk-by-chunk streaming arrives at the correct total", () => {
    const chunks = [
      "Quantum mechanics is",
      "Quantum mechanics is a branch of physics that",
      "Quantum mechanics is a branch of physics that describes nature at the smallest scales",
    ];

    const el = aiEl(chunks[0]);
    monitorAIResponse(el);
    const obs = observers[observers.length - 1];

    for (let i = 1; i < chunks.length; i++) {
      el.textContent = chunks[i];
      obs.trigger([{ type: "characterData" }]);
    }

    flushStorageWrites();
    expect(storedResponseTokens()).toBe(countTokens(chunks[chunks.length - 1]));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 16. Pre-existing message edge cases
// ════════════════════════════════════════════════════════════════════════════

describe("Pre-existing messages: edge cases", () => {
  it("markPreExistingMessages called multiple times does not break anything", () => {
    const el = userEl("Old message");
    markPreExistingMessages();
    markPreExistingMessages();
    markPreExistingMessages();

    monitorUserMessage(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });

  it("a pre-existing AI message remains ignored even if its content changes", () => {
    const el = aiEl("Old response");
    markPreExistingMessages();

    el.textContent = "Old response with more text now";
    monitorAIResponse(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 17. Storage read-back consistency
// ════════════════════════════════════════════════════════════════════════════

describe("Storage consistency: values read back equal values written", () => {
  it("promptTokens + responseTokens == totalTokens at every point", () => {
    const conversation = [
      { type: "user", text: "Hello there" },
      { type: "ai", text: "Hi! How can I help you today?" },
      { type: "user", text: "What's the weather like" },
      { type: "ai", text: "I don't have access to real-time weather data" },
      { type: "user", text: "Ok thanks" },
    ];

    for (const msg of conversation) {
      if (msg.type === "user") {
        monitorUserMessage(userEl(msg.text));
      } else {
        monitorAIResponse(aiEl(msg.text));
      }
      flushStorageWrites();

      // Invariant: total = prompt + response at every step
      expect(storedTotalTokens()).toBe(
        storedPromptTokens() + storedResponseTokens()
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 18. Edge case: handleNode called with non-matching elements
// ════════════════════════════════════════════════════════════════════════════

describe("handleNode: non-matching elements", () => {
  it("does not count a plain div that doesn't match any selector", () => {
    const el = document.createElement("div");
    el.textContent = "Just a random div";
    document.body.appendChild(el);

    handleNode(el);
    flushStorageWrites();
    expect(storageSetCallCount()).toBe(0);
  });

  it("does not crash on text nodes or comment nodes", () => {
    const textNode = document.createTextNode("raw text");
    const commentNode = document.createComment("a comment");

    // handleNode checks node.matches which only exists on Elements
    // These should not throw
    expect(() => handleNode(textNode)).not.toThrow();
    expect(() => handleNode(commentNode)).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 19. Comprehensive navigation + persistence integration test
// ════════════════════════════════════════════════════════════════════════════

describe("Integration: full session lifecycle with persistence", () => {
  it("tracks tokens across page init, messages, navigation, and more messages", () => {
    // Step 1: Initial page with existing history (ignored)
    userEl("History message 1");
    aiEl("History response 1");
    markPreExistingMessages();
    _setSessionInitialized(true);

    // Step 2: User sends a message
    monitorUserMessage(userEl("New question one"));
    flushStorageWrites();
    const step2Prompt = storedPromptTokens();
    expect(step2Prompt).toBe(countTokens("New question one"));

    // Step 3: AI responds
    const aiNode = aiEl("Thinking...");
    monitorAIResponse(aiNode);
    const obs = observers[observers.length - 1];
    aiNode.textContent = "Here is my answer to your question";
    obs.trigger([{ type: "characterData" }]);
    flushStorageWrites();

    expect(storedResponseTokens()).toBe(
      countTokens("Here is my answer to your question")
    );

    // Step 4: Navigate to another chat
    onNavigate();
    const oldHistoryInNewChat = userEl("Old message in new chat");
    observers[0].trigger([{
      type: "childList",
      addedNodes: [oldHistoryInNewChat],
    }]);
    jest.advanceTimersByTime(500); // settle

    // Step 5: Old history should not be counted
    monitorUserMessage(oldHistoryInNewChat);
    flushStorageWrites();
    // Prompt tokens should still be from step 2 only
    expect(storedPromptTokens()).toBe(step2Prompt);

    // Step 6: New message in the new chat
    monitorUserMessage(userEl("New question two"));
    flushStorageWrites();

    expect(storedPromptTokens()).toBe(
      countTokens("New question one") + countTokens("New question two")
    );
    expect(storedTotalTokens()).toBe(
      storedPromptTokens() + storedResponseTokens()
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 20. Per-platform tracking
// ════════════════════════════════════════════════════════════════════════════

describe("Per-platform tracking", () => {
  it("getPlatformKey returns 'claude.ai' for the test hostname", () => {
    expect(getPlatformKey()).toBe("claude.ai");
  });

  it("writes platform breakdown to storage on flush", () => {
    monitorUserMessage(userEl("Hello from Claude"));
    flushStorageWrites();

    const platforms = mockStorage.platforms;
    expect(platforms).toBeDefined();
    expect(platforms["claude.ai"]).toBeDefined();
    expect(platforms["claude.ai"].prompt).toBe(countTokens("Hello from Claude"));
    expect(platforms["claude.ai"].response).toBe(0);
    expect(platforms["claude.ai"].total).toBe(countTokens("Hello from Claude"));
  });

  it("accumulates platform tokens across multiple messages", () => {
    monitorUserMessage(userEl("First message"));
    flushStorageWrites();

    monitorAIResponse(aiEl("First reply"));
    flushStorageWrites();

    monitorUserMessage(userEl("Second message"));
    flushStorageWrites();

    const p = mockStorage.platforms["claude.ai"];
    const expectedPrompt = countTokens("First message") + countTokens("Second message");
    const expectedResponse = countTokens("First reply");

    expect(p.prompt).toBe(expectedPrompt);
    expect(p.response).toBe(expectedResponse);
    expect(p.total).toBe(expectedPrompt + expectedResponse);
  });

  it("platform total matches the global total (single platform)", () => {
    monitorUserMessage(userEl("Question"));
    monitorAIResponse(aiEl("Answer"));
    flushStorageWrites();

    const p = mockStorage.platforms["claude.ai"];
    expect(p.total).toBe(storedTotalTokens());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 21. Daily history tracking
// ════════════════════════════════════════════════════════════════════════════

describe("Daily history tracking", () => {
  it("getTodayKey returns a YYYY-MM-DD string", () => {
    const key = getTodayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("writes daily history entry on flush", () => {
    monitorUserMessage(userEl("Today message"));
    flushStorageWrites();

    const history = mockStorage.dailyHistory;
    expect(history).toBeDefined();

    const today = getTodayKey();
    expect(history[today]).toBeDefined();
    expect(history[today].prompt).toBe(countTokens("Today message"));
    expect(history[today].total).toBe(countTokens("Today message"));
  });

  it("accumulates tokens within the same day", () => {
    monitorUserMessage(userEl("Morning message"));
    flushStorageWrites();
    monitorUserMessage(userEl("Afternoon message"));
    flushStorageWrites();

    const today = getTodayKey();
    const day = mockStorage.dailyHistory[today];
    const expected = countTokens("Morning message") + countTokens("Afternoon message");
    expect(day.prompt).toBe(expected);
    expect(day.total).toBe(expected);
  });

  it("preserves existing daily history entries from other days", () => {
    // Pre-seed storage with a history entry from yesterday
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getDate()).padStart(2, "0")}`;
    mockStorage.dailyHistory = {
      [yesterday]: { prompt: 100, response: 200, total: 300 },
    };

    monitorUserMessage(userEl("New day message"));
    flushStorageWrites();

    const history = mockStorage.dailyHistory;
    // Yesterday's entry should still be there
    expect(history[yesterday]).toEqual({ prompt: 100, response: 200, total: 300 });
    // Today's entry should also exist
    const today = getTodayKey();
    expect(history[today].prompt).toBe(countTokens("New day message"));
  });

  it("prunes entries older than DAILY_HISTORY_RETENTION_DAYS", () => {
    // Pre-seed storage with an old entry (60 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const oldKey = oldDate.toISOString().slice(0, 10);

    mockStorage.dailyHistory = {
      [oldKey]: { prompt: 999, response: 999, total: 1998 },
    };

    monitorUserMessage(userEl("Current message"));
    flushStorageWrites();

    const history = mockStorage.dailyHistory;
    // Old entry should be pruned
    expect(history[oldKey]).toBeUndefined();
    // Today's entry should exist
    expect(history[getTodayKey()]).toBeDefined();
  });

  it("keeps entries within the retention window", () => {
    // Entry from 10 days ago should survive
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10);
    const recentKey = recentDate.toISOString().slice(0, 10);

    mockStorage.dailyHistory = {
      [recentKey]: { prompt: 50, response: 50, total: 100 },
    };

    monitorUserMessage(userEl("Today"));
    flushStorageWrites();

    expect(mockStorage.dailyHistory[recentKey]).toEqual({ prompt: 50, response: 50, total: 100 });
  });

  it("daily history prompt + response = total for each entry", () => {
    monitorUserMessage(userEl("Question"));
    monitorAIResponse(aiEl("Answer"));
    flushStorageWrites();

    const today = getTodayKey();
    const day = mockStorage.dailyHistory[today];
    expect(day.total).toBe(day.prompt + day.response);
  });
});
