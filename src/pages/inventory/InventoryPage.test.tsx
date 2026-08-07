// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InventoryPage } from "./InventoryPage";
import { createOrder, getOrder } from "@/db/orders";
import { listSites } from "@/db/sites";
import { freshDb, seedSites } from "@/db/testUtils";
import { field } from "@/test/domUtils";
import type { SiteRow, SqlDb } from "@/db/types";

let db: SqlDb;
let sites: SiteRow[];

beforeEach(async () => {
  db = await freshDb();
  await seedSites(db, "JAYD");
  sites = await listSites(db);
});

async function seedStock(buyPrice = 2000) {
  return createOrder(db, {
    order_type: "stock",
    product_name: "囤货商品",
    site_id: sites[0]!.id,
    buy_price_cny: buyPrice,
  });
}

describe("InventoryPage", () => {
  it("在库列表渲染 + 成本汇总", async () => {
    await seedStock(2000);
    render(<InventoryPage db={db} sites={sites} />);

    expect(await screen.findByText("囤货商品")).toBeInTheDocument();
    expect(screen.getByText("在库")).toBeInTheDocument();
    expect(screen.getByText(/1 件/)).toBeInTheDocument();
  });

  it("转售出核心流：填买家+卖出价 → order_type=customer、状态待发货、conversion 时间戳写入", async () => {
    const stock = await seedStock();
    const user = userEvent.setup();
    render(<InventoryPage db={db} sites={sites} />);

    await user.click(await screen.findByRole("button", { name: "转售出" }));
    await user.type(field("买家微信 *"), "wx-conv");
    await user.type(field("卖出价（元）*"), "300");
    await user.click(screen.getByRole("button", { name: "确认转售出" }));

    await waitFor(async () => {
      const o = await getOrder(db, stock.id);
      expect(o.order_type).toBe("customer");
      expect(o.status).toBe("paid_pending_ship");
      expect(o.buyer_wechat).toBe("wx-conv");
      expect(o.sell_price_cny).toBe(30000);
      expect(o.converted_from_stock_at).not.toBeNull();
      expect(o.buy_price_cny).toBe(2000); // 成本锁定不变
    });
  });

  it("挂单流转：在库 → 挂单中", async () => {
    const stock = await seedStock();
    const user = userEvent.setup();
    render(<InventoryPage db={db} sites={sites} />);

    await user.click(await screen.findByRole("button", { name: "挂单" }));

    expect(await screen.findByText("挂单中")).toBeInTheDocument();
    expect((await getOrder(db, stock.id)).status).toBe("listed");
  });
});
