const test = require("node:test");
const assert = require("node:assert/strict");

const { injectInlineStyle } = require("../src/utils");

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
