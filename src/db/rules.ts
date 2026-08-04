/**
 * rules.ts — 业务规则唯一的家（设计文档铁律）。
 * 金额换算、汇率归一化、时间戳规则实现于此；canonical_profit 与转移矩阵在 Ticket #3 加入。
 */

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
