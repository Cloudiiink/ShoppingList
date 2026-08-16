import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { listOrders, listAdjustmentGroups, changeStatus } from "@/db/orders";
import { listBatches } from "@/db/batches";
import { CopyOrderDialog } from "@/components/CopyOrderDialog";
import { HelpIcon } from "@/components/HelpIcon";
import { canConvertStock, fenToYuan, fullCost, legalTargets } from "@/db/rules";
import { ACTION_LABEL, STATUS_LABEL } from "@/lib/labels";
import { isoToLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { OrderForm } from "@/pages/orders/OrderForm";
import type { BatchRow, OrderRow, OrderStatus, SiteRow, SqlDb } from "@/db/types";

const ROW_COLOR: Partial<Record<OrderStatus, string>> = {
  in_stock: "bg-purple-100",
  listed: "bg-purple-50",
  lost: "bg-red-200",
};

export function InventoryPage({ db, sites }: { db: SqlDb; sites: SiteRow[] }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [adjustmentGroups, setAdjustmentGroups] = useState<string[]>([]);
  const [converting, setConverting] = useState<OrderRow | null>(null);
  const [copying, setCopying] = useState<OrderRow | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const [os, bs, ag] = await Promise.all([
      listOrders(db, { status: ["in_stock", "listed", "consumed", "lost"] }),
      listBatches(db),
      listAdjustmentGroups(db),
    ]);
    setOrders(os.filter((o) => o.order_type === "stock"));
    setBatches(bs);
    setAdjustmentGroups(ag);
  }, [db]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  const active = orders.filter((o) => o.status === "in_stock" || o.status === "listed");
  const totalCost = active.reduce((s, o) => s + fullCost(o), 0);

  const siteName = (id: number) => sites.find((s) => s.id === id)?.name ?? "";

  async function doAction(o: OrderRow, to: OrderStatus) {
    setError("");
    try {
      await changeStatus(db, o.id, to);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-6">
        <h2 className="text-lg font-semibold">库存</h2>
        <span className="text-sm text-muted-foreground">
          库存总成本：<b className="text-foreground">{fenToYuan(totalCost)}</b> 元 · {active.length} 件<HelpIcon text="在库＋挂单囤货的成本合计（买入价＋运费＋成本调整）与件数。" className="ml-1" />
        </span>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="p-2">订单号</th>
            <th className="p-2">商品</th>
            <th className="p-2">网站</th>
            <th className="p-2">状态</th>
            <th className="p-2">购买日</th>
            <th className="p-2 text-right">成本</th>
            <th className="p-2">备注</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const targets = legalTargets("stock", o.status);
            const convertible = canConvertStock(o.status);
            return (
              <tr key={o.id} className={cn("border-b", ROW_COLOR[o.status])}>
                <td className="p-2 font-mono text-xs">{o.order_no}</td>
                <td className="p-2">{o.product_name}{o.product_note ? `（${o.product_note}）` : ""}</td>
                <td className="p-2">{siteName(o.site_id)}</td>
                <td className="p-2">{STATUS_LABEL[o.status]}</td>
                <td className="p-2">{isoToLocalDate(o.ordered_at)}</td>
                <td className="p-2 text-right">{o.buy_price_cny != null ? fenToYuan(fullCost(o)) : "—"}</td>
                <td className="p-2 text-muted-foreground">{o.note ?? ""}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {convertible && (
                      <Button size="sm" onClick={() => setConverting(o)}>转售出</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setCopying(o)}>复制</Button>
                    {targets.map((t) => (
                      <Button key={t} size="sm" variant="ghost" onClick={() => doAction(o, t)}>
                        {ACTION_LABEL[t] ?? STATUS_LABEL[t]}
                      </Button>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
          {orders.length === 0 && (
            <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">暂无囤货</td></tr>
          )}
        </tbody>
      </table>

      <OrderForm
        db={db}
        sites={sites}
        batches={batches}
        adjustmentGroups={adjustmentGroups}
        order={converting}
        convertShortcut
        open={converting != null}
        onClose={(done) => { setConverting(null); if (done) reload(); }}
      />
      <CopyOrderDialog db={db} order={copying} onClose={(done) => { setCopying(null); if (done) reload(); }} />
    </div>
  );
}
