# 查词释义数据源调研

Status: research (未采纳；等 Yoru / Claude 拍板本地库 vs 在线 API vs 纯外链)。

## TL;DR 建议

一期只做**纯外链**：卡片高亮词加一个小图标，点击跳外部词典（英文 → Cambridge English-Chinese；日文 → 有道日汉 或 Weblio），零版权风险、零数据基础设施、上线快。

二期可加**在线 API（Wiktionary REST）**：不落库，按需查询、按 CC BY-SA 附署名，做小 popover 而不是离开产品。

三期若要**本地库**：只考虑 JMdict（日文，CC BY-SA 4.0，作为独立 CDN family 发布并整体挂 CC BY-SA），**不做 ECDICT 释义**（谱系不透明，MIT 罩不住上游义务）。

绝不：把 ECDICT 的 `translation` / `definition` 字段搬进产品的数据平面。

## 张力背景 —— 为什么这次要重新论证

enexam / JLPT 数据源的版权原则一直是「只抽 word + tag，释义一概不碰」（见 `docs/schema/en-exam-vocab.md`、`docs/schema/jlpt-vocab.md`）。这一原则让弱标签的版权面窄到几乎无风险：

- MIT 仓库 → 提取 headword + tag 属于**事实性数据**，几乎不构成再创作。
- 不携带 translation / definition / 例句 / 音标 / Collins / BNC 等**含创作性表达**的字段。

「点词出释义」功能突破了这条边界：释义**必然**是创作性表达。仓库外层的 MIT/公有域声明能罩住 headword 提取，不能自动罩住释义分发。所以这次要重新做 license 判断，不能把 enexam 的判断简单复用。

## 候选源盘点

| 候选 | 语向 | 规模 / 覆盖 | License 谱系 | 判断 |
|---|---|---|---|---|
| **ECDICT `translation` / `definition`** | EN → 中/英 释义 | ~740k 词条，包含 Collins/Oxford/BNC/FRQ 元信息 | 仓库外层 MIT；README 承认是「多来源聚合」，逐词没有 provenance 链；`translation` 明显混合了商业词典派生 + 机翻 + 社区贡献 | 🔴 不用于产品分发。 |
| **JMdict (EDRDG)** | JA → EN / 多语 | ~200k 词条，日语标准开放词典 | CC BY-SA 4.0（EDRDG 2025 年迁移到 CC）；上游 provenance 明确 | 🟡 可以，但要按 ShareAlike 处理（见下）。 |
| **JMdict_e / JMnedict** | JA → EN | 附属数据集 | 同 EDRDG CC BY-SA 4.0 | 🟡 同上 |
| **Wiktionary REST API** | 任意语种 | Wiktionary 全库按 API 按需查询 | 内容 CC BY-SA 4.0；API 服务本身无 SLA / 限流温和 | 🟢 在线不落库场景 license 面很薄，推荐二期。 |
| **Cambridge Dictionary 网页** | EN → 简中释义 + 英文单语 | 学习者向定义质量高 | 商业站，`All Rights Reserved`；只能外链，不能抓取 | 🟢 只做外链。 |
| **有道网页词典** | EN/JA → 中文 | 大众覆盖广、加载快 | 商业站；只能外链 | 🟢 只做外链。 |
| **Weblio 网页词典** | JA → JA（native） | 日文单语解释质量最高，但门槛高 | 商业站；只能外链 | 🟢 只做外链。 |
| **Jisho.org** | JA → EN | 基于 JMdict + JMnedict 的社区前端 | 前端代码 MIT，展示数据继承 JMdict 的 CC BY-SA；提供搜索页 URL 不提供稳定 API 承诺 | 🟢 可外链，但**不要爬**（会被封 IP）。 |

## License 判断细项

### ECDICT `translation` / `definition` —— 为什么不能用

三条互相独立的问题：

1. **谱系不透明**。ECDICT README 明确说数据是「多个考试大纲、语料库、早期词表和补充数据的聚合」。`translation` 列没有逐词 provenance；从字段观感（含 Collins/Oxford 元信息 + 大量与主流商业英汉词典字面接近的翻译）判断，很可能吸收了商业词典派生内容。

2. **MIT 不能追溯净化**。仓库维护者把整个仓库标 MIT，只表示维护者授权他自己的组合工作，**不能追认那些他没有拿到授权的原始条目**。任何下游产品分发这份 `translation`，等于承接了一条含混的授权链。

3. **释义就是原作者想保护的东西**。词表事实 (`headword + IELTS tag`) 的版权面本身很薄；释义是词典编纂的核心创作，是原始创作者最有动机主张权利的部分。风险级别根本不一样。

结论：可以在**本地开发 / 研究**场景查 ECDICT 全字段（就像现在 `scripts/preprocess-enexam.mjs` 缓存 `ecdict.csv`），但**不能把 translation/definition 塞进产品的数据平面（R2/CDN blob、客户端 bundle、都不行）**。

### JMdict —— CC BY-SA 4.0 的实际含义

EDRDG 在 2025 年把 JMdict 系列从旧许可迁移到 CC BY-SA 4.0（之前是 EDRDG 自家非商业条款）。CC BY-SA 4.0 对 LyricLens 的三个具体影响：

1. **属性要求**（BY）：产品必须在合理位置注明 EDRDG 及 JMdict。放在 About / 词典致谢块即可，无需在每张学习卡片上打署名。

2. **同权继承**（SA）：**只针对数据本身**——如果我们把 JMdict 转换成自己的 blob 格式挂到 CDN 分发，那份 blob 必须以 CC BY-SA 4.0 授权。**这不会污染 LyricLens 的应用代码（AGPL 3.0）**——CC 的 ShareAlike 局限于数据作品，不递归到读取该数据的软件（跟 GPL viral 的语义完全不同）。

3. **商业可行**：CC BY-SA 4.0 允许商业使用。将来做双授权 / commercial license，只要不改数据这条链的授权就 OK。

**具体到 LyricLens 集成**：
- 本地库方案 → 我们发布 `jmdict-community.<build>.v1.json.br` 到 CDN → 该 blob **必须**标 CC BY-SA 4.0，manifest 要附授权信息 + 上游 attribution。
- 在线 API 方案（走别人的 API，比如 Jisho）→ 我们不分发 → SA 不触发。
- 纯外链方案（跳 Weblio / Jisho）→ 我们连数据都没碰 → 完全无关。

风险：如果未来某个下游镜像了我们的 CDN blob 但没保留署名，那是他们违反 CC BY-SA，不是我们。我们只要保证自己发布这份 blob 时授权信息完整就没有法律责任。

### Wiktionary REST API —— 在线查询的干净场景

Wiktionary 内容基础许可是 CC BY-SA 4.0（自 2023）。API：`https://en.wiktionary.org/api/rest_v1/page/definition/{word}` 返回按语言分节的 JSON。

关键区分：
- **按需 API 查询 + 即时展示**（不落库）→ 不构成再分发；显示时挂 「Wiktionary · CC BY-SA」的属性小字即可。类似于把 Wikipedia 页面嵌入 iframe，你不用给自己的应用整体挂 CC BY-SA。
- **抓取 → 落库 → 分发**（做我们自己的镜像）→ 构成再分发；触发 SA，跟 JMdict 一样规则。

一期做前者，二期若要缓存高频词可以走后者，代价是缓存 blob 挂 CC BY-SA。

可行性：
- MediaWiki API 温和限流（未认证 200 req/min 量级）；LyricLens 卡片一次点词就一次请求，天然低频。
- 延迟：从中国大陆到 Wikimedia 服务器 300–2000ms 波动，且有一定 GFW 抖动风险。若采纳，走 Cloudflare Worker 转发一层可稳定到 500ms 内（跟现在 lrclib 代理走的通道类似）。
- 覆盖：English Wiktionary 一站覆盖英语 + 日语（`ja` section），维护活跃度足够 LyricLens 场景。

### 外链方案 —— 零版权、零基础设施

我们不接触对方任何数据，只把用户导过去。四家候选各自的定位：

- **Cambridge English-Chinese**：学习者向英汉释义天花板。URL：`https://dictionary.cambridge.org/dictionary/english-chinese-simplified/{word}`。移动网页体验 OK，广告适度。适合英文歌词的英语学习者用户。
- **有道网页版**：中文用户默认的日常英/日→中查词入口。URL 形态需上线前确认稳定（历史上换过）。加载快，广告较多，覆盖广。
- **Weblio**：日语单语释义质量最高，读日汉释义没有它准。URL：`https://www.weblio.jp/content/{word}`。日语学习进阶用户偏好。
- **Jisho**：日英学习者事实标准，UI 干净。URL：`https://jisho.org/search/{word}`。基于 JMdict 但呈现更好。

移动端体验：BetterNCM 里点外链会开系统浏览器，会切出网易云 → 用户流失感强。桌面 Tauri 版会用系统浏览器（更好）。Review PWA 里点击外链是同标签或 `target="_blank"`，取决于 mobile 浏览器行为。**外链方案的最大问题不是版权，是打断心流**——纳入 UX 决策再定。

## 三档方案对比

| 维度 | 一期：纯外链 | 二期：在线 API（Wiktionary） | 三期：本地库（JMdict-only） |
|---|---|---|---|
| **版权面** | 无（我们只是链接） | 小（不落库不触发 SA） | 明确（CDN blob 挂 CC BY-SA + EDRDG attribution） |
| **延迟** | N/A（离开产品） | 300–2000ms（可 Worker 代理压到 500ms 内） | 50–200ms（CDN + 客户端缓存） |
| **离线** | 否 | 否 | 是 |
| **覆盖** | 英/日/中文 全覆盖（四家外链拼组合） | 英/日等主要语种通过一个 API | 只日语（英语没有对等干净源） |
| **UX** | 打断心流 | 弹小 popover 不离开 | 弹小 popover 不离开 |
| **基础设施** | 零 | Cloudflare Worker 转发 + 缓存层 | CDN blob + manifest + preprocess 脚本（沿用 enexam 模式） |
| **实现工时** | 小（本地按钮 + 链接生成） | 中（Worker route + popover + CC BY-SA 属性栏） | 大（preprocess + 客户端 store + 双 host 适配） |
| **版权 blocker 风险** | 无 | 无 | 需 Yoru 拍板同意 blob 挂 CC BY-SA（此授权与产品代码 AGPL 独立） |

## 推荐路径

1. **一期**：加外链按钮。
   - 英文词 → Cambridge（首选，学习者向）+ 有道（fallback）
   - 日文词 → 有道日汉（首选，中文用户熟悉）+ Weblio（进阶用户）
   - UI：卡片上高亮词旁一个小 🔗 或 ↗ 图标，长按/次级 tap 出 sheet 选词典。
   - 版权与 attribution：零负担，词典名字出现在 UI 上就够。
   - 三个 host 都能做，成本低。

2. **二期**：加 Wiktionary popover（在得到一期使用数据、确认「不离开产品」比「学习者向定义」价值高时再上）。
   - 走 Cloudflare Worker `/dict/wikt/<lang>/<word>` 转发一层，避免 GFW 抖动 + 集中限流。
   - 卡片内小 popover，展示第一定义 + 「Wiktionary · CC BY-SA · 完整词条」链回 Wiktionary。
   - 只做在线查询，不落库。

3. **三期（可选）**：只在日语，加 JMdict 本地库。
   - 沿用 enexam 数据面模式（brotli blob → manifest → dict_store）。
   - 独立 family `jmdict/`，blob 自身挂 CC BY-SA 4.0，manifest 携带 attribution 字段。
   - 客户端 About / 词典致谢块显式署名 EDRDG。
   - 英语侧维持外链 + 在线 API 组合，不引入英语本地库（因为 ECDICT 释义不能用，也没有等价的干净英语释义源）。

## 风险与注意事项

- **ECDICT 释义诱惑**：本地缓存已有 `ecdict.csv`（含 translation/definition），任何未来的贡献者都可能觉得「反正已经缓存了，直接用一下不就行了吗」。**必须在贡献者文档 + `preprocess-enexam.mjs` 顶部注释明确写**：ECDICT 的 translation/definition 只作研究，不产品化。（这条 delta 可以在一期 landing 同一波 PR 里做，或独立小 PR。）

- **CC BY-SA 4.0 传染 misinterpret**：ShareAlike 只递归到数据作品。我们的应用代码（AGPL 3.0）和 CC BY-SA 数据是独立层。将来做双授权时讲清楚：commercial license 覆盖 LyricLens 应用代码，不覆盖也不需要覆盖 JMdict 数据（用户拿到的是可自由再分发的 CC BY-SA 数据）。

- **Wiktionary API 从中国大陆访问**：GFW 抖动风险不小。方案：做 CF Worker 缓存代理，走 `yoru-and-akari.dev` 域进本土 CDN；命中 rate 高（相同词反复查）时延迟基本可控。

- **外链方案的 UX 断层**：BetterNCM 里跳外部浏览器体验很差；如果发现用户抱怨，桌面版和 Review PWA 应先启用外链（浏览器友好环境），插件版可以延后到二期用 Wiktionary popover 内嵌替代。

- **EDRDG 未来许可再变动**：他们 2025 年才刚从自家许可迁到 CC BY-SA 4.0，短期内应不会再变。若变动我们 blob 就冻结在当前版本继续以 CC BY-SA 分发（合规），只是新条目不再入库。

- **JMdict 更新节奏**：EDRDG 每周更新。参考 enexam 的做法：手动触发 preprocess 生成新 build key，避免自动同步 + 静默 breaking 变化。

## 后续需要 Yoru / Claude 决策的点

1. **一期是否只做纯外链，还是直接跳 Wiktionary popover？** 影响首个 lookup 版本的实现节奏 + 外链 UX 断层是否接受。
2. **英语侧永远维持"外链 / 在线为主，本地无库"？** 一旦确认，等于向未来贡献者关上 "ECDICT 释义本地化" 的门。
3. **日语侧本地库何时上马？** 依赖于 Yoru 对 CC BY-SA 4.0 的接受程度 + Attribution 位置定案。

## Sources

- ECDICT repo / license: https://github.com/skywind3000/ECDICT
- ECDICT MIT license: https://github.com/skywind3000/ECDICT/blob/master/LICENSE
- EDRDG JMdict: https://www.edrdg.org/jmdict/j_jmdict.html
- EDRDG license (2025 CC BY-SA 4.0 migration): https://www.edrdg.org/edrdg/licence.html
- CC BY-SA 4.0 legal code: https://creativecommons.org/licenses/by-sa/4.0/legalcode
- Wikimedia REST API — page definition: https://en.wiktionary.org/api/rest_v1/#/Page%20content/getDefinition
- Wiktionary content license: https://en.wiktionary.org/wiki/Wiktionary:Copyrights
- Cambridge English-Chinese dictionary: https://dictionary.cambridge.org/dictionary/english-chinese-simplified/
- 有道词典: https://youdao.com/
- Weblio 辞書: https://www.weblio.jp/
- Jisho.org (JMdict-based frontend): https://jisho.org/about
