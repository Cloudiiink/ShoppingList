import { Button } from "@/components/ui/button";
import { canonicalProfit, fenToYuan, legalTargets } from "@/db/rules";
import { SOURCE_LABEL, STATUS_LABEL } from "@/lib/labels";
import { isoToLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BatchRow, OrderRow, OrderStatus, SiteRow } from "@/db/types";

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

interface Props {
  orders: OrderRow[];
  sites: SiteRow[];
  batches: BatchRow[];
  /** 隐藏批次列（团详情锁定本团时用） */
  hideBatch?: boolean;
  /** 显示外币成本与买入价来源列（团详情用） */
  showForeign?: boolean;
  onEdit: (o: OrderRow) => void;
  onShip: (o: OrderRow) => void;
  onStatus: (o: OrderRow, to: OrderStatus) => void;
  onDelete: (o: OrderRow) => void;
  /** 行尾额外操作（如团详情的「移出」） */
  extraAction?: (o: OrderRow) => React.ReactNode;
  emptyText?: string;
}

/** 订单列表共享组件：订单页与团详情成员表复用（§6.2） */
export function OrdersTable({
  orders,
  sites,
  batches,
  hideBatch,
  showForeign,
  onEdit,
  onShip,
  onStatus,
  onDelete,
  extraAction,
  emptyText = "暂无订单",
}: Props) {
  const batchName = (id: number | null) => batches.find((b) => b.id === id)?.name ?? "";
  const siteName = (id: number) => sites.find((s) => s.id === id)?.name ?? "";

  function handleStatus(o: OrderRow, to: OrderStatus) {
    if (to === "shipped" && o.status === "paid_pending_ship") {
      onShip(o);
      return;
    }
    if (to === "done" && o.shipping_fee == null) {
      if (!window.confirm("邮费未填，收益将按 0 邮费计算，仍要完结？")) return;
    }
    onStatus(o, to);
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="p-2">订单号</th>
          <th className="p-2">类型</th>
          <th className="p-2">商品</th>
          <th className="p-2">买家</th>
          <th className="p-2">网站</th>
          {!hideBatch && <th className="p-2">批次</th>}
          <th className="p-2">状态</th>
          <th className="p-2">下单日</th>
          {showForeign && <th className="p-2 text-right">外币成本</th>}
          <th className="p-2 text-right">买入</th>
          {showForeign && <th className="p-2">来源</th>}
          <th className="p-2 text-right">卖出</th>
          <th className="p-2 text-right">邮费</th>
          <th className="p-2 text-right">收益</th>
          <th className="p-2">操作</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const profit = canonicalProfit(o);
          const targets = legalTargets(o.order_type, o.status);
          const shippingMissing = IN_PROGRESS.includes(o.status) && o.shipping_fee == null;
          return (
            <tr key={o.id} className={cn("border-b", ROW_COLOR[o.status])}>
              <td className="p-2 font-mono text-xs">{o.order_no}</td>
              <td className="p-2">{o.order_type === "customer" ? "代购" : "囤货"}</td>
              <td className="p-2">{o.product_name}</td>
              <td className="p-2">{o.buyer_alias || o.buyer_wechat || ""}</td>
              <td className="p-2">{siteName(o.site_id)}</td>
              {!hideBatch && <td className="p-2">{batchName(o.batch_id)}</td>}
              <td className="p-2">{STATUS_LABEL[o.status]}</td>
              <td className="p-2">{isoToLocalDate(o.ordered_at)}</td>
              {showForeign && (
                <td className="p-2 text-right">
                  {o.cost_foreign_amount != null ? `${fenToYuan(o.cost_foreign_amount)} ${o.cost_currency}` : "—"}
                </td>
              )}
              <td className="p-2 text-right">{o.buy_price_cny != null ? fenToYuan(o.buy_price_cny) : "—"}</td>
              {showForeign && (
                <td className="p-2 text-xs text-muted-foreground">{SOURCE_LABEL[o.buy_price_source]}</td>
              )}
              <td className="p-2 text-right">{o.sell_price_cny != null ? fenToYuan(o.sell_price_cny) : "—"}</td>
              <td className={cn("p-2 text-right", shippingMissing && "bg-orange-300")}>
                {o.shipping_fee != null ? fenToYuan(o.shipping_fee) : "—"}
              </td>
              <td className="p-2 text-right">
                {profit.kind === "ok" ? fenToYuan(profit.value) : profit.kind === "incomplete" ? "—" : ""}
              </td>
              <td className="p-2">
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" onClick={() => onEdit(o)}>编辑</Button>
                  {targets.map((t) => (
                    <Button key={t} size="sm" variant="ghost" onClick={() => handleStatus(o, t)}>
                      {ACTION_LABEL[t] ?? STATUS_LABEL[t]}
                    </Button>
                  ))}
                  {extraAction?.(o)}
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onDelete(o)}>
                    删除
                  </Button>
                </div>
              </td>
            </tr>
          );
        })}
        {orders.length === 0 && (
          <tr>
            <td colSpan={(hideBatch ? 12 : 13) + (showForeign ? 2 : 0)} className="p-8 text-center text-muted-foreground">
              {emptyText}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
