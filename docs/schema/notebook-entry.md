# NotebookEntry — 跨 host 核心数据模型

**Status**: locked 2026-06-30；v1.1 additive fields 2026-07-02（`mastery` + `lastReviewedAt`，additive，不 bump 顶层 schema 字符串）。改之前必须重新讨论。
**Scope**: plugin 端 IndexedDB + desktop 端 SQLite + 两边 JSON import/export 都按这个 schema 实现。
**决策来源**: [`docs/roadmap/README.md` § 路线决策追加（2026-06-30）](../roadmap/README.md) 决策 #13–#16；v1.1 mastery 追加决策 2026-07-02（安卓单词本 app 三档复习评价 + 隐式 new）。

## 设计意图

LyricLens 的学习闭环采笔记本式：用户主动 star 想留的内容，自己加备注，最终导出给 Anki 做复习。这个 schema 是这条产品路径的最小数据单位。

> **不做**：SRS / 词频统计 / 单 highlight 粒度收藏 / 单词粒度收藏。这些都讨论过被砍。再看到把它们引回 schema 的 PR，要拒绝并指向这份文档。

## TypeScript 定义

```ts
// LLM 卡片里的一条知识点
type AnalysisPoint = {
  type: "vocabulary" | "grammar" | "culture" | "pronunciation" | "tone" | "general";
  text: string;
};

// LLM 为一句歌词生成的完整卡片
type AnalysisCard = {
  index: number;              // = lineIndex,冗余字段,历史遗留
  lineIndex: number;          // 原始歌词数组的行号
  original: string;           // 原文歌词
  translation: string;        // LLM 翻译
  points: AnalysisPoint[];    // 知识点列表
  note: string;               // LLM 给的"额外补充"
  startMs: number | null;     // 这一行的开始时间（来自 LRC）
  endMs: number | null;       // 下一行的开始时间
};

// 笔记本一条记录 = 一句歌词的整张卡片 + 用户备注
type NotebookEntry = {
  id: string;                 // uuid v4,本地唯一
  songKey: string;            // 业务唯一性的歌曲指纹,见下
  songTitle: string;          // 原始大小写保留
  songArtist: string;
  lineIndex: number;          // 原始歌词数组行号
  lineText: string;           // 原文歌词（冗余存,方便搜索）
  card: AnalysisCard;         // LLM 生成的整张卡片快照
  userNote: string;           // 用户自加备注,自由文本
  starredAt: number;          // unix ms,创建时间
  updatedAt: number;          // unix ms,最后改备注时间
  source: "plugin" | "desktop"; // 创建这条 entry 的 host
  importMergedFrom?: string[]; // 该 entry 由 import 合并产生时,记录上游 entry id

  // v1.1 additive fields (2026-07-02) —— 进度日记,不驱动抽卡
  mastery: "yes" | "meh" | "no" | "new"; // 复习评价,默认 "new"
  lastReviewedAt: number | null;         // unix ms,null = 从未复习
};
```

## v1.1 additive fields (2026-07-02) —— mastery 进度日记

安卓单词本 app（**LyricLens 移动复习器** · Compose / Kotlin / 只 Android）复习页给出三档评价 **记住了 / 不确定 / 没记住**，加隐式 `"new"`（星标但从未复习）。这两个字段承载这条评价，且 **只作为「进度日记」，绝不驱动抽卡算法**——严格贴合 [`docs/roadmap/README.md` 决策](../roadmap/README.md) 里「不做 SRS」承诺。

- 抽卡走「时间衰减 + 弱随机」，跟 mastery 无关
- **桌面 + 插件端 read-only**: 只展示 mastery dot，无评价按钮。Yes/Meh/No 只可能通过 import 从安卓 app 流回
- `mastery` 默认 `"new"`，四值枚举严格校验
- `lastReviewedAt` 默认 `null`（never reviewed）；非 null 时 must be > 0

**为什么不 bump 顶层 schema 字符串**（保持 `"lyriclens.notebook.v1"`）:

- 加字段属 additive extension，不改老字段含义
- v1 export 端（旧代码）不写这两字段 → v1.1 import 端 fallback 到 `"new"` + `null`
- v1.1 export 端写这两字段 → v1 import 端遇到不认识的 key 静默忽略（`#[serde(default)]` 自动处理，IndexedDB 原生宽容）
- 上文本文件 §"未来 v2 升级路径" 已明说「改字段含义才升 schema」—— additive 不算 breaking

跨 host 兼容矩阵：

| Import 端 | Export 端 | 兼容性 |
|---|---|---|
| v1 | v1 | 原样，无 mastery |
| v1 | v1.1 | v1 侧忽略 mastery/lastReviewedAt 字段（原样入库）|
| v1.1 | v1 | v1.1 侧 fallback `mastery: "new"`, `lastReviewedAt: null` |
| v1.1 | v1.1 | 完整，走合并规则第 8 条 |

## 唯一性

- **存储主键** = `id`（uuid v4）
- **业务唯一性** = `${songKey}:${lineIndex}` —— 同一首歌的同一行歌词只能有一条 entry
- 业务唯一性冲突时按下面的合并规则处理

## songKey 构造

```ts
function makeSongKey(title: string, artist: string, durationMs: number): string {
  return [
    title.trim().toLowerCase(),
    artist.trim().toLowerCase(),
    Math.round(durationMs / 1000),
  ].join("|");
}
```

跟桌面版当前 `trackKey` 算法一致（`src/main.ts` 的 `trackKey()`）。插件版实现时必须对齐，否则双 host 业务唯一性会脱钩。

## 合并规则（import 时遇到业务唯一性冲突）

设本地已有 `local`，import 进来的是 `incoming`。

1. **不覆盖本地 entry**。`id` 保留为 `local.id`。
2. `userNote` 拼接：
   ```
   <local.userNote>
   
   ---来自 <incoming.source>（<ISO8601 timestamp of import>）---
   <incoming.userNote>
   ```
   如果 `local.userNote` 已经包含相同分隔符头，说明之前 import 过同一份内容 → **跳过这条**，不做二次合并。
3. `card` 用 `updatedAt` 更晚的那一份（防止 prompt 版本回退）
4. `starredAt` 用更早的那一份（保留"最早收藏时间"语义）
5. `updatedAt` 设为本次 import 时间
6. `importMergedFrom` 追加 `incoming.id`（防止 A → B → A 双向 import 死循环）
7. `source` 不变（合并后仍属于本地 host）
8. **v1.1** `mastery` + `lastReviewedAt` 联动合并：
   - 双 `lastReviewedAt` 都是 `null` → 保持 local（都是 `"new"` + `null`）
   - 只一边 `lastReviewedAt` 非 null → 采那一边的 mastery + timestamp
   - 双 `lastReviewedAt` 都非 null → 取 `lastReviewedAt` 更晚的那一份
   - **不受 `starredAt` / `updatedAt` 影响**。mastery 的权威时间戳是独立的 `lastReviewedAt`，避免用户改备注（更新 `updatedAt`）意外把安卓端的复习进度覆盖掉。

## JSON 导出 / 导入格式

```json
{
  "schema": "lyriclens.notebook.v1",
  "exportedAt": "2026-06-30T12:34:56Z",
  "exportedFrom": "desktop",
  "entries": [ /* NotebookEntry[] */ ]
}
```

- `schema` 字段是版本契约。**改字段含义必须升 schema 版本**。
- import 端遇到不认识的 schema 版本时 → 报错,不要"尽力解析"
- entries 数组顺序不保证

## Anki CSV 导出

一条 `NotebookEntry` → 一张 Anki 卡片。

**正面（Front）**:
```
<songTitle> — <songArtist>
<lineText>
```

**背面（Back）**:
```
<card.translation>

<labelOf(p.type)>: <p.text>    ← 每条 point 一行
...

<card.note>

---
<userNote>
```

`labelOf(type)` 映射:
- vocabulary → 词汇
- grammar → 语法
- culture → 文化背景
- pronunciation → 发音
- tone → 语感
- general → 补充

**CSV 格式**: `\t` 分隔（Anki 默认）。字段顺序: `Front\tBack\tTags`。

**Tags**: `lyriclens song:<songKey> source:<source>`。Tag 里的空格不允许，`songKey` 里的 `|` 替换为 `_`。

## 字段约束

| 字段 | 约束 |
|---|---|
| `id` | uuid v4,32+ chars |
| `songKey` | 非空,符合 makeSongKey 输出格式 |
| `songTitle` / `songArtist` | trim 后非空 |
| `lineIndex` | ≥ 0 |
| `lineText` | trim 后非空 |
| `card` | 完整 AnalysisCard,不能只有部分字段 |
| `userNote` | 允许空字符串 |
| `starredAt` / `updatedAt` | unix ms,starredAt ≤ updatedAt |
| `source` | 严格 "plugin" \| "desktop" |
| `importMergedFrom` | 可选数组,元素是 uuid v4 |
| **v1.1** `mastery` | 严格 "yes" \| "meh" \| "no" \| "new"，默认 "new" |
| **v1.1** `lastReviewedAt` | unix ms 或 null；非 null 时必须 > 0 |

不符合约束的 entry → import 时报错跳过,不静默吞掉。

## 未来 v2 升级路径（备忘）

**这一段不是计划，是备忘**。v1 已经够 MVP 用。

### 触发条件

只在下面任一条满足时才考虑升 v2：

- 出现外部消费者（比如 LyricLens 自己的安卓单词本 app、Web 端 vocab review、第三方学习工具）需要**结构化的「词 / 假名 / 释义」分开字段**，而不接受 v1 的 `"词:释义"` 合并字符串
- 真实用户反馈 v1 的 `text` 字段拆解噪音大、影响 Anki 导出体验
- 升 prompt 让 LLM 直出结构化字段后，新数据质量明显比 v1 高

没有以上任一条之前，**不要主动升 v2**。schema 迁移涉及 prompt、cache、test、import/export、两个 host 都要动，成本不低。

### v2 可能的形态

`AnalysisPoint` 从 v1 的 `{type, text}` 升到结构化（跟插件版 [v1.3 功能规格文档](../../LyricLens-功能规格文档-v1.3-FINAL.md) §3.3 prompt 设计对齐）：

```ts
type AnalysisPointV2 = {
  type: "vocabulary" | "grammar" | "culture" | "pronunciation" | "tone" | "general";
  phrase: string;          // 主词/词组本体,如 "ルーブル" / "let yourself go"
  reading?: string;        // 日语场景假名读音
  meaning: string;         // 释义
  grammar?: string;        // 相关文法点(可选)
  context?: string;        // 文化背景/用法说明(可选)
};
```

这样安卓单词本 app 不用 flatten 字符串，直接消费 `phrase / reading / meaning` 入库。

### 兼容性约定（如果真升）

1. **schema 字段是版本契约**。v1 export 用 `"schema": "lyriclens.notebook.v1"`，v2 用 `"v2"`。
2. **import 端按 schema 字段分流**。看到 `v1` 走老解析器；看到 `v2` 走新解析器；看到不认识的版本 → **报错，不要尽力解析**。
3. **v1 export 永远能被读**。v2 import 端必须保留 v1 解析路径，不要 "rip out old code"。
4. **不强制把已有 v1 数据迁移到 v2**。LLM 调用是钱，要求用户重新跑全部历史卡片不现实。可选 "重新生成" 按钮，让用户单首歌触发。
5. **LLM prompt 版本号要独立**。当前是 `PROMPT_VERSION` 常量；升 v2 时也升 prompt 版本号让 cache 失效，避免 v1 prompt 跑出来的数据被当成 v2。
6. **桌面版和插件版要同步升**。一边升一边不升会让 JSON 互通断掉。

### 跟下游消费者的约定

LyricLens **只承诺**保留 v1 export 这条出口稳定。下游（安卓单词本、Web review、其他第三方）应该：

- 读 `schema` 字段先判版本
- v1 的 `text` 字段允许是合并字符串，**不要假设结构化**
- 想要严格结构化的话，等 LyricLens 升 v2 而不是自己反向 parse v1 的 `text`（反向 parse 容易翻车）

如果哪天 Yoru 真的开始写安卓单词本 app，先看 `text` 合并 parse 出来的质量能不能接受。能接受就不动；不能接受就升 v2。

## 实现状态

- [x] schema 文档（这份）—— v1 lock 2026-06-30，v1.1 additive 2026-07-02
- [x] desktop 端 SQLite 表 + rusqlite（bundled）接入
- [x] desktop 端 star 按钮 + 备注编辑 sheet
- [x] desktop 端 JSON export
- [x] desktop 端 JSON import + 合并规则
- [x] desktop 端 Anki TSV export
- [x] **v1.1** desktop 端 mastery 存储 + migration + 合并规则 + 只读 dot 渲染
- [ ] plugin 端 IndexedDB store
- [ ] plugin 端对应的 UI（settings 里加导出按钮）
- [ ] plugin 端 import + 合并规则
- [ ] plugin 端 Anki CSV export
- [ ] **v1.1** plugin 端 mastery（可延后到需要跟安卓 app 同步时再动，IndexedDB 天然 tolerate unknown key）
- [ ] 安卓单词本 app（LyricLens 移动复习器）—— 独立 vertical，本仓库不管

实施时两边按这份 schema 写测试，互导一次确认 round-trip 正确。
