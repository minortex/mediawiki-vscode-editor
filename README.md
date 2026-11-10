# MediaWiki ⇄ VSCode External Editor

一个用 VSCode 作为编辑器，把浏览器当做渲染器的 InPageEdit+VSCode Plugin 组合。

## 组成

- `ipe-plugin/src/index.ts`：InPageEdit NEXT 插件（TypeScript/Vite module），运行在任意 MediaWiki 站点页面里
- 本 VSCode 扩展：本地 WebSocket 服务（默认 `127.0.0.1:8927`），把页面源码落到临时文件，保存时把内容推回浏览器。


## 安装

1. VSCode 扩展编译安装：

```sh
npm ci && npm run compile
npx @vscode/vsce package
codium --install-extension dist/mediawiki-vscode-editor-*.vsix
```

调试时直接在扩展目录按 F5。

2. 浏览器端在 InPageEdit 设置 → 插件商店添加注册表：

```
https://cdn.jsdelivr.net/gh/minortex/mediawiki-vscode-editor@latest/ipe-plugin/registry.json
```

安装，允许访问本地设备，如果在 VSCode 里面跳转到定义，第一次需要在浏览器允许打开页面。

## 使用

- 直接使用 IPE 的编辑按钮，浏览器正文即时变成预览，底部浮条可填编辑摘要、标记小编辑。
- 点「保存更改」提交；「取消」恢复原页面并丢弃本次会话。
- 提交冲突（别人先改了）时会提示；自动把本地版本和站点最新版本以 `<<<<<<<` / `=======` / `>>>>>>>` 标记写入编辑器，处理后重新提交。提交失败后关闭会话会保留草稿，不会删除本地修改。
- 同一页面已在另一个浏览器窗口编辑时，新窗口保持普通页面，不会抢占原会话；再次点击编辑会提示先关闭原编辑会话。

编辑预览状态下：

- 点正文里的 wiki 内链，会在新标签打开目标页并进入 IPE 编辑态，同时在 VSCode 打开目标页源码。当前标签的会话保留，可多标签并行。
- 提交成功、浏览器刷新并显示新内容后，编辑器关闭并删除临时文件。
- 浏览器刷新或重新打开同一页面时，只要扩展仍有该条目的活动会话（编辑器打开），网页会自动恢复编辑态并重新绑定。
- 编辑器被手动关闭后，会话转为草稿：网页退出编辑态，临时文件保留。可用 `MediaWiki: 恢复编辑草稿` 重新打开编辑器并恢复会话。
- 扩展命令 `MediaWiki: 在浏览器中打开当前条目`：在浏览器打开当前活动编辑会话对应的页面；若会话仍存在，网页加载后会自动恢复编辑态。

## 多 wiki

- 网页端脚本连接扩展后，会携带浏览器登录态请求本站 `siteinfo`，通过 `register-wiki` 消息推送给扩展。
- 扩展据此生成解析配置、写入 global storage 的 `wikis/<host>.json`，并更新 globalState 注册表。
- `MediaWiki: 列出已添加的 wiki`、`MediaWiki: 删除 wiki` 仅用于查看和清理。

临时文件按站点主机分目录：`<tempDir>/<host>/<页面名>[.s<节号>].<时间戳>.wiki`。

## 语言功能

由 `wikiparser-node` 驱动：诊断与快速修复、语法/语义高亮、补全、Hover、签名帮助、折叠、大纲、内链、定义/引用/重命名。定义跳转通过浏览器打开目标页；引用与重命名仅限当前文档。

## 位置同步

- 编辑器 → 预览：AST 文本项 + section + occurrence，在预览同 section 内定位。
- 预览 → 源码：点击处文本 + section + occurrence 反查；失败时逐行文本兜底。
- 无文本模板：按模板名/参数/section/序号匹配展开块；失败时高亮整个 section。
- 模板展开内容与源码不是一一对应，块级定位不保证精确到模板内部。

