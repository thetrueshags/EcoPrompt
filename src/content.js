/* Read rendered text in memory. Send numeric deltas, never chat content. */
(function () {
  const CONFIGS = {
    "chatgpt.com": {
      // Role-specific markers support both ChatGPT layouts. A data-turn-key
      // container can contain BOTH roles and must not be treated as a message.
      user: '[data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"], [data-user-message-bubble]',
      ai: '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]',
    },
    "gemini.google.com": {
      user: ".user-query, .query-text",
      ai: ".model-response-text",
    },
    "claude.ai": {
      user: '.font-user-message, [data-testid="user-message"]',
      ai: '.font-claude-message, .font-claude-response, [data-testid="assistant-message"], [data-testid="host-assistant-message"]',
    },
  };
  // Rough heuristic; the character floor also covers code and unspaced languages.
  function countTokens(text) {
    const value = (text || "").trim().replace(/\s+/gu, " ");
    return value
      ? Math.max(
          Math.ceil(value.split(/\s+/u).length * 1.3),
          Math.ceil(Array.from(value).length / 4),
        )
      : 0;
  }
  function createTracker({
    doc = document,
    win = window,
    runtime = chrome.runtime,
    storage = chrome.storage,
  } = {}) {
    const platform = win.location.hostname,
      config = CONFIGS[platform];
    if (!config) return null;
    let state = { paused: true, epoch: 0 },
      ready = false,
      active = false;
    let lastUrl = win.location.href,
      submittedAt = 0,
      flushTimer,
      scanTimer;
    let pending = { prompt: 0, response: 0 };
    let nodes = new WeakMap(),
      boundary = null,
      boundaryId = null;
    const identities = new Map();
    const session = win.crypto.randomUUID();
    let sequence = 0;
    const selector = `${config.user}, ${config.ai}`;
    function roots() {
      return Array.from(doc.querySelectorAll(selector)).filter(
        (node) => !node.parentElement?.closest(selector),
      );
    }
    function identity(node, role) {
      // New ChatGPT layouts can remount a message without data-message-id.
      // Keep the pre-send boundary and high-water count across those remounts.
      const searchKey =
        node.getAttribute("data-content-search-unit-key") ||
        node.getAttribute("data-chatgpt-search-unit-key");
      if (searchKey) return `${role}:search:${searchKey}`;
      const wrapper = node.closest("[data-message-id], [data-turn-id]");
      const id =
        wrapper?.getAttribute("data-message-id") ||
        wrapper?.getAttribute("data-turn-id");
      return id ? `${role}:${id}` : null;
    }
    function scan(baseline = false) {
      const messages = roots();
      const boundaryIndex = boundary
        ? messages.findIndex(
            (node) =>
              node === boundary ||
              (boundaryId &&
                identity(
                  node,
                  node.matches(config.user) ? "prompt" : "response",
                ) === boundaryId),
          )
        : -1;
      for (const [index, node] of messages.entries()) {
        const role = node.matches(config.user) ? "prompt" : "response";
        const id = identity(node, role),
          tokens = countTokens(node.textContent);
        const previous = id ? identities.get(id) : nodes.get(node);
        const high = Math.max(previous || 0, tokens);
        // Scrolling can prepend older messages in the same conversation. Only
        // messages after the pre-send boundary belong to the active exchange.
        if (
          !baseline &&
          index > boundaryIndex &&
          ready &&
          active &&
          !state.paused &&
          tokens > (previous || 0)
        )
          pending[role] += tokens - (previous || 0);
        nodes.set(node, high);
        if (id) identities.set(id, high);
      }
      if (pending.prompt || pending.response) {
        // Fixed batching interval: continuous streaming cannot postpone a flush.
        if (!flushTimer) flushTimer = setTimeout(flush, 250);
      }
    }
    async function flush() {
      clearTimeout(flushTimer);
      flushTimer = null;
      if (!pending.prompt && !pending.response) return;
      const batch = {
        type: "TRACK",
        platform,
        epoch: state.epoch,
        id: `${session}:${++sequence}`,
        ...pending,
      };
      pending = { prompt: 0, response: 0 };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if ((await runtime.sendMessage(batch))?.ok) return;
        } catch {
          /* A worker restart or extension update can interrupt a message. */
        }
      }
      console.warn(
        "EcoPrompt could not save this usage batch. Reload this tab if the extension was updated.",
      );
    }
    function navigation() {
      const url = win.location.href;
      if (url === lastUrl) return;
      const old = new URL(lastUrl),
        next = new URL(url);
      lastUrl = url;
      if (old.pathname === next.pathname) return;
      // New chats get a conversation URL while the first answer is streaming.
      const firstConversation =
        (/^\/(?:new)?\/?$/.test(old.pathname) &&
          /\/(?:c|chat)\//.test(next.pathname)) ||
        (old.pathname === "/app" && /^\/app\/[^/]+/.test(next.pathname));
      if (active && firstConversation && Date.now() - submittedAt < 30000)
        return;
      active = false;
      boundary = boundaryId = null;
      identities.clear();
      nodes = new WeakMap();
      scan(true);
    }
    function submitIntent() {
      navigation();
      if (!ready || state.paused) return;
      scan(!active);
      boundary = roots().at(-1) || null;
      boundaryId = boundary
        ? identity(
            boundary,
            boundary.matches(config.user) ? "prompt" : "response",
          )
        : null;
      active = true;
      submittedAt = Date.now();
    }
    function keydown(event) {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented
      )
        return;
      if (
        event.target.closest(
          'textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        submitIntent();
    }
    function click(event) {
      if (
        event.target.closest(
          'button[data-testid="send-button"], button[data-testid="send-message-button"], button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label="Send prompt"], button.send-button, button[aria-label*="Retry"], button[aria-label*="Regenerate"]',
        )
      )
        submitIntent();
    }
    function submit(event) {
      if (
        event.target.querySelector(
          'textarea, [contenteditable="true"], [role="textbox"]',
        )
      )
        submitIntent();
    }
    const observer = new MutationObserver(() => {
      navigation();
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scan();
      }, 100);
    });
    function changed(changes, area) {
      if (area !== "local") return;
      const epochChanged =
        changes.epoch && changes.epoch.newValue !== state.epoch;
      const pauseChanged =
        changes.paused && changes.paused.newValue !== state.paused;
      // The first write materializes default values (false / 0). That is not a
      // pause/reset and must not interrupt the very first streaming response.
      if (!epochChanged && !pauseChanged) return;
      if (changes.epoch) state.epoch = changes.epoch.newValue;
      if (changes.paused) state.paused = changes.paused.newValue;
      pending = { prompt: 0, response: 0 };
      active = false;
      scan(true);
    }
    async function start() {
      try {
        const result = await runtime.sendMessage({ type: "GET_STATE" });
        if (!result?.ok) return;
        state = result.state;
        scan(true);
        ready = true;
        observer.observe(doc.body, {
          childList: true,
          characterData: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            "data-message-author-role",
            "data-content-search-unit-key",
            "data-chatgpt-search-unit-key",
            "data-user-message-bubble",
          ],
        });
        doc.addEventListener("keydown", keydown, true);
        doc.addEventListener("click", click, true);
        doc.addEventListener("submit", submit, true);
        win.addEventListener("popstate", navigation);
        win.addEventListener("pagehide", flush);
        storage.onChanged.addListener(changed);
      } catch {
        /* An invalidated extension context needs a page reload. */
      }
    }
    function stop() {
      observer.disconnect();
      clearTimeout(scanTimer);
      clearTimeout(flushTimer);
      doc.removeEventListener("keydown", keydown, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("submit", submit, true);
      win.removeEventListener("popstate", navigation);
      win.removeEventListener("pagehide", flush);
      storage.onChanged.removeListener(changed);
    }
    return { start, stop, scan, flush, navigation, submitIntent };
  }
  if (typeof module !== "undefined")
    module.exports = { CONFIGS, countTokens, createTracker };
  else {
    const launch = () => createTracker()?.start();
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", launch, { once: true });
    else launch();
  }
})();
