# VCPedia ⇄ VSCode External Editor

在浏览器里发起编辑，用 VSCode 改，保存时浏览器实时预览，最后在浏览器里提交。

## 组成

- `userscript/vcpedia-vscode-editor.user.js`：Tampermonkey 脚本，运行在 vcpedia.cn 页面里。
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

   - Tampermonkey：新建脚本，粘贴 `userscript/vcpedia-vscode-editor.user.js` 的内容。
   - 或直接放进个人 JS：打开 `https://vcpedia.cn/User:<你的用户名>/common.js`（红链就创建），粘贴同一份内容并保存，然后 `?action=purge` 或 Ctrl+F5 刷新。个人 JS 只在你登录时加载，效果与 Tampermonkey 相同。

   不要放进 `MediaWiki:Common.js`：那需要 `editinterface` 权限，且会让所有访客都去连本机端口。

3. 打开 vcpedia.cn 并登录。页面右下角出现「VSCode 编辑」，标题旁的 `[编辑]` 后面出现 `VSCode` 链接。

## 使用

- 整页编辑：点右下角按钮，或按 `Alt+E`。
- 章节编辑：点该节 `[编辑]` 后面的 `VSCode`。
- VSCode 打开临时文件（默认 `$TMPDIR/vcpedia-edit/<页面名>[.s<节号>].wiki`），改完 `Ctrl+S`。
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
- `vcpediaEditor.tempDir`：源码落盘目录，默认系统临时目录下的 `vcpedia-edit`。
- `vcpediaEditor.allowedOrigin`：允许连接的用户脚本来源，默认 `https://vcpedia.cn`。

修改端口时同步改用户脚本顶部的 `WS_URL`。

## 限制

- 预览使用 `action=parse`（`pst=1`、`preview=1`），与 InPageEdit quick-preview 相同的路径：模板、解析函数、扩展标签、站点 CSS 都生效。
- 预览内容不会执行站点 JS，依赖脚本的交互（tooltip、折叠、部分小工具）不会作用于草稿，但静态内容与样式正确。
- 提交完全由浏览器完成，扩展不接触账号密码。
- 章节编辑只把该节文本送到 VSCode，提交时使用 `section=N`，由 MediaWiki 拼回整页；冲突检测仍基于整页 `basetimestamp`。

## 本地联调

```sh
node scripts/mock-server.js    # 模拟 VSCode 端，收到 open 后回一个改过的 update
```

然后在浏览器 DevTools 里粘贴用户脚本内容（或把它装进 Tampermonkey），点击编辑按钮观察预览。
