import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listOrders, changeStatus } from "@/db/orders";
import { listBatches } from "@/db/batches";
import { convertStockToCustomer } from "@/db/inventory";
import { canConvertStock, fenToYuan, legalTargets, yuanToFen } from "@/db/rules";
import { STATUS_LABEL } from "@/lib/labels";
import { isoToLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BatchRow, OrderRow, OrderStatus, SiteRow, SqlDb } from "@/db/types";

const ROW_COLOR: Partial<Record<OrderStatus, string>> = {
  in_stock: "bg-purple-100",
  listed: "bg-purple-50",
  lost: "bg-red-200",
};

const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  listed: "挂单",
  in_stock: "下架",
  consumed: "自用",
  lost: "丢失",
};

export function InventoryPage({ db, sites }: { db: SqlDb; sites: SiteRow[] }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [converting, setConverting] = useState<OrderRow | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const [os, bs] = await Promise.all([
      listOrders(db, { status: ["in_stock", "listed", "consumed", "lost"] }),
      listBatches(db),
    ]);
    setOrders(os.filter((o) => o.order_type === "stock"));
    setBatches(bs);
  }, [db]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  const active = orders.filter((o) => o.status === "in_stock" || o.status === "listed");
  const totalCost = active.reduce((s, o) => s + (o.buy_price_cny ?? 0), 0);

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
          库存总成本：<b className="text-foreground">{fenToYuan(totalCost)}</b> 元 · {active.length} 件
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
                <td className="p-2 text-right">{o.buy_price_cny != null ? fenToYuan(o.buy_price_cny) : "—"}</td>
                <td className="p-2 text-muted-foreground">{o.note ?? ""}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    {convertible && (
                      <Button size="sm" onClick={() => setConverting(o)}>转售出</Button>
                    )}
                    {targets.map((t) => (
                      <Button key={t} size="sm" variant="ghost" onClick={() => doAction(o, t)}>
                        {ACTION_LABEL[t] ?? t}
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

      <ConvertDialog db={db} batches={batches} order={converting} onClose={(done) => { setConverting(null); if (done) reload(); }} />
    </div>
  );
}

function ConvertDialog({ db, batches, order, onClose }: { db: SqlDb; batches: BatchRow[]; order: OrderRow | null; onClose: (done: boolean) => void }) {
  const [wechat, setWechat] = useState("");
  const [alias, setAlias] = useState("");
  const [region, setRegion] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const [batchId, setBatchId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (order) {
      setWechat(""); setAlias(""); setRegion(""); setSellPrice("");
      setBatchId(order.batch_id != null ? String(order.batch_id) : "");
      setError("");
    }
  }, [order]);

  if (!order) return null;

  async function confirm() {
    setError("");
    try {
      await convertStockToCustomer(db, order!.id, {
        buyer_wechat: wechat,
        sell_price_cny: sellPrice ? yuanToFen(sellPrice) : null,
        buyer_alias: alias.trim() || null,
        region: region.trim() || null,
        batch_id: batchId ? Number(batchId) : null,
      });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open={order != null} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>转为售出 · {order.product_name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            成本 {order.buy_price_cny != null ? fenToYuan(order.buy_price_cny) : "—"} 元 · 购买日 {isoToLocalDate(order.ordered_at)}（均锁定不变）
          </p>
          <div>
            <Label>买家微信 *</Label>
            <Input value={wechat} onChange={(e) => setWechat(e.target.value)} />
          </div>
          <div>
            <Label>卖出价（元）*</Label>
            <Input value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <Label>买家备注名</Label>
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} />
          </div>
          <div>
            <Label>地区</Label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} />
          </div>
          <div>
            <Label>批次</Label>
            <Select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">散单</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={confirm} disabled={!wechat.trim() || !sellPrice}>确认转售出</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
