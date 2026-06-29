# Probe B · IndexedDB 在 NCM 环境的持久化实测

## 我们要回答的问题

收藏功能要存大量数据（词条、句子、出现次数、复习状态），如果走 BetterNCM 的 `readConfig/writeConfig` 那是个 KV，扛不住。IndexedDB 才是对路的方案，但 GPT 调研发现**没有公开案例**证明 BetterNCM 插件用过 IDB。所以必须先测。

## Probe A 带来的设计调整

Probe A 报告显示：

- `hasIndexedDB: true` —— 基础 API 在
- `hasStorageApi: false` —— **`navigator.storage` 不存在**，没法用 `estimate()`/`persist()`
- `location.href = orpheus://orpheus/pub/app.html` —— 自定义 URL scheme，**这个 origin 在 Chromium 里的存储策略未知**
- Chromium 内核版本 91（2021 年）

意味着 Probe B 不能像现代浏览器那样问"配额多少"——只能**实际写数据撞墙**来知道上限。设计相应调整：

## 修订后的问题清单

| # | 问题 | 怎么测 | 重要度 |
|---|---|---|---|
| Q1 | `indexedDB.open()` 在 `orpheus://` origin 下能成功吗？ | 直接打开一个 DB | 致命 |
| Q2 | 写入持续放大直到失败，能写多少？ | 1MB → 10MB → 50MB → 100MB → 250MB → 500MB 阶梯写 | 高 |
| Q3 | 写入速度曲线？ | 每档记 ms | 中 |
| Q4 | 读取速度？随机 key 100 次 read 平均耗时 | 中 |
| Q5 | **重启 NCM 之后数据还在吗？**（跨进程持久化）| probe 用 marker 模式：第一次跑写 marker，第二次跑读 marker | 致命 |
| Q6 | `reloadPlugins()` 之后数据还在吗？（跨重载持久化） | console helper 手动触发 | 中 |
| Q7 | 删 DB（`indexedDB.deleteDatabase`）能不能成 | 直接测 | 中 |
| Q8 | 物理存储路径 | 通过 NCM 数据目录推断 + 文件系统搜 | 中 |

## 怎么测

`LyricLensStorageProbe.plugin`，独立 manifest（带 `ncm3-compatible: true`，从 Probe A 学到的）。DB 名 `lyriclens-storage-probe`。

**两阶段执行（用 marker 区分）**：

- **第一次启动**：检查 marker 不存在 → 写 marker + 跑阶梯写测试 + 写完毕 → 提示 Yoru "请重启 NCM 跑 phase 2"
- **第二次启动**：检查 marker 存在 → 读出来对比 → 输出"持久化 OK / 数据丢失 / marker 改变"

## Yoru 需要做的事

跟 Probe A 一样——我帮你做大部分：

1. 我打包 probe → 复制到 BetterNCM plugins → 重启 NCM
2. 我读 console 输出（通过 report.json）→ 分析 phase 1 结果
3. **你只需要做的事**：phase 1 跑完后，告诉我"我重启了"，然后我跑 phase 2 看持久化是否 OK
4. 跑完所有 phase 我自动卸载 probe

## Probe 结果（2026-06-29）

### Phase 1（首次写入）

- ✅ 1MB / 10MB / 50MB / **100MB 单条记录全部写入成功**
- 写入时长：1MB 985ms（首次有 lazy open 成本）、10MB 75ms、50MB 204ms、100MB 654ms
- 累计写入 161.5MB 没爆，4 条记录都 round-trip 验证字节级完整
- `verdict: WROTE_UP_TO_100MB`

### Phase 2（重启 NCM 后读回）

- 间隔 132 秒、NCM 进程完全杀掉再重启
- ✅ marker 完好（`writtenAt`/`sentinel` 一致）
- ✅ 全部 4 条 ladder 记录在场，size 和 firstByte 都对
- 读取时长：1MB 748ms、10MB 1046ms、50MB 298ms、100MB 1189ms（首次冷读偏慢但能用）
- `verdict: PERSISTENCE_OK_ALL_LADDER_BYTES_SURVIVED`
- DB 在 phase 2 结束被自动 `deleteDatabase` 干净

### 物理位置

`C:\Users\15877\AppData\Local\NetEase\CloudMusic\webapp91x64\IndexedDB\`
- `orpheus_orpheus_0.indexeddb.leveldb`（LevelDB key-value 后端）
- `orpheus_orpheus_0.indexeddb.blob`（大 value 走 blob 文件，Chromium 优化）

origin 是 `orpheus://orpheus`（NCM 自定义 URL scheme）。NCM 升级如果替换 `webapp91x64` 目录就会丢数据，但 NCM 3.x 自带升级目前都是覆盖式不动 user data。

### 已知限制

- `navigator.storage` 不存在（Chromium 91 太老）→ 没法用 `estimate()` 主动查配额，也没法 `persist()` 升 persistent
- 没测过 200MB+ 单条（probe 只到 100MB 防止 NCM hang）。如果需要存超大词库，再加测
- 没测**用户手动点 NCM"清理缓存"按钮**是否会清 IDB——这个要 Yoru 实测一次（不影响 P0，列入 followup）

## 决策

**IndexedDB 当主存储**。覆盖 Stage 3 收藏功能所有需求：
- 单词/句子/语法条目（~KB 级别，4 条 100MB 都没问题，几万条收藏完全 OK）
- 出现次数计数（int）
- 复习状态（小对象）
- 词库缓存（~MB 级别 JSON）
- 大文件导出可以用 IDB → blob → fs.writeFile 转出去

不需要额外双写备份层。但要做的：
1. 提供"导出全部收藏"按钮 → `fs.writeFile` 写一份 JSON 到用户能找到的地方
2. 提供"导入"反向通道（用户换设备/重装 NCM 用）

## Probe 代码 & 报告

- 源码：`probes/storage-probe/probe.js` + `manifest.json`
- 打包：`probes/storage-probe/build.ps1` → `LyricLensStorageProbe.plugin` (4.7 KB)
- Phase 1 报告：`probes/storage-probe/report-phase1-2026-06-29.json`
- Phase 2 报告：`probes/storage-probe/report-phase2-2026-06-29.json`
