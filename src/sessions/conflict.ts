/**
 * 把本地文本与站点最新文本合成 Git 风格的冲突块。
 * 相同的前后缀只保留一份，只有真正不同的行进入冲突标记。
 */
export function markConflict(
  local: string,
  remote: string,
  remoteLabel: string,
): string {
  if (local === remote) return local;
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');
  let start = 0;
  while (
    start < localLines.length &&
    start < remoteLines.length &&
    localLines[start] === remoteLines[start]
  ) {
    start++;
  }
  let end = 0;
  while (
    end < localLines.length - start &&
    end < remoteLines.length - start &&
    localLines[localLines.length - 1 - end] ===
      remoteLines[remoteLines.length - 1 - end]
  ) {
    end++;
  }
  const prefix = localLines.slice(0, start);
  const suffix = localLines.slice(localLines.length - end);
  const localMiddle = localLines.slice(start, localLines.length - end).join('\n');
  const remoteMiddle = remoteLines.slice(start, remoteLines.length - end).join('\n');
  return [
    ...prefix,
    '<<<<<<< VSCode 本地版本',
    localMiddle,
    '=======',
    remoteMiddle,
    `>>>>>>> ${remoteLabel}`,
    ...suffix,
  ].join('\n');
}
