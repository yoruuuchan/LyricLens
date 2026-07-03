# IELTS / TOEFL community 词表 license 调研

Status: research → adopted 2026-07-03. 结论落地为管道 v1.1（`ielts-community` / `toefl-community` tags 从 ECDICT 单源提取）+ 双 host 淡一档 badge UI；schema doc `en-exam-vocab.md` §构建规则 已 additive 收纳。本文保留作决策档案，不作产品需求文档。

## 结论

推荐方案只有一个：如果 Yoru 决定要做雅思/托福弱标签，只用 `skywind3000/ECDICT` 里的 `ielts` / `toefl` tag，输出标签命名为 `ielts-community` / `toefl-community`，UI 文案严格写“社区参考标签 / 非官方”。不要接入单独的 IELTS/TOEFL GitHub 词表、PDF、XLSX 或商业备考网站词表。

理由：

- IELTS 官方材料只把 `Lexical resource` 作为 Speaking/Writing 评分维度，并没有发布可复用 headword list；TOEFL 官方材料也强调 vocabulary-in-context，而不是官方词表。
- ECDICT 是 MIT 仓库，数据文件已经有 tag 字段，现有 enexam 管道也已经依赖它；只抽 `word + tag` 是版权面最薄的做法。
- ECDICT 的 tag 谱系不透明，所以只能做弱标签，不能写“官方”“大纲”“必考”。
- 其他候选源要么无 license，要么来自新东方/Anki 牌组/PDF/XLSX/商业备考内容，不能商用分发，也不存在 ShareAlike 逃逸路径。

## 官方语义边界

IELTS 官方页面说明 Speaking 评分包含 `Lexical resource`，含义是词汇范围、准确性、得体性，以及不会某个词时换说法的能力。Writing 页面也把 `Lexical resource` 列为评分标准，评估词汇范围、准确性和得体性。页面底部同时声明 IELTS 标识受商标保护，不应在产品里做官方背书暗示。

TOEFL iBT Reading 官方页面说 Reading 任务测量的是在语境中理解 meaning、vocabulary、ideas；`Complete the Words` 任务测 vocabulary knowledge 和 context meaning。TOEFL 2026 specification 也写的是能理解 broad range of vocabulary、idiomatic/colloquial expressions。这些都支持“考试会测词汇能力”，但不支持“存在官方词表可分发”。

产品含义：LyricLens 可以说“这个词在社区整理的 IELTS/TOEFL 参考标签里出现”，不能说“这个词是 IELTS/TOEFL 官方词汇”。

## 候选源盘点

| 候选 | 规模 / 质量信号 | License / 谱系 | 判断 |
|---|---:|---|---|
| `skywind3000/ECDICT` | 本地缓存 `ecdict.csv` 实测：`ielts` 5040、`toefl` 6974、交集 2911；README 说明 tag 字段用于标注考试/词频 | MIT；README 说明数据来自多类考试大纲、语料库和早期词表聚合，但没有逐 tag provenance | 🟡 可选。只取 `word + ielts/toefl tag`，必须写 community-derived。 |
| `fanhongtao/IELTS` | GitHub 329 stars，单个 `IELTS Word List.txt` 约 3670 loc | GitHub license metadata 为空；raw 文件 README 明说来自新东方出版的《雅思词汇词根+联想记忆法（乱序便携版）》手工抄录 | 🔴 不用。出版物派生 + 无 license。 |
| `castrovictor/TOEFL-vocabulary-flashcards` | Anki/APKG + CSV；文件名大量出现 `400 must words`，小仓库 5 stars | GitHub license metadata 为空；看起来是 TOEFL 400 主题牌组/备考书派生 | 🔴 不用。无 license，且疑似出版物/牌组二次整理。 |
| `fg0x0/IELTS-Materials` | PDF/XLSX 材料包：`5000 Toefl word.xlsx`、`IELTS Vocabulary Booster 2016.pdf`、`5000_TOEFL-IELTS_+Words.pdf` 等 | GitHub license metadata 为空；仓库只是材料转载集合 | 🔴 不用。无 license + 文件形态就是第三方备考资料。 |
| `surajk95/wordsta` | README 说 practice GRE/TOEFL/IELTS，但 `app/lists/` 实际是 `hard.js`、`intermediate.js`、`high-frequency-gre.js` 等，不是 IELTS/TOEFL 分表 | GitHub license metadata 为空 | 🔴 不用。无 license，且没有可用的考试标签数据。 |
| Magoosh / IDP / Vocabulary.com / 各 IELTS blog 词表 | 内容质量可能高，面向备考用户 | 商业站/官方站网页内容；Magoosh 页面底部 `All Rights Reserved`；IDP 是 IELTS partner 内容 | 🔴 不用作分发数据。只能做背景阅读。 |
| `lpmi-13/machine_readable_wordlists` / AWL | AWL 570 word families，学术英语相关；repo 为 CC0 | AWL 不是 IELTS/TOEFL 专属；上游列表各有来源，repo license 不自动清掉全部上游义务 | 🟡 可作为“academic vocabulary”另一个产品方向，不应用来打 IELTS/TOEFL badge。 |

## 能否商用 / ShareAlike 判断

### ECDICT

可以作为弱标签候选，但不是零风险。

- 商用：仓库 license 是 MIT，允许商业使用、复制、修改、分发；保留 copyright/license 即可。
- 数据谱系：README 承认它是考试大纲、语料库、早期词表和补充数据的聚合，具体到 `ielts` / `toefl` tag 没有可审计来源链。MIT 仓库 license 不能百分百证明所有上游数据都干净。
- ShareAlike：没有 CC BY-SA；不存在 ShareAlike 逃逸问题。
- 风险控制：只分发 lowercase headword + tags，不带翻译、音标、例句、Collins/Oxford 字段；UI 明确“社区参考标签，非官方”。

### 其他 IELTS / TOEFL 词表仓库

不能商用分发。

- 无 license 的 GitHub 仓库默认保留版权，不能因为公开可读就复制进产品。
- 出版物/牌组/PDF/XLSX 派生数据没有 ShareAlike 可谈；问题不是 copyleft，而是没有可用授权。
- 即使某个仓库外层将代码标 MIT，也不能自动把新东方、Magoosh、Vocabulary.com、Cambridge/ETS/IELTS partner 内容洗成 MIT 数据。

### AWL / 学术词表

不建议作为 IELTS/TOEFL 标签。

- AWL 与 IELTS/TOEFL 的关系是“学术英语常见”，不是考试主办方或社区的考试标签。
- 如果未来要做，应该是独立 `academic-awl` 或 `academic-vocab` family，文案不要挂 IELTS/TOEFL。

## 集成方案（2026-07-03 已实施 v1.1）

如果要做：

```text
source = ECDICT@82c9872 ecdict.csv
tags   = ielts-community / toefl-community
fields = word + tags[] only
```

规模基线（本地缓存 `scripts/out/enexam/.cache/ecdict.csv`，2026-07-03 实测）：

```text
ielts_unique = 5040
toefl_unique = 6974
intersection = 2911
ielts_only = 2129
toefl_only = 4063
```

建议质量 gate：

- `ielts` count 必须在 `[4500, 5500]`。
- `toefl` count 必须在 `[6500, 7500]`。
- 交集必须在 `[2500, 3300]`。
- 只允许 `^[a-z][a-z'-]*$` headword；丢弃短脏 token 和明显短语。
- 产物里不要包含 ECDICT 的 `translation` / `definition` / `phonetic` / `collins` / `oxford` / `bnc` / `frq`。

UI 文案建议：

```text
IELTS 社区参考
TOEFL 社区参考

tooltip: 社区整理考试参考标签 · 非官方词表 · 数据源 ECDICT (MIT)
```

避免：

```text
IELTS 官方词汇
TOEFL 必考词
考试大纲收录
官方授权
```

## 最终建议（已采纳并实施，2026-07-03）

选 ECDICT 单源弱标签（tags `ielts-community` / `toefl-community`），不再寻找第二源硬互证；第二源目前不是 license 问题，而是没有干净数据。功能默认 off；UI 视觉「淡一档 pill + tooltip 社区参考·非官方」与现有高考/CET/考研标签视觉区隔（Yoru 2026-07-03 拍板视觉区隔）。

## Sources

- IELTS Speaking format: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-speaking
- IELTS Writing format: https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing
- TOEFL iBT Reading section: https://www.ets.org/toefl/test-takers/ibt/about/content/reading.html
- TOEFL iBT test content: https://www.ets.org/toefl/test-takers/ibt/about/content.html
- TOEFL iBT 2026 specification: https://www.es.ets.org/content/dam/ets-org/pdfs/toefl/toefl-ibt-test-specifications-2026.pdf
- ECDICT repo / license: https://github.com/skywind3000/ECDICT
- ECDICT MIT license: https://github.com/skywind3000/ECDICT/blob/master/LICENSE
- fanhongtao/IELTS: https://github.com/fanhongtao/IELTS
- castrovictor/TOEFL-vocabulary-flashcards: https://github.com/castrovictor/TOEFL-vocabulary-flashcards
- fg0x0/IELTS-Materials: https://github.com/fg0x0/IELTS-Materials
- surajk95/wordsta: https://github.com/surajk95/wordsta
- Magoosh IELTS vocabulary page: https://magoosh.com/ielts/ielts-vocabulary/
- machine_readable_wordlists / AWL inventory: https://github.com/lpmi-13/machine_readable_wordlists
