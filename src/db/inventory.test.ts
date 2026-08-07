import { describe, it, expect, beforeEach } from "vitest";
import { createOrder, changeStatus } from "./orders";
import { convertStockToCustomer } from "./inventory";
import { createBatch } from "./batches";
import { freshDb, seedSites } from "./testUtils";
import type { SqlDb } from "./types";

let db: SqlDb;

beforeEach(async () => {
  db = await freshDb();
  await seedSites(db, "JAYD");
});

const stockInput = {
  order_type: "stock" as const,
  product_name: "囤货商品",
  site_id: 1,
  buy_price_cny: 2000,
};

describe("convertStockToCustomer", () => {
  it("in_stock → customer paid_pending_ship，写 converted_from_stock_at", async () => {
    const s = await createOrder(db, stockInput);
    const c = await convertStockToCustomer(db, s.id, {
      buyer_wechat: "wx999",
      sell_price_cny: 3500,
    });
    expect(c.order_type).toBe("customer");
    expect(c.status).toBe("paid_pending_ship");
    expect(c.buyer_wechat).toBe("wx999");
    expect(c.sell_price_cny).toBe(3500);
    expect(c.converted_from_stock_at).not.toBeNull();
    // 成本与购买日锁定不变
    expect(c.buy_price_cny).toBe(2000);
    expect(c.ordered_at).toBe(s.ordered_at);
  });

  it("listed 可转", async () => {
    const s = await createOrder(db, stockInput);
    await changeStatus(db, s.id, "listed");
    const c = await convertStockToCustomer(db, s.id, {
      buyer_wechat: "wx",
      sell_price_cny: 3000,
    });
    expect(c.status).toBe("paid_pending_ship");
  });

  it("consumed 可转且清 closed_at", async () => {
    const s = await createOrder(db, stockInput);
    await changeStatus(db, s.id, "consumed");
    const consumed = await changeStatus(db, s.id, "consumed").catch(() => null);
    void consumed;
    const c = await convertStockToCustomer(db, s.id, {
      buyer_wechat: "wx",
      sell_price_cny: 3000,
    });
    expect(c.closed_at).toBeNull();
    expect(c.order_type).toBe("customer");
  });

  it("lost 不可转（需先回退 in_stock）", async () => {
    const s = await createOrder(db, stockInput);
    await changeStatus(db, s.id, "lost");
    await expect(
      convertStockToCustomer(db, s.id, { buyer_wechat: "wx", sell_price_cny: 3000 })
    ).rejects.toThrow(/lost|回退/);
  });

  it("customer 单不可转", async () => {
    const o = await createOrder(db, {
      order_type: "customer",
      product_name: "p",
      site_id: 1,
      buyer_wechat: "wx",
      sell_price_cny: 100,
    });
    await expect(
      convertStockToCustomer(db, o.id, { buyer_wechat: "wx2", sell_price_cny: 200 })
    ).rejects.toThrow();
  });

  it("缺买家/卖出价拒绝", async () => {
    const s = await createOrder(db, stockInput);
    await expect(
      convertStockToCustomer(db, s.id, { buyer_wechat: "", sell_price_cny: 3000 })
    ).rejects.toThrow();
    await expect(
      convertStockToCustomer(db, s.id, { buyer_wechat: "wx", sell_price_cny: null as unknown as number })
    ).rejects.toThrow();
  });

  it("转入带团校验（纯人民币囤货不能入团）", async () => {
    const b = await createBatch(db, { name: "202608-JAYD 一团", site_id: 1, currency: "AUD" });
    const s = await createOrder(db, stockInput); // 无外币成本
    await expect(
      convertStockToCustomer(db, s.id, {
        buyer_wechat: "wx",
        sell_price_cny: 3000,
        batch_id: b.id,
      })
    ).rejects.toThrow(/外币/);

    // 有匹配外币成本则可以
    const s2 = await createOrder(db, {
      ...stockInput,
      cost_foreign_amount: 5000,
      cost_currency: "AUD",
    });
    const c = await convertStockToCustomer(db, s2.id, {
      buyer_wechat: "wx",
      sell_price_cny: 3000,
      batch_id: b.id,
    });
    expect(c.batch_id).toBe(b.id);
  });
});
