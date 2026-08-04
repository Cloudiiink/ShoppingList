import type {
  Currency,
  OrderRow,
  OrderStatus,
  OrderType,
  SqlDb,
} from "./types";
import {
  canTransition,
  legalTargets,
  nowUtc,
  requiresBuyPrice,
  statusChangePatch,
} from "./rules";
import type { Adjustment } from "./rules";

/** 创建/编辑订单的输入 */
export interface OrderInput {
  order_type: OrderType;
  product_name: string;
  site_id: number;
  batch_id?: number | null;
  buyer_wechat?: string | null;
  buyer_alias?: string | null;
  region?: string | null;
  product_note?: string | null;
  reserved_at?: string | null;
  ordered_at?: string;
  tracking_no?: string | null;
  cost_foreign_amount?: number | null;
  cost_currency?: Currency | null;
  exchange_rate?: number | null;
  buy_price_cny?: number | null;
  buy_price_source?: "estimated" | "manual" | "batch_allocated";
  sell_price_cny?: number | null;
  shipping_fee?: number | null;
  adjustments?: Adjustment[];
  note?: string | null;
}

const SETTLEMENT_FIELDS = [
  "cost_foreign_amount",
  "cost_currency",
  "buy_price_cny",
  "buy_price_source",
  "batch_id",
] as const;

/** validateOrder：条件不变量的数据层唯一校验（与 DB CHECK 同规则） */
function validate(input: OrderInput): void {
  if (input.order_type === "customer") {
    if (!input.buyer_wechat) throw new Error("代购单必须填写买家微信");
    if (input.sell_price_cny == null) throw new Error("代购单必须填写卖出价");
  }
  if (input.order_type === "stock" && input.buy_price_cny == null) {
    throw new Error("囤货单必须填写买入价");
  }
  const hasAmount = input.cost_foreign_amount != null;
  const hasCurrency = input.cost_currency != null;
  if (hasAmount !== hasCurrency) {
    throw new Error("外币金额与币种必须同空同填");
  }
  if (!input.product_name?.trim()) throw new Error("商品名必填");
  if (!input.site_id) throw new Error("网站必选");
}

/** 下一订单号：本地日期 + 当日序号；只统计 canonical 格式 `^\d{8}-\d+$` */
export async function nextOrderNo(db: SqlDb): Promise<string> {
  const t = new Date();
  const ymd = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, "0")}${String(t.getDate()).padStart(2, "0")}`;
  const rows = await db.select<{ order_no: string }[]>(
    "SELECT order_no FROM orders WHERE order_no LIKE ?",
    [`${ymd}-%`]
  );
  let max = 0;
  const re = new RegExp(`^${ymd}-(\\d+)$`);
  for (const r of rows) {
    const m = re.exec(r.order_no);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${ymd}-${max + 1}`;
}

export async function createOrder(
  db: SqlDb,
  input: OrderInput
): Promise<OrderRow> {
  validate(input);
  const now = nowUtc();
  const status: OrderStatus =
    input.order_type === "customer" ? "paid_pending_ship" : "in_stock";

  // BEGIN IMMEDIATE 内取当日最大序号 +1，UNIQUE 约束兜底
  await db.execute("BEGIN IMMEDIATE");
  try {
    const orderNo = await nextOrderNo(db);
    const hasSettlement =
      input.batch_id != null ||
      input.cost_foreign_amount != null ||
      input.buy_price_cny != null;
    await db.execute(
      `INSERT INTO orders (
        order_no, order_type, status, batch_id, buyer_wechat, buyer_alias,
        region, product_name, product_note, site_id, reserved_at, ordered_at,
        tracking_no, cost_foreign_amount, cost_currency, exchange_rate,
        buy_price_cny, buy_price_source, sell_price_cny, shipping_fee,
        adjustments, note, created_at, updated_at, settlement_updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        orderNo,
        input.order_type,
        status,
        input.batch_id ?? null,
        input.buyer_wechat ?? null,
        input.buyer_alias ?? null,
        input.region ?? null,
        input.product_name,
        input.product_note ?? null,
        input.site_id,
        input.reserved_at ?? null,
        input.ordered_at ?? now,
        input.tracking_no ?? null,
        input.cost_foreign_amount ?? null,
        input.cost_currency ?? null,
        input.exchange_rate ?? null,
        input.buy_price_cny ?? null,
        input.buy_price_source ?? "estimated",
        input.sell_price_cny ?? null,
        input.shipping_fee ?? null,
        JSON.stringify(input.adjustments ?? []),
        input.note ?? null,
        now,
        now,
        hasSettlement ? now : null,
      ]
    );
    await upsertProduct(db, input.product_name, input.site_id, input.buy_price_cny ?? null);
    await db.execute("COMMIT");
    const rows = await db.select<OrderRow[]>(
      "SELECT * FROM orders WHERE order_no = ?",
      [orderNo]
    );
    return rows[0];
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
}

async function upsertProduct(
  db: SqlDb,
  name: string,
  siteId: number,
  lastCost: number | null
): Promise<void> {
  await db.execute(
    `INSERT INTO products (name, default_site_id, last_cost, use_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET
       use_count = use_count + 1,
       default_site_id = excluded.default_site_id,
       last_cost = COALESCE(excluded.last_cost, products.last_cost)`,
    [name, siteId, lastCost]
  );
}

export async function getOrder(db: SqlDb, id: number): Promise<OrderRow> {
  const rows = await db.select<OrderRow[]>("SELECT * FROM orders WHERE id = ?", [id]);
  if (!rows[0]) throw new Error(`订单 #${id} 不存在`);
  return rows[0];
}

export interface OrderFilter {
  status?: OrderStatus[];
  batchId?: number | null;
  search?: string;
}

export async function listOrders(
  db: SqlDb,
  filter: OrderFilter = {}
): Promise<OrderRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  if (filter.batchId !== undefined) {
    if (filter.batchId === null) {
      where.push("batch_id IS NULL");
    } else {
      where.push("batch_id = ?");
      params.push(filter.batchId);
    }
  }
  if (filter.search?.trim()) {
    where.push(
      "(buyer_wechat LIKE ? OR buyer_alias LIKE ? OR product_name LIKE ? OR order_no LIKE ?)"
    );
    const like = `%${filter.search.trim()}%`;
    params.push(like, like, like, like);
  }
  const sql = `SELECT * FROM orders${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return db.select<OrderRow[]>(sql, params);
}

export async function updateOrder(
  db: SqlDb,
  id: number,
  patch: Partial<OrderInput>
): Promise<OrderRow> {
  const existing = await getOrder(db, id);
  const merged: OrderInput = {
    order_type: existing.order_type,
    product_name: existing.product_name,
    site_id: existing.site_id,
    batch_id: existing.batch_id,
    buyer_wechat: existing.buyer_wechat,
    buyer_alias: existing.buyer_alias,
    region: existing.region,
    product_note: existing.product_note,
    reserved_at: existing.reserved_at,
    ordered_at: existing.ordered_at,
    tracking_no: existing.tracking_no,
    cost_foreign_amount: existing.cost_foreign_amount,
    cost_currency: existing.cost_currency,
    exchange_rate: existing.exchange_rate,
    buy_price_cny: existing.buy_price_cny,
    buy_price_source: existing.buy_price_source,
    sell_price_cny: existing.sell_price_cny,
    shipping_fee: existing.shipping_fee,
    adjustments: JSON.parse(existing.adjustments),
    note: existing.note,
    ...patch,
  };
  validate(merged);

  const now = nowUtc();
  const settlementTouched = SETTLEMENT_FIELDS.some(
    (f) => f in patch && patch[f as keyof OrderInput] !== existing[f]
  );

  const fields: [string, unknown][] = [
    ["batch_id", merged.batch_id ?? null],
    ["buyer_wechat", merged.buyer_wechat ?? null],
    ["buyer_alias", merged.buyer_alias ?? null],
    ["region", merged.region ?? null],
    ["product_name", merged.product_name],
    ["product_note", merged.product_note ?? null],
    ["site_id", merged.site_id],
    ["reserved_at", merged.reserved_at ?? null],
    ["ordered_at", merged.ordered_at ?? existing.ordered_at],
    ["tracking_no", merged.tracking_no ?? null],
    ["cost_foreign_amount", merged.cost_foreign_amount ?? null],
    ["cost_currency", merged.cost_currency ?? null],
    ["exchange_rate", merged.exchange_rate ?? null],
    ["buy_price_cny", merged.buy_price_cny ?? null],
    ["buy_price_source", merged.buy_price_source ?? "estimated"],
    ["sell_price_cny", merged.sell_price_cny ?? null],
    ["shipping_fee", merged.shipping_fee ?? null],
    ["adjustments", JSON.stringify(merged.adjustments ?? [])],
    ["note", merged.note ?? null],
    ["updated_at", now],
  ];
  if (settlementTouched) fields.push(["settlement_updated_at", now]);

  const sql = `UPDATE orders SET ${fields.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`;
  await db.execute(sql, [...fields.map(([, v]) => v), id]);
  return getOrder(db, id);
}

/** 状态变更统一入口：转移矩阵前置校验 + 硬校验门槛 + 时间戳兜底四条 */
export async function changeStatus(
  db: SqlDb,
  id: number,
  to: OrderStatus
): Promise<OrderRow> {
  const order = await getOrder(db, id);
  if (!canTransition(order.order_type, order.status, to)) {
    throw new Error(
      `非法状态转移：${order.order_type} 从 ${order.status} 不能到 ${to}（合法目标：${legalTargets(order.order_type, order.status).join("/") || "无"}）`
    );
  }
  if (requiresBuyPrice(to) && order.buy_price_cny === null) {
    throw new Error(`转 ${to} 前必须填写买入价`);
  }
  const now = nowUtc();
  const patch = statusChangePatch(order, to, now);
  const fields = Object.entries(patch);
  await db.execute(
    `UPDATE orders SET ${fields.map(([f]) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    [...fields.map(([, v]) => v), now, id]
  );
  return getOrder(db, id);
}

export async function deleteOrder(db: SqlDb, id: number): Promise<void> {
  await db.execute("DELETE FROM orders WHERE id = ?", [id]);
}
