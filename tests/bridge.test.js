const test = require("node:test");
const assert = require("node:assert/strict");

const Bridge = require("../src/bridge");

test("updateSettings is not a valid bridge command", () => {
  assert.equal(
    Bridge.COMMAND_NAMES.includes("updateSettings"),
    false,
    "settings must not be mutable over the bridge — that was an API-key exfil vector"
  );
});

test("expected viewer commands stay available", () => {
  for (const name of ["next", "prev", "toggleAutoFollow", "closeCurrentSong", "retry", "popIn"]) {
    assert.equal(Bridge.COMMAND_NAMES.includes(name), true, `missing command: ${name}`);
  }
});

test("createBridge sends token in hello payload", () => {
  const messages = [];
  let openHandler = null;

  class FakeSocket {
    constructor() {
      this.readyState = 1;
    }
    addEventListener(type, handler) {
      if (type === "open") openHandler = handler;
    }
    removeEventListener() {}
    send(payload) { messages.push(JSON.parse(payload)); }
    close() {}
  }

  const root = { WebSocket: FakeSocket };
  const bridge = Bridge.createBridge.call(null, {
    port: 47621,
    token: "deadbeefcafe1234",
    clientVersion: "test",
    logger: () => {},
    // No snapshot — post-open publish bails out cleanly.
  });
  // createBridge was registered into root.LyricLens.Bridge by side effect,
  // but the returned object's popOut uses globalThis.WebSocket. Patch.
  globalThis.WebSocket = FakeSocket;

  bridge.popOut();
  assert.ok(openHandler, "expected open handler to be registered");
  openHandler();

  const hello = messages.find((m) => m.type === "hello");
  assert.ok(hello, "hello frame should be sent on open");
  assert.equal(hello.payload.token, "deadbeefcafe1234");
  assert.equal(hello.payload.client, "lyriclens-plugin");
  assert.equal(hello.v, 1);

  bridge.popIn();
  delete globalThis.WebSocket;
});

test("createBridge sends empty token when none configured", () => {
  const messages = [];
  let openHandler = null;
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener(type, handler) { if (type === "open") openHandler = handler; }
    removeEventListener() {}
    send(p) { messages.push(JSON.parse(p)); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  const bridge = Bridge.createBridge.call(null, { port: 47621, logger: () => {} });
  bridge.popOut();
  openHandler();
  const hello = messages.find((m) => m.type === "hello");
  assert.equal(hello.payload.token, "");
  bridge.popIn();
  delete globalThis.WebSocket;
});

test("dispatchCommand rejects unknown commands", () => {
  let handled = null;
  let openHandler = null;
  let msgHandler = null;
  class FakeSocket {
    constructor() { this.readyState = 1; }
    addEventListener(type, handler) {
      if (type === "open") openHandler = handler;
      if (type === "message") msgHandler = handler;
    }
    removeEventListener() {}
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  const bridge = Bridge.createBridge.call(null, {
    port: 47621,
    onCommand: (name, payload) => { handled = { name, payload }; },
    logger: () => {}
  });
  bridge.popOut();
  openHandler();

  // updateSettings must be ignored even if a misbehaving server sends it.
  msgHandler({ data: JSON.stringify({ v: 1, type: "command", payload: { name: "updateSettings", payload: { apiKey: "x" } } }) });
  assert.equal(handled, null, "updateSettings must not reach onCommand");

  msgHandler({ data: JSON.stringify({ v: 1, type: "command", payload: { name: "next" } }) });
  assert.deepEqual(handled, { name: "next", payload: undefined });

  bridge.popIn();
  delete globalThis.WebSocket;
});
