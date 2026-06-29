# Probe C · Cloudflare Worker 元数据端点 + 子域名上线

这个不是 probe，是直接产出。但归到 probe 系列方便整体跟踪。

## 目标

`https://lyriclens.yoru-and-akari.dev` 上挂两个端点：

| 路径 | 作用 | 实现 |
|---|---|---|
| `/download` | 302 跳转到最新 .plugin | Worker 调 GitHub API 找 asset → 302 |
| `/latest.json` | 检查更新元数据 | Worker 缓存 GitHub API 5-30 分钟，返回精简 JSON |
| `/` | landing page（可选） | 简陋 HTML：项目说明 + 直链 |

## 前置工作

### 1. build 脚本输出固定文件名 ⚠️
GitHub 的 `releases/latest/download/<name>` URL 不会自动替换版本号，**asset 名字必须固定**。

要改 `scripts/build-plugin.ps1` 把默认 OutputName 从 `LyricLens-0.1.0.plugin` 改成 `LyricLens.plugin`。版本号继续放 `manifest.json` 和 git tag，分发文件名不带版本。

→ 这个是 task #10，做完才能做下面

### 2. Cloudflare DNS
- 在 Cloudflare 给 `lyriclens.yoru-and-akari.dev` 加个 Worker route
- 或者用 Workers Custom Domain 把子域绑给 Worker

### 3. Worker 部署
- 用 wrangler 或者 Cloudflare 控制台
- secrets 不需要（只读 GitHub 公共 API）
- 缓存用 Cloudflare Cache API 或者 KV

## Worker 代码骨架

```js
const REPO = "yoruuuchan/LyricLens";
const CACHE_TTL = 600; // 10 min

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/download") {
      return handleDownload(req, ctx);
    }
    if (url.pathname === "/latest.json") {
      return handleLatestJson(req, ctx);
    }
    if (url.pathname === "/" || url.pathname === "") {
      return handleLanding();
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleDownload(req, ctx) {
  // 优先用固定文件名直接跳转，省一次 API 调用
  return Response.redirect(
    `https://github.com/${REPO}/releases/latest/download/LyricLens.plugin`,
    302
  );
}

async function handleLatestJson(req, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache/latest.json", req);
  let cached = await cache.match(cacheKey);
  if (cached) return cached;

  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "LyricLens-Updater", "Accept": "application/vnd.github+json" }
  });
  if (!r.ok) {
    return new Response(JSON.stringify({ error: "github_api_failed", status: r.status }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }
  const rel = await r.json();
  const asset = rel.assets?.find(a => /\.plugin$/.test(a.name));

  const payload = {
    version: (rel.tag_name || "").replace(/^v/, ""),
    tag: rel.tag_name,
    name: rel.name,
    changelog: rel.body || "",
    download_url: `https://lyriclens.yoru-and-akari.dev/download`,
    asset_name: asset?.name || null,
    asset_size: asset?.size || null,
    asset_digest: asset?.digest || null,
    published_at: rel.published_at,
    html_url: rel.html_url,
  };

  const resp = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${CACHE_TTL}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

function handleLanding() {
  return new Response(LANDING_HTML, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const LANDING_HTML = `<!doctype html>
...landing page TBD...
`;
```

## 验证清单

部署完后要验证：

- [ ] `curl -I https://lyriclens.yoru-and-akari.dev/download` → 302 到 github.com
- [ ] `curl https://lyriclens.yoru-and-akari.dev/latest.json` → 合法 JSON
- [ ] 浏览器访问 `/` → landing page 能打开
- [ ] 测多次 `/latest.json`：第二次以后有 `cf-cache-status: HIT`
- [ ] 在 NCM 内（要等 Probe A 装好）用 `fetch("https://lyriclens.yoru-and-akari.dev/download")` 测能不能跟随重定向拿到 blob
- [ ] 关闭 Cloudflare Worker，确认 GitHub Releases 直链兜底（用户老版本能继续用）

## 部署结果（2026-06-29）

✅ **Worker 已上线，全部端点 200 OK**

- Worker name: `lyriclens-api`（account `5e96dfd2bf22d385e4ffdaa794d74676`）
- Hostname binding: `lyriclens.yoru-and-akari.dev`
- Mechanism: **Workers Custom Domain**（不是 zone-level route）—— Cloudflare 自动创建 DNS + 签 TLS 证书 + 配 route。比 or-proxy / tg-proxy 用的"AAAA 100:: + route"老方案更新。
- 部署方式：通过 Cloudflare MCP 用 multipart/form-data PUT 到 `/accounts/.../workers/scripts/lyriclens-api`，metadata `main_module: worker.js`，compatibility_date `2026-06-01`
- 证书签发延迟：< 30 秒（第一次 healthz 请求直接 200）

### 端点状态

| 路径 | 状态 | 说明 |
|---|---|---|
| `/` | ✅ 200 | landing page (HTML, 中文) |
| `/healthz` | ✅ 200 `ok` | 监控用 |
| `/latest.json` | ✅ 200 | 完整 release 元数据，缓存 10min |
| `/changelog` | ✅ 200 | 纯文本 changelog |
| `/download` | ✅ 302 → `github.com/.../releases/latest/download/LyricLens.plugin` | **目标 404**，因为现有 v0.1.0 的 asset 还叫 `LyricLens-0.1.0.plugin`。下次发版（带新固定文件名）后自动通 |
| `/robots.txt` | ✅ 200 | Disallow all（不希望被收录） |

### 给 #2 (一键更新) 的契约

插件代码可以直接消费这些字段（来自 `/latest.json`）：
```json
{
  "version": "0.2.0",          // 纯版本号，去掉 v 前缀，能直接 semver compare
  "tag": "v0.2.0",
  "name": "LyricLens v0.2.0",
  "changelog": "...",          // markdown
  "published_at": "2026-...",
  "html_url": "https://github.com/.../releases/tag/v0.2.0",
  "download_url": "https://lyriclens.yoru-and-akari.dev/download",  // 永远走子域名
  "github_asset_url": "https://github.com/.../LyricLens.plugin",     // 备用直链
  "asset_name": "LyricLens.plugin",
  "asset_size": 451518,
  "asset_digest": "sha256:..."  // 用作完整性校验
}
```

### 下次发版 checklist

发 v0.1.1 之前要做：
- [ ] 跑 `npm run build` 确认产出 `LyricLens.plugin`（已 task #10 修过）
- [ ] git tag v0.1.1，push
- [ ] GitHub Release UI 上传 `LyricLens.plugin`（**就这个文件名，不带版本号**）
- [ ] 等几分钟让 Cloudflare 缓存过期，或者手动 purge `/latest.json` 和 `/changelog` 缓存
- [ ] 验证 `https://lyriclens.yoru-and-akari.dev/download` 能下到 .plugin

**Worker 地址**：`lyriclens.yoru-and-akari.dev`
**DNS 状态**：✅ 通过 Workers Custom Domain 自动管理（zone id `4f9b5c7236e63090439676eec70031e2`）
**首次部署版本**：worker.js etag `821051bdc019ceb6791dc9e9b98c925c91c948d93d2cac3ffca32a699ed0728e`，上线 2026-06-29 13:57:53 UTC
