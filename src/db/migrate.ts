import type { SqlDb } from "./types";
import { executeBatch } from "./transaction";

/**
 * user_version 顺序迁移（设计文档 §3.5）：
 * - 每个迁移脚本在单事务内执行，PRAGMA user_version = N 为事务最后一步
 * - 任一步失败整体回滚并向外抛错（启动序列阻止进入主界面）
 */

interface Migration {
  version: number;
  name: string;
  /** 事务内按序执行的语句（不含 user_version 推进，框架自动附加） */
  statements: string[];
}

/** v1：canonical DDL（设计文档 §3.6，唯一权威建表语句） */
const V1_DDL: string[] = [
  `CREATE TABLE sites (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT
  ) STRICT`,
  `CREATE TABLE products (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    default_site_id INTEGER REFERENCES sites(id),
    last_cost       INTEGER,
    use_count       INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  `CREATE TABLE batches (
    id                      INTEGER PRIMARY KEY,
    name                    TEXT NOT NULL UNIQUE,
    site_id                 INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
    currency                TEXT NOT NULL CHECK (currency IN ('AUD','USD','HKD')),
    exchange_rate           REAL,
    checkout_foreign_amount INTEGER,
    effective_rate          REAL,
    allocated_at            TEXT,
    allocated_checkout      INTEGER,
    allocated_rate          REAL,
    allocated_member_count  INTEGER,
    discount_note           TEXT,
    note                    TEXT,
    created_at              TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE orders (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no               TEXT NOT NULL UNIQUE,
    order_type             TEXT NOT NULL CHECK (order_type IN ('customer','stock')),
    status                 TEXT NOT NULL,
    batch_id               INTEGER REFERENCES batches(id),
    buyer_wechat           TEXT,
    buyer_alias            TEXT,
    region                 TEXT,
    product_name           TEXT NOT NULL,
    product_note           TEXT,
    site_id                INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
    reserved_at            TEXT,
    ordered_at             TEXT NOT NULL,
    shipped_at             TEXT,
    closed_at              TEXT,
    converted_from_stock_at TEXT,
    tracking_no            TEXT,
    cost_foreign_amount    INTEGER,
    cost_currency          TEXT,
    exchange_rate          REAL,
    buy_price_cny          INTEGER,
    buy_price_source       TEXT NOT NULL DEFAULT 'estimated'
                           CHECK (buy_price_source IN ('estimated','manual','batch_allocated')),
    sell_price_cny         INTEGER,
    shipping_fee           INTEGER,
    adjustments            TEXT NOT NULL DEFAULT '[]'
                           CHECK (json_valid(adjustments) AND json_type(adjustments) = 'array'),
    note                   TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    settlement_updated_at  TEXT,
    CHECK ((cost_foreign_amount IS NULL) = (cost_currency IS NULL)),
    CHECK (
      (order_type = 'customer' AND status IN ('paid_pending_ship','shipped','done','refunded','lost'))
      OR (order_type = 'stock' AND status IN ('in_stock','listed','consumed','lost'))
    ),
    CHECK (order_type <> 'customer' OR (buyer_wechat IS NOT NULL AND sell_price_cny IS NOT NULL)),
    CHECK (order_type <> 'stock' OR buy_price_cny IS NOT NULL)
  ) STRICT`,
  `CREATE INDEX idx_orders_status ON orders(status)`,
  `CREATE INDEX idx_orders_shipped_at ON orders(shipped_at)`,
  `CREATE INDEX idx_orders_batch_id ON orders(batch_id)`,
  `CREATE INDEX idx_orders_type_status ON orders(order_type, status)`,
  `CREATE INDEX idx_orders_site_id ON orders(site_id)`,
];

/** v2：集中维护的预估汇率表（issue #11）；币种仍是固定枚举，一行一币种 */
const V2_DDL: string[] = [
  `CREATE TABLE rates (
    currency   TEXT PRIMARY KEY CHECK (currency IN ('AUD','USD','HKD')),
    rate       REAL NOT NULL CHECK (rate > 0),
    updated_at TEXT NOT NULL
  ) STRICT`,
];

const MIGRATIONS: Migration[] = [
  { version: 1, name: "init", statements: V1_DDL },
  { version: 2, name: "rates", statements: V2_DDL },
];

export async function migrate(db: SqlDb): Promise<void> {
  const rows = await db.select<{ user_version: number }[]>(
    "PRAGMA user_version"
  );
  const current = rows[0]?.user_version ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );

  for (const m of pending) {
    try {
      // 整个迁移打成一条多语句 execute：单连接原子执行（sqlx 多语句迭代），
      // 池连接轮转/释放迟滞都无从发生；user_version 同事务最后一步
      const batch = [
        "BEGIN IMMEDIATE",
        ...m.statements,
        `PRAGMA user_version = ${m.version}`,
        "COMMIT",
      ].join(";\n");
      await executeBatch(db, batch);
    } catch (e) {
      throw new Error(
        `迁移 v${m.version} (${m.name}) 失败，已回滚: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
