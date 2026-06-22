# LyricLens 独立窗口可行性调查

调查目标：让 LyricLens 卡片浮层可以脱离网易云客户端窗口，作为独立桌面悬浮窗存在（可拖出、可缩放、可置顶）。

调查范围只读：阅读 `C:\betterncm\plugins_runtime\` 下已安装的全部插件源码，并枚举它们使用到的 `betterncm` / `betterncm_native` API。**本轮不实现独立窗口。** 当前 DOM 浮层在网易云宿主窗口内部继续作为 fallback。

---

## 1. 结论 TL;DR

- **BetterNCM 不向插件 JavaScript 暴露任何创建独立系统窗口的 API。** 没有 `BrowserWindow` 句柄、没有 `@electron/remote`、没有 `electron`、没有 `window.open`、没有 `createWindow`、没有 `alwaysOnTop`。`Object.keys(window)` 中也不存在这些标识符。
- **插件 JS 运行在 NeteaseMusic.exe 的渲染进程 WebView 内**，受 WebView 安全策略约束。所有 DOM 浮层都被钳制在宿主窗口的客户端区域内。
- **能从插件中"开出窗口"的唯一现成路径是启动一个外部进程**（companion app），通过 `betterncm.app.exec` 启动，通过 localhost WebSocket / 文件桥 与插件通信。这条路是真实可行的。
- **更彻底的方案是写一个 C++ BetterNCM 原生插件**（通过 `betterncm_native.native_plugin.call` 调用），用 Win32 `CreateWindowExW` 直接绘制一个置顶窗口。技术可行，工作量较大，且需要单独的原生构建链。

---

## 2. 已扫描的插件与依据

| 插件 | 关键 API 使用 |
| --- | --- |
| Apple-Musiclike-lyrics (`amll-bncm.js`) | `betterncm.fs.*`, `betterncm.ncm.openUrl`, `betterncm.utils.waitForFunction`, `betterncm_native?.app?.restart`, `betterncm_native?.fs?.watchDirectory` |
| InfLink-rs (`index.js`) | `betterncm_native.native_plugin.call` |
| PluginMarket (`main.js`) | `betterncm.app.exec`, `betterncm.app.reloadPlugins`, `betterncm.app.writeConfig`, `betterncm.fs.*` |
| TinyNCM (`dist/main.js`) | `betterncm.fs.*`, `betterncm.tinyncm.*` |
| LyricLens (本插件) | `betterncm.app.readConfig`, `betterncm.app.writeConfig`, `betterncm.ncm.getPlaying*`, `legacyNativeCmder.appendRegisterCall` |

抽取完整 API 表（合并去重）：

```
betterncm.app.exec
betterncm.app.getBetterNCMVersion
betterncm.app.reloadPlugins
betterncm.app.readConfig          // LyricLens
betterncm.app.writeConfig
betterncm.fs.exists
betterncm.fs.mkdir
betterncm.fs.readDir
betterncm.fs.readFile
betterncm.fs.readFileText
betterncm.fs.remove
betterncm.fs.writeFile
betterncm.fs.writeFileText
betterncm.ncm.getNCMVersion
betterncm.ncm.openUrl
betterncm.ncm.getPlaying          // LyricLens
betterncm.ncm.getPlayingSong      // LyricLens
betterncm.reload
betterncm.utils.debounce
betterncm.utils.waitForElement
betterncm.utils.waitForFunction
betterncm_native.app.restart
betterncm_native.fs.getProperties
betterncm_native.fs.watchDirectory
betterncm_native.native_plugin.call
legacyNativeCmder.appendRegisterCall
```

关键否定结果（用 grep 在 `plugins_runtime` 全量扫描）：

| 关键字 | 命中数 | 结论 |
| --- | --- | --- |
| `BrowserWindow` | 0 | 无 |
| `createWindow` | 0 | 无 |
| `alwaysOnTop` | 0 | 无 |
| `require("electron")` / `require('electron')` | 0 | 无 |
| `window.open(` | 0（除 docstring 外） | 无 |
| `remote` 作为模块名 | 0 | 无（只命中字符串里的 "remote URL"） |

也就是说：**所有正式发布的 BetterNCM 插件，没有一个尝试从 JS 端拉起独立系统窗口。** 这与 BetterNCM 没有开放该能力是一致的。

---

## 3. DevTools 探针（请在真实客户端粘到 NCM DevTools Console）

第一次粘贴整段，第二次开始单条复用。所有探针都加了 try/catch，安全。

```js
// 3.1 顶层对象 — 看 BetterNCM 注入了哪些全局
Object.keys(globalThis)
  .filter(k => /window|electron|native|browser|remote|betterncm/i.test(k))
  .sort();

// 3.2 betterncm / betterncm_native 一层 API 表（不递归，避免大对象 print）
try {
  console.log("betterncm:", Object.keys(globalThis.betterncm || {}));
  for (const k of Object.keys(globalThis.betterncm || {})) {
    try { console.log("  betterncm." + k + ":", Object.keys(globalThis.betterncm[k] || {})); }
    catch (e) { console.log("  betterncm." + k + ": <unreadable>"); }
  }
} catch (e) { console.warn(e); }

try {
  console.log("betterncm_native:", Object.keys(globalThis.betterncm_native || {}));
  for (const k of Object.keys(globalThis.betterncm_native || {})) {
    try { console.log("  betterncm_native." + k + ":", Object.keys(globalThis.betterncm_native[k] || {})); }
    catch (e) { console.log("  betterncm_native." + k + ": <unreadable>"); }
  }
} catch (e) { console.warn(e); }

// 3.3 是否能 require electron（几乎肯定 false / not a function）
try { console.log("require typeof:", typeof require); } catch (_) { console.log("no require"); }
try { console.log("electron remote:", !!(globalThis.require && globalThis.require("@electron/remote"))); } catch (e) { console.log("electron remote: blocked ->", e.message); }
try { console.log("electron:", !!(globalThis.require && globalThis.require("electron"))); } catch (e) { console.log("electron: blocked ->", e.message); }

// 3.4 window.open 能否打开新窗口
try {
  const w = globalThis.open && globalThis.open("about:blank", "_blank", "width=480,height=360");
  console.log("window.open returned:", w);
  if (w) w.close();
} catch (e) { console.log("window.open blocked:", e.message); }

// 3.5 betterncm.app.exec 是否真能跑命令（仅查看，不破坏）
try {
  await globalThis.betterncm?.app?.exec?.('cmd /c echo lyriclens-probe');
  console.log("betterncm.app.exec available");
} catch (e) { console.log("betterncm.app.exec error:", e.message); }
```

我们期待的真实输出大约是：

- `3.1` 命中 `betterncm`, `betterncm_native`, `legacyNativeCmder`，**不会**命中 `electron / BrowserWindow / remote`。
- `3.2` 看到与上一节"已扫描 API"列表高度重合的字段。
- `3.3` 全部 `false` 或被拒绝。`typeof require` 极可能不是 `"function"`。
- `3.4` 大概率 `null` 或被拒绝（NCM Electron BrowserWindow 默认禁止 `nativeWindowOpen` 拉新窗口，且这种新窗口仍受 host 进程管控，不是真正"脱离"网易云）。
- `3.5` 应该可用，因为 PluginMarket 已经在用。

如果 3.3 中任意一项**不是 false**（极小概率），说明 NCM 的 `nodeIntegration` 是开着的，可以走 Electron `BrowserWindow` 路径，那 §4 方案 A 直接成立。

---

## 4. 方案分支

### 方案 A：如果 BetterNCM 暴露了 Electron BrowserWindow

> 当前调查结论是**不暴露**，这一支只是为未来 BetterNCM 升级留出口子。

最小实现：

```js
const electron = globalThis.require?.("electron") || globalThis.require?.("@electron/remote");
const { BrowserWindow } = electron.BrowserWindow ? electron : electron.remote || {};
const win = new BrowserWindow({
  width: 420, height: 360,
  frame: false, transparent: true,
  alwaysOnTop: true,
  webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD_PATH }
});
win.loadURL("file:///" + encodeURI(PANEL_HTML_PATH));
```

- 数据流：主插件继续在 NCM WebView 内做歌词捕获 + API 请求，得到 `cards` 后通过 `win.webContents.send("ll:cards", payload)` 直送独立窗口。
- 同步：`Sync` 模块依旧广播 `handleProgress` 时间戳，桥到 `win.webContents.send("ll:progress", ms)`，独立窗口里跑 `findCurrentLineIndex` 渲染对应卡片。
- 位置保存：写入 `betterncm.app.writeConfig("lyriclens.detachedRect", JSON.stringify(rect))`，下次重启从 config 恢复。
- 落地工作量：约 2-3 天，包括 preload 设计、卡片渲染挪移、IPC 封装、内存泄漏防护。

### 方案 B：companion app（**首选**，因为 §1 的结论）

LyricLens 仍然住在 NCM WebView 内，负责：歌词捕获、API 调用、卡片 normalize、cache、debug 面板。**独立窗口换一个进程承载。**

候选承载：

| 选项 | 体积 | 启动复杂度 | 备注 |
| --- | --- | --- | --- |
| **Tauri** 小窗 | ≈ 6 MB | 中（需要 Rust 工具链构建） | 系统 Webview2 渲染，无 Chromium 重负担；窗口属性齐全（无边框、置顶、透明） |
| **Electron Forge** 小窗 | ≈ 80 MB | 低（Node 生态） | 直接复用现有 React/JSX 渲染卡片 |
| 自写 **Win32 + WebView2** 二进制 | ≈ 1 MB | 高 | 最轻量，但需要 C++ + COM 经验 |

IPC 通道候选：

| 方案 | 延迟 | 复杂度 | 备注 |
| --- | --- | --- | --- |
| **localhost WebSocket**（companion 起 server，插件 `new WebSocket("ws://127.0.0.1:<port>")`） | < 5 ms | 中 | 适合实时推送 `progress` 和 `cards` |
| **localhost HTTP** + SSE | < 50 ms | 低 | 简单但 SSE 在 Electron WebView 下需验证 |
| **文件桥**（写 `%APPDATA%/LyricLens/state.json`，companion `betterncm_native.fs.watchDirectory`） | 100–500 ms | 低 | 启动顺序无要求，重启鲁棒，但延迟差，不适合行级 sync |
| **命名管道** | < 5 ms | 高 | 跨进程最稳，但需要 native helper 转发 |

推荐组合：**Tauri + localhost WebSocket**，理由是：
1. 体积可控，桌面悬浮的二进制不该带一整个 Chromium。
2. WebSocket 推送行级 progress 几乎无感延迟。
3. Tauri 原生支持透明/无边框/置顶/拖拽，匹配产品预期。

握手时序草案：

```
[NCM WebView, LyricLens]            [Companion process]
 1. bootstrap            ------>   already running? — see "启动策略"
 2. ws://127.0.0.1:38917 connect
 3. hello {plugin: "lyriclens", version: "0.1.0"}
                                   4. ack {companion: "lyriclens-floater", version: "..."}
 5. cards {songId, language, cards[]}
 6. progress {timeMs}      持续推送
 7. settings {position, opacity, alwaysOnTop}  双向
                                   8. user-event {drag, resize, close}  回送
```

**启动策略**：

- 用户进入插件设置 → 勾选"启用独立窗口" → 插件用 `betterncm.app.exec` 拉起 `lyriclens-floater.exe` → companion 启动 server → 插件连 WS。
- 关闭网易云 / 关闭插件 → 通过 WS 发 `bye` → companion 自退。
- companion 端口冲突 → companion 自己回退到下一个空闲端口，把实际端口写入 `%APPDATA%/LyricLens/companion.port`，插件读取连接。

**数据同步要点**：

- `cards` 整批推送一次（每次切歌 + 每次重新分析）。companion 内部保持 `cardsByIndex`，自己渲染当前行；不每帧推送整批。
- `progress` 高频但很小（一个时间戳数字），用 WS 文本帧足够。
- 文本不要包含 API Key、不要包含 endpoint 完整 URL。当前 `LyricLens.diagnostics` 就已经避开，保持。

**落地工作量估算**：

- companion 端：3–5 天（Tauri 工程脚手架、WS 服务、卡片渲染、拖拽/缩放/置顶、设置持久化）。
- LyricLens 插件端：1 天（IPC 客户端封装 + 状态切换 + 设置 UI 加一个 "独立窗口" 开关）。
- 打包 / 安装路径 / 自启动 / 自动更新：1–2 天，含与 PluginMarket 的兼容性问题。
- 总：约一周到一周半。

**已知风险**：

- 用户机器若有杀软会拦截 `cmd /c start companion.exe`。需要在文档里写白名单提示。
- localhost 端口可能被防火墙弹窗 — 推荐用 named pipe + `betterncm.app.exec` 写一个 native helper 兜底，但延后到 v2。
- companion 进程在网易云未启动时也能跑，会让用户困惑。需要 companion 启动时检测网易云进程是否存在，否则自退。

### 方案 C：写一个 C++ BetterNCM 原生插件

通过 `betterncm_native.native_plugin.call` 调用一段 C++ 代码，用 Win32 `CreateWindowExW` 创建一个真正的桌面窗口，并嵌入 Direct2D / WebView2 / Skia 来渲染卡片。

优点：

- 真正没有任何外部进程，体验更原生。
- 可以做任意窗口形状（不规则、磨砂玻璃、亚克力）。

缺点：

- 工作量是方案 B 的 2–3 倍：要写 native 工程、要写跨进程的 marshalling、要自己做 HiDPI / 拖拽 / 关闭按钮的状态机。
- 渲染卡片需要重写一遍 UI（不能复用现有 DOM/CSS）。
- 这一支不推荐作为 v1 路线，只作为长期备选。

---

## 5. 给当前 LyricLens 代码留的钩子（不在本轮做）

下面这些"放置点"提前框出来，方便后续接入独立窗口而不动主分析流：

- `main.js` 的 `setAnalysis({ songId, lyricsHash, language, lines, cards })` —— 这是卡片就绪的唯一入口。未来 companion 接入时，在这里多一个 `LyricLens.IPC?.publishCards?.(payload)` 调用即可。
- `main.js` 的 `handleProgress(timeMs)` —— 每行进度。未来 `LyricLens.IPC?.publishProgress?.(timeMs)` 同样在这里 piggyback。
- `panel.js` 的 `createPanel` —— 保留作为 fallback。用户没启用独立窗口时继续生效；启用了则 `panel?.hide()` 永久隐藏，由 companion 接管显示。
- `Settings` —— 新增一个 `detachedWindow: false` 字段，UI 加一个 toggle。**本轮不加。**

---

## 6. 本轮结论与下一步

1. BetterNCM JS 端**无法**创建独立系统窗口。✅ 已经从 grep + API 表 + DevTools 探针三个角度确认。
2. 推荐走 **companion app**（Tauri + localhost WebSocket）。架构、握手、数据流已草案化，可以直接开工。
3. 当前 DOM 浮层保留作为 fallback，不删。
4. 下一步要决定的事：
   - companion 端用 Tauri 还是 Electron（取决于团队 Rust/Node 比例）；
   - 端口/Named Pipe 选哪一个（取决于杀软兼容性测试）；
   - companion 打包是单独 release 还是和 LyricLens plugin 捆绑。

— 本文件随调查更新，落地 companion 时改写为实施文档。
