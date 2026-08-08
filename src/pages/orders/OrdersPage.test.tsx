// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithConfirm } from "@/test/render";
import { OrdersPage } from "./OrdersPage";
import { createOrder, getOrder, listOrders, shipOrder } from "@/db/orders";
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

describe("OrdersPage", () => {
  it("录单核心流：新建订单 → 保存 → 表格出现且落库", async () => {
    const user = userEvent.setup();
    renderWithConfirm(<OrdersPage db={db} sites={sites} />);

    await user.click(await screen.findByRole("button", { name: "新建订单" }));
    await user.type(field("商品名 *"), "页面录单商品");
    await user.selectOptions(field("网站 *"), String(sites[0]!.id));
    await user.type(field("买家微信 *"), "wx-page");
    await user.type(field("卖出价（元）*"), "600");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("页面录单商品")).toBeInTheDocument();
    const orders = await listOrders(db);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("paid_pending_ship");
  });

  it("视图过滤「待发货」：只显示待发货订单", async () => {
    const pending = await createOrder(db, {
      order_type: "customer",
      product_name: "待发商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx1",
      sell_price_cny: 100,
      buy_price_cny: 50,
    });
    await createOrder(db, {
      order_type: "customer",
      product_name: "已发商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx2",
      sell_price_cny: 100,
      buy_price_cny: 50,
    }).then((o) => shipOrder(db, o.id, { tracking_no: null, shipping_fee: 0 }));

    const user = userEvent.setup();
    renderWithConfirm(<OrdersPage db={db} sites={sites} />);
    // 默认视图两者都可见（均进行中）
    await screen.findByText("待发商品");
    expect(screen.getByText("已发商品")).toBeInTheDocument();

    await user.selectOptions(screen.getAllByRole("combobox")[0]!, "paid_pending_ship");
    await waitFor(() => {
      expect(screen.getByText("待发商品")).toBeInTheDocument();
      expect(screen.queryByText("已发商品")).not.toBeInTheDocument();
    });
    void pending;
  });

  it("db 查询失败：错误横幅可见", async () => {
    const broken: SqlDb = {
      execute: async () => ({}),
      select: async () => {
        throw new Error("db down");
      },
    };
    renderWithConfirm(<OrdersPage db={broken} sites={sites} />);
    expect(await screen.findByText("db down")).toBeInTheDocument();
  });

  it("删除订单：ConfirmDialog 确认后落库删除（issue #10 Bug 3 回归）", async () => {
    const order = await createOrder(db, {
      order_type: "customer",
      product_name: "待删商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx1",
      sell_price_cny: 100,
    });
    const user = userEvent.setup();
    renderWithConfirm(<OrdersPage db={db} sites={sites} />);

    await user.click((await screen.findAllByRole("button", { name: "删除" }))[0]!);
    // 应用内确认框（替代 window.confirm）
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`确认删除订单 ${order.order_no}？`)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(screen.queryByText("待删商品")).not.toBeInTheDocument();
    });
    expect(await listOrders(db)).toHaveLength(0);
  });

  it("删除订单：取消确认框则不删", async () => {
    await createOrder(db, {
      order_type: "customer",
      product_name: "保留商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx1",
      sell_price_cny: 100,
    });
    const user = userEvent.setup();
    renderWithConfirm(<OrdersPage db={db} sites={sites} />);

    await user.click((await screen.findAllByRole("button", { name: "删除" }))[0]!);
    await user.click(await screen.findByRole("button", { name: "取消" }));

    expect(screen.getByText("保留商品")).toBeInTheDocument();
    expect(await listOrders(db)).toHaveLength(1);
  });

  it("完结订单：邮费未填时弹软确认，确认后完结", async () => {
    const order = await createOrder(db, {
      order_type: "customer",
      product_name: "完结商品",
      site_id: sites[0]!.id,
      buyer_wechat: "wx1",
      sell_price_cny: 100,
      buy_price_cny: 50,
    });
    await shipOrder(db, order.id, { tracking_no: null, shipping_fee: null });
    const user = userEvent.setup();
    renderWithConfirm(<OrdersPage db={db} sites={sites} />);

    await user.click(await screen.findByRole("button", { name: "完结" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/邮费未填，收益将按 0 邮费计算/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "完结" }));

    await waitFor(async () => {
      expect((await getOrder(db, order.id)).status).toBe("done");
    });
  });
});
