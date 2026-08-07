import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSnapshot } from "./backup";

const loadMock = vi.fn();
const closeMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: (...args: unknown[]) => loadMock(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  loadMock.mockImplementation(async (path: string) => ({
    path,
    select: selectMock,
    close: closeMock,
  }));
  selectMock.mockResolvedValue([{ integrity_check: "ok" }]);
});

describe("checkSnapshot", () => {
  it("成功路径：load 用 sqlite: 前缀连接串，close 显式传同一连接串（issue #10 回归）", async () => {
    await checkSnapshot("/mock/dir/tracker-20260807-120000.db.backup");

    expect(loadMock).toHaveBeenCalledWith(
      "sqlite:/mock/dir/tracker-20260807-120000.db.backup"
    );
    // Bug A：无参 close() 会让 Rust 端关闭全部连接池（含主库）
    expect(closeMock).toHaveBeenCalledWith(
      "sqlite:/mock/dir/tracker-20260807-120000.db.backup"
    );
  });

  it("integrity_check 非 ok：抛错且 finally 仍 close（带参）", async () => {
    selectMock.mockResolvedValue([{ integrity_check: "page 3 corrupt" }]);

    await expect(checkSnapshot("/mock/bad.db.backup")).rejects.toThrow(
      "快照完整性校验失败"
    );
    expect(closeMock).toHaveBeenCalledWith("sqlite:/mock/bad.db.backup");
  });
});
