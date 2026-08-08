import { describe, it, expect, beforeEach } from "vitest";
import { getRate, listRates, upsertRate } from "./rates";
import { freshDb } from "./testUtils";
import type { SqlDb } from "./types";

let db: SqlDb;

beforeEach(async () => {
  db = await freshDb();
});

describe("rates 汇率表", () => {
  it("upsert 后可读取；重复 upsert 覆盖并刷新 updated_at", async () => {
    await upsertRate(db, "AUD", 4.715);
    const r1 = await getRate(db, "AUD");
    expect(r1?.rate).toBe(4.715);
    expect(r1?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await upsertRate(db, "AUD", 4.8);
    const r2 = await getRate(db, "AUD");
    expect(r2?.rate).toBe(4.8);
    expect(r2!.updated_at >= r1!.updated_at).toBe(true);
  });

  it("listRates 按币种排序；未设置的币种返回 null", async () => {
    await upsertRate(db, "USD", 7.2);
    await upsertRate(db, "AUD", 4.7);
    expect((await listRates(db)).map((r) => r.currency)).toEqual(["AUD", "USD"]);
    expect(await getRate(db, "HKD")).toBeNull();
  });

  it("汇率过 normRate 归一化（6 位小数）", async () => {
    await upsertRate(db, "HKD", 0.9123456789);
    expect((await getRate(db, "HKD"))?.rate).toBe(0.912346);
  });

  it("非法汇率（0 / 负数 / NaN）拒绝写入", async () => {
    await expect(upsertRate(db, "AUD", 0)).rejects.toThrow(/非法汇率/);
    await expect(upsertRate(db, "AUD", -1)).rejects.toThrow(/非法汇率/);
    await expect(upsertRate(db, "AUD", NaN)).rejects.toThrow(/非法汇率/);
    expect(await getRate(db, "AUD")).toBeNull();
  });
});
