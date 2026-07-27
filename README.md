# LyricLens

[中文](README.md) · [English](README.en.md)

边听歌，边把歌词变成语言学习卡片。网易云插件、独立桌面版、手机复习器——三个入口，一本笔记本。本仓库是入口之一：BetterNCM 插件，跑在网易云里，读当前歌词、调用你配置的 OpenAI 兼容 Chat Completions endpoint 出学习卡片，跟着歌词滚动显示。

## 三个 host，一个产品

LyricLens 是「一个产品，三个 host」（v1.0），本仓库是 host 1（BetterNCM 插件）：

| Host | 仓库 | 装在哪 | 干什么 |
|---|---|---|---|
| **插件（采集）** | 你正在看的这个 | 网易云客户端 + BetterNCM | 播歌时读词、调 LLM 出学习卡片、加星收藏 |
| **桌面（采集）** | [`lyriclens-desktop`](https://github.com/yoruuuchan/lyriclens-desktop) | 独立 Windows 应用 | 靠 SMTC + LRCLIB 独立运转，不依赖 BetterNCM |
| **Review PWA（复习）** | [`lyriclens-review`](https://github.com/yoruuuchan/lyriclens-review) · [直达](https://lyriclens-review.yoru-and-akari.dev) | 手机浏览器（可装桌面图标） | 把加过星的条目挪到手机上评级复习、Anki 导出 |

三个 host 都是独立完整产品，**互不依赖**——两个采集侧任一停更另一个独立运转，Review 侧把学习进度装回口袋。三者都支持 `NotebookEntry` JSON 导入/导出；桌面端与 Review PWA 还可一次配对，通过只存短时密文的端到端加密接力同步笔记和复习进度。插件端继续以 JSON 作为稳定互通路径。

学习卡片默认叠加参考词典弱标签：JLPT（N5–N1）、CEFR-J（A1–C2）、中文外语考试大纲（高考 / CET-4 / CET-6 / 考研）+ IELTS / TOEFL 社区参考弱标签（v1.1 一档色调更淡，明示非官方）。参考词典 CDN 与 host 完全独立。

## 截图

<p align="center">
  <img src="screenshots/lyric-ncm.png" alt="网易云客户端中跟随歌词显示学习卡片（Aimer - After Rain）" width="49%" />
  <img src="screenshots/lyric-amll.png" alt="AMLL 沉浸式歌词模式下的学习卡片（深色主题）" width="49%" />
</p>

## 三分钟演示

不安装网易云、不填写 API Key 也能先走通确定性的 UI 路径：

```powershell
start docs\demos\ui-demo-v2.html
```

在 demo 中切换中/日/英样例、播放状态和明暗主题，再打开设置查看完整配置面。真实链路则从 [v1.0.0 Release](https://github.com/yoruuuchan/LyricLens/releases/latest) 下载固定文件名 `LyricLens.plugin`，安装后播放一首英文或日文歌，配置 OpenAI 兼容 endpoint，即可验证「歌词捕获 → 学习卡片 → 加星入笔记本 → 导出 JSON」闭环。

## 安装

### 推荐：从插件官网下载

1. 退出网易云音乐。
2. 打开 [lyriclens.yoru-and-akari.dev](https://lyriclens.yoru-and-akari.dev)，点「下载最新版」按钮，得到 `LyricLens.plugin` 文件。
3. 把 `.plugin` 文件拖进 BetterNCM 的「插件管理」窗口，或解压到 BetterNCM 插件目录下的 `plugins/lyriclens/`。
4. 重新打开网易云音乐，在 BetterNCM 插件管理中启用 LyricLens。

### 已经装过：插件内一键更新

打开 LyricLens 浮层 → 齿轮按钮 → 关于 tab → 点「立即更新」按钮即可。下载、安装、提示重启全自动，全程不需要离开网易云。

### 备选：从 GitHub Release

如果上面的渠道都不可用，到 [Releases](https://github.com/yoruuuchan/LyricLens/releases) 页面手动下载最新的 `LyricLens.plugin` 文件，剩下步骤跟上面一样。

### 从源码安装（开发者）

1. 退出网易云音乐。
2. 将本项目整个文件夹复制到 BetterNCM 插件目录，例如 `plugins/lyriclens/`。
3. 确认目录内包含 `manifest.json`、`main.js`、`src/`、`styles/`。
4. 重新打开网易云音乐，在 BetterNCM 插件管理中启用 LyricLens。

本项目不需要构建，源码可直接加载。如需重新打包 `.plugin`：`npm run build`。

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

测试覆盖语言检测、歌词预处理、缓存 key、LLM JSON 容错解析、播放时间同步、插件打包和跨 host `NotebookEntry` 对拍。

## License

LyricLens 使用 [GNU Affero General Public License v3.0 或更高版本](LICENSE) (AGPL-3.0-or-later) 协议发布。

简短说人话：
- 你可以自由使用、修改、分发本项目。
- 你 fork 出来的版本、以及任何**通过网络对外提供 LyricLens（或衍生）服务**的部署，都必须以同一 AGPL 协议开源。
- 选择 AGPL 而非 MIT/GPL 是有意的：本项目保留以后双授权（commercial license）的可能性。如有商业授权需求请通过 Issues 联系。

字体等第三方资源的版权与许可请见 [NOTICES.md](NOTICES.md)。

## 贡献

欢迎 PR。请在每个 commit message 末尾加 `Signed-off-by: Your Name <your@email>`（git 用 `git commit -s` 自动加），表示你同意按本项目协议授权你的贡献（[Developer Certificate of Origin](https://developercertificate.org/)）。
