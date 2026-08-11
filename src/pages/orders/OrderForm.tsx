import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchRate } from "@/lib/rates";
import { getRate } from "@/db/rates";
import { isoToLocalInput, localInputToIso } from "@/lib/time";
import { foreignToFen, fenToYuan, yuanToFen, normRate, nowUtc, parseAdjustments } from "@/db/rules";
import type { Adjustment } from "@/db/rules";
import type {
  BatchRow,
  Currency,
  OrderRow,
  OrderStatus,
  OrderType,
  ProductRow,
  SiteRow,
  SqlDb,
} from "@/db/types";
import { CURRENCIES } from "@/db/types";
import { createOrder, updateOrder, changeStatus, type OrderInput } from "@/db/orders";
import { searchProducts } from "@/db/products";
import { legalTargets } from "@/db/rules";

interface Props {
  db: SqlDb;
  sites: SiteRow[];
  batches: BatchRow[];
  /** adjustments 分组联想（历史值） */
  adjustmentGroups: string[];
  /** 传入 = 编辑；null = 新建 */
  order: OrderRow | null;
  /** 从团详情「+ 加订单」进入：批次与币种锁定 */
  presetBatch?: BatchRow | null;
  open: boolean;
  onClose: (saved: boolean) => void;
}

interface FormState {
  order_type: OrderType;
  buyer_wechat: string;
  buyer_alias: string;
  region: string;
  product_name: string;
  product_note: string;
  site_id: string;
  batch_id: string;
  ordered_at: string;
  cost_foreign: string; // 折前外币原价（元，两位小数）；无折扣时 = 实付
  discount_rate: string; // 折扣率（如 0.88），空 = 无折扣
  cost_currency: string;
  exchange_rate: string;
  buy_price: string; // 人民币元
  buy_price_source: "estimated" | "manual" | "batch_allocated";
  sell_price: string;
  shipping_fee: string;
  adjustments: Adjustment[];
  note: string;
}

function initFrom(order: OrderRow | null, presetBatch?: BatchRow | null): FormState {
  const base: FormState = {
    order_type: order?.order_type ?? "customer",
    buyer_wechat: order?.buyer_wechat ?? "",
    buyer_alias: order?.buyer_alias ?? "",
    region: order?.region ?? "",
    product_name: order?.product_name ?? "",
    product_note: order?.product_note ?? "",
    site_id: order ? String(order.site_id) : "",
    batch_id: order?.batch_id != null ? String(order.batch_id) : "",
    ordered_at: isoToLocalInput(order?.ordered_at ?? nowUtc()),
    cost_foreign: order
      ? order.original_foreign_amount != null
        ? fenToYuan(order.original_foreign_amount)
        : order.cost_foreign_amount != null
          ? fenToYuan(order.cost_foreign_amount)
          : ""
      : "",
    discount_rate: order?.discount_rate != null ? String(order.discount_rate) : "",
    cost_currency: order?.cost_currency ?? "AUD",
    exchange_rate: order?.exchange_rate != null ? String(order.exchange_rate) : "",
    buy_price: order?.buy_price_cny != null ? fenToYuan(order.buy_price_cny) : "",
    buy_price_source: order?.buy_price_source ?? "estimated",
    sell_price: order?.sell_price_cny != null ? fenToYuan(order.sell_price_cny) : "",
    shipping_fee: order?.shipping_fee != null ? fenToYuan(order.shipping_fee) : "",
    adjustments: order ? parseAdjustments(order.adjustments) : [],
    note: order?.note ?? "",
  };
  if (!order && presetBatch) {
    base.batch_id = String(presetBatch.id);
    base.site_id = String(presetBatch.site_id);
    base.cost_currency = presetBatch.currency;
  }
  return base;
}

export function OrderForm({ db, sites, batches, adjustmentGroups, order, presetBatch, open, onClose }: Props) {
  const [f, setF] = useState<FormState>(() => initFrom(order, presetBatch));
  const [error, setError] = useState("");
  const [rateLoading, setRateLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ProductRow[]>([]);
  const [targetStatus, setTargetStatus] = useState<string>("");

  useEffect(() => {
    if (open) {
      setF(initFrom(order, presetBatch));
      setError("");
      setSuggestions([]);
      setTargetStatus("");
    }
  }, [open, order, presetBatch]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  // 折后外币成本（最小单位）：有折扣 = 原价 × 折扣率（四舍五入到外币最小单位）；
  // 无折扣 = 原价本身。折扣率非法时不派生（save 时报错）
  const costForeignMinor = useMemo(() => {
    if (!f.cost_foreign) return null;
    try {
      const orig = yuanToFen(f.cost_foreign);
      if (!f.discount_rate) return orig;
      const r = Number(f.discount_rate);
      if (!(r > 0 && r <= 1)) return null;
      return Math.round(orig * r);
    } catch {
      return null;
    }
  }, [f.cost_foreign, f.discount_rate]);

  // 汇率联动：仅 source = estimated 时随折后外币成本/汇率重算（§5.2）
  const linkedBuyPrice = useMemo(() => {
    if (f.buy_price_source !== "estimated") return null;
    if (costForeignMinor == null || !f.exchange_rate) return null;
    return foreignToFen(costForeignMinor, Number(f.exchange_rate));
  }, [costForeignMinor, f.exchange_rate, f.buy_price_source]);

  useEffect(() => {
    if (linkedBuyPrice != null) set("buy_price", fenToYuan(linkedBuyPrice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedBuyPrice]);

  async function onProductNameChange(v: string) {
    set("product_name", v);
    if (v.trim().length >= 1) {
      const found = await searchProducts(db, v.trim());
      setSuggestions(found.filter((p) => p.name !== v));
    } else {
      setSuggestions([]);
    }
  }

  function pickSuggestion(p: ProductRow) {
    setF((prev) => ({
      ...prev,
      product_name: p.name,
      site_id: p.default_site_id != null ? String(p.default_site_id) : prev.site_id,
      buy_price:
        prev.buy_price_source === "estimated" && p.last_cost != null && !prev.cost_foreign
          ? fenToYuan(p.last_cost)
          : prev.buy_price,
    }));
    setSuggestions([]);
  }

  // 汇率表预填（issue #11）：新建单时按币种从 rates 表静默预填；
  // 表里没有则清空（旧币种的汇率不该残留），「获取实时汇率」按钮兜底；
  // 编辑单不动（保留原单汇率）
  useEffect(() => {
    if (!open || order) return;
    let cancelled = false;
    getRate(db, f.cost_currency as Currency)
      .then((row) => {
        if (!cancelled) {
          setF((prev) => ({ ...prev, exchange_rate: row ? String(row.rate) : "" }));
        }
      })
      .catch(() => { /* 预填失败 = 留空手填 */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order, f.cost_currency, db]);

  async function onFetchRate() {
    setRateLoading(true);
    setError("");
    try {
      const rate = await fetchRate(f.cost_currency as Currency);
      set("exchange_rate", String(rate));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRateLoading(false);
    }
  }

  function setAdjustment(i: number, patch: Partial<Adjustment>) {
    set(
      "adjustments",
      f.adjustments.map((a, idx) => (idx === i ? { ...a, ...patch } : a))
    );
  }

  const adjTotal = f.adjustments.reduce((s, a) => s + (a.amount || 0), 0);

  async function save() {
    setError("");
    try {
      if (f.discount_rate) {
        const r = Number(f.discount_rate);
        if (!(r > 0 && r <= 1)) throw new Error("折扣率必须在 0-1 之间（如 0.88）");
        if (!f.cost_foreign) throw new Error("填写折扣率时必须填写外币原价");
      }
      // 非空但派生不出折后价 = 原价输入非法（memo 的 try/catch 只兜底展示，保存必须显式报错）
      if (f.cost_foreign && costForeignMinor == null) {
        throw new Error("外币原价输入非法（应为最多两位小数的金额）");
      }
      const input: OrderInput = {
        order_type: f.order_type,
        product_name: f.product_name.trim(),
        site_id: Number(f.site_id),
        batch_id: f.batch_id ? Number(f.batch_id) : null,
        buyer_wechat: f.buyer_wechat.trim() || null,
        buyer_alias: f.buyer_alias.trim() || null,
        region: f.region.trim() || null,
        product_note: f.product_note.trim() || null,
        ordered_at: localInputToIso(f.ordered_at) ?? nowUtc(),
        cost_foreign_amount: costForeignMinor,
        cost_currency: costForeignMinor != null ? (f.cost_currency as Currency) : null,
        discount_rate: f.discount_rate ? Number(f.discount_rate) : null,
        original_foreign_amount:
          f.discount_rate && f.cost_foreign ? yuanToFen(f.cost_foreign) : null,
        exchange_rate: f.exchange_rate ? normRate(Number(f.exchange_rate)) : null,
        buy_price_cny: f.buy_price ? yuanToFen(f.buy_price) : null,
        buy_price_source: f.buy_price_source,
        sell_price_cny: f.sell_price ? yuanToFen(f.sell_price) : null,
        shipping_fee: f.shipping_fee ? yuanToFen(f.shipping_fee) : null,
        adjustments: f.adjustments.filter((a) => a.group.trim() !== ""),
        note: f.note.trim() || null,
      };
      if (order) {
        await updateOrder(db, order.id, input);
        if (targetStatus) {
          await changeStatus(db, order.id, targetStatus as OrderStatus);
        }
      } else {
        await createOrder(db, input);
      }
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const targets = order ? legalTargets(order.order_type, order.status) : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{order ? `编辑订单 ${order.order_no}` : "新建订单"}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {!order && (
            <div>
              <Label>类型</Label>
              <Select value={f.order_type} onChange={(e) => set("order_type", e.target.value as OrderType)}>
                <option value="customer">代购</option>
                <option value="stock">囤货</option>
              </Select>
            </div>
          )}
          <div className="relative">
            <Label>商品名 *</Label>
            <Input value={f.product_name} onChange={(e) => onProductNameChange(e.target.value)} />
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow-md">
                {suggestions.map((p) => (
                  <button
                    key={p.name}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => pickSuggestion(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <Label>款式/备注</Label>
            <Input value={f.product_note} onChange={(e) => set("product_note", e.target.value)} />
          </div>
          <div>
            <Label>网站 *</Label>
            <Select value={f.site_id} onChange={(e) => set("site_id", e.target.value)}>
              <option value="">选择网站</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>批次（空 = 散单）</Label>
            <Select value={f.batch_id} disabled={!!presetBatch} onChange={(e) => set("batch_id", e.target.value)}>
              <option value="">散单</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </div>
          {f.order_type === "customer" && (
            <>
              <div>
                <Label>买家微信 *</Label>
                <Input value={f.buyer_wechat} onChange={(e) => set("buyer_wechat", e.target.value)} />
              </div>
              <div>
                <Label>买家备注名</Label>
                <Input value={f.buyer_alias} onChange={(e) => set("buyer_alias", e.target.value)} />
              </div>
              <div>
                <Label>地区</Label>
                <Input value={f.region} onChange={(e) => set("region", e.target.value)} />
              </div>
            </>
          )}
          <div>
            <Label>下单时间 *</Label>
            <Input type="datetime-local" value={f.ordered_at} onChange={(e) => set("ordered_at", e.target.value)} />
          </div>

          {/* 汇率区 */}
          <div>
            <Label>外币原价{f.discount_rate ? "（折前）" : "（无折扣 = 实付）"}</Label>
            <div className="flex gap-1">
              <Input value={f.cost_foreign} onChange={(e) => set("cost_foreign", e.target.value)} placeholder="0.00" />
              <Select className="w-24" value={f.cost_currency} disabled={!!presetBatch} onChange={(e) => set("cost_currency", e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label>折扣率（空 = 无折扣）</Label>
            <Input value={f.discount_rate} onChange={(e) => set("discount_rate", e.target.value)} placeholder="如 0.88" />
          </div>
          {f.discount_rate && costForeignMinor != null && (
            <div>
              <Label>折后外币金额</Label>
              <div className="py-1 text-sm font-medium">
                {fenToYuan(costForeignMinor)} {f.cost_currency}
              </div>
            </div>
          )}
          <div>
            <Label>汇率</Label>
            <div className="flex gap-1">
              <Input value={f.exchange_rate} onChange={(e) => set("exchange_rate", e.target.value)} placeholder="4.700000" />
              <Button type="button" variant="outline" size="sm" className="whitespace-nowrap" disabled={rateLoading} onClick={onFetchRate}>
                {rateLoading ? "查询中…" : "获取实时汇率"}
              </Button>
            </div>
          </div>
          <div>
            <Label>
              买入价（元）{f.order_type === "stock" && " *"}
              {f.buy_price_source === "manual" && (
                <span className="ml-2 text-xs text-orange-600">已手动修改</span>
              )}
              {f.buy_price_source === "batch_allocated" && (
                <span className="ml-2 text-xs text-blue-600">团分摊</span>
              )}
            </Label>
            <Input
              value={f.buy_price}
              onChange={(e) => {
                setF((prev) => ({ ...prev, buy_price: e.target.value, buy_price_source: "manual" }));
              }}
              placeholder="0.00"
            />
          </div>
          {f.order_type === "customer" && (
            <div>
              <Label>卖出价（元）*</Label>
              <Input value={f.sell_price} onChange={(e) => set("sell_price", e.target.value)} placeholder="0.00" />
            </div>
          )}
          <div>
            <Label>邮费（元）</Label>
            <Input value={f.shipping_fee} onChange={(e) => set("shipping_fee", e.target.value)} placeholder="0.00" />
          </div>
        </div>

        {/* adjustments 编辑器 */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label>收支调整</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set("adjustments", [...f.adjustments, { kind: "cost", group: "", amount: 0, note: null }])}
            >
              + 添加
            </Button>
          </div>
          <datalist id="adjustment-groups">
            {adjustmentGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          {f.adjustments.map((a, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <Select className="w-24" value={a.kind} onChange={(e) => setAdjustment(i, { kind: e.target.value as "cost" | "revenue" })}>
                <option value="cost">成本</option>
                <option value="revenue">收入</option>
              </Select>
              <Input placeholder="分组（如 关税）" list="adjustment-groups" value={a.group} onChange={(e) => setAdjustment(i, { group: e.target.value })} />
              <Input
                className={`w-28 ${a.amount < 0 ? "text-green-600" : ""}`}
                placeholder="金额（元）"
                defaultValue={a.amount !== 0 ? fenToYuan(a.amount) : ""}
                onBlur={(e) => {
                  try {
                    setAdjustment(i, { amount: e.target.value ? yuanToFen(e.target.value) : 0 });
                  } catch { /* 保留原值 */ }
                }}
              />
              <Input placeholder="备注" value={a.note ?? ""} onChange={(e) => setAdjustment(i, { note: e.target.value || null })} />
              <Button type="button" variant="ghost" size="sm" onClick={() => set("adjustments", f.adjustments.filter((_, idx) => idx !== i))}>
                ×
              </Button>
            </div>
          ))}
          {f.adjustments.length > 0 && (
            <div className="text-right text-sm text-muted-foreground">
              合计：{fenToYuan(adjTotal)} 元
            </div>
          )}
        </div>

        <div>
          <Label>备注</Label>
          <Textarea value={f.note} onChange={(e) => set("note", e.target.value)} />
        </div>

        {order && targets.length > 0 && (
          <div className="flex items-center gap-2">
            <Label>变更状态（当前 {order.status}）</Label>
            <Select className="w-48" value={targetStatus} onChange={(e) => setTargetStatus(e.target.value)}>
              <option value="">不变更</option>
              {targets.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
