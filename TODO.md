# TODO

## P0 清理

- [x] 删除 `userscript/`，只保留 `ipe-plugin/` 作为浏览器端实现。
- [x] 删除复制进仓库的 `config/default.json`，改为从 `wikiparser-node` 依赖读取。
- [x] 删除已过期、只实现旧协议的 `scripts/mock-server.js`。
- [x] `.vscodeignore` 排除 `test/`、`scripts/`、`ipe-plugin/`、`TODO.md`。
- [x] 更新 README 的浏览器端安装方式。
- [x] 明确项目许可证：GPL-3.0-or-later，已添加 `LICENSE`。

## P1 拆分职责

- [x] 抽出 `protocol`：WebSocket 消息、状态枚举、请求/响应类型（`src/protocol.ts`）。
- [x] 抽出 `session-store`：`sessions.json` 的读取、原子写入（`src/session-store.ts`）。
- [x] 抽出 `session-manager`：`attached` / `detached` / `draft` 状态与持久化（`src/session-manager.ts`）。
- [x] 抽出 `browser-bridge`：连接、广播、请求/响应等待（`src/browser-bridge.ts`）。
- [x] `extension.js` 只保留激活、命令、消息路由和编辑器事件；会话编排抽到 `lib/session-controller.js`。
- [x] `lib/language.js` 拆成配置加载、转换、语义高亮、定义跳转（`lib/language/*`）。
- [x] 为 session 状态与持久化补单元测试（`test/session-manager.test.mjs`）。

## P2 迁移 TypeScript

- [x] 添加 TypeScript 工具链（`tsconfig.json`，Node16/CJS 输出到 `out/`）。
- [x] 先迁 `protocol`、`session-store`。
- [x] 迁 `session-manager`。
- [ ] 迁 `wiki`。
- [ ] 再迁 `extension`、`lib/language`。
- [ ] 保持 `node_modules` 外部依赖，不对 `wikiparser-node` 做单文件打包。
- [ ] 浏览器端 IPE 插件继续使用 JavaScript。

## P3 其他

- [ ] 统一定位与语言服务的 AST 解析，避免同一文档重复 parse。
- [ ] 更新 README、版本说明和发布流程。

## 已实现，不再跟踪

- [x] 断电/重启后恢复未完成的编辑：已改为 `sessions.json` + `draft` 自动恢复。
- [x] 浏览器刷新后自动恢复编辑态。
- [x] 编辑器关闭后保留草稿并允许恢复。
