// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderForm } from "./OrderForm";
import { createOrder, listOrders } from "@/db/orders";
import { listSites } from "@/db/sites";
import { fetchRate } from "@/lib/rates";
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

function renderForm(onClose = vi.fn(), order: Parameters<typeof OrderForm>[0]["order"] = null) {
  render(
    <OrderForm
      db={db}
      sites={sites}
      batches={[]}
      adjustmentGroups={[]}
      order={order}
      open={true}
      onClose={onClose}
    />
  );
  return onClose;
}

describe("OrderForm", () => {
  it("customer 缺买家微信：校验错误可见、不落库、不关窗", async () => {
    const user = userEvent.setup();
    const onClose = renderForm();

    await user.type(field("商品名 *"), "Test 商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("卖出价（元）*"), "600");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("代购单必须填写买家微信")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(await listOrders(db)).toHaveLength(0);
  });

  it("汇率联动：外币金额 × 汇率自动估算买入价（estimated）", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(field("外币金额"), "100");
    await user.type(field("汇率"), "5");

    await waitFor(() => {
      expect((field(/买入价/) as HTMLInputElement).value).toBe("500.00");
    });
  });

  it("编辑：回显已有订单，修改卖出价后保存落库", async () => {
    const created = await createOrder(db, {
      order_type: "customer",
      product_name: "既有商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx-old",
      sell_price_cny: 8000,
    });
    const user = userEvent.setup();
    const onClose = renderForm(vi.fn(), created);

    expect((field("商品名 *") as HTMLInputElement).value).toBe("既有商品");

    const sell = field("卖出价（元）*") as HTMLInputElement;
    await user.clear(sell);
    await user.type(sell, "900");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const [o] = await listOrders(db);
    expect(o!.sell_price_cny).toBe(90000);
  });

  it("获取实时汇率失败：错误提示可见，手填汇率仍可保存", async () => {
    vi.mocked(fetchRate).mockRejectedValueOnce(new Error("网络失败"));
    const user = userEvent.setup();
    const onClose = renderForm();

    await user.click(screen.getByRole("button", { name: "获取实时汇率" }));
    expect(await screen.findByText("网络失败")).toBeInTheDocument();

    await user.type(field("商品名 *"), "Test 商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("买家微信 *"), "wx1");
    await user.type(field("卖出价（元）*"), "600");
    await user.type(field("汇率"), "4.7");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(await listOrders(db)).toHaveLength(1);
  });
});
