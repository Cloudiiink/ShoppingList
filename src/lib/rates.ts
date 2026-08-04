import { normRate } from "@/db/rules";
import type { Currency } from "@/db/types";

/**
 * 订单层预估汇率：open.er-api.com 免 key 查询。
 * 失败抛错，UI 降级为手填（§7.5：联网查询仅服务预估，团层权威汇率永远手填）。
 */
export async function fetchRate(currency: Currency): Promise<number> {
  const res = await fetch(`https://open.er-api.com/v6/latest/${currency}`);
  if (!res.ok) throw new Error(`汇率查询失败：HTTP ${res.status}`);
  const data = (await res.json()) as { result: string; rates?: { CNY?: number } };
  if (data.result !== "success" || data.rates?.CNY == null) {
    throw new Error("汇率查询失败：响应异常");
  }
  return normRate(data.rates.CNY);
}
