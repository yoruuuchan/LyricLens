# LyricLens release flow

这份流程写给下一次发版的人。脚本只负责把 release 准备到 **GitHub draft**，不会 publish，也不会部署到本机 NCM。

## 发版前 checklist

- `main` 已经包含本次要发布的全部 PR，CI / 本地测试全绿。
- `manifest.json` 的 `version` 已经 bump 到目标版本，例如 `0.4.0`。
- 本机 NCM 里的 `D:\CloudMusic\betterncm\plugins\LyricLens.plugin` 仍保持旧版本，用来验收插件内更新链路。
- changelog 考古范围明确：通常是上一个 release tag 到 `HEAD`，例如 `v0.3.0..HEAD`。
- 不要改 release asset 名。GitHub Release 资产必须叫 `LyricLens.plugin`。
- 不要在发版 PR 里改 `cloudflare-worker/`。Worker 的 `/latest.json` 缓存策略和 `CACHE_REV` 有独立节奏。

## 脚本用法

先做 dry run：

```powershell
pwsh scripts/release.ps1 -Version 0.4.0 -DryRun
```

脚本会按顺序执行：

1. 校验发布前置条件。
2. `npm run build`。
3. `npm test`。
4. 计算 `LyricLens.plugin` 的 SHA-256。
5. 生成临时 release notes 草稿。
6. 打印将要执行的 `gh release create ... --draft ... LyricLens.plugin` 命令。

真正创建 draft release：

```powershell
pwsh scripts/release.ps1 -Version 0.4.0
```

真实发布必须在干净的 `main` 上执行。PR 分支上可以跑 `-DryRun` 预览输出；脚本会警告当前不在 `main`，但不会创建 release。

## Draft 到 publish

脚本创建的是 GitHub draft release。检查以下内容后再 publish：

- 标题是 `LyricLens v0.4.0`。
- tag 是 `v0.4.0`。
- 资产文件名是 `LyricLens.plugin`。
- release notes 已人工润色，Features / Fixes / Internal 分类没有明显误放。
- SHA-256 和脚本输出一致。

可以在 GitHub UI 点 Publish，也可以用 CLI：

```powershell
gh release edit v0.4.0 --draft=false
```

publish 之前，Worker 的 `/latest.json` 仍只会看到上一个 published release。draft 对线上用户没有影响。

## Publish 后生效时间

`lyriclens.yoru-and-akari.dev/latest.json` 走 Worker edge 缓存，最长约 10 分钟才会拾取新版。刚 publish 后如果插件仍显示“已是最新”，先等缓存过期再测。

## Task #2 真机验收链路

每次发版都顺手回归插件内一键更新：

1. 发版前保持本机 NCM 插件为旧版本。
2. publish GitHub release。
3. 等 Worker 缓存最多 10 分钟。
4. 打开插件设置，点击“检查更新”。
5. 预期看到 update-available 状态。
6. 点击一键下载安装。
7. 按提示重启 NCM。
8. 重启后确认插件版本已经变成新版。

不要提前把新 `.plugin` 手动覆盖进 NCM 插件目录，否则这条 update-available 链路会被破坏。

## 警戒线

- 只用 `LyricLens.plugin` 作为 release asset 名。
- 不在 release 脚本里 publish。
- 不在 release 脚本里部署 NCM。
- 不在 release PR 里动 `cloudflare-worker/`。
- Worker 的 `asset_digest` 来自 GitHub Release API，不需要额外上传校验文件。
