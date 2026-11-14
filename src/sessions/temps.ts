import fs from 'node:fs';
import path from 'node:path';

/** Session temp files: `<title>.<yyyyMMdd-HHmmss>.wiki`. */
const TEMP_NAME = /\.\d{8}-\d{6}\.wiki$/u;
/** Section-editing leftovers: `<title>.s<N>.<yyyyMMdd-HHmmss>.wiki`. */
const LEGACY_SECTION_NAME = /\.s(?:\d+|new)\.\d{8}-\d{6}\.wiki$/u;

/** Ignore files created recently; a live session may still be registering. */
const MIN_AGE_MS = 60_000;

/**
 * Delete temp files under the session root that no session references.
 * Only files matching the temp naming scheme are touched, and only once they
 * are old enough that no in-flight session can own them.
 */
export async function removeOrphanTemps(
  root: string | undefined,
  keep: Iterable<string>,
): Promise<string[]> {
  if (!root) return [];
  const keepPaths = new Set(keep);
  const removed: string[] = [];
  let hosts: fs.Dirent[];
  try {
    hosts = await fs.promises.readdir(root, {withFileTypes: true});
  } catch {
    return removed;
  }
  for (const host of hosts) {
    if (!host.isDirectory()) continue;
    const dir = path.join(root, host.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !TEMP_NAME.test(file.name)) continue;
      if (LEGACY_SECTION_NAME.test(file.name)) continue;
      const fsPath = path.join(dir, file.name);
      if (keepPaths.has(fsPath)) continue;
      try {
        const stat = await fs.promises.stat(fsPath);
        if (Date.now() - stat.mtimeMs < MIN_AGE_MS) continue;
        await fs.promises.unlink(fsPath);
        removed.push(fsPath);
      } catch {}
    }
  }
  return removed;
}
