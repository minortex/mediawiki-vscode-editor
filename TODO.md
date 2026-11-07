# TODO

- [ ] 断电/重启后恢复未完成的编辑：把会话元数据（页面名、section、revid、basetimestamp、临时文件路径）落盘，浏览器重新连上时提供“恢复上次编辑”入口。
- [ ] 编辑冲突时展示 diff：收到 `editconflict` 后拉取线上当前版本，与本地草稿做对比，用 VS Code 的 diff 视图或浏览器内对比展示。
