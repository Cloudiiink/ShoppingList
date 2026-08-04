import Database from "@tauri-apps/plugin-sql";
import { migrate } from "./migrate";

/**
 * 启动序列（设计文档 §8，写死不得乱序）：
 * 1. main.rs 注册 tauri-plugin-sql（Rust 侧，无自定义 command）
 * 2. Database.load 单例（自动落 App Support 目录，全程复用同一连接）
 * 3. 执行并验证 PRAGMA foreign_keys = ON
 * 4. migrate（user_version 顺序迁移，单事务）
 * 5. 就绪渲染主界面
 *
 * 本模块覆盖 2-4；任一步失败抛错，由 App 层阻止进入主界面。
 */

let db: Database | null = null;

export async function initDb(): Promise<Database> {
  if (db) return db;

  // Step 2: load 单例
  const conn = await Database.load("sqlite:tracker.db");

  // Step 3: 外键开启并验证（connection-local，必须确认生效）
  await conn.execute("PRAGMA foreign_keys = ON");
  const rows = await conn.select<{ foreign_keys: number }[]>(
    "PRAGMA foreign_keys"
  );
  if (rows[0]?.foreign_keys !== 1) {
    throw new Error("PRAGMA foreign_keys = ON 未生效");
  }

  // Step 4: 迁移
  await migrate(conn);

  db = conn;
  return conn;
}

/** 已初始化后取用；未初始化抛错（调用方必须先过 initDb） */
export function getDb(): Database {
  if (!db) throw new Error("数据库未初始化：请先 await initDb()");
  return db;
}
