# MediaWiki ⇄ VSCode External Editor

在浏览器里发起编辑，用 VSCode 改，保存时浏览器实时预览，最后在浏览器里提交。

## 组成

- `userscript/mediawiki-vscode-editor.user.js`：Tampermonkey 脚本，运行在 vcpedia.cn 页面里
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
   codium --install-extension dist/mediawiki-vscode-editor-0.3.0.vsix
   # 或 code --install-extension ...

   ```

   或在扩展目录按 F5 调试。

2. 浏览器端二选一：

   - Tampermonkey：新建脚本，粘贴 `userscript/mediawiki-vscode-editor.user.js` 的内容。更新时打开同一条目，全选删除后粘贴新文件再保存。装好后控制台应出现 `[mediawiki-vscode] userscript 0.3.3 loaded`。
   - 或直接放进个人 JS：打开 `https://vcpedia.cn/User:<你的用户名>/common.js`（红链就创建），粘贴同一份内容并保存，然后 `?action=purge` 或 Ctrl+F5 刷新。个人 JS 只在你登录时加载，效果与 Tampermonkey 相同。

   不要放进 `MediaWiki:Common.js`：那需要 `editinterface` 权限，且会让所有访客都去连本机端口。

3. 打开 vcpedia.cn 并登录。页面右下角出现「VSCode 编辑」，标题旁的 `[编辑]` 后面出现 `VSCode` 链接。

## 使用

- 整页编辑：点右下角按钮，或按 `Alt+E`。
- 章节编辑：点该节 `[编辑]` 后面的 `VSCode`。
- VSCode 打开临时文件（默认 `$XDG_CACHE_HOME/mediawiki-edit/<站点主机>/<页面名>[.s<节号>].<时间戳>.wiki`，即 `~/.cache/mediawiki-edit/vcpedia.cn/…`），改完 `Ctrl+S`。
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

- `mediawikiEditor.port`：本地 WebSocket 端口，默认 `8927`。
- `mediawikiEditor.tempDir`：源码落盘目录，默认用户缓存目录 `$XDG_CACHE_HOME/mediawiki-edit`（macOS 为 `~/Library/Caches/mediawiki-edit`，Windows 为 `%LOCALAPPDATA%\mediawiki-edit`）。断电或重启后文件仍在；需要更持久的归档可改到 `~/.local/share`。
- `mediawikiEditor.allowedOrigin`：允许连接的浏览器来源，默认 `*`（不限制）；填单个 origin 可限制。
- `mediawikiEditor.languageFeatures`：是否启用内建语言功能，默认开启。
- `mediawikiEditor.diagnosticsWarnings`：诊断是否包含警告，默认关闭（只报错误）。
- `mediawikiEditor.diagnosticsDelay`：停止输入后多久执行诊断，默认 400ms。
- `mediawikiEditor.diagnosticsMaxLength`：超过该字符数不自动诊断、不生成语义高亮，默认 100000；设为 0 不限制。
- `mediawikiEditor.parserConfig`：内置 VCPedia/未注册文档的解析配置路径；自定义 wiki 使用添加时生成的独立配置。

修改端口时同步改用户脚本顶部的 `WS_URL`。

## 多 wiki

扩展内置 VCPedia；其他站点从命令面板添加：

- `MediaWiki: 添加 wiki`：输入名称和站点地址，自动探测 `/api.php` 或 `/w/api.php`，读取 `siteinfo` 生成该站点的解析配置并注册。
- `MediaWiki: 列出已添加的 wiki`、`MediaWiki: 删除 wiki`：管理自定义条目；内置 VCPedia 不可删除。

解析配置存放在扩展的 global storage（`wikis/<host>.json`），注册表保存在扩展 globalState。浏览器推送时优先使用消息里的站点地址；InPageEdit 插件发送 `location.origin`，缺失时回退 WebSocket `Origin` 头。未注册的站点会拒绝打开，并提示先添加 wiki。

临时文件按站点主机分目录：`<tempDir>/<host>/<页面名>[.s<节号>].<时间戳>.wiki`。旧根目录下的文件不会自动迁移。

## 语言功能

临时文件以 `mediawiki-wikitext` 语言打开，扩展内建由 `wikiparser-node` 驱动的语言功能：

- 语法诊断：只报错误，可开启警告；错误处可应用快速修复。
- 语法高亮：基于 TextMate 语法；另有语义高亮补充模板名、参数名、魔术字、链接目标等。
- 折叠、大纲、补全、Hover、解析函数签名帮助、颜色预览、Inlay hints。
- 模板参数/魔术字的当前文档内重命名、引用和高亮。
- 外部链接与 wiki 内链可点击。

诊断在输入后防抖执行；超大文档默认跳过自动诊断，可用 `MediaWiki: 重新检查当前文件` 手动触发。解析配置随扩展打包为 `config/vcpedia.json`，由 `scripts/build-vcpedia-config.mjs` 从站点 `siteinfo` API 生成，不执行站点脚本；需要重新生成时运行：

```sh
node scripts/build-vcpedia-config.mjs
```

语言功能是单文件分析：不会抓取远端页面，因此不提供跨页面的模板/模块定义跳转；`跳转到定义` 目前支持 `<ref name>` 到引用列表，引用/重命名也限于当前文档。章节编辑的临时文件只包含该节文本，页面级规则可能不适用。

编辑器唤起协议默认 `vscodium://`。如果用的是 VS Code，在 mediawiki 页面的控制台执行一次：

```js
localStorage.setItem('vcpe-editor-scheme', 'vscode')
```

## 位置同步

- 光标移动后，扩展用 `wikiparser-node` 找到光标处最小的 AST 文本项，连同该文本在文档中的出现序号发给预览。
- 预览在 `#mw-content-text` 的文本里按序号定位，用跨节点的 `Range` 画高亮（日期、统计句被标签拆开也能命中）。
- 高亮落在隐藏/折叠内容上时，自动点开 `.mw-collapsible-toggle` 或清除 `display:none` 后重试。
- `<poem>` 里的歌词按 `.poem` 容器限定，出现序号也在容器内计数，避免标题/信息框里的同名文字造成错位。
- 模板参数值带参数名、正文条目带前后相邻文本；匹配时依次尝试 `参数名+文本`、`文本+后文`、`前文+文本`，最后才退回纯文本+序号。songbox 字段和简介里的同名文字不会再互相串。
- 同名参数值（例如 songbox 和 `VOCALOID Songbox Introduction` 都有 `演唱=诗岸`）按该参数组合内的出现序号定位，不会都跳到第一个。
- 匹配前先把空白统一成一个空格（全角空格、换行），所以 `我哭着　也笑着` 这类歌词也能命中。
- **匹配不到就不动**：不回退到模板区域或章节比例，保持上一次的视口位置。
- 点击预览正文（非链接）时，取点击处的文本发给 VSCode，按该文本定位源码行。

## 通过 IPE 插件商店安装

在 InPageEdit 设置 → 插件商店里添加注册表：

```
https://cdn.jsdelivr.net/gh/minortex/mediawiki-vscode-editor@latest/ipe-plugin/registry.json
```

安装后由插件商店启用/禁用/卸载。也可以直接把 `ipe-plugin/mediawiki-vscode-ipe.js` 放进个人 JS 或 Tampermonkey。

## InPageEdit 插件（初版）

`ipe-plugin/mediawiki-vscode-ipe.js` 是 InPageEdit NEXT 插件版本，用来替代自写的前端入口：

- 在个人 JS 里加载（InPageEdit 之后），或控制台注入文件内容；
- 点 IPE 的编辑入口 → 关闭 IPE 弹窗 → 在 VSCode 里打开源码；
- VSCode 内容变化 → 插件调用 `action=parse` 替换正文，保留页面内预览和光标定位；
- VSCode 里执行 `MediaWiki: 通过 InPageEdit 保存当前文件` → 插件调用 `wikiPage.edit()`，复用 IPE 的 token、`basetimestamp`、冲突处理和 watchlist。

限制：章节编辑暂时只有预览提示；页面标签栏的原生“编辑”链接不经过 IPE；保存结果在页面状态条显示。插件会把当前页面 origin 作为 wiki 标识发送；换站点时先在命令面板添加对应 wiki。

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
