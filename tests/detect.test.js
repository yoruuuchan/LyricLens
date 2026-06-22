const test = require("node:test");
const assert = require("node:assert/strict");

const { detectLanguage } = require("../src/detect");

test("detects Japanese whenever kana is present", () => {
  assert.equal(detectLanguage(["僕らは夢を見ていた", "さよならだけが人生だ"]), "ja");
});

test("detects English when latin letters dominate", () => {
  assert.equal(detectLanguage(["I really want to stay at your house", "And let yourself go"]), "en");
});

test("treats CJK without kana as other", () => {
  assert.equal(detectLanguage(["我真的很想留在你家", "然后放纵自己"]), "other");
});

test("ignores punctuation and whitespace when detecting English", () => {
  assert.equal(detectLanguage(["  --- I won't let go!!!  ", "..."]), "en");
});
