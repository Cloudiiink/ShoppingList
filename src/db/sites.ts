import type { SiteRow, SqlDb } from "./types";

export async function listSites(db: SqlDb): Promise<SiteRow[]> {
  return db.select<SiteRow[]>("SELECT * FROM sites ORDER BY name");
}

export async function createSite(
  db: SqlDb,
  name: string,
  color: string | null = null
): Promise<SiteRow> {
  await db.execute("INSERT INTO sites (name, color) VALUES (?, ?)", [name, color]);
  const rows = await db.select<SiteRow[]>("SELECT * FROM sites WHERE name = ?", [name]);
  return rows[0];
}

export async function updateSite(
  db: SqlDb,
  id: number,
  patch: { name?: string; color?: string | null }
): Promise<void> {
  const fields: [string, unknown][] = [];
  if (patch.name !== undefined) fields.push(["name", patch.name]);
  if (patch.color !== undefined) fields.push(["color", patch.color]);
  if (fields.length === 0) return;
  await db.execute(
    `UPDATE sites SET ${fields.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`,
    [...fields.map(([, v]) => v), id]
  );
}

/** 引用计数（删除保护提示用） */
export async function siteRefCount(db: SqlDb, id: number): Promise<number> {
  const [o] = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM orders WHERE site_id = ?", [id]
  );
  const [b] = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM batches WHERE site_id = ?", [id]
  );
  const [p] = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM products WHERE default_site_id = ?", [id]
  );
  return o.n + b.n + p.n;
}

/** 被订单/团/商品引用时禁止删除（RESTRICT），返回引用数提示 */
export async function deleteSite(db: SqlDb, id: number): Promise<void> {
  const refs = await siteRefCount(db, id);
  if (refs > 0) {
    throw new Error(`该网站被 ${refs} 条订单/团/商品引用，禁止删除`);
  }
  await db.execute("DELETE FROM sites WHERE id = ?", [id]);
}
