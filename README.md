# LyricLens

BetterNCM AI 歌词学习插件 v0.1 MVP。播放英文/日文歌曲时，读取当前歌词，调用用户配置的 OpenAI 兼容 Chat Completions Endpoint 生成学习卡片，并在网易云客户端内显示 fixed 浮层。

## 安装

1. 退出网易云音乐。
2. 将本项目整个文件夹复制到 BetterNCM 插件目录，例如 `plugins/lyriclens/`。
3. 确认目录内包含 `manifest.json`、`main.js`、`src/`、`styles/`。
4. 重新打开网易云音乐，在 BetterNCM 插件管理中启用 LyricLens。

本项目不需要构建，直接加载源码文件。

## 配置

首次播放英文或日文歌曲且 API 未配置时，浮层会显示配置表单。也可以点击浮层右上角齿轮按钮打开设置。

需要填写：

- API Endpoint：完整 OpenAI 兼容 Chat Completions 地址，例如 `https://api.openai.com/v1/chat/completions`
- API Key：你的服务商密钥
- Model Name：模型名称
- 自动拆解：默认开启
- 浮层默认位置
- 浮层透明度

API Key 只写入本地 BetterNCM 配置，并同步一份到 localStorage 作为 MVP 降级存储；不会上传到插件作者服务器。

## 调试日志

插件会输出以下日志：

- 插件加载成功
- 当前 songId
- 歌词来源和字段探测
- 语言检测结果
- API 请求开始/成功/失败/超时
- PlayProgress 参数探测

查看方式：

- BetterNCM/网易云客户端可用开发者工具时，打开 Console。
- 如果需要打开主进程 Console，可在 BetterNCM 环境执行 `betterncm.app.showConsole(true)`。

### 诊断模式

诊断模式默认关闭。需要真实客户端验证时，在 Console 执行：

```js
localStorage.setItem("ll_debug", "true");
location.reload();
```

关闭诊断模式：

```js
localStorage.removeItem("ll_debug");
location.reload();
```

开启后，Console 会使用统一前缀 `[LyricLens:diagnostics]` 输出：

- BetterNCM / 网易云关键对象是否存在、类型、安全截断样例和错误
- `window.onProcessLyrics` 捕获到的歌词 payload 顶层结构
- 前 5 次及之后每 10 秒一次的 `PlayProgress` 参数结构
- `styles/panel.css` 解析、加载成功或失败状态

浮层内会出现折叠的“诊断”入口，显示当前 `songId`、语言检测结果、歌词来源、卡片数、当前卡片 index、API 状态、最后错误和 CSS 状态。

## 已知限制

- BetterNCM/网易云歌词对象字段需要在真实客户端里继续确认；当前按 `window.currentLyrics`、`window.CPPLYRICS_INTERNALS?.currentLyrics`、`window.AMLL?.currentLyrics`、`window.onProcessLyrics` wrapper、`betterncm.ncm.getPlayingSong()` 字段探测顺序降级。
- 没有 manifest hijack，不主动改写网易云/AMLL/CppLyrics 内部渲染。
- 内存缓存仅本次客户端运行有效。
- MVP 不提供 BetterNCM 原生设置页，先使用浮层齿轮表单。
- API 请求是否可用取决于用户配置的 endpoint、网络和 CORS/客户端 fetch 行为。

## 真实客户端验证记录模板

```md
### LyricLens v0.1 客户端验证记录

- 验证日期：
- 网易云音乐版本：
- BetterNCM/chromatic 版本：
- 操作系统：

#### Runtime Probe

- `window.betterncm`：
- `betterncm.ncm`：
- `betterncm.ncm.getPlaying`：
- `betterncm.ncm.getPlayingSong`：
- `legacyNativeCmder`：
- `window.currentLyrics`：
- `window.CPPLYRICS_INTERNALS?.currentLyrics`：
- `window.AMLL?.currentLyrics`：
- `betterncm.app.readConfig`：
- `betterncm.app.writeConfig`：

#### 返回样例

- `getPlaying` 安全截断样例：
- `getPlayingSong` 安全截断样例：
- 歌词 payload 顶层 keys：
- `lrc/yrc/tlyric/romalrc` 存在情况：
- lyric 字符串长度：
- 前 2 行脱敏/截断样例：
- `PlayProgress` 参数结构：
- `readConfig/writeConfig` 是否可用：
- CSS 加载方式是否可用：

#### 歌曲验证

- 英文歌 songId / 结果：
- 日文歌 songId / 结果：
- 中文歌 songId / 结果：
- API 失败结果：
- 切歌取消请求结果：

#### 已发现问题

-

#### 结论

-
```

## 本地测试

```powershell
npm test
```

测试覆盖语言检测、歌词预处理、缓存 key、LLM JSON 容错解析和播放时间同步等纯逻辑模块。
