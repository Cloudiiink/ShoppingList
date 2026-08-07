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
 *
 * 韧性设计（e2e 排查产物）：
 * - 每次尝试先无条件 ROLLBACK：若上一个 JS 上下文死于 BEGIN…COMMIT 之间
 *   （页面刷新/导航），池连接上会挂着未提交事务并持写锁；新上下文能启动
 *   意味着旧上下文已死，其事务必为孤儿，回滚安全。无事务时 ROLLBACK 报错，忽略。
 * - 失败重试：CI 上观察到首次启动偶发 database is locked（锁源未完全定位，
 *   疑似 sqlx create_database/PAL 的瞬时竞争），重试可自愈。
 */

let db: SqlDb | null = null;

const MAX_ATTEMPTS = 5;

/** [临时诊断] 启动步骤落 localStorage，e2e 可读（UI 失败页无法展示细节） */
function bootLog(entry: Record<string, unknown>): void {
  try {
    const log = JSON.parse(
      localStorage.getItem("ot-boot-steps") ?? "[]"
    ) as unknown[];
    log.push({ t: Date.now(), ...entry });
    localStorage.setItem("ot-boot-steps", JSON.stringify(log));
  } catch {
    /* 非浏览器环境（单测）静默 */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function initDb(): Promise<SqlDb> {
  if (db) return db;

  // Step 2: load 单例 + 串行化
  const conn = serialize(await Database.load("sqlite:tracker.db"));

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 清理上一上下文可能遗留的悬挂事务（见文件头注释）
      await conn.execute("ROLLBACK").catch(() => {});

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

      bootLog({ attempt, ok: true });
      db = conn;
      return conn;
    } catch (e) {
      lastErr = e;
      bootLog({
        attempt,
        ok: false,
        err: e instanceof Error ? e.message : String(e),
      });
      if (attempt < MAX_ATTEMPTS) await sleep(1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
