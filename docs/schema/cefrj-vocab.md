# CEFR-J 英语参考等级词库 — 数据 schema、KV 结构、客户端策略

**Status**: locked 2026-07-02（session 8 实测数据源后起草，随管道实现同 PR 交付；同日 Yoru 拍板两个决策点：**C1/C2 排除**（不吃 ShareAlike 义务）、**UI 无条件显示不加开关**）。改之前必须重新讨论。
**Scope**: 桌面版（Tauri Rust 侧）先行，插件版后续同步。与 [`jlpt-vocab.md`](jlpt-vocab.md) / [`en-exam-vocab.md`](en-exam-vocab.md) 共用 `dicts-cdn` Worker 与部署管道；`cefrj/*` family 在 Worker allowlist 早已天然放行。
**决策来源**: 路线决策 #12（MVP 词库 = CEFR-J 英 + JLPT 日，2026-06-30 锁定）+ en-exam-vocab.md §二期预留点名 + 2026-07-02 数据文件实测核验（不止 README——session 7 教训）。

## 设计意图

给歌词里的英语词汇标 CEFR-J 参考等级（A1/A2/B1/B2），让学习者知道这个词大概什么难度水平。这是**通用英语分级**，与考试无关——enexam 回答"这个词在不在我的考纲里"，CEFR-J 回答"这个词是什么难度"。两者正交并存。

**不是**官方认证、**不是**完整词典、**不是**学习路径推荐。

## 与 JLPT / enexam 的关键差异

| | JLPT | enexam | CEFR-J |
|---|---|---|---|
| 体系 | 单一（N1-N5，一词一级） | 多体系（一词多标签） | 单一（A1-B2，一词一级）— **JLPT 同构** |
| 显示 | 无条件 | 仅用户选中的目标考试 | 无条件（提案，见 §UI 渲染规则） |
| 数据源 | Tanos 单谱系 🟡 | 无干净单源，双源互证 | **唯一 🟢 源**，单源直取，无需互证 |
| runtime 值 | `Vec<JlptEntry>` | `Vec<String>` tags | `String` level |

## 数据源

| 角色 | 项目 | License | 用途 | 风险灯 |
|---|---|---|---|---|
| 唯一数据源 | [`openlanguageprofiles/olp-en-cefrj`](https://github.com/openlanguageprofiles/olp-en-cefrj) `cefrj-vocabulary-profile-1.5.csv` | © Tono Lab (TUFS)，README 明文 "research and commercial purposes with no charge, provided that you cite the dataset properly" | A1-B2 全部 7799 行；只取 headword + CEFR 两列，pos / CoreInventory / Threshold 列不碰 | 🟢 |
| ~~C1/C2 补充~~ | ~~同仓库 `octanove-vocabulary-profile-c1c2-1.0.csv`~~ | **CC BY-SA 4.0（ShareAlike）** | **排除（Yoru 拍板 2026-07-02）**。ShareAlike 正是 JLPT 选型时特意避开的义务（决策 #12：弃 yomitan CC BY-SA 选 Bluskyo MIT）。排除代价实测：1950 个 C1/C2 独有词（与主表交集 186 词已有更低级标注）；歌词场景超高阶词出现率低，宁缺毋滥 | 🟡 SA 不进管道 |

**2026-07-02 实测记录**（数据文件逐行核验，非 README 转述）：
- 仓库无独立 LICENSE 文件（GitHub API license=null），授权条款全在 README §Terms of use——两个数据文件条款**不同**，不可当一个整体引用
- 主表 7799 行，CEFR 列只有 A1/A2/B1/B2 四个干净值，无细分（A1.1 等）无脏值
- headword 形态：167 行斜杠拼写变体（`airplane/aeroplane`）、144 行短语（`according to`、`alarm clock`）、58 行含大写（月份/专有名词/缩写）、2 行含 é（`café`）、850 个 headword 多行（同词不同 pos 不同级，其中 573 个真跨级）

## 构建规则

```text
每行 (headword, CEFR):
  按 "/" 拆拼写变体 → 每个变体 trim → lowercase
  → 只留 /^\p{L}[\p{L}\p{N} .'-]*$/u
    （短语和 "mp3 player" 是人工整理的合法词条，保留——与 enexam 丢短语不同，
     那边丢的是 OCR 噪音；被拒的只有缩约词尾 'm / 're / 's 共 3 个 token）
  → é 折叠生成别名 key（café → cafe 双 key 同级，LLM 两种写法都命中）
  → 同 key 出现在多个等级 → 取最低级
    （"参考等级"语义 = 学习者最早接触的难度：above 是 A1（副词/介词）不是 B1（形容词））
```

- 被拒 token 写进构建产物 `dropped.txt` 带原因，不静默
- **规模校验（实测基线 2026-07-02，olp-en-cefrj@c5c6a64）**：
  rows=7799 ∈ [7000, 8500]、A1=1164 ∈ [900, 1500]、A2=1411 ∈ [1100, 1800]、
  B1=2446 ∈ [2000, 3000]、B2=2778 ∈ [2200, 3400]、entries=7017 ∈ [6500, 8000]。
  任一出带即 `exit 2` 中断构建（上游 reshape 数据时停下来重核验，不静默发布）
- 实测产物：7017 keys、compact JSON 106.6KB、brotli 23.2KB（比 enexam 25.8KB 更轻）

## Cloudflare KV 结构

复用 `dicts-cdn` Worker（allowlist `<family>/(manifest.json|*.json.(br|gz))` 天然放行）：

```text
KV key                                  公开 URL
cefrj/manifest.json                     https://dicts.yoru-and-akari.dev/cefrj/manifest.json
cefrj/cefrj-levels.olp-<sha7>.v1.json.br  https://dicts.yoru-and-akari.dev/cefrj/cefrj-levels.olp-<sha7>.v1.json.br
cefrj/cefrj-levels.olp-<sha7>.v1.json.gz  同名 .gz 变体（给插件版 host）
```

**gzip 变体（2026-07-02 追加，分发层 additive）**：每个 blob 同时发布 `.json.gz`，manifest `sources.<build>` 加 `gzip: {url, sha256, bytes}` 字段（optional 字段不 bump schema）。插件版 host 消费它——NCM 内嵌 Chromium 91 无 brotli 解码器（`DecompressionStream` 仅支持 gzip/deflate）；`.br` 仍是桌面版的 canonical blob，桌面侧零改动。

单源有真实 commit sha 可用，`<build>` 走 JLPT 的 `<source>-<sha7>` 惯例（如 `olp-c5c6a64.v1`），不用 enexam 的 `multi-<yyyymmdd>` 日期形式。sha 取 `commits?path=cefrj-vocabulary-profile-1.5.csv` 的 last-touching commit（数据文件没动则 build 可复现）。发布流程与 JLPT/enexam 相同：blob 先行 → 60s KV 传播 → manifest 收尾。

## Runtime JSON schema

三个 family 里最简单的——word → level 单值：

```json
{
  "schema": 1,
  "generated_at": "2026-07-02T00:00:00Z",
  "license": "CEFR-J Wordlist v1.5 (Tono Lab, TUFS) — free for research & commercial use with citation; headwords + levels only",
  "sources": { "olp-en-cefrj": "c5c6a64" },
  "entries": {
    "abandon": "B1",
    "above": "A1",
    "according to": "B1"
  }
}
```

level 枚举：`"A1" | "A2" | "B1" | "B2"`（二期若纳入 C1/C2 则追加，属 additive 变化不 bump schema）。

## 客户端 lookup 策略

```text
LLM 卡片里 vocabulary point 的 surface（prompt 已要求 base form）
  → lowercase → exact match HashMap
  → 未命中不显示（继承 JLPT 规则，不显示「未知」）
  → 命中 → 渲染 level badge
```

**MVP 不做词形还原**（running→run），与 JLPT/enexam 同款决策。日语词天然 miss 全英文 key space，无需语言检测（enexam 已验证此路径）。

## Tauri Rust 侧实现

session 7 抽的泛型 `dict_store.rs` 直接受益——`cefrj.rs` 是 `enexam.rs` 的孪生，只换两个类型参数：

```rust
pub const CONFIG: DictConfig = DictConfig {
    family: "cefrj",
    manifest_url: "https://dicts.yoru-and-akari.dev/cefrj/manifest.json",
};
pub type CefrjStore = DictStore<String>;   // enexam 是 DictStore<Vec<String>>
// lookup_level(word) -> Option<String>：lowercase exact match
```

```ts
// 前端调用
invoke("cefrj_lookup", { word }) → string | null   // e.g. "B1"
```

bootstrap 与 jlpt/enexam 并发跑（互不阻塞），失败策略继承：网络/校验失败回退缓存，无缓存则空 store，UI 不渲染 badge，绝不影响启动。

## UI 渲染规则

**无条件显示，与 JLPT 完全对称**（CEFR-J 之于英语 = JLPT 之于日语，都是单体系参考等级）。不新增设置项。Yoru 拍板 2026-07-02。

| 情况 | 显示 |
|---|---|
| 命中 | `A1` / `A2` / `B1` / `B2` pill（样式复用 `.jlpt-badge` 家族） |
| 未命中 | 不显示 |
| hover tooltip | `CEFR-J 参考等级 · 数据 © Tono Lab (TUFS)` |

不做"只显示 B1 以上"之类的过滤——LLM 挑词汇点时已过滤 trivial 词（the/you 不会成为 point），A1 泛滥场景实际不存在；真吵了再加开关（与"真发现高频 miss 再评估"同款原则）。

与 enexam badge 并存：`.point-row` 已是 4 列 grid（jlpt + enexam slot），cefrj 加第 5 个 slot，空 slot 塌缩 0 宽，互不挤占。

**文案严格规则**：
- ✅ "CEFR-J 参考等级 / community-distributed reference level"
- ❌ "官方认证 / CEFR 官方 / 欧标认证"（CEFR-J 是东京外国语大学的日本适配版，不是欧洲官方 CEFR；且我们的数据快照也不该自称官方）

## Attribution

README 的 Terms of use 要求 "cite the dataset properly"。`About` 页面必须显示：

```
CEFR-J 参考等级数据来自 CEFR-J Wordlist Version 1.5
（compiled by Yukio Tono, Tokyo University of Foreign Studies，
经 openlanguageprofiles/olp-en-cefrj 分发）。
版权归东京外国语大学投野研究室所有，允许注明出处的免费商用。
LyricLens 仅保留单词与等级两个字段，不含词性、释义、例句。
等级为参考信息，与 CEFR-J 项目无关联，未获官方背书。
```

## 二期预留（本文档不锁定，到时另行讨论）

- **C1/C2 补充**：若 Yoru 拍板接受 Octanove 的 CC BY-SA（或未来出现干净替代源），管道加第二输入文件即可（entries additive，schema 不 bump）；主表交集 186 词维持主表的更低等级
- 插件版同步（与 jlpt/enexam/mastery 一起，独立 vertical）

## 实现状态

- [x] 主仓库 `scripts/preprocess-cefrj.mjs`：单源下载 → 变体拆分/清洗 → 最低级合并 → envelope → brotli → sha256/manifest（2026-07-02 实跑 7017 keys / blob 23.2KB / dropped 3）
- [x] KV 上传：复用桌面版 `cloudflare-worker-dicts/upload-blob.sh`，family=`cefrj`（2026-07-02 上线：blob 23211 bytes；CDN 冒烟 sha256 匹配 / 7017 entries / 抽查 above→A1、café+cafe→A1、according to→B1 全对）
- [x] 桌面版 `cefrj.rs`（`DictStore<String>`）+ `cefrj_lookup` command + 并发 bootstrap（桌面 PR #36，2026-07-02 merge，cargo 64 全绿）
- [x] 桌面版 badge slot/hydrate（照 jlpt pattern，无设置项）（同 PR #36；真机验收 abandon→B1 / ability→A2 / acute→B2 / abolish→B2）
- [x] About 页 attribution section（同 PR #36）
- [ ] 插件版同步（独立 vertical）
