import type { BuyPriceSource, OrderStatus } from "@/db/types";

/** 状态/来源的中文标签，全局唯一（页面与导出共用） */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  paid_pending_ship: "待发货",
  shipped: "已发货",
  done: "完结",
  refunded: "退款",
  lost: "丢失",
  in_stock: "在库",
  listed: "挂单中",
  consumed: "自用",
};

export const SOURCE_LABEL: Record<BuyPriceSource, string> = {
  estimated: "预估",
  manual: "手动",
  batch_allocated: "分摊",
};
