import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { OrdersTable } from "@/components/OrdersTable";
import { listOrders, changeStatus, deleteOrder, listAdjustmentGroups } from "@/db/orders";
import { listBatches } from "@/db/batches";
import type { BatchRow, OrderRow, OrderStatus, SiteRow, SqlDb } from "@/db/types";
import { OrderForm } from "./OrderForm";
import { ShipDialog } from "./ShipDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { IN_PROGRESS_STATUSES } from "@/db/rules";

const IN_PROGRESS = IN_PROGRESS_STATUSES;

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
  const confirm = useConfirm();
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

  async function doAction(o: OrderRow, to: OrderStatus) {
    setError("");
    try {
      await changeStatus(db, o.id, to);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doDelete(o: OrderRow) {
    if (!(await confirm({ title: `确认删除订单 ${o.order_no}？`, confirmText: "删除", danger: true }))) return;
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

      <OrdersTable
        orders={visible}
        sites={sites}
        batches={batches}
        onEdit={(o) => { setEditing(o); setFormOpen(true); }}
        onShip={(o) => setShipping(o)}
        onStatus={doAction}
        onDelete={doDelete}
      />

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
