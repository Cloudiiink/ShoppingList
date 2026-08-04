import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { listOrders, changeStatus, deleteOrder, listAdjustmentGroups } from "@/db/orders";
import { listBatches } from "@/db/batches";
import { canonicalProfit, fenToYuan, legalTargets } from "@/db/rules";
import { isoToLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BatchRow, OrderRow, OrderStatus, SiteRow, SqlDb } from "@/db/types";
import { OrderForm } from "./OrderForm";
import { ShipDialog } from "./ShipDialog";

const IN_PROGRESS: OrderStatus[] = ["paid_pending_ship", "shipped"];

/** §4.5 行变色 */
const ROW_COLOR: Partial<Record<OrderStatus, string>> = {
  paid_pending_ship: "bg-blue-50",
  shipped: "bg-green-50",
  refunded: "bg-red-200",
  lost: "bg-red-200",
  in_stock: "bg-purple-100",
  listed: "bg-purple-50",
};

const STATUS_LABEL: Record<string, string> = {
  paid_pending_ship: "待发货",
  shipped: "已发货",
  done: "完结",
  refunded: "退款",
  lost: "丢失",
  in_stock: "在库",
  listed: "挂单中",
  consumed: "自用",
};

const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  shipped: "标记发货",
  done: "完结",
  refunded: "退款",
  lost: "丢失",
  paid_pending_ship: "回退待发货",
  in_stock: "下架/回在库",
  listed: "挂单",
  consumed: "自用",
};

type View = "default" | "all" | "in_progress" | OrderStatus;

const VIEW_LABEL: [View, string][] = [
  ["default", "默认视图"],
  ["in_progress", "进行中"],
  ["paid_pending_ship", "待发货"],
  ["shipped", "已发货"],
  ["done", "完结"],
  ["refunded", "退款"],
  ["lost", "丢失"],
  ["all", "全部"],
];

export function OrdersPage({ db, sites }: { db: SqlDb; sites: SiteRow[] }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [adjGroups, setAdjGroups] = useState<string[]>([]);
  const [view, setView] = useState<View>("default");
  const [batchFilter, setBatchFilter] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OrderRow | null>(null);
  const [shipping, setShipping] = useState<OrderRow | null>(null);

  const reload = useCallback(async () => {
    const [os, bs, gs] = await Promise.all([
      listOrders(db),
      listBatches(db),
      listAdjustmentGroups(db),
    ]);
    setOrders(os);
    setBatches(bs);
    setAdjGroups(gs);
  }, [db]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  /** 最新活跃团：最新创建且仍有进行中订单的团 */
  const activeBatchId = useMemo(() => {
    const batchIds = new Set(
      orders.filter((o) => o.batch_id != null && IN_PROGRESS.includes(o.status)).map((o) => o.batch_id)
    );
    const active = batches.find((b) => batchIds.has(b.id));
    return active?.id ?? null;
  }, [orders, batches]);

  const visible = useMemo(() => {
    let list = orders;
    if (view === "in_progress") {
      list = list.filter((o) => IN_PROGRESS.includes(o.status));
    } else if (view === "default") {
      list = list.filter(
        (o) => IN_PROGRESS.includes(o.status) || o.batch_id === activeBatchId
      );
    } else if (view !== "all") {
      // 单状态筛选
      list = list.filter((o) => o.status === view);
    }
    if (batchFilter === "none") {
      list = list.filter((o) => o.batch_id == null);
    } else if (batchFilter) {
      list = list.filter((o) => o.batch_id === Number(batchFilter));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((o) =>
        [o.buyer_wechat, o.buyer_alias, o.product_name, o.order_no]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q))
      );
    }
    // 按 id 去重（默认视图并集防御）
    return Array.from(new Map(list.map((o) => [o.id, o])).values());
  }, [orders, view, batchFilter, activeBatchId, search]);

  const missingShippingCount = useMemo(
    () =>
      orders.filter((o) => IN_PROGRESS.includes(o.status) && o.shipping_fee == null)
        .length,
    [orders]
  );

  const batchName = useCallback(
    (id: number | null) => batches.find((b) => b.id === id)?.name ?? "",
    [batches]
  );
  const siteName = useCallback(
    (id: number) => sites.find((s) => s.id === id)?.name ?? "",
    [sites]
  );

  async function doAction(o: OrderRow, to: OrderStatus) {
    setError("");
    if (to === "shipped" && o.status === "paid_pending_ship") {
      setShipping(o);
      return;
    }
    if (to === "done" && o.shipping_fee == null) {
      if (!window.confirm("邮费未填，收益将按 0 邮费计算，仍要完结？")) return;
    }
    try {
      await changeStatus(db, o.id, to);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doDelete(o: OrderRow) {
    if (!window.confirm(`确认删除订单 ${o.order_no}？`)) return;
    await deleteOrder(db, o.id);
    await reload();
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <Select className="w-40" value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEW_LABEL.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </Select>
        <Select className="w-48" value={batchFilter} onChange={(e) => setBatchFilter(e.target.value)}>
          <option value="">全部批次</option>
          <option value="none">仅散单</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </Select>
        <Input
          className="w-64"
          placeholder="搜索买家/商品/订单号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex-1" />
        <Button onClick={() => { setEditing(null); setFormOpen(true); }}>新建订单</Button>
      </div>

      {missingShippingCount > 0 && (
        <div className="rounded-md bg-orange-50 px-3 py-2 text-sm text-orange-700">
          有 {missingShippingCount} 条订单未填邮费
        </div>
      )}
      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="p-2">订单号</th>
            <th className="p-2">类型</th>
            <th className="p-2">商品</th>
            <th className="p-2">买家</th>
            <th className="p-2">网站</th>
            <th className="p-2">批次</th>
            <th className="p-2">状态</th>
            <th className="p-2">下单日</th>
            <th className="p-2 text-right">买入</th>
            <th className="p-2 text-right">卖出</th>
            <th className="p-2 text-right">邮费</th>
            <th className="p-2 text-right">收益</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((o) => {
            const profit = canonicalProfit(o);
            const targets = legalTargets(o.order_type, o.status);
            const shippingMissing =
              IN_PROGRESS.includes(o.status) && o.shipping_fee == null;
            return (
              <tr key={o.id} className={cn("border-b", ROW_COLOR[o.status])}>
                <td className="p-2 font-mono text-xs">{o.order_no}</td>
                <td className="p-2">{o.order_type === "customer" ? "代购" : "囤货"}</td>
                <td className="p-2">{o.product_name}</td>
                <td className="p-2">{o.buyer_alias || o.buyer_wechat || ""}</td>
                <td className="p-2">{siteName(o.site_id)}</td>
                <td className="p-2">{batchName(o.batch_id)}</td>
                <td className="p-2">{STATUS_LABEL[o.status]}</td>
                <td className="p-2">{isoToLocalDate(o.ordered_at)}</td>
                <td className="p-2 text-right">
                  {o.buy_price_cny != null ? fenToYuan(o.buy_price_cny) : "—"}
                </td>
                <td className="p-2 text-right">
                  {o.sell_price_cny != null ? fenToYuan(o.sell_price_cny) : "—"}
                </td>
                <td className={cn("p-2 text-right", shippingMissing && "bg-orange-300")}>
                  {o.shipping_fee != null ? fenToYuan(o.shipping_fee) : "—"}
                </td>
                <td className="p-2 text-right">
                  {profit.kind === "ok"
                    ? fenToYuan(profit.value)
                    : profit.kind === "incomplete"
                      ? "—"
                      : ""}
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => { setEditing(o); setFormOpen(true); }}>
                      编辑
                    </Button>
                    {targets.map((t) => (
                      <Button key={t} size="sm" variant="ghost" onClick={() => doAction(o, t)}>
                        {ACTION_LABEL[t] ?? t}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => doDelete(o)}>
                      删除
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={13} className="p-8 text-center text-muted-foreground">
                暂无订单
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <OrderForm
        db={db}
        sites={sites}
        batches={batches}
        adjustmentGroups={adjGroups}
        order={editing}
        open={formOpen}
        onClose={(saved) => {
          setFormOpen(false);
          if (saved) reload();
        }}
      />
      <ShipDialog
        db={db}
        order={shipping}
        onClose={(saved) => {
          setShipping(null);
          if (saved) reload();
        }}
      />
    </div>
  );
}
