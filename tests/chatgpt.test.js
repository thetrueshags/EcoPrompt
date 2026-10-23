/** @jest-environment jsdom */
const { createTracker, countTokens } = require("../src/content");
const { createStore } = require("../src/background");

let tracker, data, win;
beforeEach(async () => {
  jest.useFakeTimers();
  document.body.innerHTML = '<main></main><form><div contenteditable="true" role="textbox"></div><button type="button" data-testid="send-button"><span>Send</span></button></form>';
  data = {};
  const store = createStore({
    get: async () => JSON.parse(JSON.stringify(data)),
    set: async (values) => { data = JSON.parse(JSON.stringify(values)); },
  });
  win = {
    location: { hostname: "chatgpt.com", href: "https://chatgpt.com/" },
    crypto: { randomUUID: () => "chatgpt-layout-test" },
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  tracker = createTracker({
    doc: document, win,
    runtime: { sendMessage: async (batch) => ({ ok: true, state: await store.dispatch(batch) }) },
    storage: { onChanged: { addListener: jest.fn(), removeListener: jest.fn() } },
  });
  await tracker.start();
});
afterEach(() => {
  tracker.stop();
  jest.clearAllTimers();
  jest.useRealTimers();
});
async function settle() {
  await Promise.resolve();
  jest.advanceTimersByTime(100);
  await tracker.flush();
}
function send(method = "click") {
  if (method === "click") document.querySelector("button span").click();
  else document.querySelector('[role="textbox"]').dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}
const attributes = ["data-message-author-role", "data-content-search-unit-key", "data-chatgpt-search-unit-key"];
function exchange(attribute, id = "turn-1") {
  const value = (role) => attribute === "data-message-author-role" ? role : `${id}:0:${role}`;
  return `<section data-turn-key="${id}"><div ${attribute}="${value("user")}">Explain solar power</div><div ${attribute}="${value("assistant")}"><p>Solar</p></div></section>`;
}
test.each(attributes.flatMap((attribute) => ["click", "Enter"].map((method) => [attribute, method])))(
  "records %s with %s and streaming after the first conversation URL",
  async (attribute, method) => {
    send(method);
    document.querySelector("main").innerHTML = exchange(attribute);
    await settle();
    expect(data.promptTokens).toBe(countTokens("Explain solar power"));
    expect(data.responseTokens).toBe(countTokens("Solar"));
    win.location.href = "https://chatgpt.com/c/new-chat";
    document.querySelector("p").firstChild.data = "Solar panels convert sunlight into electricity";
    await settle();
    expect(data.responseTokens).toBe(countTokens("Solar panels convert sunlight into electricity"));
    expect(data.platforms["chatgpt.com"].total).toBe(data.totalTokens);
  },
);
test("overlapping markers count each role once within a shared turn", async () => {
  send();
  document.querySelector("main").innerHTML = `<section data-turn-key="turn-1">
    <div data-content-search-unit-key="turn-1:0:user"><div data-chatgpt-search-unit-key="turn-1:0:user"><div data-message-author-role="user"><div data-user-message-bubble>Hello world</div></div></div></div>
    <div data-content-search-unit-key="turn-1:0:assistant"><div data-chatgpt-search-unit-key="turn-1:0:assistant"><div data-message-author-role="assistant">A useful answer</div></div></div>
  </section>`;
  await settle();
  expect(data.promptTokens).toBe(countTokens("Hello world"));
  expect(data.responseTokens).toBe(countTokens("A useful answer"));
});
test("recognizes standalone user bubbles", async () => {
  send();
  document.querySelector("main").innerHTML = '<div data-user-message-bubble>Hello world</div>';
  await settle();
  expect(data.promptTokens).toBe(countTokens("Hello world"));
});
test.each(attributes)("observes %s assigned after text mounts", async (attribute) => {
  send();
  const node = document.createElement("div");
  node.textContent = "Hello world";
  document.querySelector("main").append(node);
  await settle();
  expect(data.totalTokens).toBeUndefined();
  node.setAttribute(attribute, attribute === "data-message-author-role" ? "user" : "turn-1:0:user");
  await settle();
  expect(data.promptTokens).toBe(countTokens("Hello world"));
});
test.each(attributes.slice(1))("stable %s avoids counting remounted messages and scrolled history", async (attribute) => {
  const main = document.querySelector("main");
  main.innerHTML = exchange(attribute, "old");
  await settle();
  expect(data.totalTokens).toBeUndefined();
  send();
  main.insertAdjacentHTML("beforeend", exchange(attribute));
  await settle();
  const total = data.totalTokens;
  main.innerHTML = exchange(attribute, "older") + main.innerHTML;
  await settle();
  expect(data.totalTokens).toBe(total);
  win.location.href = "https://chatgpt.com/c/history";
  tracker.navigation(); // first conversation assignment
  win.location.href = "https://chatgpt.com/c/another-history";
  main.innerHTML = exchange(attribute, "historical");
  await settle();
  expect(data.totalTokens).toBe(total);
  send("Enter");
  main.insertAdjacentHTML("beforeend", exchange(attribute, "fresh"));
  await settle();
  expect(data.totalTokens).toBe(total * 2);
});
