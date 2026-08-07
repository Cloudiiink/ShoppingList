// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShipDialog } from "./ShipDialog";
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

async function makeOrder(buyPrice: number | null) {
  return createOrder(db, {
    order_type: "customer",
    product_name: "发货测试商品",
    site_id: sites[0]!.id,
    buyer_wechat: "wx1",
    sell_price_cny: 8000,
    buy_price_cny: buyPrice,
  });
}

describe("ShipDialog", () => {
  it("发货核心流：填单号+邮费 → 确认 → 状态/单号/邮费落库", async () => {
    const order = await makeOrder(5000);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShipDialog db={db} order={order} onClose={onClose} />);

    await user.type(field("快递单号（面交可留空）"), "SF123");
    await user.type(field("邮费（元）"), "12");
    await user.click(screen.getByRole("button", { name: "确认发货" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const o = await getOrder(db, order.id);
    expect(o.status).toBe("shipped");
    expect(o.tracking_no).toBe("SF123");
    expect(o.shipping_fee).toBe(1200);
  });

  it("缺买入价：硬校验错误显示在弹窗内，状态不变", async () => {
    const order = await makeOrder(null);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShipDialog db={db} order={order} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "确认发货" }));

    expect(await screen.findByText("发货前必须填写买入价")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect((await getOrder(db, order.id)).status).toBe("paid_pending_ship");
  });

  it("取消：onClose(false)，不落库", async () => {
    const order = await makeOrder(5000);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShipDialog db={db} order={order} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledWith(false);
    expect((await getOrder(db, order.id)).status).toBe("paid_pending_ship");
  });
});
