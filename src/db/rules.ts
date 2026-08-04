/**
 * rules.ts — 业务规则唯一的家（设计文档铁律）。
 * 金额换算、汇率归一化、时间戳规则、canonical_profit、状态转移矩阵实现于此。
 */

import type { BatchRow, OrderRow, OrderStatus, OrderType } from "./types";

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

/** 进行中状态集（订单页筛选/提醒条/表格共用） */
export const IN_PROGRESS_STATUSES: OrderStatus[] = ["paid_pending_ship", "shipped"];

// ---------------------------------------------------------------------------
// 转售出（§6.3，矩阵外的特殊动作，合法来源规则同样只住在这里）
// ---------------------------------------------------------------------------

const CONVERTIBLE_STOCK: OrderStatus[] = ["in_stock", "listed", "consumed"];

/** 囤货转售出合法来源：lost 需先按矩阵回退 in_stock */
export function canConvertStock(status: OrderStatus): boolean {
  return CONVERTIBLE_STOCK.includes(status);
}

// ---------------------------------------------------------------------------
// 结算分摊（§5.3）
// ---------------------------------------------------------------------------

export interface AllocationMember {
  id: number;
  cost_foreign_amount: number | null;
  buy_price_cny: number | null;
  buy_price_source: "estimated" | "manual" | "batch_allocated";
}

export interface AllocationResult {
  id: number;
  buy_price_cny: number;
}

/**
 * 分摊算法：F = manual 成员锁定不动，P = T − F 按外币成本权重分摊，
 * floor 后余数按最大余数法逐分补齐（并列 order_id 小者优先）。
 * 构造性保证 Σ结果 ≡ T。分母只含可分摊单的外币成本。
 */
export function allocate(
  members: AllocationMember[],
  T: number
): AllocationResult[] {
  const locked = members.filter((m) => m.buy_price_source === "manual");
  const eligible = members.filter((m) => m.buy_price_source !== "manual");

  if (eligible.length === 0) {
    throw new Error("无可分摊单：所有成员成本均已手动锁定");
  }
  const F = locked.reduce((s, m) => s + (m.buy_price_cny ?? 0), 0);
  const P = T - F;
  if (P < 0) {
    throw new Error(
      `固定成本 ¥${F / 100} 已超过目标总额 ¥${T / 100}，请检查 manual 成本或 checkout/汇率`
    );
  }

  // 成员必须是外币成员（入团校验保证），防御性检查
  const denom = eligible.reduce(
    (s, m) => s + BigInt(m.cost_foreign_amount ?? 0),
    0n
  );
  if (denom <= 0n) throw new Error("可分摊单外币成本合计必须大于 0");

  const bigP = BigInt(P);
  const shares = eligible.map((m) => {
    const prod = bigP * BigInt(m.cost_foreign_amount!);
    return {
      id: m.id,
      floor: prod / denom,
      remainder: prod % denom,
    };
  });

  let leftover = bigP - shares.reduce((s, x) => s + x.floor, 0n);
  // 最大余数法：余数降序，并列 order_id 小者优先
  const order = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.id - b.id
      : a.remainder > b.remainder
        ? -1
        : 1
  );
  const bonus = new Map<number, number>();
  for (const s of order) {
    if (leftover <= 0n) break;
    bonus.set(s.id, 1);
    leftover -= 1n;
  }

  return shares.map((s) => ({
    id: s.id,
    buy_price_cny: Number(s.floor) + (bonus.get(s.id) ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// 结算四态（§3.2 派生，不落库；按锚点分支）
// ---------------------------------------------------------------------------

export type SettlementState = "unsettled" | "pending" | "allocated" | "stale";

export function settlementState(
  batch: BatchRow,
  members: Pick<OrderRow, "settlement_updated_at">[]
): SettlementState {
  if (batch.exchange_rate === null) return "unsettled";
  if (batch.allocated_at === null) return "pending";
  if (batch.allocated_rate !== batch.exchange_rate) return "stale";
  // checkout 模式锚定 checkout；手动模式 allocated_checkout 存 NULL 不参与
  if (
    batch.allocated_checkout !== null &&
    batch.allocated_checkout !== batch.checkout_foreign_amount
  ) {
    return "stale";
  }
  if (members.length !== batch.allocated_member_count) return "stale";
  if (
    members.some(
      (m) =>
        m.settlement_updated_at !== null &&
        m.settlement_updated_at > batch.allocated_at!
    )
  ) {
    return "stale";
  }
  return "allocated";
}
