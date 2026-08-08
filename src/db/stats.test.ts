import { describe, it, expect } from "vitest";
import {
  monthlyProfit,
  abnormalLedger,
  pendingShipInfo,
  stockHolding,
  unsettledBatchCount,
  batchProfitRows,
} from "./stats";
import type { BatchRow, OrderRow } from "./types";

function order(overrides: Partial<OrderRow>): OrderRow {
  return {
    id: 1, order_no: "x", order_type: "customer", status: "done",
    batch_id: null, buyer_wechat: "w", buyer_alias: null, region: null,
    product_name: "p", product_note: null, site_id: 1, reserved_at: null,
    ordered_at: "2026-08-01T00:00:00.000Z", shipped_at: null, closed_at: null,
    converted_from_stock_at: null, tracking_no: null, cost_foreign_amount: null,
    cost_currency: null, exchange_rate: null, buy_price_cny: 5000,
    buy_price_source: "estimated", sell_price_cny: 8000, shipping_fee: null,
    adjustments: "[]", note: null, created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z", settlement_updated_at: null,
    ...overrides,
  };
}

describe("monthlyProfit 月度归属", () => {
  it("仅 shipped_at 非空的单进月度统计，按 shipped_at 本地月", () => {
    const rows = [
      order({ id: 1, shipped_at: "2026-07-15T02:00:00.000Z" }), // profit 3000
      order({ id: 2, status: "paid_pending_ship" }), // 无 shipped_at 不归属
    ];
    const m = monthlyProfit(rows);
    expect(m.get("2026-07")).toEqual({ profit: 3000, lost: 0 });
    expect(m.size).toBe(1);
  });

  it("incomplete 跳过且计数", () => {
    const m = monthlyProfit([order({ buy_price_cny: null, shipped_at: "2026-07-01T00:00:00.000Z" })]);
    expect(m.get("2026-07")).toBeUndefined();
  });

  it("lost 按 closed_at 月计负（红段）", () => {
    const rows = [
      order({ id: 1, status: "lost", buy_price_cny: 5000, shipping_fee: 300, closed_at: "2026-08-10T00:00:00.000Z" }),
      order({ id: 2, shipped_at: "2026-08-05T00:00:00.000Z" }),
    ];
    const m = monthlyProfit(rows);
    expect(m.get("2026-08")).toEqual({ profit: 3000, lost: -5300 });
  });

  it("refunded 不进收益曲线", () => {
    const m = monthlyProfit([order({ status: "refunded", closed_at: "2026-08-01T00:00:00.000Z" })]);
    expect(m.size).toBe(0);
  });

  it("stock lost 也计负成本（按 closed_at 月）", () => {
    const m = monthlyProfit([
      order({ order_type: "stock", status: "lost", buy_price_cny: 2000, closed_at: "2026-08-03T00:00:00.000Z", sell_price_cny: null, buyer_wechat: null }),
    ]);
    expect(m.get("2026-08")).toEqual({ profit: 0, lost: -2000 });
  });
});

describe("abnormalLedger 异常账本", () => {
  const rows = [
    order({ id: 1, status: "refunded", sell_price_cny: 8000, closed_at: "2026-07-01T00:00:00.000Z" }),
    order({ id: 2, status: "refunded", sell_price_cny: 6000, closed_at: "2026-08-01T00:00:00.000Z" }),
    order({ id: 3, status: "lost", buy_price_cny: 5000, closed_at: "2026-08-02T00:00:00.000Z" }),
  ];

  it("全部时间：退款单数+Σsell，丢失单数+Σ|profit|", () => {
    const r = abnormalLedger(rows, null);
    expect(r).toEqual({ refundCount: 2, refundTotal: 14000, lostCount: 1, lostTotal: 5000 });
  });

  it("按月份过滤（closed_at 本地月）", () => {
    const r = abnormalLedger(rows, "2026-08");
    expect(r).toEqual({ refundCount: 1, refundTotal: 6000, lostCount: 1, lostTotal: 5000 });
  });
});

describe("卡片数据", () => {
  it("pendingShipInfo：待发货数 + 最早等待天数", () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const rows = [
      order({ id: 1, status: "paid_pending_ship", ordered_at: old }),
      order({ id: 2, status: "shipped" }),
    ];
    const r = pendingShipInfo(rows);
    expect(r.count).toBe(1);
    expect(r.oldestDays).toBeGreaterThanOrEqual(9);
  });

  it("stockHolding：in_stock/listed 完整成本（fullCost，含运费与成本调整）与件数", () => {
    const rows = [
      order({ id: 1, order_type: "stock", status: "in_stock", buy_price_cny: 2000, shipping_fee: 500 }),
      order({
        id: 2, order_type: "stock", status: "listed", buy_price_cny: 3000,
        adjustments: JSON.stringify([{ kind: "cost", group: "关税", amount: 300 }]),
      }),
      order({ id: 3, order_type: "stock", status: "consumed", buy_price_cny: 9000 }),
    ];
    expect(stockHolding(rows)).toEqual({ cost: 5800, count: 2 });
  });

  it("unsettledBatchCount：非 allocated 且非空的团", () => {
    const b: BatchRow = {
      id: 1, name: "b", site_id: 1, currency: "AUD", exchange_rate: null,
      checkout_foreign_amount: null, effective_rate: null, allocated_at: null,
      allocated_checkout: null, allocated_rate: null, allocated_member_count: null,
      discount_note: null, note: null, created_at: "2026-08-01T00:00:00.000Z",
    };
    expect(unsettledBatchCount([b], new Map([[1, [order({ batch_id: 1 })]]]))).toBe(1);
  });

  it("batchProfitRows：每团收益 + 是否已分摊", () => {
    const b: BatchRow = {
      id: 1, name: "一团", site_id: 1, currency: "AUD", exchange_rate: 4.7,
      checkout_foreign_amount: null, effective_rate: null, allocated_at: "2026-08-02T00:00:00.000Z",
      allocated_checkout: null, allocated_rate: 4.7, allocated_member_count: 1,
      discount_note: null, note: null, created_at: "2026-08-01T00:00:00.000Z",
    };
    const rows = batchProfitRows([b], new Map([[1, [order({ batch_id: 1 })]]]));
    expect(rows).toEqual([{ name: "一团", profit: 3000, allocated: true }]);
  });
});
