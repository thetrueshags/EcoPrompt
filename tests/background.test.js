const { createStore } = require("../src/background");
const S = require("../src/shared");
function fixture(initial = {}) {
  let data = structuredClone(initial);
  const storage = {
    get: jest.fn(async () => structuredClone(data)),
    set: jest.fn(async (value) => {
      data = { ...data, ...structuredClone(value) };
    }),
  };
  return {
    storage,
    store: createStore(storage, () => new Date(2026, 9, 14, 0, 15)),
    read: () => data,
  };
}
const batch = (id, extra = {}) => ({
  type: "TRACK",
  id,
  epoch: 0,
  platform: "chatgpt.com",
  prompt: 10,
  response: 20,
  ...extra,
});
test("simultaneous updates from different tabs retain all usage and platform totals", async () => {
  const { store, read } = fixture();
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      store.dispatch(
        batch(String(i), { platform: i % 2 ? "chatgpt.com" : "claude.ai" }),
      ),
    ),
  );
  expect(read().totalTokens).toBe(900);
  expect(read().platforms["chatgpt.com"].total).toBe(450);
  expect(read().dailyHistory["2026-10-14"].platforms["claude.ai"].total).toBe(
    450,
  );
  expect(read().promptTokens + read().responseTokens).toBe(read().totalTokens);
});
test("retrying a batch after a lost acknowledgement does not count it twice", async () => {
  const { store, read } = fixture();
  await store.dispatch(batch("same"));
  await store.dispatch(batch("same"));
  expect(read().totalTokens).toBe(30);
});
test("reset clears daily history and rejects queued batches from the old epoch", async () => {
  const { store, read } = fixture();
  await store.dispatch(batch("before"));
  await Promise.all([
    store.dispatch({ type: "RESET" }),
    store.dispatch(batch("stale")),
  ]);
  expect(read()).toMatchObject({
    totalTokens: 0,
    platforms: {},
    dailyHistory: {},
    epoch: 1,
    recentBatches: [],
  });
  await store.dispatch(batch("after", { epoch: 1 }));
  expect(read().totalTokens).toBe(30);
});
test("pause excludes usage and resume accepts new batches", async () => {
  const { store, read } = fixture();
  await store.dispatch({ type: "SET_PAUSED", paused: true });
  await store.dispatch(batch("paused"));
  expect(read().totalTokens).toBe(0);
  await store.dispatch({ type: "SET_PAUSED", paused: false });
  await store.dispatch(batch("stale-after-resume"));
  expect(read().totalTokens).toBe(0);
  await store.dispatch(batch("resumed", { epoch: read().epoch }));
  expect(read().totalTokens).toBe(30);
});
test("retains 30 local calendar days and preserves older all-time totals", async () => {
  const { store, read } = fixture({
    totalTokens: 100,
    dailyHistory: { "2026-09-14": { total: 40 }, "2026-09-15": { total: 60 } },
  });
  await store.dispatch(batch("new"));
  expect(read().totalTokens).toBe(130);
  expect(Object.keys(read().dailyHistory)).toEqual([
    "2026-09-15",
    "2026-10-14",
  ]);
});
test("legacy usage survives the first write without fabricating daily platform data", async () => {
  const { store, read } = fixture({
    totalTokens: 100,
    promptTokens: 40,
    responseTokens: 60,
    platforms: { "claude.ai": { prompt: 40, response: 60, total: 100 } },
    dailyHistory: { "2026-10-14": { prompt: 40, response: 60, total: 100 } },
  });
  await store.dispatch(batch("new"));
  expect(read().totalTokens).toBe(130);
  expect(read().dailyHistory["2026-10-14"].platforms["chatgpt.com"].total).toBe(
    30,
  );
});
test("failed writes are reported and do not poison the queue", async () => {
  const { store, storage, read } = fixture();
  storage.set.mockRejectedValueOnce(new Error("disk full"));
  await expect(store.dispatch(batch("failed"))).rejects.toThrow("disk full");
  await store.dispatch(batch("working"));
  expect(read().totalTokens).toBe(30);
});
test("rejects unknown platforms and ignores invalid numeric counts", async () => {
  const { store, read } = fixture();
  await expect(
    store.dispatch(batch("invalid", { platform: "evil.example" })),
  ).rejects.toThrow();
  await store.dispatch(batch("bad-count", { prompt: -100, response: NaN }));
  expect(read().totalTokens).toBeUndefined();
});
test("local dates do not depend on UTC conversion and month rollover works", () => {
  expect(S.dateKey(new Date(2026, 9, 14, 0, 5))).toBe("2026-10-14");
  expect(S.recentDays(3, new Date(2026, 0, 1))).toEqual([
    "2025-12-30",
    "2025-12-31",
    "2026-01-01",
  ]);
});
