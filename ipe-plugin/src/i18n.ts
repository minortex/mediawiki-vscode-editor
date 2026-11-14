/**
 * Translation table for the VSCode editor InPageEdit plugin.
 *
 * Keys are the English source strings used in `index.ts`; values are the
 * Simplified Chinese translations. `{{ $1 }}`-style placeholders must match
 * the source string exactly.
 */
export const messages: Record<string, string> = {
  'VSCode has unsaved changes; save the file first (Ctrl+S)':
    'VSCode 里有未保存修改，先保存文件（Ctrl+S）',
  'Submitting…': '正在提交…',
  'Editing in VSCode': 'VSCode 编辑中',
  'Edit summary': '编辑摘要',
  'Follow MediaWiki preference': '遵循 MW 首选',
  'Keep current status': '保持当前状态',
  'Add to watchlist': '添加到监视列表',
  'Remove from watchlist': '从监视列表移除',
  'Minor edit': '小编辑',
  'More': '更多功能',
  'Watchlist': '关注状态',
  'Submit': '提交',
  'Diff': '差异',
  'Quick upload': '快速上传',
  'Templates used': '使用的模板',
  'Images used': '使用的图片',
  'Cancel': '取消',
  'The site did not return siteinfo': '站点没有返回 siteinfo',
  'VSCode extension is not connected. Open VSCode and make sure the MediaWiki extension is installed and enabled.':
    'VSCode 扩展未连接。请手动打开 VSCode，并确认已安装并启用 MediaWiki 扩展。',
  'VSCode not connected': 'VSCode 未连接',
  'Open target page': '打开目标页面',
  'Popup blocked': '弹窗被拦截',
  'The popup was blocked; open the target page manually.':
    '弹窗被拦截，请手动打开目标页面。',
  'Page needs to be opened': '需要打开页面',
  'mw.util.getUrl is unavailable': 'mw.util.getUrl 不可用',
  'Extension did not respond to site registration': '扩展未响应站点注册',
  'Site registration failed': '站点注册失败',
  'Site registration failed: {{ $1 }}': '站点注册失败：{{ $1 }}',
  'The extension no longer has this session; editing has been closed.':
    '扩展没有该会话，已退出编辑态。',
  'Session ended': '会话已结束',
  'Editing in VSCode; save the file to refresh the preview':
    'VSCode 编辑中，保存文件即刷新预览',
  'Exited editing mode.': '已退出编辑状态。',
  'Editor closed': '编辑器已关闭',
  'Editing continued in another tab.': '已在另一个标签继续编辑。',
  'Session transferred': '会话已转移',
  'Preview failed: {{ $1 }}': '预览失败：{{ $1 }}',
  'Edit conflict detected; conflict markers are loaded. Resolve them before submitting.':
    '检测到编辑冲突，已载入冲突标记；处理后再提交',
  'Preview updated at {{ $1 }}': '预览已更新 {{ $1 }}',
  'Extension did not respond to the session query': '扩展未响应会话查询',
  'Extension not connected': '扩展未连接',
  'Session query failed': '会话查询失败',
  'Failed to resume the session: {{ $1 }}': '恢复会话失败：{{ $1 }}',
  'Resumed the VSCode editing session': '已恢复 VSCode 编辑会话',
  'This page is already being edited in another browser window or VSCode session. Close that session first.':
    '该页面已经在另一个浏览器窗口或 VSCode 编辑会话中。请先关闭那边的编辑会话后再试。',
  'Page already being edited': '页面已在编辑中',
  'Unable to read the current page title': '无法读取当前页面标题',
  'Failed to start editing: {{ $1 }}. Make sure the VSCode extension is running and the web plugin is up to date.':
    '启动编辑失败：{{ $1 }}。请确认 VSCode 扩展已启动并已更新网页端脚本。',
  'Failed to start editing': '启动编辑失败',
  'No images are used.': '没有使用的图片。',
  'VSCode still has unsaved changes. Discard them and close the editor?':
    'VSCode 里还有未保存的修改，放弃并关闭编辑器？',
  'There are changes not yet saved to the site. Discard them?':
    '还有未提交到站点的修改，确定放弃？',
  'Saving the file…': '正在保存文件…',
  'The page was changed by someone else.': '页面已被其他人修改。',
  'Saved; reloading and waiting for confirmation…':
    '已保存，正在刷新并等待确认…',
  'The save was submitted but no revision id could be confirmed; the temp file was kept':
    '提交已完成，但未能确认修订版本号；临时文件已保留',
  'Save unconfirmed: {{ $1 }}': '保存未确认：{{ $1 }}',
  'Save failed: {{ $1 }}': '保存失败：{{ $1 }}',
  'Edit the whole page in VSCode': '在 VSCode 中编辑整页',
}
