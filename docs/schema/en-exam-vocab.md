# 英语考试参考标签词库 — 数据 schema、KV 结构、客户端策略

**Status**: locked 2026-07-02（session 6 定稿数据源 + 产品决策；实现是独立 vertical，未开工）。改之前必须重新讨论。
**Scope**: 桌面版（Tauri Rust 侧）先行，插件版后续同步。与 [`jlpt-vocab.md`](jlpt-vocab.md) 共用 `dicts-cdn` Worker 与部署管道。
**决策来源**: GPT 数据源 license 调研报告（`C:\Users\15877\Downloads\english_exam_wordlist_license_audit.md`，2026-07-02）+ Claude 对四个决策级仓库的 LICENSE/README 原文核验 + Yoru 拍板"用户自选目标考试"。

## 设计意图

给歌词里的英语词汇标"考试参考标签"（高考 / CET-4 / CET-6 / 考研），让备考用户知道这个词在不在自己的考纲范围里。**不是**官方词表、**不是**完整词典、**不是**学习路径推荐。

用户在设置里选**一个**目标考试，badge 只显示选中体系的标签；不选则完全不显示。这是与 JLPT 最大的产品差异——JLPT 单体系无条件显示，英语多体系必须先选。

## 与 JLPT vertical 的关键差异

| | JLPT | 英语考试标签 |
|---|---|---|
| 体系 | 单一（N1-N5，一词一级） | 多体系（一词可同时属于多个考试） |
| 显示 | 无条件 | 仅显示用户选中的目标考试 |
| 数据源 | Tanos 单谱系，license 干净 | **没有干净单源**，全是 🟡，靠双源互证自建 |
| runtime 值 | level + reading + confidence | tags 数组（无 reading 问题） |

## 数据源（一期：gaokao / cet4 / cet6 / kaoyan）

| 角色 | 项目 | License | 用途 | 风险灯 |
|---|---|---|---|---|
| CET 名单源 | [`JavaProgrammerLB/cet-word-list`](https://github.com/JavaProgrammerLB/cet-word-list) | MIT（已核验 LICENSE 原文） | 2016 版四六级考试大纲官方 PDF 的 OCR 词表，定义"哪些词在四六级范围内" | 🟡 |
| 分级器 | [`skywind3000/ECDICT`](https://github.com/skywind3000/ECDICT) | MIT（已核验） | `tag` 字段（`gk`/`cet4`/`cet6`/`ky`）提供级别划分；只取 word + tag，释义音标一概不碰 | 🟡 |
| 高考种子 | [`pluto0x0/word3500`](https://github.com/pluto0x0/word3500) | MIT（已核验） | 高考 3500 headword 种子 | 🟡 |
| 高考交叉 | [`lin-mo-han/english-vocabulary-master`](https://github.com/lin-mo-han/english-vocabulary-master) | MIT | 与 word3500 交叉比对，只抽英文 headword | 🟡 |
| 考研规模校验 | [`exam-data/NETEMVocabulary`](https://github.com/exam-data/NETEMVocabulary) | 数据 **CC BY-NC-SA 4.0** | **只做 sanity check（大纲 5530 词计数），数据本身绝不进管道 / CDN** | 🔴 禁分发 |

**明确不碰的源**（审计结论，写死）：
- `kajweb/dict` 及其全部下游（`KyleBing/english-vocabulary` 等）——README 自认数据爬自商业背单词 App（网易有道系），issue 区有商用合法性质疑
- `mahavivo/english-wordlists` ——无仓库级 LICENSE，部分文件来自金山词霸 / 牛津词典
- Oxford 3000/5000、Cambridge EVP ——出版社专有内容，条款禁止系统性复制再分发
- 一切"XX 真经 / 红宝书 / 名师课程"整理的雅思托福词表——出版物 / 课程版权

**已知数据缺陷**（2026-07-02 实测 `word-list.txt`）：
1. 四六级**合并**为一个 txt（5641 行），级别标记在 OCR 时丢失——这就是必须引入 ECDICT 做分级器的原因
2. OCR 有一行多词的脏行（如 `fabrication fabulous`），行数 ≠ 词数，clean 阶段必须按空白切分

## 双源互证构建规则

```text
clean(x)   = 按空白切分多词行 → lowercase → 去纯符号/数字 → 去重
CET_ALL    = clean(cet-word-list/word-list.txt)
cet4       = CET_ALL ∩ ECDICT[tag∋cet4]
cet6       = CET_ALL ∩ ECDICT[tag∋cet6] − cet4
gaokao     = clean(word3500) ∩ clean(lin-mo-han headwords)   # ECDICT gk tag 只报告差异，不强制
kaoyan     = ECDICT[tag∋ky]                                   # NETEM 5530 词做规模校验，偏差 >10% 中断构建
```

- 只在 CET_ALL 里、ECDICT 不认识的词（OCR 错词或 ECDICT 漏标）→ **丢弃**，写进构建产物的 `dropped.txt` 供人工抽查，不静默
- 每次构建输出各 tag 词数 + 与预期规模（高考~3500 / cet4~4000+ / cet6 增量~1300 / 考研~5500）的对比，超阈值即失败

## Cloudflare KV 结构

复用 `dicts-cdn` Worker（allowlist `<family>/(manifest.json|*.json.br)` 天然放行新 family）：

```text
KV key                                   公开 URL
enexam/manifest.json                     https://dicts.yoru-and-akari.dev/enexam/manifest.json
enexam/enexam-tags.<build>.v1.json.br    https://dicts.yoru-and-akari.dev/enexam/enexam-tags.<build>.v1.json.br
```

多上游没有单一 commit sha 可用，`<build>` 用 `multi-<yyyymmdd>` 形式（如 `multi-20260702.v1`）；manifest `sources` 字段里逐个记录四个上游仓库的 commit sha。发布流程与 JLPT 相同：blob 先行 → 60s KV 传播 → manifest 收尾。

## Runtime JSON schema

比 JLPT 简单——英语无表记/reading 分歧，word → tags 数组：

```json
{
  "schema": 1,
  "generated_at": "2026-07-02T00:00:00Z",
  "license": "MIT sources, cross-verified; headwords + tags only",
  "sources": {
    "cet-word-list": "<sha7>",
    "ECDICT": "<sha7>",
    "word3500": "<sha7>",
    "english-vocabulary-master": "<sha7>"
  },
  "entries": {
    "abandon": ["cet4", "kaoyan"],
    "abolish": ["cet6", "kaoyan"],
    "above": ["gaokao", "cet4"]
  }
}
```

tag 枚举：`"gaokao" | "cet4" | "cet6" | "kaoyan"`（二期预留 `"ielts-community"` / `"toefl-community"`）。

## 客户端 lookup 策略

```text
LLM 卡片里 vocabulary point 的 surface（prompt 已要求 base form）
  → lowercase → exact match HashMap
  → 未命中不显示（继承 JLPT 规则，不显示「未知」）
  → 命中 → 按 settings.targetExam 过滤，非选中体系不显示
```

**MVP 不做词形还原**（running→run）。LLM prompt 已要求 surface 是原形，与 JLPT"不做分词"同款决策；真发现高频 miss 再评估。

## Tauri Rust 侧实现

复用 `jlpt.rs` 的 bootstrap 骨架（manifest 缓存 → 网络刷新 → sha256 校验 → brotli 解压 → HashMap）。实现时优先评估把公共部分抽成 `dict_store.rs`（manifest+blob 拉取逻辑两边一字不差），lookup 层各自实现；抽象成本若高于收益则复制 pattern，不强求。

```ts
// 前端调用
invoke("enexam_lookup", { word }) → string[]   // e.g. ["cet4","kaoyan"]
```

设置新增 `targetExam: "off" | "gaokao" | "cet4" | "cet6" | "kaoyan"`（默认 `off`），属 UI 偏好，存 localStorage（非凭证，不进 credentials.json）。

## UI 渲染规则

| 情况 | 显示 |
|---|---|
| 选中考试且命中该 tag | `高考` / `CET-4` / `CET-6` / `考研` pill（样式复用 `.jlpt-badge`） |
| 命中但不含选中体系的 tag | 不显示 |
| `targetExam = off`（默认） | 全部不显示 |
| 未命中 | 不显示 |
| hover tooltip | `考试参考标签 · 社区词表交叉整理 · 非官方授权` |

**文案严格规则**：
- ✅ "考试参考标签 / community-derived exam reference labels"
- ❌ "官方词表 / 大纲完整收录 / 必考词 / 官方授权"

## Attribution

`About` 页面必须显示：

```
英语考试参考标签数据由以下 MIT 协议开源项目交叉整理：
JavaProgrammerLB/cet-word-list、skywind3000/ECDICT、
pluto0x0/word3500、lin-mo-han/english-vocabulary-master。
LyricLens 仅保留单词与考试标签两个字段，不含释义、音标、例句。
标签为社区整理的参考信息，与教育部教育考试院及任何考试主办方
无关联，未获任何官方背书。
```

## 二期预留（本文档不锁定，到时另行讨论）

- **雅思 / 托福**：官方均不发布词表；若做，用 ECDICT `ielts`/`toefl` tag 做 `*-community` 弱标签，UI 明确降级为"社区参考"，与一期四个考试的文案区隔
- **CEFR-J**（[`openlanguageprofiles/olp-en-cefrj`](https://github.com/openlanguageprofiles/olp-en-cefrj)，唯一 🟢 源，已核验 commercial OK）：可做通用英语分级 fallback，`cefrj/*` family 早已在 Worker allowlist 预留
- 插件版同步

## 实现状态

- [ ] 主仓库 `scripts/preprocess-enexam.mjs`：四源下载 → clean → 双源互证 → tags envelope → brotli → sha256/manifest（复用 preprocess-jlpt.mjs 模板）
- [ ] KV 上传：复用桌面版 `cloudflare-worker-dicts/upload-blob.sh`，family=`enexam`
- [ ] 桌面版 Rust store + `enexam_lookup` command（评估抽 `dict_store.rs`）
- [ ] 桌面版设置项 `targetExam` 单选 + badge 渲染 + hydrate
- [ ] About 页 attribution section
- [ ] 插件版同步（独立 vertical）
