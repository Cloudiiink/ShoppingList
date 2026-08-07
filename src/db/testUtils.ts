import Database from "better-sqlite3";
import { migrate } from "./migrate";
import type { SqlDb } from "./types";

/** better-sqlite3 包装成 SqlDb 接口（测试专用） */
export function wrap(raw: Database.Database): SqlDb {
  return {
    execute: async (sql, params = []) => {
      // 多语句批量（executeBatch）：与 sqlx 的单连接多语句迭代对齐。
      // 我们的批量 SQL 是静态文本——";" 不会出现在字符串字面量里，
      // "?" 只会是占位符，因此可以安全拆分并按顺序偏移绑定。
      const hasMultiple = sql.trim().replace(/;+\s*$/, "").includes(";");
      if (!hasMultiple) return raw.prepare(sql).run(...(params as never[]));
      if (params.length === 0) {
        raw.exec(sql);
        return { rowsAffected: 0, lastInsertId: 0 };
      }
      let offset = 0;
      for (const stmt of sql.split(";")) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        const n = (trimmed.match(/\?/g) ?? []).length;
        raw.prepare(trimmed).run(...(params.slice(offset, offset + n) as never[]));
        offset += n;
      }
      if (offset !== params.length) {
        throw new Error(`批量语句绑定数不匹配：用了 ${offset}，给了 ${params.length}`);
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    },
    select: async <T,>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).all(...(params as never[])) as T,
  };
}

/** 内存库 + 外键开启 + 完成迁移；站点等种子数据用 seedSites 按需加 */
export async function freshDb(): Promise<SqlDb> {
  const db = wrap(new Database(":memory:"));
  await db.execute("PRAGMA foreign_keys = ON");
  await migrate(db);
  return db;
}

/** 插入站点种子，返回首站点 id（单站点场景方便直接用） */
export async function seedSites(db: SqlDb, ...names: string[]): Promise<number> {
  const list = names.length > 0 ? names : ["JAYD"];
  for (const name of list) {
    await db.execute("INSERT INTO sites (name) VALUES (?)", [name]);
  }
  const rows = await db.select<{ id: number }[]>(
    "SELECT MIN(id) AS id FROM sites"
  );
  return rows[0]!.id;
}
