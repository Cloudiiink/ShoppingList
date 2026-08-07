/**
 * 池级恢复注册表：避免 transaction.ts ↔ connection.ts 循环依赖。
 * connection.ts 在 initDb 时注册 recoverPool；事务层在锁错误持续时调用。
 */

let recoverer: (() => Promise<void>) | null = null;

export function registerRecoverer(fn: () => Promise<void>): void {
  recoverer = fn;
}

/** 关池重建（释放池连接持有的一切锁/悬挂事务）；未注册时（测试环境）为 no-op */
export async function recoverPool(): Promise<void> {
  await recoverer?.();
}
