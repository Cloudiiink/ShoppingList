import type { SqlDb } from "./types";

/** 支持池级恢复（recoverPool 换新连接后切换 inner）的串行化 SqlDb */
export interface SerializedDb extends SqlDb {
  swapInner(next: SqlDb): void;
}

/**
 * 串行化适配器（issue #10 Bug B）：promise-chain 互斥锁包住 SqlDb。
 *
 * 原理：tauri-plugin-sql 底层是 sqlx `Pool::connect` 默认配置（连接懒加载，
 * 只在所有现有连接都忙时才开新连接）。串行化保证任意时刻最多 1 条查询在飞
 * → 池永远只用第 1 条物理连接 → db/ 层手工 BEGIN IMMEDIATE…COMMIT 多语句事务
 * 与 connection-local 的 PRAGMA foreign_keys = ON 都稳定落在同一条连接上。
 *
 * select 也必须排队：VACUUM INTO / BEGIN IMMEDIATE 与并发 select 同样会抢连接。
 */
export function serialize(initial: SqlDb): SerializedDb {
  let inner = initial;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    // 吞掉错误再续链：一条语句失败不能毒化后续所有排队查询。
    // 尾部追加 1ms 间隙：sqlx 的归连是在 Rust 侧独立任务里完成的，
    // 若下一次 acquire 抢在归还完成前发生，池就会多开一条连接
    // （CI 实测根因：FD 证据 + 语句跨连接轮转 → 手工事务被拆散报
    // database is locked / no such table）。1ms 窗口让归还先完成。
    tail = result.then(
      () => new Promise<void>((r) => setTimeout(r, 1)),
      () => new Promise<void>((r) => setTimeout(r, 1))
    );
    return result;
  };
  return {
    execute: (sql, params) => enqueue(() => inner.execute(sql, params)),
    select: <T,>(sql: string, params?: unknown[]) =>
      enqueue(() => inner.select<T>(sql, params)),
    // 仅在无在飞语句时调用（withTransaction 的恢复路径满足此约束）
    swapInner(next: SqlDb) {
      inner = next;
    },
  };
}
