import type { ProductRow, SqlDb } from "./types";

export async function searchProducts(db: SqlDb, prefix: string): Promise<ProductRow[]> {
  return db.select<ProductRow[]>(
    "SELECT * FROM products WHERE name LIKE ? ORDER BY use_count DESC LIMIT 8",
    [`%${prefix}%`]
  );
}
