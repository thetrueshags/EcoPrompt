/* Shared local calculations. No network requests. */
(function (root) {
  const PLATFORMS = {
    "chatgpt.com": "ChatGPT",
    "gemini.google.com": "Gemini",
    "claude.ai": "Claude",
  };
  // Illustrative assumptions, not measurements or provider-specific benchmarks.
  const MODEL = Object.freeze({
    id: "illustrative-v1",
    whPerToken: 0.0005,
    mlPerToken: 0.002,
    gramsPerKwh: 450,
    bulbWatts: 9,
  });
  const count = (value) =>
    Number.isSafeInteger(value) && value > 0 ? value : 0;
  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function recentDays(length = 7, now = new Date()) {
    return Array.from({ length }, (_, i) => {
      const day = new Date(now);
      day.setDate(day.getDate() - length + 1 + i);
      return dateKey(day);
    });
  }
  function usage(value = {}) {
    value = value && typeof value === "object" ? value : {};
    const prompt = count(value.prompt),
      response = count(value.response);
    return {
      prompt,
      response,
      total: Math.max(count(value.total), prompt + response),
    };
  }
  function normalize(raw = {}) {
    const totals = usage({
      prompt: raw.promptTokens,
      response: raw.responseTokens,
      total: raw.totalTokens,
    });
    const platforms = (value) =>
      Object.fromEntries(
        Object.keys(PLATFORMS)
          .filter((key) => value?.[key])
          .map((key) => [key, usage(value[key])]),
      );
    return {
      schemaVersion: 2,
      totalTokens: totals.total,
      promptTokens: totals.prompt,
      responseTokens: totals.response,
      platforms: platforms(raw.platforms),
      dailyHistory: Object.fromEntries(
        Object.entries(raw.dailyHistory || {})
          .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
          .map(([key, day]) => [
            key,
            { ...usage(day), platforms: platforms(day?.platforms) },
          ]),
      ),
      paused: raw.paused === true,
      epoch: count(raw.epoch),
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
      lastActivity:
        typeof raw.lastActivity === "string" ? raw.lastActivity : null,
      recentBatches: Array.isArray(raw.recentBatches)
        ? raw.recentBatches.filter((id) => typeof id === "string").slice(-256)
        : [],
    };
  }
  function estimate(tokens) {
    const wh = count(tokens) * MODEL.whPerToken;
    return {
      wh,
      ml: count(tokens) * MODEL.mlPerToken,
      grams: (wh / 1000) * MODEL.gramsPerKwh,
      bulbSeconds: (wh / MODEL.bulbWatts) * 3600,
    };
  }
  const api = {
    PLATFORMS,
    MODEL,
    count,
    dateKey,
    recentDays,
    usage,
    normalize,
    estimate,
  };
  root.EcoPrompt = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
