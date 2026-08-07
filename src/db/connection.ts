import Database from "@tauri-apps/plugin-sql";
import { migrate } from "./migrate";
import { serialize } from "./serialize";
import type { SqlDb } from "./types";

/**
 * 启动序列（设计文档 §8，写死不得乱序）：
 * 1. main.rs 注册 tauri-plugin-sql（Rust 侧，无自定义 command）
 * 2. Database.load 单例（自动落 App Support 目录，全程复用同一连接）
 *    → 立即包 serialize()（issue #10：逼 sqlx 池只用一条物理连接，
 *      手工事务与 connection-local PRAGMA 才安全）
 * 3. 执行并验证 PRAGMA foreign_keys = ON
 * 4. migrate（user_version 顺序迁移，单事务）
 * 5. 就绪渲染主界面
 *
 * 本模块覆盖 2-4；任一步失败抛错，由 App 层阻止进入主界面。
 */

let db: SqlDb | null = null;

export async function initDb(): Promise<SqlDb> {
  if (db) return db;

  // Step 2: load 单例 + 串行化
  const conn = serialize(await Database.load("sqlite:tracker.db"));

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
