import { describe, it, expect } from "vitest";
import { allocate, settlementState, type AllocationMember } from "./rules";
import type { BatchRow, OrderRow } from "./types";

function member(
  id: number,
  foreign: number | null,
  source: "estimated" | "manual" | "batch_allocated" = "estimated",
  buy: number | null = null
): AllocationMember {
  return { id, cost_foreign_amount: foreign, buy_price_cny: buy, buy_price_source: source };
}

describe("allocate 结算分摊", () => {
  it("整除情形：按比例精确分配", () => {
    // T=1000 分，两单外币 1:3 → 250/750
    const r = allocate([member(1, 100), member(2, 300)], 1000);
    expect(r).toEqual([
      { id: 1, buy_price_cny: 250 },
      { id: 2, buy_price_cny: 750 },
    ]);
  });

  it("最大余数法：尾差补给余数最大者", () => {
    // T=100，三单各外币 100 → 每人 33.33… → 34/33/33，并列按 id 小者优先
    const r = allocate([member(1, 100), member(2, 100), member(3, 100)], 100);
    expect(r).toEqual([
      { id: 1, buy_price_cny: 34 },
      { id: 2, buy_price_cny: 33 },
      { id: 3, buy_price_cny: 33 },
    ]);
  });

  it("Σ ≡ T 构造性成立（大量随机权重）", () => {
    const members = Array.from({ length: 17 }, (_, i) => member(i + 1, (i * 37) % 500 + 1));
    const T = 999983;
    const r = allocate(members, T);
    expect(r.reduce((s, x) => s + x.buy_price_cny, 0)).toBe(T);
  });

  it("manual 成员锁定不动，不 participation 分母", () => {
    // manual 单 buy=400 锁定；T=1000 → P=600 分给两单 1:1 → 300/300
    const r = allocate([member(1, 100, "manual", 400), member(2, 100), member(3, 100)], 1000);
    expect(r).toEqual([
      { id: 2, buy_price_cny: 300 },
      { id: 3, buy_price_cny: 300 },
    ]);
  });

  it("batch_allocated 成员参与再分摊（幂等）", () => {
    const first = allocate([member(1, 100), member(2, 300)], 1000);
    const again = allocate(
      [member(1, 100, "batch_allocated", 250), member(2, 300, "batch_allocated", 750)],
      1000
    );
    expect(again).toEqual(first);
  });

  it("可分摊池为空 → 抛错", () => {
    expect(() => allocate([member(1, 100, "manual", 500)], 500)).toThrow(/无可分摊/);
  });

  it("P < 0（固定成本超过 T）→ 抛错", () => {
    expect(() => allocate([member(1, 100, "manual", 600), member(2, 100)], 500)).toThrow(/固定成本/);
  });

  it("P = 0 → 允许，全分 0", () => {
    const r = allocate([member(1, 100, "manual", 500), member(2, 100)], 500);
    expect(r).toEqual([{ id: 2, buy_price_cny: 0 }]);
  });

  it("大数值不溢出（BigInt 路径）", () => {
    const r = allocate([member(1, 99999999), member(2, 1)], 99999999999);
    expect(r[0].buy_price_cny + r[1].buy_price_cny).toBe(99999999999);
  });
});

function batchRow(overrides: Partial<BatchRow>): BatchRow {
  return {
    id: 1,
    name: "202608-JAYD 一团",
    site_id: 1,
    currency: "AUD",
    exchange_rate: null,
    checkout_foreign_amount: null,
    effective_rate: null,
    allocated_at: null,
    allocated_checkout: null,
    allocated_rate: null,
    allocated_member_count: null,
    discount_note: null,
    note: null,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function orderRow(overrides: Partial<OrderRow>): OrderRow {
  return {
    id: 1, order_no: "x", order_type: "customer", status: "paid_pending_ship",
    batch_id: 1, buyer_wechat: "w", buyer_alias: null, region: null,
    product_name: "p", product_note: null, site_id: 1, reserved_at: null,
    ordered_at: "2026-08-01T00:00:00.000Z", shipped_at: null, closed_at: null,
    converted_from_stock_at: null, tracking_no: null, cost_foreign_amount: 100,
    cost_currency: "AUD", exchange_rate: null, buy_price_cny: 470,
    buy_price_source: "estimated", sell_price_cny: 800, shipping_fee: null,
    adjustments: "[]", note: null, created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z", settlement_updated_at: null,
    ...overrides,
  };
}

describe("settlementState 四态派生", () => {
  it("团汇率空 → unsettled（预估）", () => {
    expect(settlementState(batchRow({}), [])).toBe("unsettled");
  });

  it("有汇率未分摊 → pending（待分摊）", () => {
    expect(settlementState(batchRow({ exchange_rate: 4.7 }), [])).toBe("pending");
  });

  it("checkout 模式已分摊 → allocated", () => {
    const b = batchRow({
      exchange_rate: 4.7, checkout_foreign_amount: 10000,
      allocated_at: "2026-08-02T00:00:00.000Z", allocated_rate: 4.7,
      allocated_checkout: 10000, allocated_member_count: 1,
    });
    expect(settlementState(b, [orderRow({})])).toBe("allocated");
  });

  it("手动模式（allocated_checkout=NULL）→ allocated，checkout 变化不影响", () => {
    const b = batchRow({
      exchange_rate: 4.7, checkout_foreign_amount: 999,
      allocated_at: "2026-08-02T00:00:00.000Z", allocated_rate: 4.7,
      allocated_checkout: null, allocated_member_count: 1,
    });
    expect(settlementState(b, [orderRow({})])).toBe("allocated");
  });

  it("汇率变了 → stale", () => {
    const b = batchRow({
      exchange_rate: 4.8, allocated_at: "2026-08-02T00:00:00.000Z",
      allocated_rate: 4.7, allocated_checkout: null, allocated_member_count: 1,
    });
    expect(settlementState(b, [orderRow({})])).toBe("stale");
  });

  it("checkout 模式 checkout 变了 → stale", () => {
    const b = batchRow({
      exchange_rate: 4.7, checkout_foreign_amount: 20000,
      allocated_at: "2026-08-02T00:00:00.000Z", allocated_rate: 4.7,
      allocated_checkout: 10000, allocated_member_count: 1,
    });
    expect(settlementState(b, [orderRow({})])).toBe("stale");
  });

  it("成员结算字段变更 → stale；备注变更不触发", () => {
    const b = batchRow({
      exchange_rate: 4.7, allocated_at: "2026-08-02T00:00:00.000Z",
      allocated_rate: 4.7, allocated_checkout: null, allocated_member_count: 2,
    });
    const stale = orderRow({ id: 1, settlement_updated_at: "2026-08-03T00:00:00.000Z" });
    const quiet = orderRow({ id: 2, settlement_updated_at: "2026-08-01T00:00:00.000Z" });
    expect(settlementState(b, [stale, quiet])).toBe("stale");
    expect(settlementState(b, [orderRow({ id: 1 }), quiet])).toBe("allocated");
  });

  it("成员增减（数量不符）→ stale", () => {
    const b = batchRow({
      exchange_rate: 4.7, allocated_at: "2026-08-02T00:00:00.000Z",
      allocated_rate: 4.7, allocated_checkout: null, allocated_member_count: 1,
    });
    expect(settlementState(b, [orderRow({ id: 1 }), orderRow({ id: 2 })])).toBe("stale");
  });
});
