# TODO

## 补全开发进度（2026-11-11）

### P0 自动闭合修复（已完成）

- [x] `language-configuration.json`：移除单引号 `'` 与单字符 `<` 的自动闭合/包围。
- [x] 新增 `{{{` → `}}}`、`<!--` → `-->`、`-{` → `}-` 多字符闭合。
- [x] `npm test` 通过；无 VSCode 运行环境，敲击手感未手测。

### P1 静态片段补全（已完成）

- [x] `src/language/snippets.ts`：纯函数片段目录与上下文匹配。
  - 引号：输入单个 `'` 即提供斜体/粗体/粗斜体候选；继续输入 2/3/5 个则只给对应样式
  - 标题：1–6 级，按输入级别预选
  - 表格：`{|` 多行骨架
  - 标签：按站点 `config.ext` / `config.html` 生成成对标签；输入 `<` 即返回候选并随输入过滤，`<ref>` 带名引用与自闭合
  - 重定向：识别站点 `config.redirection`
  - 签名：`~~~` → `~~~~` / `~~~~~`
  - 注释、语言变体、分隔线
  - 内链/模板/参数/注释 opener 仅在缺少自动闭合 closer 时提供
- [x] `src/language/features.ts`：注册独立 `CompletionItemProvider`。
  - 触发字符：`'`、`<`、`~`、`-`，沿用 `#`、`{`、`[`、`=`
  - 精确替换 range、`filterText`、`sortText`、去重、`preselect`、多行 `keepWhitespace`
  - AST 抑制：`nowiki`、`pre`、`source`、`syntaxhighlight`、`math`、`chem`、`ce`、`score`、`graph`、`timeline`、`hiero`、`templatedata`、`imagemap`、`gallery` 等及注释；超过 `diagnosticsMaxLength` 跳过
- [x] `test/completion-snippets.test.mjs`：表驱动覆盖主要上下文与替换范围。
- [x] `README.md` 补充结构片段与自动闭合说明。
- [x] `npm test`：24/24 通过。
- [ ] 待手测：VSCode Extension Development Host 中验证弹窗、Tab 接受、片段占位符跳转与上游补全共存。

### P1.5 解析函数参数骨架（已完成）

- [x] 新增 `src/language/function-snippets.ts`：读取 `wikiparser-node/data/signatures.json`，按站点 `config.parserFunction` 解析本地别名，生成参数占位符。
- [x] 在 `features.ts` 的补全映射中，把解析函数项的 `insertText` 替换为片段；保留原 range，不重复 `}}`。
- [x] 多签名函数取第一组；`#switch` 生成多行分支骨架；空签名保持只补名字。
- [x] 保留已输入的半角/全角冒号。
- [x] `test/function-snippets.test.mjs`：覆盖 `#if`、`#switch`、`#invoke`、本地别名、全角冒号、空签名与多签名。
- [x] `npm test`：32/32 通过。

### 关闭编辑会话命令（已完成）

- [x] `package.json` 新增命令 `mediawikiEditor.closeSession`（「MediaWiki: 关闭当前编辑会话」）。
- [x] 用 SHA-256 保存页面原始内容哈希，判断是否发生过实际修改；旧会话无哈希时保守询问。
- [x] 有修改：模态询问「保存并关闭」/「放弃修改」；保存复用 `saveInPage` + `finish('saved')`，浏览器确认后清理文件并关闭页面。
- [x] 无修改：发送 `finish('unchanged')`，关闭编辑器标签并删除临时文件。
- [x] 浏览器端复用现有 `finish` 处理：脚本打开的标签会执行 `window.close()`，用户手动打开的标签由浏览器自行拦截。
- [x] `onDidCloseTextDocument` 在等待确认或已请求关闭页面时不再把会话标成草稿。
- [x] `npm test`：36/36 通过。

### P2 跨 wiki 补全（未开始）

- [ ] 新增 `src/language/wiki-data.ts`：API 客户端、LRU/TTL 缓存、Abort 与超时降级。
- [ ] 接入页面/模板搜索（`opensearch`）与模板参数解析（`revisions` + `Parser.parse`）。
- [ ] 补全排序与源标记（本地/站点/片段），网络失败静默降级。
- [ ] 可选：私有 wiki 通过浏览器 WebSocket 代理 API 请求。

### P3 幽灵文本（未评估）

- [ ] 评估并实现引号/闭合符 `InlineCompletionItemProvider`。

---

以下为早期记录。

## P0 清理

- [x] 删除 `userscript/`，只保留 `ipe-plugin/` 作为浏览器端实现。
- [x] 删除复制进仓库的 `config/default.json`，改为从 `wikiparser-node` 依赖读取。
- [x] 删除已过期、只实现旧协议的 `scripts/mock-server.js`。
- [x] `.vscodeignore` 排除 `test/`、`scripts/`、`ipe-plugin/`、`TODO.md`。
- [x] 更新 README 的浏览器端安装方式。
- [x] 明确项目许可证：GPL-3.0-or-later，已添加 `LICENSE`。

## P1 拆分职责

- [x] 抽出 `protocol`：WebSocket 消息、状态枚举、请求/响应类型（`src/protocol.ts`）。
- [x] 抽出 `session-store`：`sessions.json` 的读取、原子写入（`src/sessions/store.ts`）。
- [x] 抽出 `session-manager`：`attached` / `detached` / `draft` 状态与持久化（`src/sessions/manager.ts`）。
- [x] 抽出 `browser-bridge`：连接、广播、请求/响应等待（`src/browser/bridge.ts`）。
- [x] `extension.js` 只保留激活、命令、消息路由和编辑器事件；会话编排抽到 `lib/session-controller.js`。
- [x] `lib/language.js` 拆成配置加载、转换、语义高亮、定义跳转（`lib/language/*`）。
- [x] 为 session 状态与持久化补单元测试（`test/session-manager.test.mjs`）。

## P2 迁移 TypeScript

- [x] 添加 TypeScript 工具链（`tsconfig.json`，Node16/CJS 输出到 `out/`）。
- [x] 先迁 `protocol`、`session-store`。
- [x] 迁 `session-manager`。
- [x] 迁 `wiki`（`src/wiki/config.ts`、`src/wiki/registry.ts`）。
- [x] 再迁 `extension`、`language`、`items`、`session-controller`。
- [x] 保持 `node_modules` 外部依赖，不对 `wikiparser-node` 做单文件打包。
- [x] 浏览器端 IPE 插件迁移到 TypeScript + Vite ES module。

## P3 其他

- [x] 统一定位与语言服务的 AST 解析：`items` 复用 `languageFeatures.ast(document)` 的缓存。
- [ ] 更新 README、版本说明和发布流程。
- [x] 全部 TypeScript 源码已开启 `noImplicitAny`，`npm run compile` 通过。
- [x] 清除 `src` 中的 `require` / `module.exports` / `'use strict'` / 显式 `any`，统一 ESM 导入导出。
- [x] 按职责重组目录：`browser/`、`sessions/`、`wiki/`、`editor/`、`language/`。

## 已实现，不再跟踪

- [x] 断电/重启后恢复未完成的编辑：已改为 `sessions.json` + `draft` 自动恢复。
- [x] 浏览器刷新后自动恢复编辑态。
- [x] 编辑器关闭后保留草稿并允许恢复。
