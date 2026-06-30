# LyricLens 下一阶段执行文档

这个目录是 LyricLens 长期开发的工作台。每次开新窗口（不管是我换 session、Yoru 换设备、还是从 codex/gpt 那边切回来），都先来这里看一眼。

## 谁在主导

- **Yoru**：产品决策、本机 NCM 验证（probe 跑分、装新 .plugin）、最终拍板
- **Claude (这个 session)**：写代码、写文档、给方案、推进任务
- **GPT/Codex**：调研、给 brief、回答 Claude 解决不了的开放问题

## 北极星目标（2026-06-29 重新明确）

**LyricLens 是"一个产品，两个 host"。**

```
┌─────────────────────────────────────────────────────────────┐
│ LyricLens Core（独立 lib，host-agnostic）                  │
│  prompt / LLM / data schema / vocab indexing / card render  │
└─────────────────────────────────────────────────────────────┘
              ▲                                ▲
              │ host 1                         │ host 2
┌─────────────────────────┐         ┌─────────────────────────┐
│ Plugin (BetterNCM)      │         │ Desktop (Tauri)          │
│ src: NCM 注入            │         │ src: SMTC/MRMR/MPRIS    │
│ storage: IndexedDB      │         │ storage: SQLite          │
│ ui: NCM 浮层            │         │ ui: 独立窗口             │
│ lyrics: NCM 内存        │         │ lyrics: LRCLIB+公开 API │
└─────────────────────────┘         └─────────────────────────┘
                  ↕  JSON 导出 / 导入互通（不实时同步）
```

**Plugin 和 Desktop 都是独立完整产品**。两边数据格式打通，用户可以二选一、或两边都装。**BetterNCM 任何时候死了，Desktop 那一支不受影响。**

## 当前阶段地图

```
阶段 1 · 分发基建（80% 完成）
├─ ✅ Probe A · BetterNCM 自更新能力
├─ ✅ Probe B · IndexedDB 持久化
├─ ✅ Probe C · Cloudflare Worker + 子域名
├─ ✅ Task #1 · 子域名上线 + landing（带设计系统）
├─ ✅ Task #10 · build 固定文件名
└─ ⏳ Task #2 · 插件内一键检查更新（前置都通了）

阶段 2 · 双轨地基（关键阶段，所有后续都吃它）
├─ ⏳ Task #15 · core 抽取 + 双 host interface 设计 ← 核心
├─ ⏳ Task #16 · LyricSource pluggable interface（NCM = source 1）
├─ ⏳ Task #18 · 跨 host 数据互通格式（plugin ↔ desktop import/export）
├─ ✅ Probe D · Now Playing API 覆盖率（task #13，SMTC/MRMR/MPRIS）
├─ ✅ Probe E · 歌词反查命中率 benchmark（task #14）
└─ ⏳ Task #4 · 自定义 prompt + 知识点勾选（PR #4 draft，等最终真机验收/merge）

阶段 3 · 学习闭环
├─ ⏳ Task #5 · 词库 CDN
└─ ⏳ Task #6 · 收藏 + 词频 + 等级 + 导出（plugin 端 IDB / desktop 端 SQLite）

阶段 4 · 独立桌面版（任务 #17）
└─ ⏳ Tauri companion 从查看器升级为独立产品
   带 SMTC reader、LRCLIB client、SQLite、独立 UI、.msi 安装包

阶段 ∞ · 商业化（不一定做）
```

## 路线决策（已锁）

这些是 Yoru + Claude 在 2026-06-29 讨论后定的，**改之前必须再讨论**：

1. **北极星 = 双 host，独立桌面版是明确目标**（不是 fallback）。所有架构决策都要为双 host 服务。
2. **Plugin 和 Desktop 都是独立完整产品**，不是主从关系。用户任选一边都能用满所有功能。
3. **两边通过数据格式打通**（JSON 导入/导出），不做实时同步——那个太贵。
4. **远期"脱离 BetterNCM"靠 SMTC + LRCLIB + 独立桌面端**，不靠"手动粘歌词"。
5. **多语言 = 用户自己写 prompt**。插件不限制语言种类。
6. **词库走 CDN**，不内嵌进 .plugin。
7. **MVP 阶段词库只上 CEFR-J**（CC BY-SA 授权清楚）。CET/IELTS/TOEFL 等社区词表延后做 license 审计再上。
   - **2026-06-30 修订**：MVP 同时上 CEFR-J + JLPT，详见 #12。
8. **JLPT 标签标"参考等级"**，不能写"官方"。
9. **更新流程**：插件下载 → 校验 → 写入 → 提示用户重启。不追求纯静默热重载。
10. **子域名**：`lyriclens.yoru-and-akari.dev`（已上线）。

## 路线决策追加（2026-06-30）

桌面版 MVP 真机验收阶段触发的一批方向决策。基础是这次 SMTC timeline 调研报告（GPT 产出，`C:\Users\15877\Downloads\lyriclens_smtc_timeline_research.md`）。Yoru + Claude 锁定，**改之前必须再讨论**。

11. **平台范围 = Windows only**。macOS（MRMediaRemote 是 private API，苹果可以随时切）/ Linux（用户基数小）都不做，roadmap 的「阶段 4 跨平台」段落作废。
12. **MVP 词库 = CEFR-J（英）+ JLPT（日）双语**。修订决策 #7（"MVP 只 CEFR-J"）。
    - JLPT 数据源 = **`Bluskyo/JLPT_Vocabulary`（MIT 仓库 + Tanos CC BY 上游数据）**。选这个不选 `stephenmk/yomitan-jlpt-vocab`（CC BY-SA 4.0）是为了保留商业化灵活度（避开 ShareAlike 数据义务）。代价：质量不如 yomitan、没有 JMdict mapping、自己做清洗。
    - **不论选哪个，所有候选都是 Tanos 谱系，没有真正独立来源**——UI 必须严格写「参考等级 community-derived reference level」，不能写「官方」。
    - 切换预案：留 feature flag `JLPT_DATA_SOURCE=bluskyo | yomitan | off`，未来发现 Bluskyo 误标多可以切回 yomitan。
    - 详细 schema / KV 结构 / attribution / 客户端策略 → [`docs/schema/jlpt-vocab.md`](../schema/jlpt-vocab.md)
    - 调研报告原文 → `C:\Users\15877\Downloads\lyriclens_jlpt_vocab_research.md`
13. **学习闭环 = 笔记本式**。Star + 自加备注 + 导出给 Anki。**不做 SRS**（间隔复习提醒）。**不做词频统计**——用户主动 star 就够。
14. **收藏粒度 = 一句歌词的整张卡片**。原文 + 翻译 + 全部 highlights + LLM note + 用户备注打包成一条 `NotebookEntry`。**不做单 highlight 粒度、不做单词粒度**。
15. **跨 host 数据合并 = 两边都保留**。冲突时 `userNote` 用 `\n---来自 <source>---\n` 拼接，import 不覆盖本地。
16. **核心数据模型 = `NotebookEntry`**。两个 host 都按 [`docs/schema/notebook-entry.md`](../schema/notebook-entry.md) 实现。
17. **永久砍掉的方向**（明示，避免反复诱惑）：WASAPI loopback 推导歌曲 position / 网易云 InfLink-rs 兼容（让插件版去操心）/ Spotify Web API 深度集成（政策风险）/ macOS MRMediaRemote / 任何苹果生态 / 实时双 host 同步 / SRS 间隔复习 / 词频统计 / WAV onset 自动对齐 LRC。
18. **桌面版"播放器能力"按 timeline health 分级**，不按播放器名一刀切。`timeline_healthy` 才启用逐行同步；`metadata_only` 只显示静态笔记本式卡片。详细分类参考 SMTC timeline 调研报告 §7。

## ⚠️ 当前 IN-PROGRESS

**`HANDOFF-2026-06-30-session2.md` 是最新交接，先读它再做任何事。**

## 关键参考文档

- [`probe-a-updater.md`](probe-a-updater.md) — BetterNCM 自更新能力 ✅
- [`probe-b-storage.md`](probe-b-storage.md) — IndexedDB 持久化 ✅
- [`probe-c-cloudflare.md`](probe-c-cloudflare.md) — 子域名 + Worker ✅
- `probe-d-nowplaying.md` — SMTC/MRMR/MPRIS（待写）
- `probe-e-lyrics-sources.md` — LRCLIB 覆盖率（待写）
- `../detached-window-feasibility.md` — 历史调研，独立窗口可行性
- `C:\Users\15877\Downloads\LyricLens_next_stage_technical_research.md` — GPT 给的完整调研报告

## 进度日志

进度按时间倒序记在 [`progress.md`](progress.md)。

## 给"下一个我"的注意事项

- 先看 `progress.md` 最近 3 条，再看当前 stage 的 probe md
- 不要先动代码，先看每个 probe 文件最后的"决策"段落是不是 unblocked
- `HANDOFF.md` 已经废了（那是 PR #3 时期的，已经合并），新工作不要往那里写
- Yoru 是中文母语，技术上是小白，所有讨论用中文；code/commit/comment 英文
- 提到的所有路径以 Windows 为准（NCM 客户端在 Windows），但项目代码可能也会在 WSL 跑
- **任何架构决策都要问一句"双 host 下还成立吗"**。这是新增的硬约束。
