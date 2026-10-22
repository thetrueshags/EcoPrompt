const CONFIGS = {
  "gemini.google.com": {
    user: ".user-query, .query-text",
    ai: ".model-response-text",
  },
  "chatgpt.com": {
    // ChatGPT serves both the legacy layout and a newer layout that omits
    // data-message-author-role. Search-unit keys identify each role separately;
    // data-turn-key alone can contain BOTH the prompt and the reply.
    user: '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"], [data-user-message-bubble]',
    ai: '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]',
  },
  "claude.ai": {
    user: '.font-user-message, [data-testid="user-message"]',
    ai: '.font-claude-message, .font-claude-response, [data-testid="assistant-message"], [data-testid="host-assistant-message"]',
  },
};

const hostname = window.location.hostname;
const currentConfig = Object.keys(CONFIGS).find((key) => hostname.includes(key))
  ? CONFIGS[Object.keys(CONFIGS).find((key) => hostname.includes(key))]
  : null;

// Track AI message states for streaming: node -> lastTokenCount
const aiStreamStates = new WeakMap();
// Track User message states to ensure we capture text if it loads late
const userMessageStates = new WeakMap();
// Track nodes that existed before we started monitoring (should NOT be counted)
const preExistingNodes = new WeakSet();

let sessionInitialized = false;

function countTokens(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

// --- Helpers for per-platform and daily tracking ---

function getPlatformKey() {
  if (!hostname) return null;
  return Object.keys(CONFIGS).find((key) => hostname.includes(key)) || null;
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAILY_HISTORY_RETENTION_DAYS = 30;

// --- Batched storage updates ---
// Multiple synchronous updateStorage() calls are coalesced into a single
// chrome.storage read-modify-write on the next microtask.  This prevents a
// race condition where concurrent get() callbacks all read the same stale base
// value and later set() calls silently overwrite each other, losing tokens.
let pendingDeltas = { prompt: 0, response: 0, total: 0 };
let flushTimer = null;

function updateStorage(type, tokenDelta) {
  if (tokenDelta <= 0) return;

  pendingDeltas.total += tokenDelta;
  if (type === "prompt") pendingDeltas.prompt += tokenDelta;
  else if (type === "response") pendingDeltas.response += tokenDelta;

  if (flushTimer === null) {
    flushTimer = setTimeout(flushPendingDeltas, 0);
  }
  console.log(`[EcoPrompt] Queued ${tokenDelta} ${type} tokens.`);
}

function flushPendingDeltas() {
  flushTimer = null;
  const deltas = { ...pendingDeltas };
  pendingDeltas = { prompt: 0, response: 0, total: 0 };

  if (deltas.total === 0) return;

  const platform = getPlatformKey();
  const today = getTodayKey();

  chrome.storage.local.get(
    ["totalTokens", "promptTokens", "responseTokens", "platforms", "dailyHistory"],
    (result) => {
      const updates = {
        totalTokens: (result.totalTokens || 0) + deltas.total,
        promptTokens: (result.promptTokens || 0) + deltas.prompt,
        responseTokens: (result.responseTokens || 0) + deltas.response,
      };

      // ── Per-platform breakdown ──
      const platforms = result.platforms || {};
      if (platform) {
        const p = platforms[platform] || { prompt: 0, response: 0, total: 0 };
        platforms[platform] = {
          prompt: p.prompt + deltas.prompt,
          response: p.response + deltas.response,
          total: p.total + deltas.total,
        };
        updates.platforms = platforms;
      }

      // ── Daily history ──
      const history = result.dailyHistory || {};
      const day = history[today] || { prompt: 0, response: 0, total: 0 };
      history[today] = {
        prompt: day.prompt + deltas.prompt,
        response: day.response + deltas.response,
        total: day.total + deltas.total,
      };
      // Prune entries older than retention period
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - DAILY_HISTORY_RETENTION_DAYS);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      for (const key of Object.keys(history)) {
        if (key < cutoffStr) delete history[key];
      }
      updates.dailyHistory = history;

      chrome.storage.local.set(updates);
      console.log(
        `[EcoPrompt] Flushed: +${deltas.prompt} prompt, +${deltas.response} response, +${deltas.total} total` +
        (platform ? ` [${platform}]` : "") + ".",
      );
    },
  );
}

function monitorUserMessage(node) {
  if (preExistingNodes.has(node)) return;
  if (!sessionInitialized) return;
  if (userMessageStates.has(node)) return;

  const checkAndLog = () => {
    const tokens = countTokens(node.textContent);
    if (tokens > 0) {
      updateStorage("prompt", tokens);
      userMessageStates.set(node, true);
      return true;
    }
    return false;
  };

  if (checkAndLog()) return;

  userMessageStates.set(node, "observing");

  const userObserver = new MutationObserver((_, obs) => {
    if (checkAndLog()) obs.disconnect();
  });

  userObserver.observe(node, { childList: true, characterData: true, subtree: true });

  // Bug fix: after timeout, DELETE the entry (not set to true) so that if the
  // node is re-processed later (e.g. by the main observer after text finally
  // arrives), it can still be counted instead of being silently dropped.
  setTimeout(() => {
    userObserver.disconnect();
    if (userMessageStates.get(node) === "observing") {
      userMessageStates.delete(node);
    }
  }, 10000);
}

const AI_IDLE_TIMEOUT = 30000; // 30 s of no DOM changes → disconnect observer

function monitorAIResponse(node) {
  if (preExistingNodes.has(node)) return;
  if (!sessionInitialized) return;
  if (aiStreamStates.has(node)) return;

  aiStreamStates.set(node, 0);

  let idleTimer = null;

  const updateLogic = () => {
    const currentTokens = countTokens(node.textContent);
    const lastTokens = aiStreamStates.get(node) || 0;
    const delta = currentTokens - lastTokens;
    if (delta > 0) {
      updateStorage("response", delta);
      aiStreamStates.set(node, currentTokens);
    }
    // Reset idle timer — once the response stops changing for
    // AI_IDLE_TIMEOUT ms, we assume streaming is done and disconnect
    // to avoid memory leaks and phantom token bumps from DOM reformats.
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      streamObserver.disconnect();
      console.log("[EcoPrompt] AI response observer disconnected after idle timeout.");
    }, AI_IDLE_TIMEOUT);
  };

  updateLogic();

  const streamObserver = new MutationObserver(() => updateLogic());
  streamObserver.observe(node, { childList: true, characterData: true, subtree: true });
}

// Several ChatGPT markers can wrap the same message. Always monitor the
// outermost matching element so nested aliases don't count the text twice.
function getMessageNodes(node, selector) {
  const candidates = [];
  if (node.matches && node.matches(selector)) candidates.push(node);
  // Preserve the existing handling of nested containers on Gemini and Claude.
  if (getPlatformKey() !== "chatgpt.com" && candidates.length) return candidates;
  if (node.querySelectorAll) candidates.push(...node.querySelectorAll(selector));
  if (getPlatformKey() !== "chatgpt.com") return candidates;

  return [...new Set(candidates.map((candidate) => {
    let ancestor = candidate.parentElement?.closest(selector);
    while (ancestor) {
      candidate = ancestor;
      ancestor = candidate.parentElement?.closest(selector);
    }
    return candidate;
  }))];
}

function handleNode(node) {
  if (!currentConfig) return;

  getMessageNodes(node, currentConfig.user).forEach(monitorUserMessage);
  getMessageNodes(node, currentConfig.ai).forEach(monitorAIResponse);
}

function markPreExistingMessages() {
  if (!currentConfig) return;
  document.querySelectorAll(currentConfig.user).forEach((n) => preExistingNodes.add(n));
  document.querySelectorAll(currentConfig.ai).forEach((n) => preExistingNodes.add(n));
}

// --- SPA Navigation Detection ---
// Fixed-timeout grace periods are inherently racy: if the SPA takes longer than
// the window to render chat history, those messages get miscounted.
//
// Replacement approach — DOM settling:
//   1. On navigation, immediately pause tracking and mark whatever is already rendered.
//   2. Spin up a navigationObserver that marks every newly added message node as
//      pre-existing AS IT ARRIVES, and resets a short settle timer on each mutation.
//   3. Once the DOM has been quiet for SETTLE_DELAY ms (no new nodes), re-enable
//      tracking.  A hard cap of MAX_WAIT ms prevents waiting forever on a broken page.
//
// This ensures that chat history loading at any speed during navigation is caught,
// without relying on an arbitrary fixed timeout.

let lastUrl = window.location.href;
let navigationObserver = null;
let navSettleTimer = null;
let navMaxTimer = null;

const SETTLE_DELAY = 500;  // ms of DOM quiet → re-enable tracking
const NAV_MAX_WAIT = 4000; // absolute maximum navigation grace period

function enableTracking() {
  clearTimeout(navSettleTimer);
  clearTimeout(navMaxTimer);
  if (navigationObserver) {
    navigationObserver.disconnect();
    navigationObserver = null;
  }
  markPreExistingMessages(); // final sweep for anything that loaded right at the edge
  sessionInitialized = true;
  console.log("[EcoPrompt] Session re-initialized — tracking new messages only");
}

function resetSettleTimer() {
  clearTimeout(navSettleTimer);
  navSettleTimer = setTimeout(enableTracking, SETTLE_DELAY);
}

function onNavigate() {
  console.log("[EcoPrompt] Navigation detected — pausing tracking");
  sessionInitialized = false;

  // Cancel any in-progress navigation handling
  clearTimeout(navSettleTimer);
  clearTimeout(navMaxTimer);
  if (navigationObserver) navigationObserver.disconnect();

  // Mark everything currently in the DOM as pre-existing
  markPreExistingMessages();

  // Watch for nodes added during navigation and mark them pre-existing immediately.
  // This fires synchronously inside the mutation callback, before handleNode ever
  // sees the node, so sessionInitialized being false is a secondary guard here.
  navigationObserver = new MutationObserver((mutations) => {
    if (!currentConfig) return;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches && node.matches(currentConfig.user)) preExistingNodes.add(node);
        if (node.matches && node.matches(currentConfig.ai)) preExistingNodes.add(node);
        if (node.querySelectorAll) {
          node.querySelectorAll(currentConfig.user).forEach((n) => preExistingNodes.add(n));
          node.querySelectorAll(currentConfig.ai).forEach((n) => preExistingNodes.add(n));
        }
      });
    }
    resetSettleTimer();
  });

  navigationObserver.observe(document.body, { childList: true, subtree: true });

  navMaxTimer = setTimeout(enableTracking, NAV_MAX_WAIT);
  resetSettleTimer(); // start the initial settle countdown
}

function checkUrlChange() {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    onNavigate();
  }
}

function setupNavigationDetection() {
  window.addEventListener("popstate", checkUrlChange);

  if (typeof history !== "undefined" && typeof history.pushState === "function") {
    const origPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      origPushState(...args);
      checkUrlChange();
    };

    const origReplaceState = history.replaceState.bind(history);
    history.replaceState = function (...args) {
      origReplaceState(...args);
      checkUrlChange();
    };
  }
}

// --------------------------------

const mainObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    // Role attributes may be assigned after the message shell is mounted.
    if (mutation.type === "attributes") handleNode(mutation.target);
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) handleNode(node);
      });
    }
  }
});

function initialize() {
  const chatBody = document.querySelector("body");
  if (!chatBody || !currentConfig) {
    console.log("[EcoPrompt] Not active or config missing for this site.");
    return;
  }

  markPreExistingMessages();
  setupNavigationDetection();

  setTimeout(() => {
    markPreExistingMessages();
    sessionInitialized = true;
    console.log("[EcoPrompt] Session initialized — tracking new messages only");
    mainObserver.observe(chatBody, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-message-author-role",
        "data-content-search-unit-key",
        "data-chatgpt-search-unit-key",
        "data-user-message-bubble",
      ],
    });
  }, 2000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}

// Export for tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
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
    _getSessionInitialized: () => sessionInitialized,
    _setSessionInitialized: (val) => { sessionInitialized = val; },
    _getLastUrl: () => lastUrl,
    _setLastUrl: (val) => { lastUrl = val; },
    _resetFlush: () => {
      clearTimeout(flushTimer);
      flushTimer = null;
      pendingDeltas = { prompt: 0, response: 0, total: 0 };
    },
  };
}
