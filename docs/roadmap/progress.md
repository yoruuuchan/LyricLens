# 进度日志

最新的在上面。每次有实质性进展或决策就记一条，格式：

```
## YYYY-MM-DD [tag] 一句话标题
- 做了什么
- 学到了什么
- 下一步
```

tag 含义：`[plan]` 路线决策 / `[probe]` probe 结果 / `[ship]` 产品功能上线 / `[debug]` 排查问题 / `[note]` 其他记录

---

## 2026-06-30 [ship] Task #4 自定义 prompt + 多语言支持进 PR #4

Codex 接上 `HANDOFF-2026-06-30-session2.md` 后，把 Task #4 的 UI、测试、build、部署和 PR 都收到了可验收状态。

要点：
- `feat/custom-prompt-multi-lang` 已 push，PR #4 处于 draft，PR head 是 `68fa5cd`
- 设置面板 AI 服务 tab 已有学习偏好、目标语言、知识点勾选、自定义 Prompt 高级折叠区、恢复默认
- 真机反馈的两个问题已修：自定义 Prompt 展开会自动合上/跳顶、`中文` 显示成 `ä¸­æ`
- 验证：`npm test` 331 pass，`npm run build` 成功
- 本次 `.plugin` 已部署到 `D:\CloudMusic\betterncm\plugins\LyricLens.plugin`，覆盖前备份是 `LyricLens.plugin.bak-prompt-scroll-encoding-20260630-140058`
- 未跟踪文件 `LyricLens_D_E_research_raw_urls.md` 和 `probes/lrclib-benchmark/` 仍不属于 PR

下一步：Yoru 启动/重启 NCM 做最终真机验收；没问题就把 PR #4 从 draft 收口/merge。

## 2026-06-30 [note] 换 session 交接 — #2 卡在 UI 验证最后一步

Yoru 额度快没了切窗口。详情看 **`HANDOFF-2026-06-30.md`**。

要点：
- task #2 (Update check + one-click download) **90%**，代码全在，等真机验证 UI 修复
- 顺手发现并修了**地基级 bug**：`src/styles.js` 之前硬编码 panel.css 字符串，导致改 panel.css 不生效（task #19）。已经把 build 脚本改成 build 时把 panel.css → styles.js marker 块。新 .plugin 已 build 成功、本地验证 JS literal 合法，但**还没部署到 NCM**
- manifest.json 现在是 v0.0.9（测试用，**最后必须改回 v0.1.0**）
- 不要碰那 2 个 fallback parse 测试（旧 fail，跟 #2 无关）

下一步：build → 部署 → Yoru 看截图反馈 → 没问题就 manifest 回 0.1.0 → commit + PR

## 2026-06-29 [plan] 路线图大改 — 双 host 提到北极星地位

Yoru 看进度汇报时抓到我："不依靠 betterncm 这件事怎么消失了"。

她说得对——我在最后那次汇报里把"脱离 BetterNCM"压成了远期一行小字，实质上等于降级。她明确："想早点脱离，最终独立出来更好"。

**新北极星**：LyricLens = 一个产品，两个 host。Plugin (BetterNCM) 和 Desktop (Tauri) 是两个独立完整产品，**不是主从**。两边通过 JSON 导出/导入打通数据格式，不实时同步。

**架构含义**：
- 阶段 2 的 "core 抽取" 工作量翻 1.5x（必须支持双 host）
- 收藏存储 plugin 用 IDB / desktop 用 SQLite，**core 抽象 storage interface 不一定做**——通过 JSON 序列化打通就行
- Probe D（Now Playing 跨平台）+ Probe E（LRCLIB 命中率）**必须做**，是 desktop 产品能不能成立的前提
- Tauri companion 现状是查看器，要重写成主体

**任务变化**：
- 删除旧 task #3（原 core 解耦，单 host 视角）
- 新建 #13 (Probe D)、#14 (Probe E)、#15 (双 host core 抽取)、#16 (LyricSource interface)、#17 (Tauri standalone)、#18 (跨 host 数据互通)
- 给 task list 加 blockedBy 依赖：#4/#5 都 blocked by #15；#17 blocked by 13/14/15/16；#16 blocked by 15
- 改 task #6 描述：明确双 host 存储（IDB + SQLite）+ 共享 JSON 格式

**README.md 重写**，进度日志的最高优先级目标统一改为"双 host 北极星"。

## 2026-06-29 [ship] landing 按 yoru-and-akari 设计系统重写 ✅

参考 `D:\DESIGN\yoru-and-akari Console Design System (1)` 全套 token 重写 landing：

- **双主题**：akari (cool porcelain) / yoru (midnight indigo)，跟随 `prefers-color-scheme`
- **字体**：Geist + Geist Mono + Zen Kaku Gothic New（Google Fonts）
- **品牌**：左侧暖橙圆 (akari) + 右侧冷蓝圆 (yoru) 相切 mark + lowercase wordmark `akari·yoru`
- **soft neumorphism**：双向高光/冷阴影 shadow，inset 给沉浸控件（code 块）
- **glass pill**：service status pill 用 backdrop-filter
- **JP accents**：`歌詞のレンズ` / `灯と夜` 等点缀
- **frost dot breathe animation**：状态点呼吸效果 2.6s 循环
- 全 lowercase 文案：`download` / `prerequisite` / `restart` / `listen`
- mobile-first 设计宽度，540px 以下断点

**部署机制升级**：从 MCP execute 改为 `cloudflare-worker/deploy.sh`（WSL bash + curl + Cloudflare API token）。MCP execute 在 large payload 上不便（30KB base64 inline 不优雅）；新脚本直接 PUT multipart，可重复用。

成果：
- worker.js 9KB → 23KB（多出来是 design tokens + 完整 light/dark CSS）
- 部署 etag `80b8cbadba1815ae9bef8a408eb99e9d0d6ff63d38e658de2dca97237ef9e61b`
- task #12 完成

## 2026-06-29 [ship] Probe C / 子域名 / Worker 全部上线 ✅

**子域名活了**：`lyriclens.yoru-and-akari.dev`

- Worker `lyriclens-api` 部署成功（通过 Cloudflare MCP 直接 PUT 多部分上传，没用 wrangler）
- 用 **Workers Custom Domain** 接的（不是 zone-level route），证书 30 秒内签好
- 6 个端点全部 200 OK
- `/download` 302 → GitHub Release latest，但因为现有 v0.1.0 asset 还叫 `LyricLens-0.1.0.plugin`，目标 404。下次发版用固定文件名 `LyricLens.plugin` 后自动通

**踩坑**：
- MCP token 没 zone-level "Workers Routes:Edit" 权限，第一次试 zone routes 报 10000 auth error。改用 account-level Workers Custom Domain API 成功
- 第一次外层调用同时创建 DNS + route 失败回滚不彻底——DNS 已建但 route 没建，外层报错。后来删除 DNS 重做（Custom Domain 自己管 DNS）

**任务收口**：
- task #9 (Probe C) → completed
- task #1 (子域名上线 + landing) → completed（landing 也在 Worker 里）
- task #2 (#2 一键更新) 进入实际可做状态——`/latest.json` 已经在线，插件代码消费它就行

## 2026-06-29 [probe] Probe B 跑通 ✅ → IndexedDB 当主存储

**Phase 1**：1MB / 10MB / 50MB / 100MB 单条记录全过，累计写 161.5MB 不爆
**Phase 2**：NCM 完全重启后 132 秒，全部 4 条 ladder + marker 完好，verdict `PERSISTENCE_OK_ALL_LADDER_BYTES_SURVIVED`

物理路径：`C:\Users\15877\AppData\Local\NetEase\CloudMusic\webapp91x64\IndexedDB\orpheus_orpheus_0.indexeddb.{leveldb,blob}`

**决策**：
- Stage 3 收藏功能用 IndexedDB
- 不需要双写备份，但要做"导出全部收藏"按钮
- followup（不阻塞）：测一下用户点 NCM"清理缓存"按钮会不会清 IDB

**新增 task #11**：config.json 里 API key 明文存储，加密层延后做但要先记上

## 2026-06-29 [probe] Probe A 跑通 ✅ → 更新走 B 档·半自动

环境：BetterNCM 1.3.4 + NCM 3.1.23.204764 + Chromium 91

**结论**：
- `fs.writeFile(blob)` 10MB 仅 126ms，覆盖写也过
- `fs.rename` 在 `betterncm.fs` 缺，但在 `betterncm_native.fs` 有
- `betterncm_native.app.restart()` 存在
- `plugin.pluginPath` / `plugin.filePath` 可用，自检方便
- `navigator.storage.estimate()` 不存在（Chromium 91 太老），Probe B 设计要调
- `location.href = orpheus://orpheus/pub/app.html`（自定义 URL scheme，可能影响 IDB 持久化）
- `C:\betterncm` 是 junction → `D:\CloudMusic\betterncm`

**踩坑**：
- BetterNCM 1.3.4 manifest 必须有 `ncm3-compatible: true`，否则插件被静默跳过
- BetterNCM 不会在 NCM 启动后自动扫新 .plugin，必须从 BetterNCM 装或重启 NCM

**已做**：
- probe.plugin 已卸载
- report 移到 `probes/updater-probe/report-2026-06-29.json`（项目内可查）
- LyricLens 主体 + 备份完好无损
- 决策已填进 `probe-a-updater.md`：#2 走 B 档（半自动 = 下载→提示→一键 restart）

**下一步**：
- Probe B：因 Chromium 91 没 storage API，需要改设计 → 直接 indexedDB.open + 实际写数据测 quota
- Probe C：Cloudflare Worker 可以开干

## 2026-06-29 [probe] Probe A 代码就绪，等 Yoru 跑

- 写了 `probes/updater-probe/probe.js`，打包成 5.67 KB 的 `.plugin`
- 测点：BetterNCM/native API surface、fs.writeFile(blob) 100kb/1mb/10mb、rename、覆盖写、readDir、reload/restart API inventory（不主动跑，留 console helper）
- 同时改了 `build-plugin.ps1` → 输出 `LyricLens.plugin`（固定名，无版本号，task #10 完成）。GitHub Release latest 直链需要固定文件名才能用。
- 一并更新 `tests/smoke.test.js` 里的旧文件名。注意现存的 2 个 fail 是改之前就在 fail 的（auto-retry 那个 commit 引入的），跟我这次改动无关
- 下一步：等 Yoru 装 probe → 贴回 console log + report.json → 填决策

## 2026-06-29 [plan] Stage 1-3 路线敲定 + 启动 Probe A/B/C

- Yoru 提了 5 件事：子域名、检查更新、收藏、自定义 prompt、词库
- 讨论后整理成阶段 1（分发）→ 阶段 2（core 解耦 + 自定义 prompt）→ 阶段 3（学习闭环）
- GPT 给了 8 个 P0-P3 问题的调研报告（下载在 `C:\Users\15877\Downloads\LyricLens_next_stage_technical_research.md`）
- 调研结论：BetterNCM 自更新可行但热重载不一定干净、IndexedDB 没有验证案例、SMTC 不能覆盖所有播放器、网易云歌词 API 已被作者归档不能当基础设施、CET/IELTS 词表大多授权不清
- 下一步：先做 Probe A（自更新能力）+ Probe B（IDB）+ Probe C（Cloudflare Worker），其它都等 probe 结果
- 文档结构：`docs/roadmap/` 放执行文档，旧的 `HANDOFF.md` 已经废
