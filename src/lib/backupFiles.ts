import { appConfigDir, join } from "@tauri-apps/api/path";
import { readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import {
  backupFileName,
  checkSnapshot,
  createSnapshot,
  isBackupFile,
  pruneTargets,
} from "@/db/backup";
import type { SqlDb } from "@/db/types";

/** 列出全部备份文件名（新的在前） */
export async function listBackups(): Promise<string[]> {
  const entries = await readDir(".", { baseDir: BaseDirectory.AppConfig });
  return entries
    .filter((e) => e.isFile && isBackupFile(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** 最新备份距今天数；无备份返回 null */
export async function newestBackupAgeDays(): Promise<number | null> {
  const backups = await listBackups();
  if (backups.length === 0) return null;
  const info = await stat(backups[0], { baseDir: BaseDirectory.AppConfig });
  if (!info.mtime) return null;
  return (Date.now() - info.mtime.getTime()) / 86_400_000;
}

/**
 * 「立即备份」三步流程（§6.5）：
 * 1. VACUUM INTO 秒级命名快照
 * 2. integrity_check，失败删快照报错、不动旧备份
 * 3. 校验通过后删旧保留最新 2 份
 */
export async function doBackup(db: SqlDb): Promise<string> {
  const dir = await appConfigDir();
  const name = backupFileName(new Date());
  // appConfigDir() 返回的路径不带结尾分隔符，必须用 join 拼接
  const abs = await join(dir, name);

  await createSnapshot(db, abs);
  try {
    await checkSnapshot(abs);
  } catch (e) {
    await remove(name, { baseDir: BaseDirectory.AppConfig }).catch(() => {});
    throw e;
  }

  const all = await listBackups();
  for (const old of pruneTargets(all, 2)) {
    await remove(old, { baseDir: BaseDirectory.AppConfig });
  }
  return name;
}
