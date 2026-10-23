/* A single writer serializes updates from all tabs, including reset and pause. */
if (typeof importScripts === "function") importScripts("shared.js");
const Shared =
  typeof module !== "undefined" ? require("./shared.js") : globalThis.EcoPrompt;

function createStore(storage, now = () => new Date()) {
  let queue = Promise.resolve();
  function dispatch(message) {
    const job = queue.then(async () => {
      const state = Shared.normalize(await storage.get(null));
      if (message.type === "GET_STATE") return state;
      if (message.type === "SET_PAUSED") {
        const paused = message.paused === true;
        if (paused !== state.paused) state.epoch += 1;
        state.paused = paused;
      } else if (message.type === "RESET") {
        const fresh = Shared.normalize({
          paused: state.paused,
          epoch: state.epoch + 1,
        });
        await storage.set(fresh);
        return fresh;
      } else if (message.type === "TRACK") {
        if (
          state.paused ||
          message.epoch !== state.epoch ||
          state.recentBatches.includes(message.id)
        )
          return state;
        if (
          !Object.hasOwn(Shared.PLATFORMS, message.platform) ||
          typeof message.id !== "string" ||
          message.id.length > 100
        )
          throw new Error("Invalid usage batch");
        const prompt = Shared.count(message.prompt),
          response = Shared.count(message.response);
        if (!prompt && !response) return state;
        const instant = now(),
          today = Shared.dateKey(instant);
        const add = (entry) => {
          const base = Shared.usage(entry);
          return {
            prompt: base.prompt + prompt,
            response: base.response + response,
            total: base.total + prompt + response,
          };
        };
        state.promptTokens += prompt;
        state.responseTokens += response;
        state.totalTokens += prompt + response;
        state.platforms[message.platform] = add(
          state.platforms[message.platform],
        );
        const day = state.dailyHistory[today] || {};
        state.dailyHistory[today] = {
          ...add(day),
          platforms: {
            ...day.platforms,
            [message.platform]: add(day.platforms?.[message.platform]),
          },
        };
        const cutoff = Shared.recentDays(30, instant)[0];
        for (const key of Object.keys(state.dailyHistory))
          if (key < cutoff) delete state.dailyHistory[key];
        state.startedAt ||= instant.toISOString();
        state.lastActivity = instant.toISOString();
        state.recentBatches = [...state.recentBatches, message.id].slice(-256);
      } else throw new Error("Unknown request");
      await storage.set(state);
      return state;
    });
    queue = job.catch(() => {});
    return job;
  }
  return { dispatch };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const store = createStore(chrome.storage.local);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      sender.id !== chrome.runtime.id ||
      !["GET_STATE", "TRACK", "RESET", "SET_PAUSED"].includes(message?.type)
    )
      return;
    if (message.type === "TRACK") {
      let host;
      try {
        host = new URL(sender.url).hostname;
      } catch {
        return;
      }
      if (host !== message.platform || !Object.hasOwn(Shared.PLATFORMS, host))
        return;
    } else if (
      message.type !== "GET_STATE" &&
      sender.url !== chrome.runtime.getURL("popup.html")
    )
      return;
    store.dispatch(message).then(
      (state) => reply({ ok: true, state }),
      () =>
        reply({ ok: false, error: "Could not save usage. Please try again." }),
    );
    return true;
  });
}
if (typeof module !== "undefined") module.exports = { createStore };
