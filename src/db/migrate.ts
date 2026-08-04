import Database from "@tauri-apps/plugin-sql";

/**
 * user_version 顺序迁移（设计文档 §3.5）：
 * - 每个迁移脚本在单事务内执行，user_version = N 作为事务最后一步提交
 * - 任一步失败整体回滚，向外抛错（启动序列阻止进入主界面）
 *
 * Ticket #2 将加入 v1 建表迁移。
 */
export async function migrate(db: Database): Promise<void> {
  const rows = await db.select<{ user_version: number }[]>(
    "PRAGMA user_version"
  );
  const current = rows[0]?.user_version ?? 0;
  void current;
  // 占位：无迁移脚本
}
