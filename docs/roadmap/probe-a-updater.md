# Probe A · BetterNCM 自更新能力实测

## 我们要回答的问题

为了实现"插件内一键检查更新→下载新 .plugin→提示重启"，必须先在 Yoru 的本机 NCM 环境里把这 8 个不确定点打死：

| # | 问题 | 我们的假设 | 为什么要测 |
|---|---|---|---|
| Q1 | `betterncm.fs.writeFile(path, blob)` 能不能写入插件目录的 `.plugin` 文件？ | 能（PluginMarket 源码已证明） | 别人的环境≠你的环境，BetterNCM 版本可能差异 |
| Q2 | 能不能写入 `.plugin.download` 这种新文件名（临时文件法）？ | 能 | 安全更新流程的前置 |
| Q3 | 能不能 `fs.rename(tmp, final)` 覆盖正在使用的 .plugin？ | 不确定，Windows 文件锁可能挡 | 决定要不要走"放下次启动加载"路线 |
| Q4 | `betterncm.app.reloadPlugins()` 之后旧的 observer/定时器/全局对象残不残留？ | 可能残留 | 决定要不要直接劝重启而不是热重载 |
| Q5 | `betterncm.reload()` 是不是真的刷新页面？跟 reloadPlugins 区别？ | 不确定 | 同上 |
| Q6 | `betterncm_native.app.restart()` 是不是真重启 NCM 进程？ | 大概是 | 决定我们要不要直接用这个一键重启 |
| Q7 | 网易云的进程名到底是 `cloudmusic.exe` 还是 `ncm.exe`？ | `cloudmusic.exe` 但要确认 | exec(taskkill) 兜底方案的前置 |
| Q8 | `betterncm.fs.exists` / `readDir` 能列出 `./plugins/` 看到自己吗？ | 能 | 检测当前安装路径用 |

## 怎么测

我会写一个**临时 probe 插件** `LyricLensUpdaterProbe.plugin`（不动 LyricLens 本体），装上去之后它会自己跑完所有测试、把结果打印到 Console 和写到一个 JSON 文件。Yoru 把 Console 日志 + 那个 JSON 文件贴回来给我就行。

**测试不会破坏 LyricLens 当前安装**——所有写入都用 `LyricLensUpdaterProbe.*` 这种名字，互不干扰。

## Yoru 需要做的事

1. **备份当前 LyricLens.plugin**（CLAUDE.md 规矩：动 BetterNCM 文件前先备）
   ```powershell
   Copy-Item "D:\CloudMusic\betterncm\plugins\LyricLens.plugin" `
             "D:\CloudMusic\betterncm\plugins\LyricLens.plugin.bak-probeA-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```
   （如果文件名不一样按实际改）
2. 装 probe：把 `D:\LyricLens\probes\updater-probe\LyricLensUpdaterProbe.plugin` 拖进 BetterNCM 插件管理
3. 重启 NCM（或在 BetterNCM 里点重载插件）
4. 打开 Console：`F12`，或者在 BetterNCM 里运行 `betterncm.app.showConsole(true)`
5. 等大约 5 秒，会看到 `[ProbeA]` 前缀的日志一直跑到 `=== LyricLens Updater Probe DONE ===`
6. **复制全部 `[ProbeA]` 日志给我**（右键 console → save as 也行）
7. **也把这个文件给我**：`D:\CloudMusic\betterncm\plugins\lyriclens-probe-a-report.json`
8. （可选，单独跑）想验证热重载/重启 API：
   - 在 console 里输入 `__probeARunReload()` → 1 秒后跑 `reloadPlugins()`，看 probe 会不会被重新加载、原 LyricLens 会不会被踢坏
   - 在 console 里输入 `__probeARunRestart()` → 2 秒后跑 `betterncm_native.app.restart()`，看 NCM 是不是真的被杀+重启
9. **跑完所有想测的之后**：在 BetterNCM 里卸载 probe，或把 `LyricLensUpdaterProbe.plugin` 重命名加 `.disabled`

## 环境（已确认）

- BetterNCM **1.3.4**
- 网易云客户端 **3.1.23** 64-bit
- LyricLens 装成 .plugin 文件
- 任务管理器进程名："NetEase Cloud Music"（实际 exe 文件待 probe 输出确认）

## Probe 结果（2026-06-29）

环境验证：BetterNCM 1.3.4 + NCM 3.1.23.204764 + Chromium 91 内核（Electron-like UA）

### Q1-Q8 答案

| # | 问题 | 结果 |
|---|---|---|
| Q1 | `fs.writeFile(path, blob)` 写 .plugin 文件 | ✅ 100kb (41ms), 1MB (118ms), 10MB (126ms) 全过 |
| Q2 | 写 `.plugin.download` 临时文件 | ✅ writeFileText + writeFile 都过 |
| Q3 | `fs.rename(tmp, final)` 覆盖正在用的 .plugin | ⚠️ **fs.rename 不存在**。但 `betterncm_native.fs.rename` 存在，需要绕一层 |
| Q4 | `reloadPlugins()` 后旧 observer 残不残留 | 未自动测（probe 不能在跑的时候自杀），但 helper `__probeARunReload()` 已挂上 |
| Q5 | `betterncm.reload()` vs `reloadPlugins()` 区别 | 都存在，差异未实测 |
| Q6 | `betterncm_native.app.restart()` | ✅ 函数存在，helper `__probeARunRestart()` 已挂上 |
| Q7 | 进程名 | ✅ 通过 `Get-Process` 确认：`cloudmusic.exe`（路径 `E:\cloudmusic.exe`）|
| Q8 | `readDir('./plugins/')` 列文件 | ✅ 44 个条目，能识别 LyricLens 和 probe 自己写的临时文件 |

### 关键收获

1. **覆盖写完全可行**：`overwriteSameFile` 通过（51200 bytes 覆盖 1MB 文件成功）。这是 PluginMarket 一直能用的原因。
2. **`fs.rename` 不在 `betterncm.fs` 里**，要走 `betterncm_native.fs.rename`。更新代码要走两层 API。
3. **临时文件命名模式 `.plugin.download` 完全可用**。安全更新流程能直接套：写到 `.download` → 校验 → `native.fs.rename` 到 `.plugin`。
4. **10MB 写入 126ms**，意味着典型 .plugin（~450KB）下载完写盘可以忽略不计。
5. **`navigator.storage.estimate()` 不存在**（`hasStorageApi: false`）——Probe B 的设计要改，Chromium 91 比预期老。IndexedDB API 倒是有 (`hasIndexedDB: true`)。
6. **`location.href = orpheus://orpheus/pub/app.html`** —— 这是 NCM 自定义 URL scheme，origin 不是 https，这可能影响 IndexedDB 持久化策略（要在 Probe B 重点关注）。
7. **`plugin.pluginPath` / `plugin.filePath` 都是 string**——能直接拿到当前插件物理路径，对更新自检很有用。
8. **路径里出现 `C:\betterncm/./plugins/...`** ——BetterNCM 1.3.4 的根目录用的是 **C:\betterncm**，不是 `D:\CloudMusic\betterncm`。这俩之前以为是同一个，需要确认（可能是符号链接、或者旧装的残留）。

### 决策

`#2` 任务（一键更新）走 **B 档·半自动**：

```
1. fetch(/download) 拿 blob (BetterNCM fetch 默认 follow 302，从 PluginMarket 验证过)
2. betterncm.fs.writeFile('./plugins/LyricLens.plugin.download', blob)
3. 校验大小 / 可选 sha256
4. betterncm_native.fs.remove('./plugins/LyricLens.plugin')  // Windows 可能锁，要测
5. betterncm_native.fs.rename(... '.download' → '.plugin')
6. 弹窗提示"已下载新版本，请重启网易云"
7. 提供"立即重启"按钮 → betterncm_native.app.restart()
```

**还要补充测的**（next probe，或者直接在 #2 实现里小心做）：
- 覆盖正在跑的 LyricLens.plugin 时 Windows 文件锁会不会拒绝（probe 没测，因为不想破坏当前安装）
- BetterNCM 的 `betterncmFetch` 函数（probe 在 api surface 里发现了）跟标准 fetch 有啥区别，能不能跟随 302
- `__probeARunReload()` 是不是真的能让旧 LyricLens 实例的 observer 全部清理（如果不能，更新后旧实例和新实例会并存）

**最终选择**：B 档·半自动（写入 → 提示 → 一键 restart）

## Probe 代码

- 源码：`probes/updater-probe/probe.js` + `probes/updater-probe/manifest.json`
- 打包脚本：`probes/updater-probe/build.ps1`
- 产物：`probes/updater-probe/LyricLensUpdaterProbe.plugin` (5.67 KB)
- 重新打包：`pwsh probes/updater-probe/build.ps1`

报告：**待 Yoru 装上运行后贴回**
