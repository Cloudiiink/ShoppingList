import { describe, it, expect } from "vitest";
import { serialize } from "./serialize";
import type { SqlDb } from "./types";

/** 可手动放行的 deferred fake，记录并发在飞数 */
function makeFake() {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const gates: (() => void)[] = [];

  const inner: SqlDb = {
    execute: async (sql: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(sql);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
      return { rowsAffected: 1 };
    },
    select: async <T,>(sql: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(sql);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
      return [] as T;
    },
  };

  /** 放行一个等待中的调用 */
  const releaseOne = () => gates.shift()?.();
  const pending = () => gates.length;

  return { inner, releaseOne, pending, order, maxInFlight: () => maxInFlight };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("serialize（issue #10 Bug B）", () => {
  it("并发调用不重叠：maxInFlight 恒为 1", async () => {
    const fake = makeFake();
    const db = serialize(fake.inner);

    const calls = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? db.execute(`stmt-${i}`) : db.select(`stmt-${i}`)
    );
    await flush();
    expect(fake.pending()).toBe(1); // 只有第一个在执行，其余排队

    for (let i = 0; i < 20; i++) {
      fake.releaseOne();
      await flush();
      expect(fake.maxInFlight()).toBe(1);
    }
    await Promise.all(calls);
    expect(fake.maxInFlight()).toBe(1);
  });

  it("执行顺序 == 发起顺序", async () => {
    const fake = makeFake();
    const db = serialize(fake.inner);

    const calls = [0, 1, 2, 3].map((i) => db.execute(`s${i}`));
    for (let i = 0; i < 4; i++) {
      await flush();
      fake.releaseOne();
    }
    await Promise.all(calls);
    expect(fake.order).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("一条失败不毒化后续排队查询", async () => {
    const inner: SqlDb = {
      execute: async (sql: string) => {
        if (sql === "bad") throw new Error("boom");
        return { rowsAffected: 1 };
      },
      select: async <T,>() => [] as T,
    };
    const db = serialize(inner);

    await expect(db.execute("bad")).rejects.toThrow("boom");
    await expect(db.execute("good")).resolves.toEqual({ rowsAffected: 1 });
  });

  it("结果原样透传", async () => {
    const inner: SqlDb = {
      execute: async () => ({ rowsAffected: 3 }),
      select: async <T,>() => [{ id: 1 }] as T,
    };
    const db = serialize(inner);

    await expect(db.execute("x")).resolves.toEqual({ rowsAffected: 3 });
    await expect(db.select<{ id: number }[]>("y")).resolves.toEqual([
      { id: 1 },
    ]);
  });
});
