import type { OrderRow, SqlDb } from "./types";
import { getOrder } from "./orders";
import { assertBatchMembership } from "./batches";
import { canConvertStock, nowUtc } from "./rules";
import { withTransaction } from "./transaction";

export interface ConvertInput {
  buyer_wechat: string;
  sell_price_cny: number | null;
  buyer_alias?: string | null;
  region?: string | null;
  batch_id?: number | null;
}

/**
 * 转售出（单事务）：清 closed_at（consumed 时有值）→
 * order_type→customer、status→paid_pending_ship、写 converted_from_stock_at。
 * 成本与购买日锁定不变。合法来源规则见 rules.ts canConvertStock。
 */
export async function convertStockToCustomer(
  db: SqlDb,
  id: number,
  input: ConvertInput
): Promise<OrderRow> {
  const order = await getOrder(db, id);
  if (order.order_type !== "stock") {
    throw new Error("只有囤货单可以转售出");
  }
  if (!canConvertStock(order.status)) {
    throw new Error(`lost 状态的囤货不能直接转售出，请先回退到在库`);
  }
  if (!input.buyer_wechat.trim()) throw new Error("转售出必须填写买家微信");
  if (input.sell_price_cny == null) throw new Error("转售出必须填写卖出价");
  const sellPrice = input.sell_price_cny;

  const now = nowUtc();
  return withTransaction(db, async () => {
    if (input.batch_id != null) {
      await assertBatchMembership(db, input.batch_id, {
        site_id: order.site_id,
        cost_foreign_amount: order.cost_foreign_amount,
        cost_currency: order.cost_currency,
      });
    }
    await db.execute(
      `UPDATE orders SET
        order_type = 'customer', status = 'paid_pending_ship',
        buyer_wechat = ?, sell_price_cny = ?,
        buyer_alias = COALESCE(?, buyer_alias), region = COALESCE(?, region),
        batch_id = ?, closed_at = NULL, converted_from_stock_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.buyer_wechat.trim(),
        sellPrice,
        input.buyer_alias ?? null,
        input.region ?? null,
        input.batch_id ?? order.batch_id,
        now,
        now,
        id,
      ]
    );
    return getOrder(db, id);
  });
}
