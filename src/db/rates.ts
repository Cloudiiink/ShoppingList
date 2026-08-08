import type { Currency, SqlDb } from "./types";
import { normRate, nowUtc } from "./rules";

/**
 * 集中维护的预估汇率表（issue #11，§7.5：仅服务订单层预估）。
 * 固定 3 行语义：币种是写死枚举（DB CHECK 同枚举），UI 固定渲染三行。
 */

export interface RateRow {
  currency: Currency;
  rate: number;
  updated_at: string;
}

export async function listRates(db: SqlDb): Promise<RateRow[]> {
  return db.select<RateRow[]>("SELECT * FROM rates ORDER BY currency");
}

export async function getRate(db: SqlDb, currency: Currency): Promise<RateRow | null> {
  const rows = await db.select<RateRow[]>(
    "SELECT * FROM rates WHERE currency = ?",
    [currency]
  );
  return rows[0] ?? null;
}

/** 手填/刷新统一入口：汇率过 normRate 归一化后 upsert */
export async function upsertRate(db: SqlDb, currency: Currency, rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`非法汇率：${rate}（必须为正数）`);
  }
  await db.execute(
    `INSERT INTO rates (currency, rate, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at`,
    [currency, normRate(rate), nowUtc()]
  );
}
