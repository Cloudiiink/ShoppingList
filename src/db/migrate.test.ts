import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./migrate";
import { wrap } from "./testUtils";
import type { SqlDb } from "./types";

/** 裸库（不 migrate）——本文件测的就是 migrate 本身 */
function rawDb(): SqlDb {
  return wrap(new Database(":memory:"));
}

describe("migrate", () => {
  it("全新库：user_version 推进到最新版本，五表建成", async () => {
    const db = rawDb();
    await migrate(db);
    const [{ user_version }] = await db.select<{ user_version: number }[]>(
      "PRAGMA user_version"
    );
    expect(user_version).toBe(2);
    const tables = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orders','batches','products','sites','rates') ORDER BY name"
    );
    expect(tables.map((t) => t.name)).toEqual([
      "batches",
      "orders",
      "products",
      "rates",
      "sites",
    ]);
  });

  it("幂等：重复迁移不报错、版本不重复推进", async () => {
    const db = rawDb();
    await migrate(db);
    await migrate(db);
    const [{ user_version }] = await db.select<{ user_version: number }[]>(
      "PRAGMA user_version"
    );
    expect(user_version).toBe(2);
  });

  it("STRICT 生效：INTEGER 列写入非整数报错", async () => {
    const db = rawDb();
    await migrate(db);
    await db.execute(
      "INSERT INTO sites (name) VALUES ('JAYD')"
    );
    await db.execute(
      "INSERT INTO orders (order_no, order_type, status, product_name, site_id, ordered_at, buyer_wechat, sell_price_cny, created_at, updated_at) VALUES ('20260804-1','customer','paid_pending_ship','test',1,'2026-08-04T00:00:00.000Z','wx',100,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')"
    );
    await expect(
      db.execute("UPDATE orders SET buy_price_cny = 12.5 WHERE id = 1")
    ).rejects.toThrow();
  });

  it("adjustments 约束：NULL 与坏 JSON 被拒，缺省为 '[]'", async () => {
    const db = rawDb();
    await migrate(db);
    await db.execute("INSERT INTO sites (name) VALUES ('JAYD')");
    const cols =
      "(order_no, order_type, status, product_name, site_id, ordered_at, buyer_wechat, sell_price_cny, created_at, updated_at)";
    const vals =
      "('20260804-1','customer','paid_pending_ship','t',1,'2026-08-04T00:00:00.000Z','wx',100,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')";
    await db.execute(`INSERT INTO orders ${cols} VALUES ${vals}`);
    const [row] = await db.select<{ adjustments: string }[]>(
      "SELECT adjustments FROM orders WHERE id = 1"
    );
    expect(row.adjustments).toBe("[]");
    await expect(
      db.execute("UPDATE orders SET adjustments = NULL WHERE id = 1")
    ).rejects.toThrow();
    await expect(
      db.execute("UPDATE orders SET adjustments = 'not json' WHERE id = 1")
    ).rejects.toThrow();
    await expect(
      db.execute("UPDATE orders SET adjustments = '{}' WHERE id = 1")
    ).rejects.toThrow();
  });

  it("枚举域 CHECK：stock 单不允许 customer 状态", async () => {
    const db = rawDb();
    await migrate(db);
    await db.execute("INSERT INTO sites (name) VALUES ('JAYD')");
    await expect(
      db.execute(
        "INSERT INTO orders (order_no, order_type, status, product_name, site_id, ordered_at, buy_price_cny, created_at, updated_at) VALUES ('20260804-1','stock','done','t',1,'2026-08-04T00:00:00.000Z',100,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')"
      )
    ).rejects.toThrow();
  });

  it("条件不变量：customer 缺买家/卖出价被拒；stock 缺买入价被拒", async () => {
    const db = rawDb();
    await migrate(db);
    await db.execute("INSERT INTO sites (name) VALUES ('JAYD')");
    await expect(
      db.execute(
        "INSERT INTO orders (order_no, order_type, status, product_name, site_id, ordered_at, sell_price_cny, created_at, updated_at) VALUES ('20260804-1','customer','paid_pending_ship','t',1,'2026-08-04T00:00:00.000Z',100,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')"
      )
    ).rejects.toThrow(); // 缺 buyer_wechat
    await expect(
      db.execute(
        "INSERT INTO orders (order_no, order_type, status, product_name, site_id, ordered_at, created_at, updated_at) VALUES ('20260804-2','stock','in_stock','t',1,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')"
      )
    ).rejects.toThrow(); // 缺 buy_price_cny
  });

  it("外币字段同空同填", async () => {
    const db = rawDb();
    await migrate(db);
    await db.execute("INSERT INTO sites (name) VALUES ('JAYD')");
    await expect(
      db.execute(
        "INSERT INTO orders (order_no, order_type, status, product_name, site_id, ordered_at, buyer_wechat, sell_price_cny, cost_foreign_amount, created_at, updated_at) VALUES ('20260804-1','customer','paid_pending_ship','t',1,'2026-08-04T00:00:00.000Z','wx',100,5000,'2026-08-04T00:00:00.000Z','2026-08-04T00:00:00.000Z')"
      )
    ).rejects.toThrow(); // 有金额无币种
  });
});
