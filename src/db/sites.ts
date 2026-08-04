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
