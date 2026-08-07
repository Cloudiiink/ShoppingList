import { describe, it, expect, beforeEach } from "vitest";
import { executeBatch, isLockError, withTransaction } from "./transaction";
import { registerRecoverer } from "./recovery";
import { freshDb } from "./testUtils";
import type { SqlDb } from "./types";

beforeEach(() => {
  // 测试间隔离：recoverer 注册是模块级状态
  registerRecoverer(() => Promise.resolve());
});

describe("isLockError", () => {
  it("识别 SQLite 锁错误", () => {
    expect(isLockError(new Error("error returned from database: (code: 5) database is locked"))).toBe(true);
    expect(isLockError(new Error("database table is locked"))).toBe(true);
    expect(isLockError(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isLockError("database is locked")).toBe(true);
  });
});

describe("withTransaction", () => {
  it("正常路径：BEGIN → fn → COMMIT，返回 fn 结果", async () => {
    const db = await freshDb();
    const result = await withTransaction(db, async () => {
      await db.execute("INSERT INTO sites (name) VALUES ('A')");
      return "done";
    });
    expect(result).toBe("done");
    const rows = await db.select<{ name: string }[]>("SELECT name FROM sites");
    expect(rows.map((r) => r.name)).toEqual(["A"]);
  });

  it("非锁错误：立即回滚抛出，不重试", async () => {
    const db = await freshDb();
    let calls = 0;
    await expect(
      withTransaction(db, async () => {
        calls++;
        await db.execute("INSERT INTO sites (name) VALUES ('A')");
        throw new Error("业务校验失败");
      })
    ).rejects.toThrow("业务校验失败");
    expect(calls).toBe(1);
    expect(await db.select("SELECT COUNT(*) AS c FROM sites")).toEqual([{ c: 0 }]);
  });

  it("锁错误：重放整个事务直到成功", async () => {
    const db = await freshDb();
    let calls = 0;
    const result = await withTransaction(db, async () => {
      calls++;
      if (calls < 3) throw new Error("(code: 5) database is locked");
      await db.execute("INSERT INTO sites (name) VALUES ('B')");
      return calls;
    });
    expect(result).toBe(3);
    expect(await db.select("SELECT COUNT(*) AS c FROM sites")).toEqual([{ c: 1 }]);
  });

  it("锁持续：第 2 次失败后触发池恢复，最终仍失败则抛出锁错误", async () => {
    const db = await freshDb();
    let recoveries = 0;
    registerRecoverer(async () => {
      recoveries++;
    });
    let calls = 0;
    await expect(
      withTransaction(db, async () => {
        calls++;
        throw new Error("database is locked");
      })
    ).rejects.toThrow("database is locked");
    expect(calls).toBe(4); // MAX_ATTEMPTS
    expect(recoveries).toBe(1);
  });

  it("fn 抛出后 ROLLBACK 失败不掩盖原始错误", async () => {
    // ROLLBACK 必败的伪 db（无事务）
    const db: SqlDb = {
      execute: async (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("no transaction is active");
        return {};
      },
      select: async <T,>() => [] as T,
    };
    await expect(
      withTransaction(db, async () => {
        throw new Error("原始业务错误");
      })
    ).rejects.toThrow("原始业务错误");
  });

  it("「cannot start a transaction」（悬挂事务）视为可恢复错误并重放", async () => {
    const db = await freshDb();
    let calls = 0;
    const result = await withTransaction(db, async () => {
      calls++;
      if (calls === 1) throw new Error("cannot start a transaction within a transaction");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("executeBatch", () => {
  it("多语句批处理：全部语句原子生效", async () => {
    const db = await freshDb();
    await executeBatch(
      db,
      "BEGIN IMMEDIATE; INSERT INTO sites (name) VALUES ('A'); INSERT INTO sites (name) VALUES ('B'); COMMIT;"
    );
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sites ORDER BY name"
    );
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
  });

  it("批处理中途失败：尽力回滚，不落部分写入", async () => {
    const db = await freshDb();
    await expect(
      executeBatch(
        db,
        "BEGIN IMMEDIATE; INSERT INTO sites (name) VALUES ('A'); INSERT INTO sites (name) VALUES ('A'); COMMIT;"
      )
    ).rejects.toThrow(); // UNIQUE 冲突
    expect(await db.select("SELECT COUNT(*) AS c FROM sites")).toEqual([{ c: 0 }]);
  });
});
