/**
 * rules.ts — 业务规则唯一的家（设计文档铁律）。
 * 金额换算、汇率归一化、时间戳规则、canonical_profit、状态转移矩阵实现于此。
 */

import type { OrderRow, OrderStatus, OrderType } from "./types";

/** 当前时间，UTC ISO-8601（全局唯一入库格式） */
export function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * 汇率归一化：统一 round 到 6 位小数。
 * 入库前、比较前必须过此函数，规避二进制浮点表示误差。
 */
export function normRate(rate: number): number {
  return Number(rate.toFixed(6));
}

const MICRO = 1_000_000n;

/**
 * 外币最小单位 × 汇率 → 分，round half-up。
 * 十进制安全：汇率归一化后放大为整数微倍率，用 BigInt 精确计算，
 * 避开 4.715 存成 4.7149999… 导致的取整方向错误。
 */
export function foreignToFen(foreignMinor: number, rate: number): number {
  if (!Number.isInteger(foreignMinor)) throw new Error("外币金额必须是整数最小单位");
  if (foreignMinor < 0) throw new Error("外币成本不允许为负");
  const micros = BigInt(Math.round(normRate(rate) * 1e6));
  const prod = BigInt(foreignMinor) * micros;
  // half-up：加半个单位后整除
  const result = (prod + MICRO / 2n) / MICRO;
  return Number(result);
}

/** 分 → 「元」两位小数字符串（展示/导出用） */
export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${yuan}.${cents}`;
}

/** 「元」字符串 → 分（UI 输入解析用），非法输入抛错 */
export function yuanToFen(yuan: string): number {
  const trimmed = yuan.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`非法金额输入: ${yuan}`);
  }
  const negative = trimmed.startsWith("-");
  const [intPart, decPart = ""] = trimmed.replace("-", "").split(".");
  const fen =
    parseInt(intPart, 10) * 100 + parseInt((decPart + "00").slice(0, 2), 10);
  return negative ? -fen : fen;
}

/**
 * UTC ISO-8601 → 本地月份「YYYY-MM」（月度归属唯一入口）。
 * 收益按 shipped_at、丢失按 closed_at 的本地月归属。
 */
export function utcToLocalMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间戳: ${iso}`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// adjustments（§3.1 存储契约）
// ---------------------------------------------------------------------------

export interface Adjustment {
  kind: "cost" | "revenue";
  group: string;
  /** 整数最小单位，允许负数 */
  amount: number;
  note?: string | null;
}

/** 解析 adjustments JSON；解析失败 = 数据损坏，显式报错，不静默当 0 */
export function parseAdjustments(json: string): Adjustment[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("adjustments 数据损坏：非法 JSON");
  }
  if (!Array.isArray(data)) throw new Error("adjustments 数据损坏：不是数组");
  return data.map((item, i) => {
    const a = item as Partial<Adjustment>;
    if (a?.kind !== "cost" && a?.kind !== "revenue")
      throw new Error(`adjustments[${i}] kind 非法`);
    if (typeof a.group !== "string" || a.group.length === 0)
      throw new Error(`adjustments[${i}] group 必须非空`);
    if (!Number.isInteger(a.amount))
      throw new Error(`adjustments[${i}] amount 必须是整数`);
    return a as Adjustment;
  });
}

// ---------------------------------------------------------------------------
// canonical_profit（§5.1，全局唯一收益实现）
// ---------------------------------------------------------------------------

export type ProfitResult =
  | { kind: "ok"; value: number }
  | { kind: "incomplete" }
  | { kind: "excluded" };

export function canonicalProfit(order: OrderRow): ProfitResult {
  // refunded 恒 0：全额退款无需成本信息，先于缺成本判断
  if (order.status === "refunded") return { kind: "ok", value: 0 };

  if (order.order_type === "stock") {
    // 在库/挂单 = 资金占用非损益；自用无盈亏
    if (order.status === "lost") {
      return {
        kind: "ok",
        value: -fullCost(order),
      };
    }
    return { kind: "excluded" };
  }

  if (order.buy_price_cny === null) return { kind: "incomplete" };

  if (order.status === "lost") return { kind: "ok", value: -fullCost(order) };

  // paid_pending_ship / shipped / done
  const adj = parseAdjustments(order.adjustments);
  const revenueAdj = sumByKind(adj, "revenue");
  const costAdj = sumByKind(adj, "cost");
  return {
    kind: "ok",
    value:
      (order.sell_price_cny ?? 0) +
      revenueAdj -
      order.buy_price_cny -
      (order.shipping_fee ?? 0) -
      costAdj,
  };
}

function sumByKind(adj: Adjustment[], kind: Adjustment["kind"]): number {
  return adj.filter((a) => a.kind === kind).reduce((s, a) => s + a.amount, 0);
}

function fullCost(order: OrderRow): number {
  const costAdj = sumByKind(parseAdjustments(order.adjustments), "cost");
  return (
    (order.buy_price_cny ?? 0) + (order.shipping_fee ?? 0) + costAdj
  );
}

// ---------------------------------------------------------------------------
// 状态转移矩阵（§4.2，唯一实现）
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<OrderType, Record<string, OrderStatus[]>> = {
  customer: {
    paid_pending_ship: ["shipped", "refunded", "lost"],
    shipped: ["done", "refunded", "lost", "paid_pending_ship"],
    done: ["shipped"],
    refunded: ["paid_pending_ship", "shipped"],
    lost: ["paid_pending_ship", "shipped"],
  },
  stock: {
    in_stock: ["listed", "consumed", "lost"],
    listed: ["in_stock", "consumed", "lost"],
    consumed: ["in_stock"],
    lost: ["in_stock"],
  },
};

export function canTransition(
  type: OrderType,
  from: OrderStatus,
  to: OrderStatus
): boolean {
  return TRANSITIONS[type][from]?.includes(to) ?? false;
}

export function legalTargets(type: OrderType, from: OrderStatus): OrderStatus[] {
  return TRANSITIONS[type][from] ?? [];
}

const TERMINAL: Record<OrderType, OrderStatus[]> = {
  customer: ["done", "refunded", "lost"],
  stock: ["consumed", "lost"],
};

export function isTerminal(status: OrderStatus, type?: OrderType): boolean {
  if (type) return TERMINAL[type].includes(status);
  return TERMINAL.customer.includes(status) || TERMINAL.stock.includes(status);
}

/** 转 shipped / lost 前 buy_price_cny 必填（硬校验门槛） */
export function requiresBuyPrice(to: OrderStatus): boolean {
  return to === "shipped" || to === "lost";
}

/**
 * 状态变更时间戳兜底四条（§4.4），纯函数返回待写字段：
 * 1. 进 shipped → 补写 shipped_at（为空才写）
 * 2. 进终态 → 补写 closed_at（为空才写）
 * 3. 终态回退中间态 → 清空 closed_at
 * 4. 目标是 paid_pending_ship → 一律清 shipped_at（tracking_no 保留）
 */
export function statusChangePatch(
  order: OrderRow,
  to: OrderStatus,
  now: string
): Partial<OrderRow> {
  const patch: Partial<OrderRow> = { status: to };

  if (to === "shipped" && order.shipped_at === null) {
    patch.shipped_at = now;
  }
  if (isTerminal(to, order.order_type) && order.closed_at === null) {
    patch.closed_at = now;
  }
  if (isTerminal(order.status, order.order_type) && !isTerminal(to, order.order_type)) {
    patch.closed_at = null;
  }
  if (to === "paid_pending_ship") {
    patch.shipped_at = null;
  }
  return patch;
}
