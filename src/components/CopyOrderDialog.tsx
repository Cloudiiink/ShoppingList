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
import { copyOrdersAsStock, MAX_COPY_COUNT } from "@/db/orders";
import type { OrderRow, SqlDb } from "@/db/types";

/**
 * 一键复制对话框（issue #11）：源单 → N 条新囤货单（stock/in_stock）。
 * customer 单复制即转囤货单；缺成本单禁止复制。
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
  const noCost = order.buy_price_cny === null;

  async function confirm() {
    setError("");
    setBusy(true);
    try {
      await copyOrdersAsStock(db, order!.id, Number(count));
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
          <DialogTitle>复制为囤货单 · {order.product_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            将创建 N 条新囤货单（在库状态，各自新订单号）。
            {order.order_type === "customer" && "本单是客户单，复制后即转为囤货单。"}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>保留：商品、网站、买入价、外币金额/币种、汇率、成本侧调整、备注</li>
            <li>清空：买家信息、卖出价、运费、快递单号</li>
            <li>批次仅当团未结算时保留，否则记为散单</li>
          </ul>
          {noCost ? (
            <p className="text-sm text-destructive">
              该单尚未补成本，无法复制为囤货单，请先补成本
            </p>
          ) : (
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
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={confirm} disabled={noCost || busy}>确认复制</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
