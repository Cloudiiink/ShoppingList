// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderForm } from "./OrderForm";
import { createOrder, listOrders } from "@/db/orders";
import { listSites } from "@/db/sites";
import { upsertRate } from "@/db/rates";
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

    await user.type(field(/外币原价/), "100");
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

  it("汇率表预填：新建单按币种从 rates 表静默预填，切换币种跟随", async () => {
    await upsertRate(db, "AUD", 4.7);
    await upsertRate(db, "USD", 7.2);
    const user = userEvent.setup();
    renderForm();

    // 默认币种 AUD → 预填 4.7
    await waitFor(() => {
      expect((field("汇率") as HTMLInputElement).value).toBe("4.7");
    });
    // 切到 USD → 预填 7.2
    await user.selectOptions(field(/外币原价/).parentElement!.querySelector("select")!, "USD");
    await waitFor(() => {
      expect((field("汇率") as HTMLInputElement).value).toBe("7.2");
    });
    // 切到 HKD（表里未设置）→ 留空
    await user.selectOptions(field(/外币原价/).parentElement!.querySelector("select")!, "HKD");
    await waitFor(() => {
      expect((field("汇率") as HTMLInputElement).value).toBe("");
    });
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

  it("折扣（issue #12）：原价 × 折扣率自动算折后价与买入价，落库三字段", async () => {
    const user = userEvent.setup();
    const onClose = renderForm();

    await user.type(field("商品名 *"), "折扣商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("买家微信 *"), "wx1");
    await user.type(field("卖出价（元）*"), "600");
    await user.type(field(/外币原价/), "100");
    await user.type(field("折扣率（空 = 无折扣）"), "0.88");
    await user.type(field("汇率"), "5");

    // 折后 88 AUD 展示；买入价联动 = 88 × 5
    expect(await screen.findByText("88.00 AUD")).toBeInTheDocument();
    await waitFor(() => {
      expect((field(/买入价/) as HTMLInputElement).value).toBe("440.00");
    });

    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const [o] = await listOrders(db);
    expect(o!.original_foreign_amount).toBe(10000);
    expect(o!.discount_rate).toBe(0.88);
    expect(o!.cost_foreign_amount).toBe(8800);
    expect(o!.buy_price_cny).toBe(44000);
  });

  it("折扣率非法：保存报错、不落库", async () => {
    const user = userEvent.setup();
    const onClose = renderForm();

    await user.type(field("商品名 *"), "折扣商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("买家微信 *"), "wx1");
    await user.type(field("卖出价（元）*"), "600");
    await user.type(field(/外币原价/), "100");
    await user.type(field("折扣率（空 = 无折扣）"), "1.5");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("折扣率必须在 0-1 之间（如 0.88）")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(await listOrders(db)).toHaveLength(0);
  });

  it("外币原价非法：保存报错、不落库（不得静默存 NULL 成本）", async () => {
    const user = userEvent.setup();
    const onClose = renderForm();

    await user.type(field("商品名 *"), "坏金额商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("买家微信 *"), "wx1");
    await user.type(field("卖出价（元）*"), "600");
    await user.type(field(/外币原价/), "abc");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/外币原价输入非法/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(await listOrders(db)).toHaveLength(0);
  });

  it("编辑带折扣单：回显折扣率与折前原价、折后价展示", async () => {
    const created = await createOrder(db, {
      order_type: "customer",
      product_name: "折扣商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx-old",
      sell_price_cny: 8000,
      cost_foreign_amount: 8800,
      cost_currency: "AUD",
      discount_rate: 0.88,
      original_foreign_amount: 10000,
      exchange_rate: 5,
      buy_price_cny: 44000,
    });
    renderForm(vi.fn(), created);

    expect((field("折扣率（空 = 无折扣）") as HTMLInputElement).value).toBe("0.88");
    expect((field(/外币原价/) as HTMLInputElement).value).toBe("100.00");
    expect(await screen.findByText("88.00 AUD")).toBeInTheDocument();
  });
});
