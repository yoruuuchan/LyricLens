const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");

const { injectInlineStyle, sha256HexSync } = require("../src/utils");

function nodeSha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createStyleDocument() {
  const nodes = [];
  const head = {
    appendChild(node) {
      nodes.push(node);
      node.parentNode = head;
      return node;
    }
  };
  return {
    head,
    nodes,
    getElementById(id) {
      return nodes.find((node) => node.id === id) || null;
    },
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        id: "",
        textContent: "",
        dataset: {},
        parentNode: null,
        setAttribute(name, value) {
          this[name] = String(value);
        }
      };
    }
  };
}

test("injectInlineStyle creates and updates one style element without a link request", () => {
  const previousDocument = globalThis.document;
  const document = createStyleDocument();
  const cssEvents = [];
  globalThis.document = document;

  try {
    const first = injectInlineStyle("ll-panel-style", ".ll-panel { color: red; }", {
      recordCss: (status) => cssEvents.push(status)
    });
    const second = injectInlineStyle("ll-panel-style", ".ll-panel { color: blue; }", {
      recordCss: (status) => cssEvents.push(status)
    });

    assert.equal(first, second);
    assert.equal(document.nodes.length, 1);
    assert.equal(document.nodes[0].tagName, "STYLE");
    assert.equal(document.nodes[0].textContent, ".ll-panel { color: blue; }");
    assert.deepEqual(cssEvents, ["inline-injected", "inline-injected"]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("sha256HexSync matches known answer vectors", () => {
  assert.equal(
    sha256HexSync(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    sha256HexSync(Buffer.from("abc", "utf8")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.equal(
    sha256HexSync(Buffer.alloc(1_000_000, "a")),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
  );
});

test("sha256HexSync matches node crypto across block boundaries", () => {
  for (const length of [0, 1, 63, 64, 65, 4096, 100000]) {
    const bytes = randomBytes(length);
    assert.equal(sha256HexSync(bytes), nodeSha256Hex(bytes), `length ${length}`);

    const wrapped = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xee])]);
    const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 1, bytes.length);
    assert.equal(sha256HexSync(view), nodeSha256Hex(bytes), `offset view ${length}`);
  }
});
