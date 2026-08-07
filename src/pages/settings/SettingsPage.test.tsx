// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "./SettingsPage";
import { createOrder } from "@/db/orders";
import { listSites } from "@/db/sites";
import { freshDb, seedSites } from "@/db/testUtils";
import { field } from "@/test/domUtils";
import type { SqlDb } from "@/db/types";

const writeTextFileMock = vi.fn();
const doBackupMock = vi.fn();
const listBackupsMock = vi.fn();

vi.mock("@tauri-apps/api/path", () => ({
  appConfigDir: async () => "/mock/config/",
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppConfig: 0 },
  writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
}));

vi.mock("@/lib/backupFiles", () => ({
  doBackup: (...args: unknown[]) => doBackupMock(...args),
  listBackups: (...args: unknown[]) => listBackupsMock(...args),
}));

let db: SqlDb;

beforeEach(async () => {
  vi.clearAllMocks();
  doBackupMock.mockResolvedValue("tracker-20260807-120000.db.backup");
  listBackupsMock.mockResolvedValue([]);
  writeTextFileMock.mockResolvedValue(undefined);
  db = await freshDb();
});

function renderPage() {
  return render(<SettingsPage db={db} onSitesChanged={vi.fn()} />);
}

describe("SettingsPage", () => {
  it("添加网站：表格出现、引用数 0", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/还没有网站/)).toBeInTheDocument();
    await user.type(field("新网站名"), "JAYD 澳洲站");
    await user.click(screen.getByRole("button", { name: "添加" }));

    expect(await screen.findByText("JAYD 澳洲站")).toBeInTheDocument();
    expect(screen.getByText("引用 0")).toBeInTheDocument();
    expect((await listSites(db)).map((s) => s.name)).toEqual(["JAYD 澳洲站"]);
  });

  it("删除被引用网站：错误可见、网站保留", async () => {
    await seedSites(db, "JAYD");
    const [site] = await listSites(db);
    await createOrder(db, {
      order_type: "stock",
      product_name: "引用商品",
      site_id: site!.id,
      buy_price_cny: 100,
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "删除" }));

    expect(await screen.findByText(/禁止删除/)).toBeInTheDocument();
    expect(await listSites(db)).toHaveLength(1);
  });

  it("立即备份：走 doBackup 并显示成功消息", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "立即备份" }));

    expect(
      await screen.findByText(/备份完成：tracker-20260807-120000\.db\.backup/)
    ).toBeInTheDocument();
    expect(doBackupMock).toHaveBeenCalledTimes(1);
  });

  it("导出全部订单 CSV：写文件名带日期、内容带 BOM", async () => {
    await seedSites(db, "JAYD");
    const [site] = await listSites(db);
    await createOrder(db, {
      order_type: "customer",
      product_name: "导出商品",
      site_id: site!.id,
      buyer_wechat: "wx1",
      sell_price_cny: 8000,
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "导出全部订单 CSV" }));

    expect(await screen.findByText(/已导出 1 条订单/)).toBeInTheDocument();
    const [name, content] = writeTextFileMock.mock.calls[0]!;
    expect(name).toMatch(/^orders-export-\d{8}\.csv$/);
    expect(content.startsWith("﻿")).toBe(true);
    expect(content).toContain("导出商品");
  });
});
