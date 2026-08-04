import { describe, it, expect } from "vitest";
import {
  canonicalProfit,
  parseAdjustments,
  canTransition,
  legalTargets,
  statusChangePatch,
  isTerminal,
  requiresBuyPrice,
} from "./rules";
import type { OrderRow } from "./types";

function order(overrides: Partial<OrderRow>): OrderRow {
  return {
    id: 1,
    order_no: "20260804-1",
    order_type: "customer",
    status: "paid_pending_ship",
    batch_id: null,
    buyer_wechat: "wx",
    buyer_alias: null,
    region: null,
    product_name: "test",
    product_note: null,
    site_id: 1,
    reserved_at: null,
    ordered_at: "2026-08-04T00:00:00.000Z",
    shipped_at: null,
    closed_at: null,
    converted_from_stock_at: null,
    tracking_no: null,
    cost_foreign_amount: null,
    cost_currency: null,
    exchange_rate: null,
    buy_price_cny: 5000,
    buy_price_source: "estimated",
    sell_price_cny: 8000,
    shipping_fee: null,
    adjustments: "[]",
    note: null,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    settlement_updated_at: null,
    ...overrides,
  };
}

describe("canonical_profit", () => {
  it("普通完成单：sell − buy − shipping", () => {
    expect(
      canonicalProfit(order({ status: "done", shipping_fee: 500 }))
    ).toEqual({ kind: "ok", value: 8000 - 5000 - 500 });
  });

  it("shipping 未填按 0", () => {
    expect(canonicalProfit(order({ status: "shipped" }))).toEqual({
      kind: "ok",
      value: 3000,
    });
  });

  it("buy_price_cny 为空 → incomplete", () => {
    expect(canonicalProfit(order({ buy_price_cny: null }))).toEqual({
      kind: "incomplete",
    });
  });

  it("refunded 恒 0，且先于缺成本判断", () => {
    expect(
      canonicalProfit(order({ status: "refunded", buy_price_cny: null }))
    ).toEqual({ kind: "ok", value: 0 });
    expect(canonicalProfit(order({ status: "refunded" }))).toEqual({
      kind: "ok",
      value: 0,
    });
  });

  it("lost 计负全成本（含 shipping 与 cost 侧调整）", () => {
    expect(
      canonicalProfit(
        order({
          status: "lost",
          shipping_fee: 300,
          adjustments: JSON.stringify([
            { kind: "cost", group: "关税", amount: 200 },
          ]),
        })
      )
    ).toEqual({ kind: "ok", value: -(5000 + 300 + 200) });
  });

  it("adjustments 收入侧加、成本侧减", () => {
    expect(
      canonicalProfit(
        order({
          status: "done",
          adjustments: JSON.stringify([
            { kind: "revenue", group: "补款", amount: 100 },
            { kind: "revenue", group: "让利", amount: -50 },
            { kind: "cost", group: "折扣", amount: -200 },
          ]),
        })
      )
    ).toEqual({ kind: "ok", value: 8000 + 100 - 50 - 5000 - 0 - -200 });
  });

  it("stock in_stock/listed/consumed → excluded", () => {
    for (const s of ["in_stock", "listed", "consumed"] as const) {
      expect(canonicalProfit(order({ order_type: "stock", status: s }))).toEqual({
        kind: "excluded",
      });
    }
  });

  it("stock lost → 负全成本", () => {
    expect(
      canonicalProfit(order({ order_type: "stock", status: "lost" }))
    ).toEqual({ kind: "ok", value: -5000 });
  });
});

describe("parseAdjustments", () => {
  it("合法数组解析", () => {
    expect(
      parseAdjustments('[{"kind":"cost","group":"关税","amount":100}]')
    ).toEqual([{ kind: "cost", group: "关税", amount: 100 }]);
  });

  it("损坏数据显式报错，不静默当 0", () => {
    expect(() => parseAdjustments("not json")).toThrow();
    expect(() => parseAdjustments("{}")).toThrow();
    expect(() => parseAdjustments('[{"kind":"x","group":"g","amount":1}]')).toThrow();
    expect(() => parseAdjustments('[{"kind":"cost","group":"","amount":1}]')).toThrow();
    expect(() => parseAdjustments('[{"kind":"cost","group":"g","amount":1.5}]')).toThrow();
  });
});

describe("转移矩阵 canTransition", () => {
  it("customer 合法路径", () => {
    expect(canTransition("customer", "paid_pending_ship", "shipped")).toBe(true);
    expect(canTransition("customer", "shipped", "done")).toBe(true);
    expect(canTransition("customer", "shipped", "refunded")).toBe(true);
    expect(canTransition("customer", "shipped", "lost")).toBe(true);
    expect(canTransition("customer", "shipped", "paid_pending_ship")).toBe(true);
    expect(canTransition("customer", "done", "shipped")).toBe(true);
    expect(canTransition("customer", "refunded", "paid_pending_ship")).toBe(true);
    expect(canTransition("customer", "lost", "shipped")).toBe(true);
  });

  it("customer 非法跳变", () => {
    expect(canTransition("customer", "paid_pending_ship", "done")).toBe(false);
    expect(canTransition("customer", "done", "paid_pending_ship")).toBe(false);
    expect(canTransition("customer", "refunded", "done")).toBe(false);
  });

  it("stock 合法/非法", () => {
    expect(canTransition("stock", "in_stock", "listed")).toBe(true);
    expect(canTransition("stock", "listed", "in_stock")).toBe(true);
    expect(canTransition("stock", "consumed", "in_stock")).toBe(true);
    expect(canTransition("stock", "lost", "in_stock")).toBe(true);
    expect(canTransition("stock", "consumed", "listed")).toBe(false);
    expect(canTransition("stock", "lost", "listed")).toBe(false);
  });

  it("legalTargets 只列合法目标", () => {
    expect(legalTargets("customer", "done")).toEqual(["shipped"]);
    expect(legalTargets("stock", "in_stock").sort()).toEqual(
      ["consumed", "listed", "lost"].sort()
    );
  });
});

describe("isTerminal / requiresBuyPrice", () => {
  it("终态判定", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("consumed")).toBe(true);
    expect(isTerminal("shipped")).toBe(false);
    expect(isTerminal("in_stock")).toBe(false);
  });

  it("shipped/lost 需要 buy_price 硬校验", () => {
    expect(requiresBuyPrice("shipped")).toBe(true);
    expect(requiresBuyPrice("lost")).toBe(true);
    expect(requiresBuyPrice("done")).toBe(false);
  });
});

describe("statusChangePatch 时间戳兜底四条", () => {
  const NOW = "2026-08-04T12:00:00.000Z";

  it("进 shipped 补写 shipped_at（为空才写）", () => {
    expect(statusChangePatch(order({}), "shipped", NOW)).toMatchObject({
      status: "shipped",
      shipped_at: NOW,
    });
    const o = order({ status: "shipped", shipped_at: "2026-08-01T00:00:00.000Z" });
    // patch 中不包含 shipped_at = 不覆盖已有值
    expect(statusChangePatch(o, "shipped", NOW).shipped_at).toBeUndefined();
  });

  it("进终态补写 closed_at（为空才写）", () => {
    expect(statusChangePatch(order({ status: "shipped" }), "done", NOW)).toMatchObject({
      closed_at: NOW,
    });
  });

  it("终态回退中间态清 closed_at", () => {
    const o = order({ status: "done", closed_at: NOW });
    expect(statusChangePatch(o, "shipped", NOW).closed_at).toBeNull();
  });

  it("目标是 paid_pending_ship 一律清 shipped_at（无论来源），tracking_no 保留", () => {
    const base = {
      shipped_at: "2026-08-01T00:00:00.000Z",
      tracking_no: "SF123",
    };
    for (const from of ["shipped", "lost", "refunded"] as const) {
      const o = order({ ...base, status: from, closed_at: from === "shipped" ? null : NOW });
      const patch = statusChangePatch(o, "paid_pending_ship", NOW);
      expect(patch.shipped_at).toBeNull();
      expect(patch).not.toHaveProperty("tracking_no");
    }
  });
});
