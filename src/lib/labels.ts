import type { BuyPriceSource, OrderStatus, OrderType } from "@/db/types";

/**
 * 前端展示中文标签的唯一来源（页面与导出共用）。
 * 状态机/操作按钮/类型等英文枚举不得直接出现在 UI，统一从这里取中文。
 */

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

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  customer: "代购",
  stock: "囤货",
};

/** 状态跳转动作文案（目标状态 → 动词）；缺失时回退 STATUS_LABEL */
export const ACTION_LABEL: Partial<Record<OrderStatus, string>> = {
  shipped: "标记发货",
  done: "完结",
  refunded: "退款",
  lost: "丢失",
  paid_pending_ship: "回退待发货",
  in_stock: "下架/回在库",
  listed: "挂单",
  consumed: "自用",
};
