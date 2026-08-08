import type { BatchRow, OrderRow } from "./types";
import { canonicalProfit, fullCost, settlementState, utcToLocalMonth } from "./rules";

/** 统计聚合（§6.4）：纯函数，输入全量订单/团，输出图表与卡片数据 */

export interface MonthBucket {
  /** 非 lost 收益合计（柱正段） */
  profit: number;
  /** lost 亏损合计，负数（红段堆叠） */
  lost: number;
}

/**
 * 月度收益：仅 shipped_at 非空的单按 shipped_at 本地月入 profit；
 * lost 单按 closed_at 本地月入 lost（负值）；refunded 不进收益曲线；
 * incomplete 跳过（UI 显示提示）。
 */
export function monthlyProfit(orders: OrderRow[]): Map<string, MonthBucket> {
  const map = new Map<string, MonthBucket>();
  const bucket = (month: string) => {
    let b = map.get(month);
    if (!b) {
      b = { profit: 0, lost: 0 };
      map.set(month, b);
    }
    return b;
  };
  for (const o of orders) {
    if (o.status === "lost") {
      if (!o.closed_at) continue;
      const p = canonicalProfit(o);
      if (p.kind === "ok") bucket(utcToLocalMonth(o.closed_at)).lost += p.value; // p.value 为负
      continue;
    }
    if (!o.shipped_at) continue; // paid_pending_ship 不归属月份；refunded 无 shipped_at 或被清
    if (o.status === "refunded") continue;
    const p = canonicalProfit(o);
    if (p.kind === "ok") bucket(utcToLocalMonth(o.shipped_at)).profit += p.value;
  }
  return map;
}

/** 近 N 个月（本地）YYYY-MM 列表，旧→新 */
export function lastNMonths(n: number, from = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(from.getFullYear(), from.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export interface Ledger {
  refundCount: number;
  refundTotal: number;
  lostCount: number;
  lostTotal: number;
}

/** 异常账本：退款/丢失按 closed_at 本地月过滤；month=null = 全部时间 */
export function abnormalLedger(orders: OrderRow[], month: string | null): Ledger {
  const r: Ledger = { refundCount: 0, refundTotal: 0, lostCount: 0, lostTotal: 0 };
  for (const o of orders) {
    if (o.status !== "refunded" && o.status !== "lost") continue;
    if (month && (!o.closed_at || utcToLocalMonth(o.closed_at) !== month)) continue;
    if (o.status === "refunded") {
      r.refundCount++;
      r.refundTotal += o.sell_price_cny ?? 0;
    } else {
      // lost 在转移时已硬校验 buy_price，正常不会 incomplete；防御性处理：
      // 单数永远计入，亏损额在可计算时累加，绝不静默当 0
      r.lostCount++;
      const p = canonicalProfit(o);
      if (p.kind === "ok") r.lostTotal += Math.abs(p.value);
    }
  }
  return r;
}

/** 未补成本单数（聚合提示用）：以 canonicalProfit 三态为唯一判据，页面不得复制分支 */
export function incompleteCount(orders: OrderRow[]): number {
  return orders.filter((o) => canonicalProfit(o).kind === "incomplete").length;
}

/** 待发货卡片：单数 + 最早等待天数 */
export function pendingShipInfo(orders: OrderRow[]): { count: number; oldestDays: number } {
  const pending = orders.filter((o) => o.status === "paid_pending_ship");
  let oldestDays = 0;
  for (const o of pending) {
    const days = Math.floor((Date.now() - new Date(o.ordered_at).getTime()) / 86_400_000);
    oldestDays = Math.max(oldestDays, days);
  }
  return { count: pending.length, oldestDays };
}

/** 库存占用卡片：in_stock/listed 完整成本（fullCost，含运费与成本调整）与件数 */
export function stockHolding(orders: OrderRow[]): { cost: number; count: number } {
  const held = orders.filter(
    (o) => o.order_type === "stock" && (o.status === "in_stock" || o.status === "listed")
  );
  return {
    cost: held.reduce((s, o) => s + fullCost(o), 0),
    count: held.length,
  };
}

/** 未结算团数：有成员且状态不是「已分摊」的团 */
export function unsettledBatchCount(
  batches: BatchRow[],
  membersByBatch: Map<number, OrderRow[]>
): number {
  return batches.filter((b) => {
    const members = membersByBatch.get(b.id) ?? [];
    if (members.length === 0) return false;
    return settlementState(b, members) !== "allocated";
  }).length;
}

/** 团收益对比：Σ canonical_profit（incomplete 跳过）+ 是否已分摊 */
export function batchProfitRows(
  batches: BatchRow[],
  membersByBatch: Map<number, OrderRow[]>
): { name: string; profit: number; allocated: boolean }[] {
  return batches.flatMap((b) => {
    const members = membersByBatch.get(b.id) ?? [];
    if (members.length === 0) return [];
    let profit = 0;
    for (const m of members) {
      const p = canonicalProfit(m);
      if (p.kind === "ok") profit += p.value;
    }
    return [{ name: b.name, profit, allocated: settlementState(b, members) === "allocated" }];
  });
}
