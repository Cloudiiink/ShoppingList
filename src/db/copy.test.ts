import { describe, it, expect, beforeEach } from "vitest";
import { copyOrdersAsStock, createOrder } from "./orders";
import { createBatch, updateBatch } from "./batches";
import { freshDb, seedSites } from "./testUtils";
import type { SqlDb } from "./types";

let db: SqlDb;
let siteId: number;

beforeEach(async () => {
  db = await freshDb();
  siteId = await seedSites(db, "JAYD");
});

describe("copyOrdersAsStock 一键复制", () => {
  it("stock 单复制 3 份：新订单号互不相同、字段保留/清空正确", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "囤货商品",
      product_note: "500ml",
      site_id: siteId,
      buy_price_cny: 2000,
      cost_foreign_amount: 4000,
      cost_currency: "AUD",
      exchange_rate: 4.7,
      shipping_fee: 500,
      note: "好用",
      adjustments: [{ kind: "cost", group: "关税", amount: 300 }],
    });
    const copies = await copyOrdersAsStock(db, src.id, 3);

    expect(copies).toHaveLength(3);
    expect(new Set(copies.map((c) => c.order_no)).size).toBe(3);
    expect(copies.every((c) => c.order_no !== src.order_no)).toBe(true);
    for (const c of copies) {
      expect(c.order_type).toBe("stock");
      expect(c.status).toBe("in_stock");
      expect(c.product_name).toBe("囤货商品");
      expect(c.product_note).toBe("500ml");
      expect(c.buy_price_cny).toBe(2000);
      expect(c.cost_foreign_amount).toBe(4000);
      expect(c.cost_currency).toBe("AUD");
      expect(c.exchange_rate).toBe(4.7);
      expect(c.note).toBe("好用");
      expect(JSON.parse(c.adjustments)).toEqual([{ kind: "cost", group: "关税", amount: 300 }]);
      // 清空项
      expect(c.shipping_fee).toBeNull();
      expect(c.sell_price_cny).toBeNull();
      expect(c.buyer_wechat).toBeNull();
      expect(c.tracking_no).toBeNull();
      expect(c.shipped_at).toBeNull();
      expect(c.closed_at).toBeNull();
    }
  });

  it("customer 单复制即转囤货单：买家/售价清空，revenue 调整丢弃", async () => {
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "代购商品",
      site_id: siteId,
      buyer_wechat: "wx-buyer",
      buyer_alias: "小王",
      region: "上海",
      sell_price_cny: 8000,
      buy_price_cny: 5000,
      shipping_fee: 1200,
      tracking_no: "SF123",
      adjustments: [
        { kind: "cost", group: "关税", amount: 300 },
        { kind: "revenue", group: "小费", amount: 100 },
      ],
    });
    const [c] = await copyOrdersAsStock(db, src.id, 1);

    expect(c!.order_type).toBe("stock");
    expect(c!.status).toBe("in_stock");
    expect(c!.buyer_wechat).toBeNull();
    expect(c!.buyer_alias).toBeNull();
    expect(c!.region).toBeNull();
    expect(c!.sell_price_cny).toBeNull();
    expect(c!.shipping_fee).toBeNull();
    expect(c!.tracking_no).toBeNull();
    expect(JSON.parse(c!.adjustments)).toEqual([{ kind: "cost", group: "关税", amount: 300 }]);
  });

  it("缺 buy_price_cny 的单禁止复制", async () => {
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "未补成本",
      site_id: siteId,
      buyer_wechat: "wx",
      sell_price_cny: 8000,
    });
    await expect(copyOrdersAsStock(db, src.id, 1)).rejects.toThrow(/尚未补成本/);
  });

  it("份数非法（0 / 21 / 小数）抛错", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "x",
      site_id: siteId,
      buy_price_cny: 100,
    });
    await expect(copyOrdersAsStock(db, src.id, 0)).rejects.toThrow(/份数/);
    await expect(copyOrdersAsStock(db, src.id, 21)).rejects.toThrow(/份数/);
    await expect(copyOrdersAsStock(db, src.id, 1.5)).rejects.toThrow(/份数/);
  });

  it("折扣信息随副本继承（issue #12）", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "折扣囤货",
      site_id: siteId,
      buy_price_cny: 4136,
      cost_foreign_amount: 8800, // 折后价
      cost_currency: "AUD",
      discount_rate: 0.88,
      original_foreign_amount: 10000,
      exchange_rate: 4.7,
    });
    const [c] = await copyOrdersAsStock(db, src.id, 1);
    expect(c!.discount_rate).toBe(0.88);
    expect(c!.original_foreign_amount).toBe(10000);
    expect(c!.cost_foreign_amount).toBe(8800);
  });

  it("团未结算：batch_id 保留", async () => {
    const b = await createBatch(db, { name: "一团", site_id: siteId, currency: "AUD" });
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "团内囤货",
      site_id: siteId,
      batch_id: b.id,
      buy_price_cny: 4700,
      cost_foreign_amount: 10000,
      cost_currency: "AUD",
    });
    const [c] = await copyOrdersAsStock(db, src.id, 1);
    expect(c!.batch_id).toBe(b.id);
  });

  it("团已结算：batch_id 清空记散单，batch_allocated 降级 manual", async () => {
    const b = await createBatch(db, { name: "一团", site_id: siteId, currency: "AUD" });
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "团内囤货",
      site_id: siteId,
      batch_id: b.id,
      buy_price_cny: 4700,
      cost_foreign_amount: 10000,
      cost_currency: "AUD",
    });
    await updateBatch(db, b.id, { exchange_rate: 4.7 });
    // 模拟已分摊落库
    await db.execute("UPDATE orders SET buy_price_source = 'batch_allocated' WHERE id = ?", [src.id]);

    const [c] = await copyOrdersAsStock(db, src.id, 1);
    expect(c!.batch_id).toBeNull();
    expect(c!.buy_price_source).toBe("manual");
    expect(c!.buy_price_cny).toBe(4700);
  });
});
