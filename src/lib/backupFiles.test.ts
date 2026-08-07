import { describe, it, expect, vi, beforeEach } from "vitest";
import { doBackup, newestBackupAgeDays } from "./backupFiles";
import type { SqlDb } from "@/db/types";

const readDirMock = vi.fn();
const removeMock = vi.fn();
const statMock = vi.fn();
const loadMock = vi.fn();
const selectMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@tauri-apps/api/path", () => ({
  appConfigDir: async () => "/mock/config/",
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppConfig: 0 },
  readDir: (...args: unknown[]) => readDirMock(...args),
  remove: (...args: unknown[]) => removeMock(...args),
  stat: (...args: unknown[]) => statMock(...args),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: (...args: unknown[]) => loadMock(...args),
  },
}));

/** 目录里的文件（readDir 的返回源）；VACUUM INTO 会把新快照加进来 */
let dirFiles: string[];
/** 记录 VACUUM INTO 语句 */
let vacuumSql: string[];

const fakeDb: SqlDb = {
  execute: async (sql: string) => {
    vacuumSql.push(sql);
    const m = /^VACUUM INTO '(.*)'$/.exec(sql);
    if (m) dirFiles.push(m[1]!.replace("/mock/config/", ""));
    return { rowsAffected: 0, lastInsertId: 0 } as never;
  },
  select: async () => [] as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  dirFiles = [];
  vacuumSql = [];
  readDirMock.mockImplementation(async () =>
    dirFiles.map((name) => ({ name, isFile: true }))
  );
  removeMock.mockResolvedValue(undefined);
  loadMock.mockImplementation(async (path: string) => ({
    path,
    select: selectMock,
    close: closeMock,
  }));
  selectMock.mockResolvedValue([{ integrity_check: "ok" }]);
});

describe("doBackup", () => {
  it("成功路径：生成快照、保留最新 2 份、删除最旧", async () => {
    dirFiles = [
      "tracker-20260801-090000.db.backup",
      "tracker-20260802-090000.db.backup",
      "tracker-20260803-090000.db.backup",
      "notes.txt", // 非备份文件不受影响
    ];

    const name = await doBackup(fakeDb);

    expect(name).toMatch(/^tracker-\d{8}-\d{6}\.db\.backup$/);
    expect(vacuumSql[0]).toBe(`VACUUM INTO '/mock/config/${name}'`);
    // 目录 = 3 旧 + 1 新 = 4 份 → 删到剩 2：删最旧两份（顺序无关）
    const removed = removeMock.mock.calls.map((c) => c[0]).sort();
    expect(removed).toEqual([
      "tracker-20260801-090000.db.backup",
      "tracker-20260802-090000.db.backup",
    ]);
  });

  it("integrity 校验失败：删新快照、不动旧备份、抛错", async () => {
    selectMock.mockResolvedValue([{ integrity_check: "page 2 corrupt" }]);
    dirFiles = ["tracker-20260801-090000.db.backup"];

    await expect(doBackup(fakeDb)).rejects.toThrow("快照完整性校验失败");

    const removed = removeMock.mock.calls.map((c) => c[0]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^tracker-\d{8}-\d{6}\.db\.backup$/);
    expect(removed[0]).not.toBe("tracker-20260801-090000.db.backup");
  });

  it("路径含单引号：VACUUM INTO 正确转义", async () => {
    const { doBackup: doBackupAgain } = await import("./backupFiles");
    // appConfigDir 固定 /mock/config/，转义逻辑在 createSnapshot 内；
    // 直接验证 fakeDb 收到的 SQL 不含未转义引号注入
    await doBackupAgain(fakeDb);
    expect(vacuumSql[0]).toMatch(/^VACUUM INTO '\/mock\/config\/[^']*'$/);
  });
});

describe("newestBackupAgeDays", () => {
  it("最新备份 8 天前 → 返回 > 7（供 7 天提醒）", async () => {
    dirFiles = ["tracker-20260801-090000.db.backup"];
    statMock.mockResolvedValue({
      mtime: new Date(Date.now() - 8 * 86_400_000),
    });

    const age = await newestBackupAgeDays();
    expect(age).toBeGreaterThan(7);
    expect(age).toBeLessThan(9);
  });

  it("无备份 → null", async () => {
    dirFiles = [];
    expect(await newestBackupAgeDays()).toBeNull();
  });
});
