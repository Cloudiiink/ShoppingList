import { appConfigDir, join } from "@tauri-apps/api/path";
import { writeFile, remove, BaseDirectory } from "@tauri-apps/plugin-fs";
import { switchDb } from "@/db/connection";
import { doBackup } from "./backupFiles";
import type { SqlDb } from "@/db/types";

export type ImportMode = "replace" | "preview";

const MAIN_FILE = "tracker.db";
const PREVIEW_FILE = "tracker.preview.db";

/**
 * 导入 / 临时加载数据库文件（把 `<input type="file">` 读到的字节写入应用目录后切换）。
 * - replace：先自动备份当前库，再覆盖 tracker.db（持久，重启仍用）
 * - preview：写入 tracker.preview.db（临时，重启仍用 tracker.db，启动时清理）
 */
export async function importDatabase(
  file: File,
  mode: ImportMode,
  db: SqlDb
): Promise<SqlDb> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mode === "replace") {
    await doBackup(db); // 替换前自动备份当前库（含 integrity_check）
    await writeFile(MAIN_FILE, bytes, { baseDir: BaseDirectory.AppConfig });
    return switchDb(await join(await appConfigDir(), MAIN_FILE));
  }
  await writeFile(PREVIEW_FILE, bytes, { baseDir: BaseDirectory.AppConfig });
  return switchDb(await join(await appConfigDir(), PREVIEW_FILE));
}

/** 启动时清理陈旧的临时加载文件（失败忽略） */
export async function cleanPreviewFile(): Promise<void> {
  await remove(PREVIEW_FILE, { baseDir: BaseDirectory.AppConfig }).catch(() => {});
}
