import { describe, it, expect, beforeEach } from "vitest";
import {
  createOrder,
  updateOrder,
  changeStatus,
  deleteOrder,
  getOrder,
  listOrders,
  nextOrderNo,
  shipOrder,
} from "./orders";
import { freshDb, seedSites } from "./testUtils";
import type { SqlDb } from "./types";

let db: SqlDb;

beforeEach(async () => {
  db = await freshDb();
  await seedSites(db, "JAYD");
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

  it("汇率入库前归一化 6 位小数", async () => {
    const o = await createOrder(db, {
      ...baseCustomer,
      exchange_rate: 4.7151234567,
    });
    expect(o.exchange_rate).toBe(4.715123);
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

describe("shipOrder（单事务发货）", () => {
  it("buy_price 缺失时整体拒绝，不写任何字段", async () => {
    const o = await createOrder(db, baseCustomer);
    await expect(
      shipOrder(db, o.id, { tracking_no: "SF123", shipping_fee: 1000 })
    ).rejects.toThrow();
    const after = await getOrder(db, o.id);
    expect(after.status).toBe("paid_pending_ship");
    expect(after.tracking_no).toBeNull();
    expect(after.shipping_fee).toBeNull();
  });

  it("成功时单号/邮费/状态/shipped_at 一次落库", async () => {
    const o = await createOrder(db, { ...baseCustomer, buy_price_cny: 5000 });
    const shipped = await shipOrder(db, o.id, {
      tracking_no: "SF123",
      shipping_fee: 1000,
    });
    expect(shipped.status).toBe("shipped");
    expect(shipped.tracking_no).toBe("SF123");
    expect(shipped.shipping_fee).toBe(1000);
    expect(shipped.shipped_at).not.toBeNull();
  });

  it("非 paid_pending_ship 状态拒绝", async () => {
    const o = await createOrder(db, { ...baseCustomer, buy_price_cny: 5000 });
    await changeStatus(db, o.id, "lost");
    await expect(
      shipOrder(db, o.id, { tracking_no: null, shipping_fee: null })
    ).rejects.toThrow();
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

describe("折扣字段（issue #12）", () => {
  const discounted = {
    ...baseCustomer,
    cost_foreign_amount: 8800, // 折后价
    cost_currency: "AUD" as const,
    discount_rate: 0.88,
    original_foreign_amount: 10000, // 折前原价
  };

  it("带折扣建单：两列落库，cost_foreign_amount 是折后价", async () => {
    const o = await createOrder(db, discounted);
    expect(o.discount_rate).toBe(0.88);
    expect(o.original_foreign_amount).toBe(10000);
    expect(o.cost_foreign_amount).toBe(8800);
  });

  it("无折扣建单：两列为 NULL", async () => {
    const o = await createOrder(db, {
      ...baseCustomer,
      cost_foreign_amount: 8800,
      cost_currency: "AUD",
    });
    expect(o.discount_rate).toBeNull();
    expect(o.original_foreign_amount).toBeNull();
  });

  it("折扣率与折前原价必须同空同填", async () => {
    await expect(
      createOrder(db, { ...discounted, original_foreign_amount: null })
    ).rejects.toThrow(/同空同填/);
    await expect(
      createOrder(db, { ...discounted, discount_rate: null })
    ).rejects.toThrow(/同空同填/);
  });

  it("折扣率越界（0 / 1.5）抛错", async () => {
    await expect(
      createOrder(db, { ...discounted, discount_rate: 0 })
    ).rejects.toThrow(/折扣率/);
    await expect(
      createOrder(db, { ...discounted, discount_rate: 1.5 })
    ).rejects.toThrow(/折扣率/);
  });

  it("有折扣但无外币成本抛错", async () => {
    await expect(
      createOrder(db, {
        ...discounted,
        cost_foreign_amount: null,
        cost_currency: null,
      })
    ).rejects.toThrow(/外币成本/);
  });

  it("编辑加/清折扣；折扣字段变更刷新 settlement_updated_at", async () => {
    const o = await createOrder(db, {
      ...baseCustomer,
      cost_foreign_amount: 8800,
      cost_currency: "AUD",
    });
    const withDiscount = await updateOrder(db, o.id, {
      discount_rate: 0.88,
      original_foreign_amount: 10000,
    });
    expect(withDiscount.discount_rate).toBe(0.88);
    expect(withDiscount.original_foreign_amount).toBe(10000);
    expect(withDiscount.settlement_updated_at).not.toBeNull();

    const cleared = await updateOrder(db, o.id, {
      discount_rate: null,
      original_foreign_amount: null,
    });
    expect(cleared.discount_rate).toBeNull();
    expect(cleared.original_foreign_amount).toBeNull();
  });
});
