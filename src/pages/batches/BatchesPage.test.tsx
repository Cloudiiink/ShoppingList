// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithConfirm } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { BatchesPage } from "./BatchesPage";
import { createBatch, updateBatch, listMembers } from "@/db/batches";
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

/** 填团内订单表单（presetBatch 锁定网站与币种） */
async function fillMemberForm(
  user: ReturnType<typeof userEvent.setup>,
  opts: { foreign?: string } = {}
) {
  await user.type(field("商品名 *"), "团内商品");
  await user.type(field("买家微信 *"), "wx-batch");
  await user.type(field("卖出价（元）*"), "600");
  if (opts.foreign != null) {
    await user.type(field(/外币原价/), opts.foreign);
    await user.type(field("汇率"), "5");
  }
}

describe("BatchesPage", () => {
  it("开团核心流：新建团 → 列表出现（预估态）", async () => {
    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByRole("button", { name: "新建团" }));
    await user.type(field("团名 *"), "202608-JAYD 一团");
    await user.selectOptions(
      field("网站 *（一团一站，成员单必须同站）"),
      String(sites[0]!.id)
    );
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("202608-JAYD 一团")).toBeInTheDocument();
    expect(await screen.findByText("预估")).toBeInTheDocument();
  });

  it("issue #10 Bug 1 回归：团详情「+ 加订单」填完可保存，成员列表出现", async () => {
    await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "+ 加订单" }));
    await fillMemberForm(user, { foreign: "100" });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("成员订单（1）")).toBeInTheDocument();
    expect(await screen.findByText("团内商品")).toBeInTheDocument();
  });

  it("纯人民币成员禁入团：缺外币成本时校验错误可见", async () => {
    const batch = await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "+ 加订单" }));
    await fillMemberForm(user); // 不填外币金额
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(
      await screen.findByText("纯人民币单不能入团：成员必须有外币成本")
    ).toBeInTheDocument();
    expect(await listMembers(db, batch.id)).toHaveLength(0);
  });

  it("分摊核心流：preview 显示 → 确认分摊 → 成员 buy_price_source=batch_allocated", async () => {
    const batch = await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const member = await createOrder(db, {
      order_type: "customer",
      product_name: "分摊商品",
      site_id: sites[0]!.id,
      batch_id: batch.id,
      buyer_wechat: "wx1",
      sell_price_cny: 80000,
      cost_foreign_amount: 10000, // 100 AUD
      cost_currency: "AUD",
      exchange_rate: 5,
      buy_price_cny: 50000,
      buy_price_source: "estimated",
    });
    await updateBatch(db, batch.id, {
      checkout_foreign_amount: 10000, // 实付 100 AUD
      exchange_rate: 5,
    });

    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "结算分摊" }));

    // 预览区出现 T/F/P
    expect(await screen.findByText(/目标总额 T/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认分摊" }));

    await waitFor(async () => {
      const m = await getOrder(db, member.id);
      expect(m.buy_price_source).toBe("batch_allocated");
      expect(m.buy_price_cny).toBe(50000); // 100 AUD × 5
    });
  });

  it("团内复制（issue #15）：未结算团成员行「复制」→ 副本为同团代购单（类型/买家保留）", async () => {
    const batch = await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "团内商品",
      site_id: sites[0]!.id,
      batch_id: batch.id,
      buyer_wechat: "wx1",
      sell_price_cny: 80000,
      cost_foreign_amount: 10000,
      cost_currency: "AUD",
      exchange_rate: 5,
      buy_price_cny: 50000,
    });
    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "复制" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认复制" }));

    // 副本照搬入团 → 成员数 2，副本仍为 customer、买家保留
    expect(await screen.findByText("成员订单（2）")).toBeInTheDocument();
    const ms = await listMembers(db, batch.id);
    const copy = ms.find((m) => m.id !== src.id);
    expect(copy).toBeDefined();
    expect(copy!.order_type).toBe("customer");
    expect(copy!.status).toBe("paid_pending_ship");
    expect(copy!.buyer_wechat).toBe("wx1");
    expect(copy!.batch_id).toBe(batch.id);
  });

  it("团内复制（issue #15）：已结算团源单副本照搬入团，成员数 +1", async () => {
    const batch = await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const src = await createOrder(db, {
      order_type: "customer",
      product_name: "团内商品",
      site_id: sites[0]!.id,
      batch_id: batch.id,
      buyer_wechat: "wx1",
      sell_price_cny: 80000,
      cost_foreign_amount: 10000,
      cost_currency: "AUD",
      buy_price_cny: 50000,
    });
    await updateBatch(db, batch.id, { exchange_rate: 4.7 }); // 已结算

    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "复制" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/复制订单/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认复制" }));

    // 副本照搬入团（不再落散单）→ 成员数 2
    await waitFor(async () => {
      expect(await listMembers(db, batch.id)).toHaveLength(2);
    });
    const copy = (await listMembers(db, batch.id)).find((m) => m.id !== src.id);
    expect(copy).toBeDefined();
    expect(copy!.batch_id).toBe(batch.id);
    expect(copy!.order_type).toBe("customer");
    expect(copy!.buyer_wechat).toBe("wx1");
  });

  it("删除团：ConfirmDialog 确认后团删除、成员变散单（issue #10 Bug 3 回归）", async () => {
    const batch = await createBatch(db, { name: "202608-JAYD 一团", site_id: sites[0]!.id, currency: "AUD" });
    const member = await createOrder(db, {
      order_type: "customer",
      product_name: "散单候选",
      site_id: sites[0]!.id,
      batch_id: batch.id,
      buyer_wechat: "wx1",
      sell_price_cny: 60000,
      cost_foreign_amount: 10000,
      cost_currency: "AUD",
    });
    const user = userEvent.setup();
    renderWithConfirm(<BatchesPage db={db} sites={sites} />);

    await user.click(await screen.findByText("202608-JAYD 一团"));
    await user.click(await screen.findByRole("button", { name: "删除团" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("确认删除团「202608-JAYD 一团」？")).toBeInTheDocument();
    expect(within(dialog).getByText("成员单将变为散单。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    // 回到列表且团消失；成员 batch_id 置空
    expect(await screen.findByText("暂无团")).toBeInTheDocument();
    expect((await getOrder(db, member.id)).batch_id).toBeNull();
  });
});
