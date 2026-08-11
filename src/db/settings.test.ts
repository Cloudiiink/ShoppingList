import { describe, it, expect } from "vitest";
import { backupFileName, pruneTargets, isBackupFile } from "./backup";
import { ordersToCsv } from "./export";
import type { OrderRow } from "./types";

describe("backupFileName", () => {
  it("秒级时间戳命名", () => {
    const d = new Date(2026, 7, 4, 21, 30, 5);
    expect(backupFileName(d)).toBe("tracker-20260804-213005.db.backup");
  });
});

describe("isBackupFile / pruneTargets", () => {
  it("只认 tracker-*.db.backup", () => {
    expect(isBackupFile("tracker-20260804-213005.db.backup")).toBe(true);
    expect(isBackupFile("tracker.db")).toBe(false);
    expect(isBackupFile("other.db.backup")).toBe(false);
  });

  it("保留最新 2 份，其余为删除目标", () => {
    const files = [
      "tracker-20260801-100000.db.backup",
      "tracker-20260803-100000.db.backup",
      "tracker-20260802-100000.db.backup",
      "tracker-20260804-100000.db.backup",
    ];
    expect(pruneTargets(files, 2).sort()).toEqual([
      "tracker-20260801-100000.db.backup",
      "tracker-20260802-100000.db.backup",
    ]);
  });

  it("不足 2 份时不删", () => {
    expect(pruneTargets(["tracker-20260804-100000.db.backup"], 2)).toEqual([]);
  });
});

function order(overrides: Partial<OrderRow>): OrderRow {
  return {
    id: 1, order_no: "20260804-1", order_type: "customer", status: "done",
    batch_id: 1, buyer_wechat: "wx", buyer_alias: "老王", region: "上海",
    product_name: "精华, 50ml", product_note: null, site_id: 1, reserved_at: null,
    ordered_at: "2026-08-01T00:00:00.000Z", shipped_at: "2026-08-02T00:00:00.000Z",
    closed_at: "2026-08-03T00:00:00.000Z", converted_from_stock_at: null,
    tracking_no: "SF123", cost_foreign_amount: 10000, cost_currency: "AUD",
    discount_rate: null, original_foreign_amount: null,
    exchange_rate: 4.7, buy_price_cny: 47000, buy_price_source: "batch_allocated",
    sell_price_cny: 80000, shipping_fee: 1500,
    adjustments: '[{"kind":"cost","group":"关税","amount":200}]',
    note: '含"引号"', created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-03T00:00:00.000Z", settlement_updated_at: null,
    ...overrides,
  };
}

describe("ordersToCsv", () => {
  it("金额导出为元两位小数，含 batch_name 列，adjustments 展开为 JSON 字符串", () => {
    const csv = ordersToCsv([order({})], new Map([[1, "202608-JAYD 一团"]]));
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("批次");
    const row = lines[1];
    expect(row).toContain("470.00"); // buy_price 元
    expect(row).toContain("800.00"); // sell_price 元
    expect(row).toContain("15.00");  // shipping 元
    expect(row).toContain("202608-JAYD 一团");
    expect(row).toContain("100.00"); // 外币成本也按两位小数
  });

  it("CSV 转义：逗号与引号正确包裹", () => {
    const csv = ordersToCsv([order({})], new Map([[1, "b"]]));
    const row = csv.split("\n")[1];
    expect(row).toContain('"精华, 50ml"');
    expect(row).toContain('"含""引号"""');
  });

  it("空值导出为空字符串", () => {
    const csv = ordersToCsv([order({ tracking_no: null, note: null, batch_id: null })], new Map());
    const row = csv.split("\n")[1];
    expect(row).not.toContain("null");
  });
});
