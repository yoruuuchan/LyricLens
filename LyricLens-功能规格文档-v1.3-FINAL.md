# LyricLens — BetterNCM AI 歌词学习插件

## 功能规格文档 v1.3 FINAL（Codex 开发输入版）

**项目定位：** 网易云音乐 BetterNCM 插件，播放英文/日文歌曲时自动拆解歌词，生成学习卡片，帮助用户在听歌过程中学习语言。

**对标产品：** LyricBloom（Mac独立应用，¥19.9/月）。本插件免费，Win端，内嵌网易云，零额外安装。

---

## 1. 技术环境

| 项目 | 值 |
|------|------|
| 网易云客户端 | Win 3.1.23 64位 |
| BetterNCM | 1.3.4 |
| 插件语言 | JavaScript（可选 TypeScript + ESBuild） |
| Node.js（开发机） | v24.14.0 |
| 歌词插件 | AMLL 可选增强：优先复用 AMLL/现有歌词插件的解析结果，不作为硬依赖 |
| 网络能力 | 插件 JS 环境已有直接 fetch OpenAI 兼容接口的先例（GPTTrans）；具体 endpoint 需实测 CORS/网络可用性 |
| 窗口能力 | 未发现 BetterNCM 公开 BrowserWindow / 独立窗口 API；MVP 使用 DOM fixed 浮层 |

---

## 2. 架构设计

```
歌曲切换事件
    │
    ▼
歌词获取模块 ──→ 语言检测模块
    │                  │
    │          ┌───────┴───────┐
    │          │ 英文/日文     │ 中文/其他
    │          ▼               ▼
    │     LLM 拆解模块      跳过，不触发
    │          │
    │          ▼
    │     缓存层（内存）
    │          │
    ▼          ▼
播放进度监听 ──→ 浮层卡片 UI
```

### 核心原则

- **一次拆解，全程使用：** 歌曲加载时一次性把全部歌词发给 LLM，返回结果缓存在内存。播放过程中纯前端渲染，零延迟。
- **零侵入 AMLL：** 不修改 AMLL 的 DOM、不影响歌词渲染、不注入 AMLL 的样式。学习卡片使用独立浮层。
- **降级安全：** API 不可用、网络失败、中文歌曲等情况下插件静默不显示，不影响任何原有功能。

---

## 3. 核心模块

### 3.1 歌词获取模块

利用 BetterNCM 环境获取歌词数据，**按以下优先级尝试，避免与 AMLL/CppLyrics 冲突：**

**优先级 1：读取现有歌词插件暴露的数据**
```javascript
// 示例：检查常见全局歌词对象，实际字段需运行时探测
const candidates = [
  window.currentLyrics,
  window.CPPLYRICS_INTERNALS?.currentLyrics,
  window.AMLL?.currentLyrics
].filter(Boolean);
```

**优先级 2：接入现有歌词处理回调**
```javascript
// 如需接入已有歌词处理回调（如 onProcessLyrics），
// 采用 wrapper 包装原函数，必须保留原函数返回值、异步行为和异常传播；
// 无法安全包装时放弃该路径。
```

**优先级 3：自行获取歌词（仅在上述均不可用时）**
```javascript
// 获取当前歌曲
betterncm.ncm.getPlayingSong()
// 获取歌曲 ID
betterncm.ncm.getPlaying().id
// 监听播放进度
legacyNativeCmder.appendRegisterCall(
  "PlayProgress", "audioplayer", (progress) => { ... }
)
// 自行 hijack 歌词处理流程
// 注意：如果检测到同 URL hijack 已存在，放弃 hijack，避免互相覆盖
```

**优先级 4：全部失败则静默降级，不显示浮层**

### 3.2 语言检测模块

```
输入：原文歌词（纯文本，不包含翻译歌词 tlyric/ytlrc）
输出：'en' | 'ja' | 'other'
逻辑：
  - 只对原文歌词做检测，翻译歌词不参与统计（避免中文翻译干扰）
  - 有平假名/片假名 → 优先判定 'ja'
  - 拉丁字母占比 > 60% 且假名极少 → 'en'
  - CJK 多但无假名 → 'other'（中文歌，不触发拆解）
```

不需要调 API 做语言检测，字符统计足够准确且零成本。注意日文歌词汉字比例可能很高，单靠假名占比阈值不稳，有假名即优先判定日文。

### 3.3 LLM 拆解模块

#### API 格式

统一使用 OpenAI 兼容格式：

```javascript
const response = await fetch(apiEndpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: formattedLyrics }
    ],
    temperature: 0.3
  })
});
```

用户在插件设置中配置：
- **API Endpoint**（OpenAI 兼容 Chat Completions 完整地址，例如 `https://api.openai.com/v1/chat/completions`。插件不做路径拼接，用户填什么就请求什么）
- **API Key**
- **Model Name**（默认留空，提示用户填写）

不预设任何供应商。国内用户可填硅基流动/DeepSeek/通义千问/智谱的地址，海外用户可填 OpenRouter/OpenAI。

#### 歌词预处理（发送前）

```
1. 只取原文歌词，丢弃翻译歌词（tlyric/ytlrc/ttlrc）和罗马音（romalrc）
2. 去除逐字时间戳，只保留纯文本
3. 去除空行和纯标点行
4. MVP 不做重复段压缩；最多处理前 80 个有效原文行，超出部分不显示学习卡片
5. 每行使用原始歌词数组中的行号作为 index（不使用过滤后的连续行号），过滤只影响是否发送给 LLM，不改变原始 index
```

**示例（跳过了空行和纯标点行）：**
```text
[3] I really want to stay at your house
[4] And let yourself go
[7] You know you didn't lose your self-control
```

这样播放同步模块可以直接用 `index → lyricLine.startTime` 对齐。

#### Prompt 设计

**英文歌词 System Prompt：**

```
你是一个英语学习助手。用户会发送一首英文歌的完整歌词，每行带有行号，格式为 [行号] 歌词内容。

请为每行歌词生成学习卡片。严格按以下 JSON 格式返回，不要添加任何其他文字：

{
  "cards": [
    {
      "index": 0,
      "line": "原始歌词行",
      "translation": "中文翻译",
      "highlights": [
        {
          "phrase": "值得学习的表达/词组/俚语",
          "meaning": "释义",
          "pronunciation": "发音要点（连读、弱读、省略等，如有）",
          "context": "文化背景或用法说明（如有）"
        }
      ]
    }
  ]
}

规则：
- index 必须与输入行号一致
- 每行歌词一张卡片，不可省略任何行
- 纯感叹词或重复段落也必须返回对应 index；可以让 translation 写"同上"、highlights 为空数组，但不要省略该行
- highlights 只挑值得学的表达，不是每个词都要解释，普通词汇跳过
- translation 要自然流畅，不要机翻腔
- 如果某一行没有值得学习的内容，highlights 为空数组
- 只返回 JSON，不要返回其他任何内容
```

**日文歌词 System Prompt：**

```
你是一个日语学习助手。用户会发送一首日文歌的完整歌词，每行带有行号，格式为 [行号] 歌词内容。

请为每行歌词生成学习卡片。严格按以下 JSON 格式返回，不要添加任何其他文字：

{
  "cards": [
    {
      "index": 0,
      "line": "原始歌词行",
      "translation": "中文翻译",
      "highlights": [
        {
          "phrase": "值得学习的单词/文法/惯用表达",
          "reading": "假名读音",
          "meaning": "释义",
          "grammar": "相关文法点（如有）",
          "context": "文化背景或用法说明（如有）"
        }
      ]
    }
  ]
}

规则：
- index 必须与输入行号一致
- 每行歌词一张卡片，不可省略任何行
- 纯感叹词或重复段落也必须返回对应 index；可以让 translation 写"同上"、highlights 为空数组，但不要省略该行
- highlights 优先挑 N2 及以上词汇、歌词特有表达、口语缩约形
- 基础词汇（N4/N5）跳过，除非用法特殊
- translation 要自然流畅
- 如果某一行没有值得学习的内容，highlights 为空数组
- 只返回 JSON，不要返回其他任何内容
```

#### 用户消息格式

发送给 LLM 的歌词带行号，格式如下：

```
[0] I really want to stay at your house
[1] And let yourself go
[2] You know you didn't lose your self-control
```

#### 返回数据处理

```
1. 解析 JSON（容错处理：如果 LLM 返回了 markdown code fence 则先 strip）
2. 按 index 字段与歌词行对齐，line 字段仅做校验
3. index 不存在或超出范围的卡片丢弃
4. 缓存到内存 Map：Map<`${songId}:${lyricsHash}:${endpointHash}:${modelName}:${promptVersion}`, Card[]>
5. 切歌时清除上一首的缓存
```

**缓存 key 说明：** endpointHash 是 API Endpoint 的哈希值（同名模型在不同供应商可能完全不同）。promptVersion 为硬编码常量，每次更新 prompt 时手动递增。

### 3.4 内部数据结构

```ts
type LyricLine = {
  index: number;       // 原始歌词数组行号
  text: string;
  startTime: number;   // ms
  endTime?: number;    // ms
};

type LyricCard = {
  index: number;
  line: string;
  translation: string;
  highlights: Array<Record<string, string>>;
};

type SongAnalysis = {
  songId: string | number;
  lyricsHash: string;
  language: 'en' | 'ja';
  lines: LyricLine[];
  cardsByIndex: Map<number, LyricCard>;
};
```

### 3.5 歌曲切换检测

优先监听 BetterNCM/网易云已有播放事件；若不可用，MVP 使用 polling：

```javascript
// 每 1000ms 检测 songId 变化
let lastSongId = null;
setInterval(() => {
  const currentId = betterncm.ncm.getPlaying()?.id;
  if (currentId && currentId !== lastSongId) {
    lastSongId = currentId;
    onSongChange(currentId);
  }
}, 1000);
```

### 3.6 播放进度监听

```javascript
legacyNativeCmder.appendRegisterCall(
  "PlayProgress",
  "audioplayer",
  (...args) => {
    // 运行时 console.log(args) 确认参数结构；
    // CppLyrics 先例中参数形式为 (_, time)，time 需 *1000 转 ms
    // 目标：取得当前播放时间，统一转换为 ms
  }
);
```

第一版不要假设参数结构，运行时打印确认后再硬编码。

### 3.7 浮层关闭状态

```javascript
// 用户点击关闭时记录当前 songId
let suppressedSongId = null;

// 关闭时
suppressedSongId = currentSongId;

// songId 变化时清除，不继承上一首的关闭状态
if (currentSongId !== suppressedSongId) {
  suppressedSongId = null;
}
```

### 3.8 80 行截断与同步的关系

LLM 只分析前 80 个有效原文行。播放到未分析行时，浮层保持隐藏或显示空状态，不影响歌词同步监听继续运行。同步模块查找 `cardsByIndex.get(currentLineIndex)`，找不到则不渲染，不报错。

### 3.9 浮层卡片 UI

#### 实现方式

在网易云 DOM 中创建一个 `position: fixed` 的可拖拽浮层面板。

```
┌─────────────────────────────────────┐
│ ⚡ LyricLens          ─  □  ✕     │  ← 标题栏（可拖拽）
├─────────────────────────────────────┤
│                                     │
│  🎵 当前歌词行（高亮显示）           │
│  翻译文本                           │
│                                     │
│  ┌─ highlight ─────────────────┐   │
│  │ phrase → 释义               │   │
│  │ 🔤 发音要点 / 假名读音      │   │
│  │ 💡 文化背景 / 文法点        │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─ highlight ─────────────────┐   │
│  │ phrase → 释义               │   │
│  │ ...                         │   │
│  └─────────────────────────────┘   │
│                                     │
│         ● ● ○ ○ ○ ○ ○ ← 行进度指示 │
└─────────────────────────────────────┘
```

#### 技术要求

- **拖拽：** 标题栏支持 mousedown 拖拽，记住位置到 localStorage
- **缩放：** 右下角拖拽缩放，最小宽度 300px，最小高度 200px
- **最小化：** 点击 `─` 按钮收起为一个小图标悬浮在角落
- **关闭：** 点击 `✕` 关闭浮层（当前歌曲不再显示，下一首重新判断）
- **层级：** z-index 足够高，不被网易云原生 UI 遮挡
- **样式隔离：** 所有样式使用独立 class 前缀（如 `ll-`），避免与网易云/AMLL 样式冲突

#### 视觉风格

- 暗色半透明背景（`rgba(20, 20, 30, 0.85)` + `backdrop-filter: blur(20px)`）
- 与 AMLL 的毛玻璃风格协调
- 字体跟随系统，正文 14px，歌词行 16px 加粗
- 卡片圆角、微妙边框（`1px solid rgba(255,255,255,0.1)`）
- 过渡动画：卡片切换使用 fade + 轻微上滑（200ms ease）

#### 播放同步

- 监听播放进度，当进度进入下一行歌词的时间范围时，浮层自动切换到对应卡片
- 切换时平滑过渡，不要闪跳
- 用户手动滚动/查看其他行时暂停自动同步，3秒无操作后恢复

---

## 4. 插件设置面板

在 BetterNCM 插件设置中提供配置项：

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| API Endpoint | text | （空） | OpenAI 兼容 Chat Completions 完整地址 |
| API Key | password | （空） | API 密钥 |
| Model Name | text | （空） | 模型名称 |
| 自动拆解 | toggle | 开 | 播放英/日文歌时自动触发 |
| 浮层默认位置 | select | 右下 | 左上/右上/左下/右下 |
| 浮层透明度 | slider | 85% | 50%-100% |

**存储方式：** 优先使用 `betterncm.app.readConfig / writeConfig`；如 BetterNCM 插件设置 UI API 不稳定，MVP 先在浮层内做简易设置入口（齿轮图标展开设置表单）。

**API Key 安全：** API Key 存储在本地 BetterNCM 配置中，不上传到任何外部服务器。但不保证系统级加密，用户应知晓本地存储的安全边界。

首次使用时，如果未配置 API，浮层显示引导提示："请在插件设置中配置 AI 服务"。

---

## 5. 降级与错误处理

| 场景 | 行为 |
|------|------|
| API 未配置 | 浮层显示配置引导，不报错 |
| API 请求失败 | 浮层显示"拆解失败，点击重试"，可手动重试 |
| API 返回非法 JSON | 尝试修复（strip code fence），失败则当作请求失败 |
| 中文歌 / 语言检测为 other | 不显示浮层，完全静默 |
| 歌词数据获取失败 | 不显示浮层 |
| AMLL 未安装 | 按优先级链降级：尝试其他歌词数据来源，全部失败则不显示浮层 |
| 网络超时 | 15秒超时，浮层显示"请求超时，点击重试" |
| 歌曲切换过快 | 取消上一首未完成的请求，只处理当前歌曲 |

---

## 6. 文件结构（建议）

```
lyriclens/
├── manifest.json          # BetterNCM 插件清单
├── main.js                # 入口，注册生命周期
├── src/
│   ├── lyrics.js          # 歌词获取与解析
│   ├── detect.js          # 语言检测
│   ├── api.js             # LLM API 调用
│   ├── cache.js           # 内存缓存
│   ├── panel.js           # 浮层 UI 创建与管理
│   ├── card.js            # 学习卡片渲染
│   ├── sync.js            # 播放进度同步
│   ├── settings.js        # 插件设置面板
│   └── utils.js           # 工具函数
├── styles/
│   └── panel.css          # 浮层样式（所有 class 以 ll- 前缀）
└── README.md
```

---

## 7. manifest.json 示例

```json
{
  "manifest_version": 1,
  "name": "LyricLens",
  "slug": "lyriclens",
  "version": "0.1.0",
  "description": "AI 歌词学习助手 — 听歌时自动拆解英/日文歌词，生成学习卡片",
  "author": "Yoru",
  "injects": {
    "Main": [
      {
        "file": "main.js"
      }
    ]
  },
  "requirements": []
}
```

---

## 8. 开发步骤（建议顺序）

1. **搭骨架：** manifest + main.js，确认插件能被 BetterNCM 加载
2. **歌词获取：** 实现歌词获取模块，打印当前歌曲歌词到 console 验证
3. **语言检测：** 实现字符统计检测，只对英/日文歌曲继续
4. **API 调用：** 实现 LLM 调用模块，先用硬编码歌词测试 prompt 效果
5. **浮层 UI：** 创建可拖拽浮层，先用假数据渲染卡片
6. **串联：** 把歌词获取 → 检测 → API → 缓存 → UI 串起来
7. **播放同步：** 实现进度监听和卡片自动切换
8. **设置面板：** 添加配置项
9. **打磨：** 错误处理、动画、边界情况

---

## 9. OPC 展示包装（备忘）

**一句话：** 非技术背景大学生，用 AI 工具链在停止维护的开源项目上二次开发，把 Mac 端付费歌词学习应用的体验改造成网易云内置免费插件。

**关键标签：** AI + 文化娱乐 / AI + 教育 / OPC 个体开发者

**展示形式：** 现场演示（播放一首英文歌 + 一首日文歌，展示实时学习卡片）
