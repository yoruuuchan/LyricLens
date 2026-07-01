# JLPT 参考等级词库 — 数据 schema、KV 结构、客户端策略

**Status**: locked 2026-06-30. 改之前必须重新讨论。
**Scope**: 桌面版（Tauri Rust 侧）+ 插件版（NCM 注入环境）共用同一份 KV 数据。
**决策来源**: [`docs/roadmap/README.md` 决策 #12](../roadmap/README.md) + 调研报告 `C:\Users\15877\Downloads\lyriclens_jlpt_vocab_research.md`。

## 设计意图

给歌词里的日语词汇标一个"参考难度等级"，让中文母语用户知道这个词大概有多难。**不是**官方 JLPT 考试词表、**不是**完整词典、**不是**学习路径推荐。

## 数据源

| 角色 | 项目 | License | 用途 |
|---|---|---|---|
| 首选 | [`Bluskyo/JLPT_Vocabulary`](https://github.com/Bluskyo/JLPT_Vocabulary) | MIT 仓库代码 + Tanos CC BY 数据 | MVP 用 |
| 备选 | [`stephenmk/yomitan-jlpt-vocab`](https://github.com/stephenmk/yomitan-jlpt-vocab) | CC BY-SA 4.0 | feature flag 切换 |
| 上游 | [Tanos / Jonathan Waller JLPT Resources](http://www.tanos.co.uk/jlpt/) | CC BY | 真正的原始数据 |

**所有可用候选都是 Tanos 谱系**——不存在"独立第二来源"做交叉验证。这是产品决策的硬约束：UI 必须承认这只是"参考等级"。

为什么不选 yomitan（虽然维护更活跃、有 JMdict mapping）：
- CC BY-SA 4.0 要求改编后的数据继续 ShareAlike，对未来桌面版商业分发的解释空间有限
- Bluskyo MIT + Tanos CC BY 路径完全没有 ShareAlike 义务，灵活度更高
- Bluskyo MVP 质量足够；真发现误标多再切

## Cloudflare KV 结构

**部署 target**：`dicts.yoru-and-akari.dev` 子域（`dicts-cdn` Worker + `LYRICLENS_DICTS` KV namespace）。schema 文档 lock 时预期的根路径 `yoru-and-akari.dev/dicts/...` 在实施时改为子域，因为根域已被 Cloudflare Pages landing 站占用 —— 子域分离更干净、未来 CEFR-J 家族共用同 CDN 更清晰。

```text
KV key                                    公开 URL
jlpt/manifest.json                        https://dicts.yoru-and-akari.dev/jlpt/manifest.json
jlpt/jlpt-levels.bluskyo-<sha7>.v1.json.br  https://dicts.yoru-and-akari.dev/jlpt/jlpt-levels.bluskyo-<sha7>.v1.json.br
jlpt/jlpt-levels.yomitan-<version>.v1.json.br  ← 备选,可选上传
```

manifest 用短缓存（1h），versioned blob 用长缓存（`max-age=31536000, immutable`）。**发布流程**：先上传 blob → 等 KV 传播（~60s）→ 再更新 manifest。

版本 tag 用 Bluskyo 上游 commit 的 short sha（脚本自动查 `commits?path=...` API 拿最近一次），例如 `bluskyo-d29a678.v1`。这样多次上游更新的 blob 可以在 KV 里共存，manifest 用 `latest` 字段指向当前活跃版本。

### manifest.json

```json
{
  "name": "lyriclens-jlpt-levels",
  "schema": 1,
  "latest": "bluskyo-d29a678.v1",
  "generated_at": "2026-07-01T19:58:31.327Z",
  "sources": {
    "bluskyo-d29a678.v1": {
      "url": "https://dicts.yoru-and-akari.dev/jlpt/jlpt-levels.bluskyo-d29a678.v1.json.br",
      "encoding": "br",
      "license": "MIT-repo / CC-BY-upstream",
      "source": "Bluskyo/JLPT_Vocabulary @ d29a678",
      "upstream": "Jonathan Waller / Tanos JLPT Resources (CC BY)",
      "sha256": "3df62da131e582aa0c0595c101bef7d478f9d2889a5fb03091d64a4483402b22",
      "bytes": 63939
    }
  }
}
```

**首次上线数据规模** (Bluskyo @ d29a678, 2026-07-01)：8138 surfaces / 8505 candidates。level 分布 N1=3475 / N2=1846 / N3=1835 / N4=649 / N5=700。JSON 779 KB → brotli quality 11 压 63.9 KB (8.2%).

## Runtime JSON schema

**不要**用 `Record<string, "N5">` —— 同一词不同表记/reading 可能不同 level，强行压成单值会丢信息。

```json
{
  "schema": 1,
  "generated_at": "2026-06-30T00:00:00Z",
  "license": "MIT (repo) / CC BY (upstream data)",
  "source": {
    "name": "Bluskyo/JLPT_Vocabulary",
    "version": "1.5",
    "url": "https://github.com/Bluskyo/JLPT_Vocabulary",
    "upstream": "Tanos / Jonathan Waller"
  },
  "entries": {
    "挨拶": [
      { "level": "N3", "reading": "あいさつ", "source": "bluskyo", "confidence": "source" }
    ],
    "あいさつ": [
      { "level": "N4", "reading": "あいさつ", "source": "bluskyo", "confidence": "source-surface" }
    ]
  }
}
```

字段说明：
- `entries[surface]` 是数组，允许同一 surface 在不同 reading / source 下有不同 level
- `confidence` 取值：`source`（数据源直接给的）/ `source-surface`（同 surface 不同 reading）/ `lemma`（归一化后匹配）

## 客户端 lookup 策略

```text
LLM 卡片里的 highlight.text （已经被 LLM 提取出来的词）
  → exact(surface, reading) 优先 (reading 来自 LLM 卡片里附的假名)
  → exact(surface) 次选
  → 不命中就不显示 badge
  → 命中多个 level 候选时返回所有,UI 自己决定渲染
```

**MVP 不做日语分词**。原因：LLM 输出的 `highlights[].text` 已经是「提取出来的词」，直接 surface lookup 就够。等真发现高频误标，再上 [`lindera`](https://github.com/lindera-morphology/lindera) 或 [`sudachi.rs`](https://github.com/WorksApplications/sudachi.rs)。

## Tauri Rust 侧实现

**不**把词库放 `localStorage` / IndexedDB。统一在 Rust 侧管理：

```text
启动时：
1. 读取 app data dir 里的 manifest cache
2. 后台拉 Cloudflare manifest
3. 如果 version / sha256 变化 → 下载新 versioned blob
4. 校验 sha256
5. brotli 解压 → 加载为 HashMap<String, Vec<JlptEntry>>
6. 暴露 Tauri command 给前端调用
```

Rust 依赖：

```toml
serde / serde_json    # parse manifest + lookup JSON
reqwest               # 下载 manifest + blob
sha2                  # 校验
brotli                # 解压
```

**词库走 HashMap，不走 SQLite**。SQLite 只用于 [`NotebookEntry`](notebook-entry.md) 存储。两套数据职责分离。

Tauri command 示例：

```ts
type JlptLookupResult = {
  surface: string;
  candidates: Array<{
    level: "N1" | "N2" | "N3" | "N4" | "N5";
    reading?: string;
    source: string;
    confidence: "source" | "source-surface" | "lemma";
  }>;
};

// 前端调用
invoke("jlpt_lookup", { surface, reading }) → JlptLookupResult
```

## UI 渲染规则

| 情况 | 显示 |
|---|---|
| 命中唯一 level | `JLPT N5` |
| 命中多 level 候选 | `JLPT N3 / N4`（按数字升序） |
| 未命中 | 不显示 badge（不显示「未知」，避免噪音） |
| hover tooltip | `JLPT 参考等级 · 数据来自 Bluskyo / Tanos community list` |

**文案严格规则**：
- ✅ "JLPT 参考等级 / community-derived JLPT reference level"
- ❌ "JLPT 官方等级 / Official JLPT level / N5 必考词"

## Attribution

`About` 页面必须显示：

```
JLPT 参考等级数据来自 Bluskyo/JLPT_Vocabulary
(https://github.com/Bluskyo/JLPT_Vocabulary), MIT licensed.
原始词表来源是 Jonathan Waller 的 Tanos JLPT Resources
(http://www.tanos.co.uk/jlpt/), licensed under Creative Commons Attribution.
LyricLens 把数据转成 compact lookup JSON，不包含释义、例句、官方 JLPT 考试材料。

JLPT 是由 Japan Foundation 与 Japan Educational Exchanges and Services 主办。
LyricLens 与 JLPT 主办方无任何关联，也未获得任何官方背书。
```

英文版照搬调研报告 §6.1 的英文模板。

## 切换预案 / feature flag

```text
JLPT_DATA_SOURCE = bluskyo | yomitan | off
```

桌面版从设置 / 环境变量读，插件版从 BetterNCM config 读。

切换条件：
- 用户反馈某个 level 误标率 > 某阈值（待定阈值，建议等收到 ≥10 条反馈后再决定）
- 法律 / license 解释发生重大变化（极不可能）
- yomitan-jlpt-vocab 更新到了对我们有显著价值的新版本（比如修复了大量 Tanos 老错误）

切换不需要发桌面版新版——更新 KV manifest 的 `latest` 字段即可（前提是两个数据 blob 都已经上传到 KV）。

## 质量审计预留

后续如果要对 Bluskyo / yomitan 数据做全量 diff，加 `tools/audit-jlpt-levels.ts`：

```text
exact surface+reading 冲突率
surface-only 冲突率
level 分布对比
sample conflicts
rare spelling replacements
```

这个脚本现在不写，等真的怀疑数据质量再上。

## 实现状态

- [x] manifest.json + KV 上传脚本 —— [`cloudflare-worker-dicts/upload-blob.sh`](../../../lyriclens-desktop/cloudflare-worker-dicts/upload-blob.sh)（桌面版仓库），blob-then-manifest 顺序 + 60s KV 传播等待
- [x] Bluskyo 数据预处理脚本 —— [`scripts/preprocess-jlpt.mjs`](../../scripts/preprocess-jlpt.mjs)，upstream JSON → compact envelope → brotli q11 → sha256/manifest
- [x] Tauri Rust 端 manifest 拉取 + sha256 校验 + 解压 + HashMap 加载 —— [`src-tauri/src/jlpt.rs`](../../../lyriclens-desktop/src-tauri/src/jlpt.rs) `bootstrap()` / `refresh_from_network()`
- [x] Tauri command `jlpt_lookup(surface, reading?) → JlptLookupResult` —— `src-tauri/src/lib.rs` invoke_handler，State 是 `tokio::RwLock<JlptStore>` 在 setup hook 里 async 初始化
- [x] 桌面版前端 badge 渲染 + tooltip —— `src/jlpt.ts` + `src/main.ts` `renderJlptBadgeSlot` / `hydrateJlptBadges`，两阶段（sync slot + async fill）+ 内存 cache
- [x] About 页面 attribution —— `index.html` 设置 overlay 关于 tab 补 "JLPT 参考等级 · 致谢" section
- [ ] 插件版同步实现（lookup 走 BetterNCM 自身 fetch，缓存到 IndexedDB）—— 主仓库独立 vertical
- [ ] feature flag `JLPT_DATA_SOURCE` 设置入口 —— MVP 只有 Bluskyo blob，flag 意义不大，等真要切上 yomitan 再加
