const CONFIGS = {
  "gemini.google.com": {
    user: ".user-query, .query-text",
    ai: ".model-response-text",
  },
  "chatgpt.com": {
    user: '[data-message-author-role="user"]',
    ai: '[data-message-author-role="assistant"]',
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

// Flag to indicate when we're ready to start counting new messages
let sessionInitialized = false;

function countTokens(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(words * 1.3);
}

function updateStorage(type, tokenDelta) {
  if (tokenDelta <= 0) return;

  chrome.storage.local.get(
    ["totalTokens", "promptTokens", "responseTokens"],
    (result) => {
      const currentTotal = result.totalTokens || 0;
      const currentPrompt = result.promptTokens || 0;
      const currentResponse = result.responseTokens || 0;

      const updates = {
        totalTokens: currentTotal + tokenDelta,
      };

      if (type === "prompt") {
        updates.promptTokens = currentPrompt + tokenDelta;
      } else if (type === "response") {
        updates.responseTokens = currentResponse + tokenDelta;
      }

      chrome.storage.local.set(updates);
      console.log(`[EcoPrompt] Added ${tokenDelta} ${type} tokens.`);
    },
  );
}

function monitorUserMessage(node) {
  // Skip if this is a pre-existing node from page load
  if (preExistingNodes.has(node)) {
    console.log("[EcoPrompt] Skipping pre-existing user message");
    return;
  }

  // Skip if session not initialized yet
  if (!sessionInitialized) {
    console.log("[EcoPrompt] Skipping user message - session not initialized");
    return;
  }

  if (userMessageStates.has(node)) return;

  const checkAndLog = () => {
    const text = node.textContent;
    const tokens = countTokens(text);

    if (tokens > 0) {
      updateStorage("prompt", tokens);
      userMessageStates.set(node, true);
      return true;
    }
    return false;
  };

  if (checkAndLog()) return;

  userMessageStates.set(node, "observing");

  const userObserver = new MutationObserver((mutations, obs) => {
    if (checkAndLog()) {
      obs.disconnect();
    }
  });

  userObserver.observe(node, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  // Safety timeout to stop observing if nothing happens (e.g. empty container)
  setTimeout(() => {
    userObserver.disconnect();
    if (userMessageStates.get(node) === "observing") {
      userMessageStates.set(node, true); // Give up to free memory logic
    }
  }, 10000);
}

function monitorAIResponse(node) {
  // Skip if this is a pre-existing node from page load
  if (preExistingNodes.has(node)) {
    console.log("[EcoPrompt] Skipping pre-existing AI response");
    return;
  }

  // Skip if session not initialized yet
  if (!sessionInitialized) {
    console.log("[EcoPrompt] Skipping AI response - session not initialized");
    return;
  }

  if (aiStreamStates.has(node)) return; // Already monitoring

  // Initialize state - start from 0 for brand new messages
  aiStreamStates.set(node, 0);

  const updateLogic = () => {
    const text = node.textContent;
    const currentTokens = countTokens(text);
    const lastTokens = aiStreamStates.get(node) || 0;
    const delta = currentTokens - lastTokens;

    if (delta > 0) {
      updateStorage("response", delta);
      aiStreamStates.set(node, currentTokens);
    }
  };

  // Run initial check
  updateLogic();

  // Observe active changes (streaming)
  const streamObserver = new MutationObserver((mutations) => {
    updateLogic();
  });

  streamObserver.observe(node, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  // Optional: could disconnect after long silence, but keeping it active handles corrections/updates.
}

function handleNode(node) {
  if (!currentConfig) return;

  if (node.matches && node.matches(currentConfig.user)) {
    monitorUserMessage(node);
  } else if (node.querySelector) {
    const userChild = node.querySelector(currentConfig.user);
    if (userChild) monitorUserMessage(userChild);
  }

  if (node.matches && node.matches(currentConfig.ai)) {
    monitorAIResponse(node);
  } else if (node.querySelector) {
    const aiChild = node.querySelector(currentConfig.ai);
    if (aiChild) monitorAIResponse(aiChild);
  }
}

function markPreExistingMessages() {
  if (!currentConfig) return;

  console.log(
    "[EcoPrompt] Marking pre-existing messages to exclude from tracking...",
  );

  // Find all user messages that already exist
  const existingUserMessages = document.querySelectorAll(currentConfig.user);
  existingUserMessages.forEach((node) => {
    preExistingNodes.add(node);
    console.log("[EcoPrompt] Marked pre-existing user message");
  });

  // Find all AI messages that already exist
  const existingAIMessages = document.querySelectorAll(currentConfig.ai);
  existingAIMessages.forEach((node) => {
    preExistingNodes.add(node);
    console.log("[EcoPrompt] Marked pre-existing AI message");
  });

  console.log(
    `[EcoPrompt] Marked ${existingUserMessages.length} user and ${existingAIMessages.length} AI messages as pre-existing`,
  );
}

const mainObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          handleNode(node);
        }
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

  setTimeout(() => {
    markPreExistingMessages();

    sessionInitialized = true;
    console.log(
      "[EcoPrompt] Session initialized - now tracking NEW messages only",
    );

    mainObserver.observe(chatBody, { childList: true, subtree: true });
    console.log("[EcoPrompt] Active monitoring started for " + hostname);
  }, 2000); // 2 second grace period for page to fully load
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  // DOM is already loaded
  initialize();
}

// Export for tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    countTokens,
    CONFIGS,
  };
}
