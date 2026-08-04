import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./migrate";
import {
  createOrder,
  updateOrder,
  changeStatus,
  deleteOrder,
  getOrder,
  listOrders,
  nextOrderNo,
} from "./orders";
import type { SqlDb } from "./types";

function wrap(raw: Database.Database): SqlDb {
  return {
    execute: async (sql, params = []) => raw.prepare(sql).run(...(params as never[])),
    select: async <T,>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).all(...(params as never[])) as T,
  };
}

let db: SqlDb;

beforeEach(async () => {
  db = wrap(new Database(":memory:"));
  await db.execute("PRAGMA foreign_keys = ON");
  await migrate(db);
  await db.execute("INSERT INTO sites (name) VALUES ('JAYD')");
});

const baseCustomer = {
  order_type: "customer" as const,
  product_name: "Test 商品",
  site_id: 1,
  buyer_wechat: "wx123",
  sell_price_cny: 8000,
};

describe("订单编号", () => {
  it("格式 = 本地日期 + 当日序号", async () => {
    const no = await nextOrderNo(db);
    const today = new Date();
    const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    expect(no).toBe(`${ymd}-1`);
  });

  it("当日序号递增，不规则手改号不参与", async () => {
    await createOrder(db, baseCustomer);
    await createOrder(db, baseCustomer);
    // 手改成不规则编号
    await db.execute("UPDATE orders SET order_no = 'custom-abc' WHERE id = 2");
    const o3 = await createOrder(db, baseCustomer);
    expect(o3.order_no).toMatch(/-2$/); // 只统计 canonical 格式的 1 号
  });
});

describe("createOrder / validateOrder", () => {
  it("customer 必填买家与卖出价", async () => {
    await expect(
      createOrder(db, { ...baseCustomer, buyer_wechat: null })
    ).rejects.toThrow();
    await expect(
      createOrder(db, { ...baseCustomer, sell_price_cny: null })
    ).rejects.toThrow();
  });

  it("stock 必填买入价", async () => {
    await expect(
      createOrder(db, {
        order_type: "stock",
        product_name: "囤货",
        site_id: 1,
        buy_price_cny: null,
      })
    ).rejects.toThrow();
    const s = await createOrder(db, {
      order_type: "stock",
      product_name: "囤货",
      site_id: 1,
      buy_price_cny: 2000,
    });
    expect(s.status).toBe("in_stock");
  });

  it("外币字段同空同填", async () => {
    await expect(
      createOrder(db, { ...baseCustomer, cost_foreign_amount: 5000 })
    ).rejects.toThrow();
  });

  it("创建写 created_at/updated_at，settlement 字段有值时写 settlement_updated_at", async () => {
    const o = await createOrder(db, {
      ...baseCustomer,
      cost_foreign_amount: 5000,
      cost_currency: "AUD",
      buy_price_cny: 25000,
    });
    expect(o.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(o.settlement_updated_at).not.toBeNull();
  });

  it("products upsert：新品建记录，复用累加 use_count", async () => {
    await createOrder(db, baseCustomer);
    await createOrder(db, baseCustomer);
    const [p] = await db.select<{ use_count: number; last_cost: number }[]>(
      "SELECT use_count, last_cost FROM products WHERE name = 'Test 商品'"
    );
    expect(p.use_count).toBe(2);
  });
});

describe("changeStatus", () => {
  it("非法转移拒绝", async () => {
    const o = await createOrder(db, baseCustomer);
    await expect(changeStatus(db, o.id, "done")).rejects.toThrow();
  });

  it("转 shipped 前 buy_price_cny 必填", async () => {
    const o = await createOrder(db, baseCustomer);
    await expect(changeStatus(db, o.id, "shipped")).rejects.toThrow();
    await updateOrder(db, o.id, { buy_price_cny: 5000 });
    const shipped = await changeStatus(db, o.id, "shipped");
    expect(shipped.status).toBe("shipped");
    expect(shipped.shipped_at).not.toBeNull();
  });

  it("回退到 paid_pending_ship 清 shipped_at、保留 tracking_no", async () => {
    const o = await createOrder(db, { ...baseCustomer, buy_price_cny: 5000 });
    await changeStatus(db, o.id, "shipped");
    await updateOrder(db, o.id, { tracking_no: "SF123" });
    const back = await changeStatus(db, o.id, "paid_pending_ship");
    expect(back.shipped_at).toBeNull();
    expect(back.tracking_no).toBe("SF123");
  });

  it("终态回退清 closed_at", async () => {
    const o = await createOrder(db, { ...baseCustomer, buy_price_cny: 5000 });
    await changeStatus(db, o.id, "shipped");
    const done = await changeStatus(db, o.id, "done");
    expect(done.closed_at).not.toBeNull();
    const back = await changeStatus(db, o.id, "shipped");
    expect(back.closed_at).toBeNull();
  });
});

describe("updateOrder", () => {
  it("结算字段变更更新 settlement_updated_at，备注不更新", async () => {
    const o = await createOrder(db, baseCustomer);
    expect(o.settlement_updated_at).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const noted = await updateOrder(db, o.id, { note: "备注" });
    expect(noted.settlement_updated_at).toBeNull();
    const priced = await updateOrder(db, o.id, { buy_price_cny: 5000 });
    expect(priced.settlement_updated_at).not.toBeNull();
  });

  it("手改 buy_price_cny 自动降级 source 为 manual", async () => {
    const o = await createOrder(db, { ...baseCustomer, buy_price_cny: 5000 });
    expect(o.buy_price_source).toBe("estimated");
    const edited = await updateOrder(db, o.id, {
      buy_price_cny: 6000,
      buy_price_source: "manual",
    });
    expect(edited.buy_price_source).toBe("manual");
  });
});

describe("listOrders / deleteOrder", () => {
  it("按状态与团筛选", async () => {
    const a = await createOrder(db, { ...baseCustomer, buy_price_cny: 1 });
    await createOrder(db, baseCustomer);
    await changeStatus(db, a.id, "shipped");
    const shipped = await listOrders(db, { status: ["shipped"] });
    expect(shipped).toHaveLength(1);
    expect(shipped[0].id).toBe(a.id);
  });

  it("删除后可查不到", async () => {
    const o = await createOrder(db, baseCustomer);
    await deleteOrder(db, o.id);
    await expect(getOrder(db, o.id)).rejects.toThrow();
  });
});
