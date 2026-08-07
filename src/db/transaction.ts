import { recoverPool } from "./recovery";
import type { SqlDb } from "./types";

/**
 * 手工多语句事务的统一入口（BEGIN IMMEDIATE … COMMIT）。
 *
 * 为什么需要重试与池恢复：tauri-plugin-sql 底层是 sqlx 连接池，CI 上
 * 反复观察到锁错误（database is locked，WAL 模式下写锁互斥）。锁源未
 * 完全定位，但实测「关闭并重建连接池」必然释放——据此设计两级恢复：
 * 1. 瞬时锁：退避重试整个事务（BEGIN 可重入，fn 必须幂等可重放）
 * 2. 持续锁（第 2 次仍失败）：recoverPool() 关池重建后再试
 *
 * 注意：fn 内的所有语句必须走同一个 db（serialize 串行化保证单连接），
 * 且 fn 必须是纯重放安全的（失败回滚后可整体重跑）。
 */

const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isLockError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes("database is locked") || m.includes("database table is locked");
}

export async function withTransaction<T>(
  db: SqlDb,
  fn: () => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await db.execute("BEGIN IMMEDIATE");
      const result = await fn();
      await db.execute("COMMIT");
      return result;
    } catch (e) {
      lastErr = e;
      // 尽力回滚：ROLLBACK 自身失败不能掩盖原始错误
      await db.execute("ROLLBACK").catch(() => {});
      if (!isLockError(e)) throw e;
      if (attempt === 2) await recoverPool();
      if (attempt < MAX_ATTEMPTS) await sleep(150 * attempt);
    }
  }
  throw lastErr;
}
