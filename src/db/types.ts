/**
 * db/ 层对数据库的最小抽象：tauri-plugin-sql 的 Database 与测试里的
 * better-sqlite3 包装都满足这个接口，业务代码只依赖它。
 */
export interface SqlDb {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

/** 金额单位：分（或外币最小单位），INTEGER */
export type Fen = number;

export type OrderType = "customer" | "stock";
export type CustomerStatus =
  | "paid_pending_ship"
  | "shipped"
  | "done"
  | "refunded"
  | "lost";
export type StockStatus = "in_stock" | "listed" | "consumed" | "lost";
export type OrderStatus = CustomerStatus | StockStatus;
export type BuyPriceSource = "estimated" | "manual" | "batch_allocated";
export type Currency = "AUD" | "USD" | "HKD";

/** 币种固定枚举的唯一常量源（DB CHECK/表单下拉/rates 表三处语义共享，新增币种走代码变更） */
export const CURRENCIES: Currency[] = ["AUD", "USD", "HKD"];

export interface OrderRow {
  id: number;
  order_no: string;
  order_type: OrderType;
  status: OrderStatus;
  batch_id: number | null;
  buyer_wechat: string | null;
  buyer_alias: string | null;
  region: string | null;
  product_name: string;
  product_note: string | null;
  site_id: number;
  reserved_at: string | null;
  ordered_at: string;
  shipped_at: string | null;
  closed_at: string | null;
  converted_from_stock_at: string | null;
  tracking_no: string | null;
  cost_foreign_amount: number | null;
  cost_currency: Currency | null;
  exchange_rate: number | null;
  buy_price_cny: Fen | null;
  buy_price_source: BuyPriceSource;
  sell_price_cny: Fen | null;
  shipping_fee: Fen | null;
  adjustments: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  settlement_updated_at: string | null;
}

export interface BatchRow {
  id: number;
  name: string;
  site_id: number;
  currency: Currency;
  exchange_rate: number | null;
  checkout_foreign_amount: number | null;
  effective_rate: number | null;
  allocated_at: string | null;
  allocated_checkout: number | null;
  allocated_rate: number | null;
  allocated_member_count: number | null;
  discount_note: string | null;
  note: string | null;
  created_at: string;
}

export interface SiteRow {
  id: number;
  name: string;
  color: string | null;
}

export interface ProductRow {
  id: number;
  name: string;
  default_site_id: number | null;
  last_cost: Fen | null;
  use_count: number;
}
