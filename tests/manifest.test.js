const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("manifest.json parses as plain JSON", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});
