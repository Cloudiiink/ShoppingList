import { recoverPool } from "./recovery";
import type { SqlDb } from "./types";

/**
 * 手工事务的统一入口与锁自愈（issue #10 及 e2e 排查产物）。
 *
 * 背景：tauri-plugin-sql 底层是 sqlx 连接池，且连接释放是在 Rust 异步任务里
 * 完成的——JS 侧 await 拿到结果时，连接可能还没回到空闲队列，下一次 acquire
 * 会新开连接（CI 实测：FD 证据 + 语句跨连接轮转）。一旦池里 ≥2 条连接，
 * 手工 BEGIN…COMMIT 的语句会 FIFO 轮转到不同连接上，系统性报
 * database is locked / no such table。
 *
 * 两层防御：
 * 1. withLockRetry：可恢复错误（锁、悬挂事务）退避重放整个操作；
 *    第 2 次仍失败 → recoverPool() 关池重建（实测必释放锁源）。
 * 2. executeBatch：能静态拼出的整个事务（含 BEGIN/COMMIT）打成**一条**
 *    多语句 execute——sqlx-sqlite 会在单连接上顺序执行全部语句，一次
 *    acquire 完成整个事务，轮转/释放迟滞都无从发生。（仅限无参数绑定的
 *    场景；better-sqlite3 的 exec 也不收绑定参数。）
 */

const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isLockError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("database is locked") || m.includes("database table is locked");
}

/** 可恢复的数据库错误：锁冲突，或上一条被打断的事务留下的悬挂事务 */
function isRecoverableDbError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return isLockError(e) || m.includes("cannot start a transaction");
}

/** 可恢复错误退避重放；持续失败触发池级恢复。fn 必须可整体重放 */
export async function withLockRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRecoverableDbError(e)) throw e;
      if (attempt === 2) await recoverPool();
      if (attempt < MAX_ATTEMPTS) await sleep(150 * attempt);
    }
  }
  throw lastErr;
}

/** 多语句事务：fn 内全部语句走同一 db（serialize 串行化保证单连接） */
export async function withTransaction<T>(
  db: SqlDb,
  fn: () => Promise<T>
): Promise<T> {
  return withLockRetry(async () => {
    await db.execute("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      await db.execute("COMMIT");
      return result;
    } catch (e) {
      // 尽力回滚：ROLLBACK 自身失败不能掩盖原始错误
      await db.execute("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}

/**
 * 单 execute 批量事务：sql 必须是含 BEGIN IMMEDIATE … COMMIT 的完整多语句串。
 * 失败时尽力 ROLLBACK（中止的批处理会在连接上留下未提交事务）。
 */
export async function executeBatch(
  db: SqlDb,
  sql: string,
  params: unknown[] = []
): Promise<unknown> {
  return withLockRetry(async () => {
    try {
      return await db.execute(sql, params);
    } catch (e) {
      await db.execute("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
