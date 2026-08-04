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
import { yuanToFen } from "@/db/rules";
import { changeStatus, updateOrder } from "@/db/orders";
import type { OrderRow, SqlDb } from "@/db/types";

interface Props {
  db: SqlDb;
  order: OrderRow | null;
  onClose: (saved: boolean) => void;
}

/** 标记发货弹窗：快递单号（可空，面交跳过）+ 邮费；前置硬校验 buy_price 已填 */
export function ShipDialog({ db, order, onClose }: Props) {
  const [trackingNo, setTrackingNo] = useState("");
  const [shippingFee, setShippingFee] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (order) {
      setTrackingNo(order.tracking_no ?? "");
      setShippingFee("");
      setError("");
    }
  }, [order]);

  if (!order) return null;

  async function confirm() {
    setError("");
    try {
      const fee = shippingFee ? yuanToFen(shippingFee) : null;
      await updateOrder(db, order!.id, {
        tracking_no: trackingNo.trim() || null,
        shipping_fee: fee,
      });
      await changeStatus(db, order!.id, "shipped");
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open={order != null} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>标记发货 · {order.order_no}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>快递单号（面交可留空）</Label>
            <Input value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
          </div>
          <div>
            <Label>邮费（元）</Label>
            <Input value={shippingFee} onChange={(e) => setShippingFee(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={confirm}>确认发货</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
