import Database from "@tauri-apps/plugin-sql";
import type { SqlDb } from "./types";

/**
 * 备份（§6.5）：VACUUM INTO 秒级命名 → integrity_check → 删旧保留 2 份。
 * 文件枚举/删除在 UI 层经 @tauri-apps/plugin-fs（scope 限应用目录）。
 */

/** 秒级时间戳文件名，防连点撞名 */
export function backupFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `tracker-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db.backup`;
}

export function isBackupFile(name: string): boolean {
  return /^tracker-\d{8}-\d{6}\.db\.backup$/.test(name);
}

/** 名称含时间戳，字典序 = 时间序；返回超出保留数的旧文件（新的在前） */
export function pruneTargets(names: string[], keep: number): string[] {
  const sorted = names.filter(isBackupFile).sort().reverse();
  return sorted.slice(keep);
}

/** 第 1 步：VACUUM INTO 生成一致性快照 */
export async function createSnapshot(db: SqlDb, absPath: string): Promise<void> {
  // VACUUM INTO 不支持参数绑定；路径来自应用目录 + 固定格式文件名，安全
  await db.execute(`VACUUM INTO '${absPath.replace(/'/g, "''")}'`);
}

/** 第 2 步：新快照完整性校验，失败抛错（调用方删快照、不动旧备份） */
export async function checkSnapshot(absPath: string): Promise<void> {
  const conn = await Database.load(`sqlite:${absPath}`);
  try {
    const rows = await conn.select<{ integrity_check: string }[]>(
      "PRAGMA integrity_check"
    );
    if (rows[0]?.integrity_check !== "ok") {
      throw new Error(`快照完整性校验失败: ${rows[0]?.integrity_check}`);
    }
  } finally {
    await conn.close();
  }
}
