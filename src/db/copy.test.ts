import { describe, it, expect, beforeEach } from "vitest";
import { copyOrders, createOrder, shipOrder } from "./orders";
import { createBatch, updateBatch } from "./batches";
import { freshDb, seedSites } from "./testUtils";
import type { SqlDb } from "./types";

let db: SqlDb;
let siteId: number;

beforeEach(async () => {
  db = await freshDb();
  siteId = await seedSites(db, "JAYD");
});

describe("copyOrders 全量复制", () => {
  it("customer 单全量复制：类型/买家/售价/运费/快递单号/全部调整保留，新订单号", async () => {
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "代购商品",
      product_note: "500ml",
      site_id: siteId,
      buyer_wechat: "wx-buyer",
      buyer_alias: "小王",
      region: "上海",
      sell_price_cny: 8000,
      buy_price_cny: 5000,
      shipping_fee: 1200,
      tracking_no: "SF123",
      note: "好用",
      adjustments: [
        { kind: "cost", group: "关税", amount: 300 },
        { kind: "revenue", group: "小费", amount: 100 },
      ],
    });
    const [c] = await copyOrders(db, src.id, 1);

    expect(c!.order_type).toBe("customer");
    expect(c!.status).toBe("paid_pending_ship");
    expect(c!.buyer_wechat).toBe("wx-buyer");
    expect(c!.buyer_alias).toBe("小王");
    expect(c!.region).toBe("上海");
    expect(c!.sell_price_cny).toBe(8000);
    expect(c!.shipping_fee).toBe(1200);
    expect(c!.tracking_no).toBe("SF123");
    expect(c!.buy_price_cny).toBe(5000);
    expect(c!.note).toBe("好用");
    expect(JSON.parse(c!.adjustments)).toEqual([
      { kind: "cost", group: "关税", amount: 300 },
      { kind: "revenue", group: "小费", amount: 100 },
    ]);
    expect(c!.order_no).not.toBe(src.order_no);
  });

  it("stock 单全量复制：类型保持 stock、状态 in_stock", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "囤货商品",
      site_id: siteId,
      buy_price_cny: 2000,
      cost_foreign_amount: 4000,
      cost_currency: "AUD",
      exchange_rate: 4.7,
    });
    const [c] = await copyOrders(db, src.id, 1);
    expect(c!.order_type).toBe("stock");
    expect(c!.status).toBe("in_stock");
    expect(c!.buy_price_cny).toBe(2000);
    expect(c!.cost_foreign_amount).toBe(4000);
  });

  it("复制已发货单：状态重置 paid_pending_ship、shipped_at 清空、快递单号/运费保留", async () => {
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "已发货",
      site_id: siteId,
      buyer_wechat: "wx",
      sell_price_cny: 8000,
      buy_price_cny: 5000,
    });
    const shipped = await shipOrder(db, src.id, { tracking_no: "SF999", shipping_fee: 1500 });
    expect(shipped.status).toBe("shipped");

    const [c] = await copyOrders(db, src.id, 1);
    expect(c!.status).toBe("paid_pending_ship");
    expect(c!.shipped_at).toBeNull();
    expect(c!.closed_at).toBeNull();
    expect(c!.tracking_no).toBe("SF999");
    expect(c!.shipping_fee).toBe(1500);
  });

  it("份数非法（0 / 21 / 小数）抛错", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "x",
      site_id: siteId,
      buy_price_cny: 100,
    });
    await expect(copyOrders(db, src.id, 0)).rejects.toThrow(/份数/);
    await expect(copyOrders(db, src.id, 21)).rejects.toThrow(/份数/);
    await expect(copyOrders(db, src.id, 1.5)).rejects.toThrow(/份数/);
  });

  it("折扣信息随副本继承（issue #12）", async () => {
    const src = await createOrder(db, {
      order_type: "stock",
      product_name: "折扣囤货",
      site_id: siteId,
      buy_price_cny: 4136,
      cost_foreign_amount: 8800,
      cost_currency: "AUD",
      discount_rate: 0.88,
      original_foreign_amount: 10000,
      exchange_rate: 4.7,
    });
    const [c] = await copyOrders(db, src.id, 1);
    expect(c!.discount_rate).toBe(0.88);
    expect(c!.original_foreign_amount).toBe(10000);
    expect(c!.cost_foreign_amount).toBe(8800);
  });

  it("batch_id 照搬：已结算团也保留，batch_allocated 降级 manual", async () => {
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

    const [c] = await copyOrders(db, src.id, 1);
    expect(c!.batch_id).toBe(b.id);
    expect(c!.buy_price_source).toBe("manual");
    expect(c!.buy_price_cny).toBe(4700);
  });
});
