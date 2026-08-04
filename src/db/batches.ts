import type { BatchRow, Currency, OrderRow, SqlDb } from "./types";
import { allocate, foreignToFen, normRate, nowUtc } from "./rules";

export interface BatchInput {
  name: string;
  site_id: number;
  currency: Currency;
  note?: string | null;
}

export async function createBatch(db: SqlDb, input: BatchInput): Promise<BatchRow> {
  if (!input.name.trim()) throw new Error("团名必填");
  await db.execute(
    "INSERT INTO batches (name, site_id, currency, note, created_at) VALUES (?,?,?,?,?)",
    [input.name.trim(), input.site_id, input.currency, input.note ?? null, nowUtc()]
  );
  const rows = await db.select<BatchRow[]>("SELECT * FROM batches WHERE name = ?", [input.name.trim()]);
  return rows[0];
}

export async function listBatches(db: SqlDb): Promise<BatchRow[]> {
  return db.select<BatchRow[]>("SELECT * FROM batches ORDER BY created_at DESC, id DESC");
}

export async function getBatch(db: SqlDb, id: number): Promise<BatchRow> {
  const rows = await db.select<BatchRow[]>("SELECT * FROM batches WHERE id = ?", [id]);
  if (!rows[0]) throw new Error(`团 #${id} 不存在`);
  return rows[0];
}

export async function updateBatch(
  db: SqlDb,
  id: number,
  patch: Partial<Pick<BatchRow, "name" | "exchange_rate" | "checkout_foreign_amount" | "discount_note" | "note">>
): Promise<BatchRow> {
  const fields: [string, unknown][] = [];
  if (patch.name !== undefined) fields.push(["name", patch.name]);
  if (patch.exchange_rate !== undefined)
    fields.push(["exchange_rate", patch.exchange_rate != null ? normRate(patch.exchange_rate) : null]);
  if (patch.checkout_foreign_amount !== undefined)
    fields.push(["checkout_foreign_amount", patch.checkout_foreign_amount]);
  if (patch.discount_note !== undefined) fields.push(["discount_note", patch.discount_note]);
  if (patch.note !== undefined) fields.push(["note", patch.note]);
  if (fields.length === 0) return getBatch(db, id);
  await db.execute(
    `UPDATE batches SET ${fields.map(([f]) => `${f} = ?`).join(", ")} WHERE id = ?`,
    [...fields.map(([, v]) => v), id]
  );
  return getBatch(db, id);
}

export async function deleteBatch(db: SqlDb, id: number): Promise<void> {
  await db.execute("UPDATE orders SET batch_id = NULL WHERE batch_id = ?", [id]);
  await db.execute("DELETE FROM batches WHERE id = ?", [id]);
}

export async function listMembers(db: SqlDb, batchId: number): Promise<OrderRow[]> {
  return db.select<OrderRow[]>(
    "SELECT * FROM orders WHERE batch_id = ? ORDER BY id",
    [batchId]
  );
}

/**
 * 团成员不变量（§3.2/§7.2，db/ 层事务校验）：
 * 必须外币成本必填且币种 == 团币种、site_id == 团网站；纯人民币单禁止入团。
 */
export async function assertBatchMembership(
  db: SqlDb,
  batchId: number,
  order: { site_id: number; cost_foreign_amount: number | null; cost_currency: string | null }
): Promise<void> {
  const batch = await getBatch(db, batchId);
  if (order.site_id !== batch.site_id) {
    throw new Error(`一团一站：订单网站与团「${batch.name}」的网站不一致`);
  }
  if (order.cost_foreign_amount == null || order.cost_currency == null) {
    throw new Error("纯人民币单不能入团：成员必须有外币成本");
  }
  if (order.cost_currency !== batch.currency) {
    throw new Error(`一团一币种：订单币种 ${order.cost_currency} ≠ 团币种 ${batch.currency}`);
  }
}

export type AllocateMode =
  | { mode: "checkout" }
  | { mode: "manual"; rate: number };

/**
 * 结算分摊（§5.3，单事务）：
 * T = checkout×团汇率（checkout 模式）或 Σ外币成本×输入汇率（手动模式，只取整一次）
 * → allocate() 分摊 → Σ≡T 校验 → 写 allocated_* 五字段。手动模式 allocated_checkout 存 NULL。
 */
export async function allocateBatch(
  db: SqlDb,
  batchId: number,
  mode: AllocateMode
): Promise<{ T: number; total: number }> {
  const batch = await getBatch(db, batchId);
  const members = await listMembers(db, batchId);

  if (members.length === 0) throw new Error("团内无订单，无法分摊");

  let T: number;
  let allocatedRate: number;
  let allocatedCheckout: number | null;

  if (mode.mode === "checkout") {
    if (batch.checkout_foreign_amount == null || batch.exchange_rate == null) {
      throw new Error("按结账结算需要填写实付总额与团汇率");
    }
    allocatedRate = normRate(batch.exchange_rate);
    allocatedCheckout = batch.checkout_foreign_amount;
    T = foreignToFen(batch.checkout_foreign_amount, batch.exchange_rate);
  } else {
    if (mode.rate == null) throw new Error("手动汇率模式需要输入汇率");
    allocatedRate = normRate(mode.rate);
    allocatedCheckout = null;
    const totalForeign = members.reduce((s, m) => s + (m.cost_foreign_amount ?? 0), 0);
    if (totalForeign <= 0) throw new Error("团内无外币成员，无法分摊");
    T = foreignToFen(totalForeign, mode.rate);
  }

  const results = allocate(members, T);

  await db.execute("BEGIN IMMEDIATE");
  try {
    for (const r of results) {
      await db.execute(
        "UPDATE orders SET buy_price_cny = ?, buy_price_source = 'batch_allocated', updated_at = ? WHERE id = ?",
        [r.buy_price_cny, nowUtc(), r.id]
      );
    }
    // 事务内校验：Σ(分摊后 buy_price) ≡ T，不等回滚
    const [{ total }] = await db.select<{ total: number }[]>(
      "SELECT COALESCE(SUM(buy_price_cny),0) AS total FROM orders WHERE batch_id = ?",
      [batchId]
    );
    if (total !== T) {
      throw new Error(`分摊校验失败：Σ=${total} ≠ T=${T}`);
    }
    const totalForeign = members.reduce((s, m) => s + (m.cost_foreign_amount ?? 0), 0);
    const effectiveRate =
      mode.mode === "checkout" && totalForeign > 0
        ? normRate(
            Number(
              (
                (BigInt(batch.checkout_foreign_amount!) *
                  BigInt(Math.round(normRate(batch.exchange_rate!) * 1e6))) /
                BigInt(totalForeign)
              )
            ) / 1e6
          )
        : null;
    await db.execute(
      `UPDATE batches SET allocated_at = ?, allocated_checkout = ?, allocated_rate = ?,
        allocated_member_count = ?, effective_rate = ? WHERE id = ?`,
      [nowUtc(), allocatedCheckout, allocatedRate, members.length, effectiveRate, batchId]
    );
    await db.execute("COMMIT");
    return { T, total };
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
}
