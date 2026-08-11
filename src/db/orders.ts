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
  normRate,
  nowUtc,
  parseAdjustments,
  requiresBuyPrice,
  statusChangePatch,
} from "./rules";
import type { Adjustment } from "./rules";
import { assertBatchMembership, getBatch, isBatchSettled } from "./batches";
import { executeBatch } from "./transaction";

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
  /** 折扣率（如 0.88）；与 original_foreign_amount 必须同空同填 */
  discount_rate?: number | null;
  /** 折前外币原价（最小单位）；cost_foreign_amount 始终是折后价 */
  original_foreign_amount?: number | null;
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
  "discount_rate",
  "original_foreign_amount",
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
  // 折扣两列同生同灭（跨列 CHECK 无法随 ALTER 添加，语义闸在这里）
  const hasRate = input.discount_rate != null;
  const hasOriginal = input.original_foreign_amount != null;
  if (hasRate !== hasOriginal) {
    throw new Error("折扣率与折前原价必须同空同填");
  }
  if (hasRate) {
    const r = input.discount_rate!;
    if (!(r > 0 && r <= 1)) throw new Error("折扣率必须在 0-1 之间（如 0.88）");
    if (!hasAmount) throw new Error("有折扣的订单必须填写外币成本（折后价）");
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

  // 入团校验只读，无需纳入事务
  if (input.batch_id != null) {
    await assertBatchMembership(db, input.batch_id, {
      site_id: input.site_id,
      cost_foreign_amount: input.cost_foreign_amount ?? null,
      cost_currency: input.cost_currency ?? null,
    });
  }
  // 单窗口 + serialize 串行写入，不会并发取号；UNIQUE(order_no) 兜底
  const orderNo = await nextOrderNo(db);
  const hasSettlement =
    input.batch_id != null ||
    input.cost_foreign_amount != null ||
    input.buy_price_cny != null;

  // 单 execute 多语句批量事务：INSERT 订单 + upsert 商品在一条连接上一次
  // 完成，池连接轮转/释放迟滞无从拆散事务（根因见 transaction.ts 注释）
  await executeBatch(
    db,
    `BEGIN IMMEDIATE;
     INSERT INTO orders (
        order_no, order_type, status, batch_id, buyer_wechat, buyer_alias,
        region, product_name, product_note, site_id, reserved_at, ordered_at,
        tracking_no, cost_foreign_amount, cost_currency, discount_rate,
        original_foreign_amount, exchange_rate,
        buy_price_cny, buy_price_source, sell_price_cny, shipping_fee,
        adjustments, note, created_at, updated_at, settlement_updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
     INSERT INTO products (name, default_site_id, last_cost, use_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        use_count = use_count + 1,
        default_site_id = excluded.default_site_id,
        last_cost = COALESCE(excluded.last_cost, products.last_cost);
     COMMIT;`,
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
      input.discount_rate ?? null,
      input.original_foreign_amount ?? null,
      input.exchange_rate != null ? normRate(input.exchange_rate) : null,
      input.buy_price_cny ?? null,
      input.buy_price_source ?? "estimated",
      input.sell_price_cny ?? null,
      input.shipping_fee ?? null,
      JSON.stringify(input.adjustments ?? []),
      input.note ?? null,
      now,
      now,
      hasSettlement ? now : null,
      // products upsert 的绑定（sqlx 跨语句按顺序偏移绑定）
      input.product_name,
      input.site_id,
      input.buy_price_cny ?? null,
    ]
  );
  const rows = await db.select<OrderRow[]>(
    "SELECT * FROM orders WHERE order_no = ?",
    [orderNo]
  );
  return rows[0];
}

export async function getOrder(db: SqlDb, id: number): Promise<OrderRow> {
  const rows = await db.select<OrderRow[]>("SELECT * FROM orders WHERE id = ?", [id]);
  if (!rows[0]) throw new Error(`订单 #${id} 不存在`);
  return rows[0];
}

/** 一键复制份数上限（CopyOrderDialog 与 db 层共用） */
export const MAX_COPY_COUNT = 20;

/**
 * 一键复制（issue #11）：用源单的商品/成本信息建 count 条新囤货单（stock/in_stock）。
 * customer 单复制即转囤货单。逐条走 createOrder，继承全部校验/CHECK/入团闸/连号。
 * 注意：逐条独立事务，**非原子**——中途失败会留下已创建的部分副本（份数 ≤20，风险可接受）。
 * 清空：买家四件套、卖出价、运费、快递单号；adjustments 只留 kind=cost；
 * 折扣信息（discount_rate + 折前原价）随副本继承（issue #12）；
 * batch_id 仅团未结算才保留（batch_allocated 必已结算 → 降级 manual 并记散单）。
 */
export async function copyOrdersAsStock(
  db: SqlDb,
  sourceId: number,
  count: number
): Promise<OrderRow[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COPY_COUNT) {
    throw new Error(`份数必须是 1-${MAX_COPY_COUNT} 的整数`);
  }
  const src = await getOrder(db, sourceId);
  if (src.buy_price_cny === null) {
    throw new Error("该单尚未补成本，无法复制为囤货单，请先补成本");
  }

  let batchId: number | null = null;
  if (src.batch_id !== null) {
    const b = await getBatch(db, src.batch_id);
    if (!isBatchSettled(b)) batchId = b.id; // 未结算才保留
  }

  const input: OrderInput = {
    order_type: "stock",
    product_name: src.product_name,
    product_note: src.product_note,
    site_id: src.site_id,
    batch_id: batchId,
    reserved_at: src.reserved_at,
    cost_foreign_amount: src.cost_foreign_amount,
    cost_currency: src.cost_currency,
    discount_rate: src.discount_rate,
    original_foreign_amount: src.original_foreign_amount,
    exchange_rate: src.exchange_rate,
    buy_price_cny: src.buy_price_cny,
    buy_price_source: src.buy_price_source === "batch_allocated" ? "manual" : src.buy_price_source,
    adjustments: parseAdjustments(src.adjustments).filter((a) => a.kind === "cost"),
    note: src.note,
  };

  const out: OrderRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await createOrder(db, input));
  }
  return out;
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
    discount_rate: existing.discount_rate,
    original_foreign_amount: existing.original_foreign_amount,
    exchange_rate: existing.exchange_rate,
    buy_price_cny: existing.buy_price_cny,
    buy_price_source: existing.buy_price_source,
    sell_price_cny: existing.sell_price_cny,
    shipping_fee: existing.shipping_fee,
    adjustments: parseAdjustments(existing.adjustments),
    note: existing.note,
    ...patch,
  };
  validate(merged);

  // 成员不变量：只要编辑后仍在团内就必须持续成立（改 site/币种/清空外币也受约束）
  if (merged.batch_id != null) {
    await assertBatchMembership(db, merged.batch_id, {
      site_id: merged.site_id,
      cost_foreign_amount: merged.cost_foreign_amount ?? null,
      cost_currency: merged.cost_currency ?? null,
    });
  }

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
    ["discount_rate", merged.discount_rate ?? null],
    ["original_foreign_amount", merged.original_foreign_amount ?? null],
    ["exchange_rate", merged.exchange_rate != null ? normRate(merged.exchange_rate) : null],
    ["buy_price_cny", merged.buy_price_cny ?? null],
    ["buy_price_source", merged.buy_price_source ?? "estimated"],
    ["sell_price_cny", merged.sell_price_cny ?? null],
    ["shipping_fee", merged.shipping_fee ?? null],
    ["adjustments", JSON.stringify(merged.adjustments ?? [])],
    ["note", merged.note ?? null],
    ["updated_at", now],
  ];
  if (settlementTouched) fields.push(["settlement_updated_at", now]);

  await runUpdate(db, id, fields);
  return getOrder(db, id);
}

/** 动态 UPDATE 构建（updateOrder / changeStatus 共用） */
async function runUpdate(
  db: SqlDb,
  id: number,
  fields: [string, unknown][]
): Promise<void> {
  const sql = `UPDATE orders SET ${fields.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`;
  await db.execute(sql, [...fields.map(([, v]) => v), id]);
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
  await runUpdate(db, id, [...Object.entries(patch), ["updated_at", now]]);
  return getOrder(db, id);
}

/**
 * 标记发货（单事务）：先校验 buy_price 硬门槛，再同事务写快递单号/邮费 + 转 shipped。
 * 仅从 paid_pending_ship 发起；lost/refunded 的纠错回退走通用 changeStatus。
 * 任一失败整体回滚，不留部分写入。
 */
export async function shipOrder(
  db: SqlDb,
  id: number,
  shipping: { tracking_no: string | null; shipping_fee: number | null }
): Promise<OrderRow> {
  const order = await getOrder(db, id);
  if (order.status !== "paid_pending_ship") {
    throw new Error(`当前状态 ${order.status} 不能标记发货`);
  }
  if (order.buy_price_cny === null) {
    throw new Error("发货前必须填写买入价");
  }
  const now = nowUtc();
  const patch = statusChangePatch(order, "shipped", now);
  const fields: [string, unknown][] = [
    ["tracking_no", shipping.tracking_no],
    ["shipping_fee", shipping.shipping_fee],
    ...Object.entries(patch),
    ["updated_at", now],
  ];
  // 单 execute 批量事务（见 createOrder 注释）
  const setClause = fields.map(([f]) => `${f} = ?`).join(", ");
  await executeBatch(
    db,
    `BEGIN IMMEDIATE; UPDATE orders SET ${setClause} WHERE id = ?; COMMIT;`,
    [...fields.map(([, v]) => v), id]
  );
  return getOrder(db, id);
}

/** adjustments 分组联想：返回历史出现过的全部分组名 */
export async function listAdjustmentGroups(db: SqlDb): Promise<string[]> {
  const rows = await db.select<{ adjustments: string }[]>(
    "SELECT adjustments FROM orders WHERE adjustments <> '[]'"
  );
  const groups = new Set<string>();
  for (const r of rows) {
    for (const a of parseAdjustments(r.adjustments)) groups.add(a.group);
  }
  return [...groups].sort();
}

export async function deleteOrder(db: SqlDb, id: number): Promise<void> {
  await db.execute("DELETE FROM orders WHERE id = ?", [id]);
}
