import type { OrderRow } from "./types";
import { fenToYuan } from "./rules";
import { isoToLocalDate } from "@/lib/time";
import { SOURCE_LABEL, STATUS_LABEL } from "@/lib/labels";

/** CSV 导出（§6.5）：订单全字段 + batch_name，金额导出为「元」两位小数 */

function esc(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function yuan(fen: number | null): string {
  return fen == null ? "" : fenToYuan(fen);
}

function dt(iso: string | null): string {
  return iso ? isoToLocalDate(iso) : "";
}

export function ordersToCsv(
  orders: OrderRow[],
  batchNames: Map<number, string>
): string {
  const header = [
    "ID", "订单号", "类型", "状态", "批次", "买家微信", "买家备注", "地区",
    "商品", "款式备注", "预订时间", "下单时间", "发货时间", "关闭时间",
    "转售出时间", "快递单号", "外币成本", "币种", "订单汇率",
    "买入价(元)", "买入价来源", "卖出价(元)", "邮费(元)", "收支调整", "备注",
    "创建时间", "更新时间", "结算变更时间",
  ];
  const rows = orders.map((o) =>
    [
      String(o.id),
      o.order_no,
      o.order_type === "customer" ? "代购" : "囤货",
      STATUS_LABEL[o.status],
      o.batch_id != null ? (batchNames.get(o.batch_id) ?? "") : "",
      o.buyer_wechat ?? "",
      o.buyer_alias ?? "",
      o.region ?? "",
      o.product_name,
      o.product_note ?? "",
      dt(o.reserved_at),
      dt(o.ordered_at),
      dt(o.shipped_at),
      dt(o.closed_at),
      dt(o.converted_from_stock_at),
      o.tracking_no ?? "",
      yuan(o.cost_foreign_amount),
      o.cost_currency ?? "",
      o.exchange_rate != null ? String(o.exchange_rate) : "",
      yuan(o.buy_price_cny),
      SOURCE_LABEL[o.buy_price_source],
      yuan(o.sell_price_cny),
      yuan(o.shipping_fee),
      o.adjustments,
      o.note ?? "",
      dt(o.created_at),
      dt(o.updated_at),
      dt(o.settlement_updated_at),
    ]
      .map(esc)
      .join(",")
  );
  return [header.map(esc).join(","), ...rows].join("\n");
}
