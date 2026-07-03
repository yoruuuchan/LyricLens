const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const worker = fs.readFileSync(path.join(__dirname, "..", "cloudflare-worker", "worker.js"), "utf8");

test("landing keeps the hero notebook phrase together at medium widths", () => {
  assert.match(worker, /\.hero \.lede \{[\s\S]*text-wrap:\s*balance;/);
  assert.match(worker, /\.nowrap \{ white-space: nowrap; \}/);
  assert.match(worker, /手机复习器——<span class="nowrap">三个入口，一本笔记本。<\/span>/);
});

test("landing desktop entry points to the first Windows installer release asset", () => {
  assert.match(
    worker,
    /https:\/\/github\.com\/yoruuuchan\/lyriclens-desktop\/releases\/latest\/download\/LyricLens_0\.1\.0_x64-setup\.exe/
  );
  assert.match(worker, />下载 Windows 安装包</);
  assert.match(worker, /Windows 10\/11 · v0\.1\.0 · AGPL-3\.0/);
  assert.match(worker, /SmartScreen/);
  assert.match(worker, />GitHub 仓库</);
  assert.doesNotMatch(worker, /正式安装包还没发/);
  assert.doesNotMatch(worker, /到 GitHub 看仓库/);
});

test("landing tells the relay-sync story while keeping JSON as fallback", () => {
  assert.match(worker, /桌面和手机配对一次，笔记就能加密接力/);
  assert.match(worker, /电脑推送、手机刷卡打分、进度自动流回/);
  assert.match(worker, /云上只停留 10 分钟密文/);
  assert.match(worker, /JSON 导出\/导入仍然保留，作为备份和插件侧通道/);
  assert.doesNotMatch(worker, /经 JSON 导出\/导入在三端自由流动/);
});

test("landing review entry mentions paired sync and original-line reading", () => {
  assert.match(worker, /配对后一键接收电脑推送的笔记/);
  assert.match(worker, /卡片可朗读原文/);
});
