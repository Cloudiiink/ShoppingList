import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./migrate";
import { createOrder, updateOrder } from "./orders";
import {
  createBatch,
  updateBatch,
  allocateBatch,
  listMembers,
} from "./batches";
import type { SqlDb } from "./types";

function wrap(raw: Database.Database): SqlDb {
  return {
    execute: async (sql, params = []) => raw.prepare(sql).run(...(params as never[])),
    select: async <T,>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).all(...(params as never[])) as T,
  };
}

let db: SqlDb;
let batchId: number;

beforeEach(async () => {
  db = wrap(new Database(":memory:"));
  await db.execute("PRAGMA foreign_keys = ON");
  await migrate(db);
  await db.execute("INSERT INTO sites (name) VALUES ('JAYD'), ('Cettire')");
  const b = await createBatch(db, {
    name: "202608-JAYD 一团",
    site_id: 1,
    currency: "AUD",
  });
  batchId = b.id;
});

const memberInput = {
  order_type: "customer" as const,
  product_name: "Test",
  site_id: 1,
  buyer_wechat: "wx",
  sell_price_cny: 8000,
  cost_foreign_amount: 10000, // 100.00 AUD
  cost_currency: "AUD" as const,
};

describe("团成员不变量", () => {
  it("纯人民币单禁止入团", async () => {
    await expect(
      createOrder(db, {
        order_type: "customer",
        product_name: "RMB 单",
        site_id: 1,
        buyer_wechat: "wx",
        sell_price_cny: 8000,
        buy_price_cny: 5000,
        batch_id: batchId,
      })
    ).rejects.toThrow(/外币/);
  });

  it("币种不符拒绝入团", async () => {
    await expect(
      createOrder(db, { ...memberInput, cost_currency: "USD", batch_id: batchId })
    ).rejects.toThrow(/币种/);
  });

  it("网站不符拒绝入团", async () => {
    await expect(
      createOrder(db, { ...memberInput, site_id: 2, batch_id: batchId })
    ).rejects.toThrow(/网站/);
  });

  it("散单挂团同样校验", async () => {
    const o = await createOrder(db, { ...memberInput, cost_currency: "USD" });
    await expect(updateOrder(db, o.id, { batch_id: batchId })).rejects.toThrow(/币种/);
    const ok = await createOrder(db, memberInput);
    const attached = await updateOrder(db, ok.id, { batch_id: batchId });
    expect(attached.batch_id).toBe(batchId);
  });
});

describe("updateBatch", () => {
  it("汇率归一化入库", async () => {
    const b = await updateBatch(db, batchId, { exchange_rate: 4.7151234567 });
    expect(b.exchange_rate).toBe(4.715123);
  });
});

describe("allocateBatch", () => {
  async function seedTwoMembers() {
    await createOrder(db, { ...memberInput, batch_id: batchId }); // 100 AUD
    await createOrder(db, { ...memberInput, cost_foreign_amount: 30000, batch_id: batchId }); // 300 AUD
  }

  it("checkout 模式：T=checkout×团汇率，Σ≡T，写 allocated_* 五字段", async () => {
    await seedTwoMembers();
    await updateBatch(db, batchId, { exchange_rate: 4.7, checkout_foreign_amount: 40000 });
    const r = await allocateBatch(db, batchId, { mode: "checkout" });
    // T = 40000 × 4.7 = 188000 分；1:3 → 47000 / 141000
    expect(r.T).toBe(188000);
    expect(r.total).toBe(188000);
    const members = await listMembers(db, batchId);
    expect(members.map((m) => m.buy_price_cny).sort((a, b) => a! - b!)).toEqual([47000, 141000]);
    expect(members.every((m) => m.buy_price_source === "batch_allocated")).toBe(true);
    const b = (await db.select<{ allocated_checkout: number | null; allocated_member_count: number; effective_rate: number | null }[]>(
      "SELECT allocated_checkout, allocated_member_count, effective_rate FROM batches WHERE id = ?", [batchId]
    ))[0];
    expect(b.allocated_checkout).toBe(40000);
    expect(b.allocated_member_count).toBe(2);
    expect(b.effective_rate).toBeCloseTo(4.7, 6);
  });

  it("手动汇率模式：allocated_checkout 存 NULL", async () => {
    await seedTwoMembers();
    await updateBatch(db, batchId, { exchange_rate: 4.7 });
    const r = await allocateBatch(db, batchId, { mode: "manual", rate: 5 });
    // T = 40000 × 5 = 200000；1:3 → 50000/150000
    expect(r.T).toBe(200000);
    const [b] = await db.select<{ allocated_checkout: number | null; allocated_rate: number }[]>(
      "SELECT allocated_checkout, allocated_rate FROM batches WHERE id = ?", [batchId]
    );
    expect(b.allocated_checkout).toBeNull();
    expect(b.allocated_rate).toBe(5);
  });

  it("幂等：重复分摊结果一致", async () => {
    await seedTwoMembers();
    await updateBatch(db, batchId, { exchange_rate: 4.7, checkout_foreign_amount: 40000 });
    await allocateBatch(db, batchId, { mode: "checkout" });
    const second = await allocateBatch(db, batchId, { mode: "checkout" });
    expect(second.total).toBe(188000);
  });

  it("manual 成员锁定不动", async () => {
    await seedTwoMembers();
    const locked = await createOrder(db, {
      ...memberInput, cost_foreign_amount: 5000, batch_id: batchId,
    });
    await updateOrder(db, locked.id, { buy_price_cny: 99999, buy_price_source: "manual" });
    await updateBatch(db, batchId, { exchange_rate: 4.7, checkout_foreign_amount: 45000 });
    const r = await allocateBatch(db, batchId, { mode: "checkout" });
    // T = 45000×4.7=211500；P = 211500-99999=111501 → 1:3 分
    expect(r.total).toBe(211500);
    const kept = await listMembers(db, batchId);
    expect(kept.find((m) => m.id === locked.id)!.buy_price_cny).toBe(99999);
  });

  it("checkout 填了但无成员 → 拒绝", async () => {
    await updateBatch(db, batchId, { exchange_rate: 4.7, checkout_foreign_amount: 40000 });
    await expect(allocateBatch(db, batchId, { mode: "checkout" })).rejects.toThrow();
  });

  it("手动模式缺 rate → 拒绝", async () => {
    await seedTwoMembers();
    await expect(allocateBatch(db, batchId, { mode: "manual", rate: undefined as unknown as number })).rejects.toThrow();
  });
});
