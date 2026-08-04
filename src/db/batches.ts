import type { BatchRow, SqlDb } from "./types";

export async function listBatches(db: SqlDb): Promise<BatchRow[]> {
  return db.select<BatchRow[]>("SELECT * FROM batches ORDER BY created_at DESC, id DESC");
}

export async function getBatch(db: SqlDb, id: number): Promise<BatchRow> {
  const rows = await db.select<BatchRow[]>("SELECT * FROM batches WHERE id = ?", [id]);
  if (!rows[0]) throw new Error(`团 #${id} 不存在`);
  return rows[0];
}
