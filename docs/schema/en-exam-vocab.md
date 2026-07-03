# 英语考试参考标签词库 — 数据 schema、KV 结构、客户端策略

**Status**: locked 2026-07-02（session 6 定稿数据源 + 产品决策）；2026-07-02 session 7 实现管道时按实测数据修正三处（见 §数据源 lin-mo-han 行、§构建规则、§规模校验基线）；**2026-07-03 v1.1** 加入 IELTS/TOEFL 社区弱标签（ECDICT 单源，见 [`research-ielts-toefl-license.md`](../roadmap/research-ielts-toefl-license.md)），命名 `ielts-community` / `toefl-community` 显式标弱标签；tag 值域 additive，顶层 schema `1` 不 bump。其余未动。改之前必须重新讨论。
**Scope**: 桌面版（Tauri Rust 侧）先行，插件版后续同步。与 [`jlpt-vocab.md`](jlpt-vocab.md) 共用 `dicts-cdn` Worker 与部署管道。
**决策来源**: GPT 数据源 license 调研报告（`C:\Users\15877\Downloads\english_exam_wordlist_license_audit.md`，2026-07-02）+ Claude 对四个决策级仓库的 LICENSE/README 原文核验 + Yoru 拍板"用户自选目标考试"。

## 设计意图

给歌词里的英语词汇标"考试参考标签"（高考 / CET-4 / CET-6 / 考研），让备考用户知道这个词在不在自己的考纲范围里。**不是**官方词表、**不是**完整词典、**不是**学习路径推荐。

用户在设置里选**一个**目标考试，badge 只显示选中体系的标签；不选则完全不显示。这是与 JLPT 最大的产品差异——JLPT 单体系无条件显示，英语多体系必须先选。

v1.1 起选项分两档：**四个中国考试标签**（gaokao/cet4/cet6/kaoyan，官方大纲名单 × ECDICT 双源互证，实心 pill）+ **两个社区弱标签**（ielts-community/toefl-community，ECDICT 单源，**淡一档 pill** + tooltip「社区参考·非官方」）。视觉区隔来自调研报告 §最终建议「与现有高考/CET/考研标签区隔」——见 §UI 渲染规则。

## 与 JLPT vertical 的关键差异

| | JLPT | 英语考试标签 |
|---|---|---|
| 体系 | 单一（N1-N5，一词一级） | 多体系（一词可同时属于多个考试） |
| 显示 | 无条件 | 仅显示用户选中的目标考试 |
| 数据源 | Tanos 单谱系，license 干净 | **没有干净单源**，全是 🟡，靠双源互证自建 |
| runtime 值 | level + reading + confidence | tags 数组（无 reading 问题） |

## 数据源（一期：gaokao / cet4 / cet6 / kaoyan / ielts-community / toefl-community）

| 角色 | 项目 | License | 用途 | 风险灯 |
|---|---|---|---|---|
| CET 名单源 | [`JavaProgrammerLB/cet-word-list`](https://github.com/JavaProgrammerLB/cet-word-list) | MIT（已核验 LICENSE 原文） | 2016 版四六级考试大纲官方 PDF 的 OCR 词表，定义"哪些词在四六级范围内" | 🟡 |
| 分级器 + IELTS/TOEFL 弱标签源 | [`skywind3000/ECDICT`](https://github.com/skywind3000/ECDICT) | MIT（已核验） | `tag` 字段：`gk`/`cet4`/`cet6`/`ky` 提供中国考试级别划分；v1.1 起 `ielts`/`toefl` 提供社区弱标签（单源，无 roster 互证）；只取 word + tag，释义音标一概不碰 | 🟡 |
| 高考名单源 | [`pluto0x0/word3500`](https://github.com/pluto0x0/word3500) | MIT（已核验） | 高考 3500 headword（`3500.txt`，三行一组：词/音标/释义），ECDICT `gk` tag 做第二互证源 | 🟡 |
| ~~高考交叉~~ | ~~`lin-mo-han/english-vocabulary-master`~~ | MIT | **不可用，已移除**（session 7 实测：仓库只含 `init_words()` 硬编码的 20 个示例词，3500 词表需用户自建 MySQL 导入，无可提取数据。GPT 调研报告此项失实——license 结论对，数据假设错） | ❌ 无数据 |
| 考研规模校验 | [`exam-data/NETEMVocabulary`](https://github.com/exam-data/NETEMVocabulary) | 数据 **CC BY-NC-SA 4.0** | **只做 sanity check（大纲 5530 词计数），数据本身绝不进管道 / CDN** | 🔴 禁分发 |

**明确不碰的源**（审计结论，写死）：
- `kajweb/dict` 及其全部下游（`KyleBing/english-vocabulary` 等）——README 自认数据爬自商业背单词 App（网易有道系），issue 区有商用合法性质疑
- `mahavivo/english-wordlists` ——无仓库级 LICENSE，部分文件来自金山词霸 / 牛津词典
- Oxford 3000/5000、Cambridge EVP ——出版社专有内容，条款禁止系统性复制再分发
- 一切"XX 真经 / 红宝书 / 名师课程"整理的雅思托福词表——出版物 / 课程版权
- `fanhongtao/IELTS`（新东方出版物派生 + GitHub license metadata 空）/ `castrovictor/TOEFL-vocabulary-flashcards`（Anki 牌组 + 疑似 TOEFL 400 备考书派生 + 无 license）/ `fg0x0/IELTS-Materials`（PDF/XLSX 材料包 + 无 license）/ `surajk95/wordsta`（README 宣称 GRE/TOEFL/IELTS 分表但实际只有 hard/intermediate 泛难度分级 + 无 license）/ Magoosh / IDP / Vocabulary.com / AWL 谱系（AWL 与 IELTS/TOEFL 无直接关系，不能挂考试 badge）

**IELTS/TOEFL 单源决策（2026-07-03 v1.1）**：所有独立雅思托福词表候选源都被排除（license / 谱系 / 数据形态三重问题），唯一可行方案 = ECDICT 单源，tag 输出命名 `ielts-community` / `toefl-community` 明确社区语义。完整调研见 [`research-ielts-toefl-license.md`](../roadmap/research-ielts-toefl-license.md) §候选源盘点。

**已知数据缺陷**（2026-07-02 实测 `word-list.txt`）：
1. 四六级**合并**为一个 txt（5641 行），级别标记在 OCR 时丢失——这就是必须引入 ECDICT 做分级器的原因
2. OCR 有一行多词的脏行（如 `fabrication fabulous`），行数 ≠ 词数，clean 阶段必须按空白切分
3. ECDICT 的 `ielts`/`toefl` tag 谱系不透明（README 承认聚合了多种考试大纲/语料库/早期词表），无法审计具体来源——只能做弱标签，UI 严格「社区参考·非官方」

## 构建规则

```text
clean(x)         = 按空白切分多词行 → 剥首尾标点 → lowercase → 只留 ^[a-z][a-z'-]*$ → 去重
CET_ALL          = clean(cet-word-list/word-list.txt)
cet4             = CET_ALL ∩ ECDICT[tag∋cet4]
cet6             = CET_ALL ∩ ECDICT[tag∋cet6] − cet4
gaokao           = clean(word3500 headwords) ∩ ECDICT[tag∋gk]  # session 7 修正：lin-mo-han 无数据，
                                                                # 第二互证源改 ECDICT gk（与 CET 同模式）
kaoyan           = ECDICT[tag∋ky]      # 唯一可分发源；NETEM 5530 只做覆盖率校验（数据绝不进管道）
ielts-community  = ECDICT[tag∋ielts]   # v1.1；单源无 roster 互证（雅思无干净 headword list，
                                        # 见调研报告 §候选源盘点；输出 tag 显式带 `-community`）
toefl-community  = ECDICT[tag∋toefl]   # v1.1；同上
```

- 名单源里 ECDICT 未确认的词（OCR 错词 / 变位形式 / ECDICT 漏标）→ **丢弃**，写进构建产物的 `dropped.txt` 带原因，不静默
- **规模校验（实测基线 2026-07-02，cet-word-list@f18dedd + ECDICT@82c9872 + word3500@36da565）**：
  gaokao=3655 ∈ [3200, 4000]、cet4=3469 ∈ [3000, 4500]、cet6=1357 ∈ [1000, 2000]、kaoyan=4801 ∈ [4300, 6100]，
  且 kaoyan 对 NETEM 5530 的覆盖率 ≥80%（实测 86.8%——ECDICT `ky` 基于旧大纲，缺口 ~700 词；
  "参考标签"产品语义下宁缺毋滥可接受）。任一出带即中断构建。
  session 6 原定的"偏差 >10% 中断"是未实测的拍值，session 7 以实测替换为绝对带 + 覆盖率下限
- 实测汇总：CET_ALL=7625（5641 行 OCR 切出 1390 个多词行）、word3500 headwords=3953（含变位/OCR 错词）、
  dropped 共 3097（cet 侧 2799 + gaokao 侧 298，样本人工抽查过：arose/awoken 变位、acut/afte OCR 错词，丢得对）
- **v1.1 IELTS/TOEFL 规模校验（实测基线 2026-07-03，同 ECDICT@82c9872）**：
  ielts-community=5038 ∈ [4500, 5500]、toefl-community=6970 ∈ [6500, 7500]。
  单源无 roster 互证，无 dropped 记账；bands ±10% around measured baseline。
  加入两 tag 后总 entries **6734 → 11041**（+4307 新词主要来自 IELTS/TOEFL 独有词汇，与四中国考试标签交叠的部分只加 tag、不加 key）

## Cloudflare KV 结构

复用 `dicts-cdn` Worker（allowlist `<family>/(manifest.json|*.json.(br|gz))` 天然放行新 family）：

```text
KV key                                   公开 URL
enexam/manifest.json                     https://dicts.yoru-and-akari.dev/enexam/manifest.json
enexam/enexam-tags.<build>.v1.json.br    https://dicts.yoru-and-akari.dev/enexam/enexam-tags.<build>.v1.json.br
enexam/enexam-tags.<build>.v1.json.gz    同名 .gz 变体（给插件版 host）
```

**gzip 变体（2026-07-02 追加，分发层 additive）**：每个 blob 同时发布 `.json.gz`，manifest `sources.<build>` 加 `gzip: {url, sha256, bytes}` 字段（optional 字段不 bump schema）。插件版 host 消费它——NCM 内嵌 Chromium 91 无 brotli 解码器（`DecompressionStream` 仅支持 gzip/deflate）；`.br` 仍是桌面版的 canonical blob，桌面侧零改动。

多上游没有单一 commit sha 可用，`<build>` 用 `multi-<yyyymmdd>` 形式（如 `multi-20260702.v1`，日期取 generated_at 的 UTC 日期）；manifest `sources` 字段里逐个记录三个上游数据文件的 last-touching commit sha（`commits?path=<file>` 语义，数据文件没动则 build 可复现）。发布流程与 JLPT 相同：blob 先行 → 60s KV 传播 → manifest 收尾。

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
    "word3500": "<sha7>"
  },
  "entries": {
    "abandon": ["cet4", "kaoyan"],
    "abolish": ["cet6", "kaoyan"],
    "above": ["gaokao", "cet4"]
  }
}
```

tag 枚举：`"gaokao" | "cet4" | "cet6" | "kaoyan" | "ielts-community" | "toefl-community"`（`-community` 后缀 = ECDICT 单源社区弱标签，v1.1 加入；tag 值域 additive 不 bump 顶层 schema 字段）。

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

设置新增 `targetExam: "off" | "gaokao" | "cet4" | "cet6" | "kaoyan" | "ielts-community" | "toefl-community"`（v1.1 起共 7 值；默认 `off`），属 UI 偏好，存 localStorage（非凭证，不进 credentials.json）。

## UI 渲染规则

| 情况 | 显示 |
|---|---|
| 选中中国考试（gaokao/cet4/cet6/kaoyan）且命中该 tag | `高考` / `CET-4` / `CET-6` / `考研` **实心 pill**（`.enexam-badge` 桌面 / `.ll-dict-badge` 插件） |
| 选中 IELTS/TOEFL 社区（ielts-community/toefl-community）且命中该 tag | `IELTS` / `TOEFL` **淡一档 pill**（`.enexam-badge--community` 修饰类 / 插件 `.ll-dict-badge--community`；淡边框 + `--ink-*` 灰调色，视觉上区隔于双源互证的实心 pill） |
| 命中但不含选中体系的 tag | 不显示 |
| `targetExam = off`（默认） | 全部不显示 |
| 未命中 | 不显示 |
| hover tooltip（中国考试标签） | `考试参考标签 · 社区词表交叉整理 · 非官方授权` |
| hover tooltip（IELTS/TOEFL 社区弱标签） | `IELTS 社区参考 · 单源整理 · 非官方 · 数据源 ECDICT (MIT)` / `TOEFL …`（前缀随 tag 变） |

**文案严格规则**：
- ✅ "考试参考标签 / community-derived exam reference labels"、"社区参考 · 非官方"
- ❌ "官方词表 / 大纲完整收录 / 必考词 / 官方授权"、"IELTS 官方词汇 / TOEFL 必考词"（调研报告 §官方语义边界 拉红线）

## Attribution

`About` 页面必须显示：

```
英语考试参考标签数据由以下 MIT 协议开源项目交叉整理：
JavaProgrammerLB/cet-word-list、skywind3000/ECDICT、
pluto0x0/word3500。IELTS/TOEFL 弱标签为 ECDICT `ielts`/`toefl` tag
单源整理，未与官方大纲交叉验证。
LyricLens 仅保留单词与考试标签两个字段，不含释义、音标、例句。
标签为社区整理的参考信息，与教育部教育考试院、British Council、
IDP、ETS 及任何考试主办方无关联，未获任何官方背书。
```

## 已完成的二期项（原本预留，实际已落地）

- **雅思 / 托福社区弱标签**：**2026-07-03 v1.1** 上线（ielts-community / toefl-community，ECDICT 单源，双 host badge + CDN 全套）
- **CEFR-J** [`openlanguageprofiles/olp-en-cefrj`](https://github.com/openlanguageprofiles/olp-en-cefrj)：**2026-07-02** CEFR-J vertical 上线（唯一 🟢 源，独立 `cefrj/*` family，与本文档 enexam family 并列，不再混做 fallback）
- **插件版同步**：**2026-07-02** 主仓库 PR #24 三件套（jlpt + enexam + cefrj）+ 2026-07-03 v1.1 IELTS/TOEFL 同步

## 二期预留（本文档不锁定，到时另行讨论）

- 目前无。若新增考试体系（例如 GRE 学术、TOEIC 商务）再评估数据源与产品优先级。

## 实现状态

- [x] 主仓库 `scripts/preprocess-enexam.mjs`：三源下载 → clean → 双源互证 → tags envelope → brotli → sha256/manifest（复用 preprocess-jlpt.mjs 模板；2026-07-02 v1.0 实跑 6734 entries / blob 25.8KB）
- [x] KV 上传：`enexam/manifest.json` + blob 已上线 `dicts.yoru-and-akari.dev`（2026-07-02 端到端验证：下载→sha256→解压 6734 entries）
- [x] 桌面版 Rust store + `enexam_lookup` command（desktop PR #35；评估结论=抽，泛型 `dict_store.rs` 落地，jlpt/enexam 共用）
- [x] 桌面版设置项 `targetExam` 单选 + badge 渲染 + hydrate（desktop PR #35，localStorage）
- [x] About 页 attribution section（desktop PR #35）
- [x] 插件版同步（LyricLens 主仓库 PR #24，2026-07-02，349 → 401 tests；`src/dicts.js` 与桌面 `dict_store.rs` 语义对齐）
- [x] **v1.1 IELTS/TOEFL 社区弱标签**（2026-07-03）：管道加 ECDICT `ielts`/`toefl` 单源提取 → 双 host 淡一档 badge → CDN 新 blob `multi-20260703.v1`；`ielts-community=5038 toefl-community=6970`，总 entries 6734→11041
