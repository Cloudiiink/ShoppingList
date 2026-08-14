import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyOrders, MAX_COPY_COUNT } from "@/db/orders";
import type { OrderRow, SqlDb } from "@/db/types";

/**
 * 一键复制对话框（issue #15）：源单 → N 条全量副本（保留类型与全部业务字段）。
 */
export function CopyOrderDialog({
  db,
  order,
  onClose,
}: {
  db: SqlDb;
  order: OrderRow | null;
  onClose: (done: boolean) => void;
}) {
  const [count, setCount] = useState("1");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (order) {
      setCount("1");
      setError("");
      setBusy(false);
    }
  }, [order]);

  if (!order) return null;

  async function confirm() {
    setError("");
    setBusy(true);
    try {
      await copyOrders(db, order!.id, Number(count));
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open={order != null} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>复制订单 · {order.product_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            将创建 N 条全量副本（保留类型：{order.order_type === "customer" ? "代购" : "囤货"}，各自新订单号）。
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>保留：类型、商品、网站、买家、卖出价、运费、快递单号、外币/折扣/汇率、调整、备注</li>
            <li>重置：订单号（连号）、状态（新单初始态）、发货/完结时间戳</li>
            <li>批次照搬进原团；已分摊的团会因此变「待重新分摊」</li>
          </ul>
          <div>
            <Label>份数（1-{MAX_COPY_COUNT}）</Label>
            <Input
              type="number"
              min={1}
              max={MAX_COPY_COUNT}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={confirm} disabled={busy}>确认复制</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
