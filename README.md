# VCPedia ⇄ VSCode External Editor

在浏览器里发起编辑，用 VSCode 改，保存时浏览器实时预览，最后在浏览器里提交。

## 组成

RTY-MARKER- `userscript/vcpedia-vscode-editor.user.js`：Tampermonkey 脚本，运行在 vDIRTYDIRTYcpedia.cn 页面里
- 本 VSCode 扩展：本地 WebSocket 服务（默认 `127.0.0.1:8927`），把页面源码落到临时文件，保存时把内容推回浏览器。

内容方向：

```
浏览器 --open--> VSCode（写临时 .wiki 文件）
VSCode --保存--> 浏览器（action=parse 渲染预览）
浏览器 --保存更改--> 站点（action=edit，带 basetimestamp）
```

## 安装

1. VSCode 扩展：

   ```sh
   codium --install-extension dist/vcpedia-vscode-editor-0.1.0.vsix
   # 或 code --install-extension ...

   ```

   或在扩展目录按 F5 调试。

2. 浏览器端二选一：

   - Tampermonkey：新建脚本，粘贴 `userscript/vcpedia-vscode-editor.user.js` 的内容。更新时打开同一条目，全选删除后粘贴新文件再保存。装好后控制台应出现 `[vcpedia-vscode] userscript 0.3.1 loaded`。
   - 或直接放进个人 JS：打开 `https://vcpedia.cn/User:<你的用户名>/common.js`（红链就创建），粘贴同一份内容并保存，然后 `?action=purge` 或 Ctrl+F5 刷新。个人 JS 只在你登录时加载，效果与 Tampermonkey 相同。

   不要放进 `MediaWiki:Common.js`：那需要 `editinterface` 权限，且会让所有访客都去连本机端口。

3. 打开 vcpedia.cn 并登录。页面右下角出现「VSCode 编辑」，标题旁的 `[编辑]` 后面出现 `VSCode` 链接。

## 使用

- 整页编辑：点右下角按钮，或按 `Alt+E`。
- 章节编辑：点该节 `[编辑]` 后面的 `VSCode`。
- VSCode 打开临时文件（默认 `$XDG_CACHE_HOME/vcpedia-edit/<页面名>[.s<节号>].<时间戳>.wiki`，即 `~/.cache/vcpedia-edit`），改完 `Ctrl+S`。
- 浏览器正文即时变成预览，底部浮条可填编辑摘要、标记小编辑。
- 点「保存更改」提交；「取消」恢复原页面并丢弃本次会话。
- 提交冲突（别人先改了）时会提示，取消后重新发起编辑。

编辑预览状态下：

- 点正文里的 wiki 内链，会打开新标签并直接进入目标页的编辑预览，同时在 VSCode 打开目标页源码。当前标签的会话保留，可多标签并行。
- 外链、红链、特殊页面、编辑/历史链接不拦截。
- 取消或关闭浏览器标签时，扩展会关闭对应的 VSCode 编辑器；若文件有未保存修改，VSCode 会弹出自己的保存提示，只有真正关闭后临时文件才删除。
- 提交成功后编辑器关闭，临时文件删除。

## 配置

VSCode 设置：

- `vcpediaEditor.port`：本地 WebSocket 端口，默认 `8927`。
- `vcpediaEditor.tempDir`：源码落盘目录，默认用户缓存目录 `$XDG_CACHE_HOME/vcpedia-edit`（macOS 为 `~/Library/Caches/vcpedia-edit`，Windows 为 `%LOCALAPPDATA%\vcpedia-edit`）。断电或重启后文件仍在；需要更持久的归档可改到 `~/.local/share`。
- `vcpediaEditor.allowedOrigin`：允许连接的用户脚本来源，默认 `https://vcpedia.cn`。

修改端口时同步改用户脚本顶部的 `WS_URL`。

编辑器唤起协议默认 `vscodium://`。如果用的是 VS Code，在 vcpedia 页面的控制台执行一次：

```js
localStorage.setItem('vcpe-editor-scheme', 'vscode')
```

## 位置同步

- 光标移动后，扩展用 `wikiparser-node` 找到光标处最小的 AST 文本项，连同该文本在文档中的出现序号发给预览。
- 预览在 `#mw-content-text` 的文本里按序号定位，用跨节点的 `Range` 画高亮（日期、统计句被标签拆开也能命中）。
- 高亮落在隐藏/折叠内容上时，自动点开 `.mw-collapsible-toggle` 或清除 `display:none` 后重试。
- `<poem>` 里的歌词按 `.poem` 容器限定，出现序号也在容器内计数，避免标题/信息框里的同名文字造成错位。
- 匹配前先把空白统一成一个空格（全角空格、换行），所以 `我哭着　也笑着` 这类歌词也能命中。
- **匹配不到就不动**：不回退到模板区域或章节比例，保持上一次的视口位置。
- 点击预览正文（非链接）时，取点击处的文本发给 VSCode，按该文本定位源码行。

## 测试

`test/survey.mjs` 会从 wiki 随机抽取不同类型的页面（条目、模板、项目页、模块、分类、分类成员），对每页取 2 个 AST 文本项，验证定位和高亮。

```sh
# 需要浏览器开着 9222 调试端口并已登录；先停掉 VSCodium 让出 8927
BROWSER_PORT=9222 node test/survey.mjs
```

每页独立连接、结束释放标签和会话，单步超时 2 秒。

## 限制

- 预览使用 `action=parse`（`pst=1`、`preview=1`），与 InPageEdit quick-preview 相同的路径：模板、解析函数、扩展标签、站点 CSS 都生效。
- 预览会执行模板/页面输出的内联 `<script>`（与站内预览、InPageEdit 一致），所以 `{{#widget:...}}`、`{{BilibiliCount}}` 这类模板能显示真实数据；代价是每次预览可能重复请求外部 API。
- 除内联脚本外，页面级 gadget 不会重新初始化，依赖它们的交互仍可能不作用于草稿。
- 提交完全由浏览器完成，扩展不接触账号密码。
- 章节编辑只把该节文本送到 VSCode，提交时使用 `section=N`，由 MediaWiki 拼回整页；冲突检测仍基于整页 `basetimestamp`。

## 联调

无法自动化的浏览器侧状态（例如 VSCode 的未保存状态）可以用一个只实现协议的后端模拟：

```sh
MOCK_MODE=dirty node scripts/mock-server.js   # 回一条 state(dirty:true)
MOCK_MODE=update node scripts/mock-server.js  # 回一条 update(text + 标记)
```

它不打开编辑器，仅用于验证浏览器端交互。正常运行不需要它。
