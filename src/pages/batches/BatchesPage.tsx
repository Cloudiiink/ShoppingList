import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  allocateBatch,
  createBatch,
  deleteBatch,
  listBatches,
  listMembers,
  previewAllocation,
  updateBatch,
} from "@/db/batches";
import { updateOrder } from "@/db/orders";
import {
  canonicalProfit,
  fenToYuan,
  settlementState,
  yuanToFen,
  type SettlementState,
} from "@/db/rules";
import { SOURCE_LABEL } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { BatchRow, Currency, OrderRow, SiteRow, SqlDb } from "@/db/types";
import { OrderForm } from "@/pages/orders/OrderForm";
import { listAdjustmentGroups } from "@/db/orders";

const STATE_LABEL: Record<SettlementState, { text: string; className: string }> = {
  unsettled: { text: "预估", className: "text-muted-foreground" },
  pending: { text: "待分摊", className: "text-blue-600" },
  allocated: { text: "已分摊", className: "text-green-600" },
  stale: { text: "待重新分摊", className: "text-orange-600" },
};

export function BatchesPage({ db, sites }: { db: SqlDb; sites: SiteRow[] }) {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [members, setMembers] = useState<OrderRow[]>([]);
  const [adjGroups, setAdjGroups] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [allocOpen, setAllocOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const bs = await listBatches(db);
    setBatches(bs);
    if (selected != null) setMembers(await listMembers(db, selected));
  }, [db, selected]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  useEffect(() => {
    listAdjustmentGroups(db).then(setAdjGroups).catch(() => {});
  }, [db]);

  const batch = batches.find((b) => b.id === selected) ?? null;

  // ---------------- 详情 ----------------
  if (batch) {
    return (
      <BatchDetail
        db={db}
        sites={sites}
        batch={batch}
        members={members}
        adjGroups={adjGroups}
        batches={batches}
        error={error}
        setError={setError}
        onBack={() => { setSelected(null); reload(); }}
        onChanged={reload}
        allocOpen={allocOpen}
        setAllocOpen={setAllocOpen}
        addMemberOpen={addMemberOpen}
        setAddMemberOpen={setAddMemberOpen}
      />
    );
  }

  // ---------------- 列表 ----------------
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">团</h2>
        <Button onClick={() => setCreateOpen(true)}>新建团</Button>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>}
      <BatchTable db={db} sites={sites} batches={batches} onOpen={(id) => setSelected(id)} />
      <CreateBatchDialog db={db} sites={sites} open={createOpen} onClose={(saved) => { setCreateOpen(false); if (saved) reload(); }} />
    </div>
  );
}

/** 列表行：需成员数据计算订单数/外币合计/状态/收益，逐团懒加载 */
function BatchTable({ db, sites, batches, onOpen }: { db: SqlDb; sites: SiteRow[]; batches: BatchRow[]; onOpen: (id: number) => void }) {
  const [stats, setStats] = useState<Record<number, { total: number; inProgress: number; foreign: number; state: SettlementState; profit: number | null }>>({});

  useEffect(() => {
    (async () => {
      const out: typeof stats = {};
      for (const b of batches) {
        const ms = await listMembers(db, b.id);
        const inProgress = ms.filter((m) => m.status === "paid_pending_ship" || m.status === "shipped").length;
        const foreign = ms.reduce((s, m) => s + (m.cost_foreign_amount ?? 0), 0);
        let profit: number | null = 0;
        for (const m of ms) {
          const p = canonicalProfit(m);
          if (p.kind === "incomplete") { profit = null; continue; }
          if (p.kind === "ok" && profit !== null) profit += p.value;
        }
        out[b.id] = { total: ms.length, inProgress, foreign, state: settlementState(b, ms), profit };
      }
      setStats(out);
    })();
  }, [db, batches]);

  const siteName = (id: number) => sites.find((s) => s.id === id)?.name ?? "";

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="p-2">团名</th>
          <th className="p-2">网站</th>
          <th className="p-2">币种</th>
          <th className="p-2">订单数</th>
          <th className="p-2 text-right">外币成本合计</th>
          <th className="p-2">结算状态</th>
          <th className="p-2 text-right">收益</th>
        </tr>
      </thead>
      <tbody>
        {batches.map((b) => {
          const s = stats[b.id];
          const st = s ? STATE_LABEL[s.state] : null;
          return (
            <tr key={b.id} className="cursor-pointer border-b hover:bg-accent" onClick={() => onOpen(b.id)}>
              <td className="p-2 font-medium">{b.name}</td>
              <td className="p-2">{siteName(b.site_id)}</td>
              <td className="p-2">{b.currency}</td>
              <td className="p-2">{s ? `${s.inProgress}/${s.total}` : "…"}</td>
              <td className="p-2 text-right">{s ? `${fenToYuan(s.foreign)} ${b.currency}` : "…"}</td>
              <td className={cn("p-2", st?.className)}>{st?.text ?? "…"}</td>
              <td className="p-2 text-right">{s ? (s.profit === null ? "—" : fenToYuan(s.profit)) : "…"}</td>
            </tr>
          );
        })}
        {batches.length === 0 && (
          <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">暂无团</td></tr>
        )}
      </tbody>
    </table>
  );
}

function CreateBatchDialog({ db, sites, open, onClose }: { db: SqlDb; sites: SiteRow[]; open: boolean; onClose: (saved: boolean) => void }) {
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [currency, setCurrency] = useState<Currency>("AUD");
  const [error, setError] = useState("");

  useEffect(() => { if (open) { setName(""); setSiteId(""); setError(""); } }, [open]);

  async function save() {
    try {
      await createBatch(db, { name, site_id: Number(siteId), currency });
      onClose(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>新建团</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>团名 *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="202608-JAYD 一团" /></div>
          <div>
            <Label>网站 *（一团一站，成员单必须同站）</Label>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">选择网站</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>币种 *（一团一币种）</Label>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="AUD">AUD</option><option value="USD">USD</option><option value="HKD">HKD</option>
            </Select>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={save} disabled={!name.trim() || !siteId}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DetailProps {
  db: SqlDb; sites: SiteRow[]; batch: BatchRow; members: OrderRow[];
  adjGroups: string[]; batches: BatchRow[];
  error: string; setError: (s: string) => void;
  onBack: () => void; onChanged: () => Promise<void>;
  allocOpen: boolean; setAllocOpen: (b: boolean) => void;
  addMemberOpen: boolean; setAddMemberOpen: (b: boolean) => void;
}

function BatchDetail({ db, sites, batch, members, adjGroups, batches, error, setError, onBack, onChanged, allocOpen, setAllocOpen, addMemberOpen, setAddMemberOpen }: DetailProps) {
  const [checkout, setCheckout] = useState("");
  const [rate, setRate] = useState("");

  useEffect(() => {
    setCheckout(batch.checkout_foreign_amount != null ? fenToYuan(batch.checkout_foreign_amount) : "");
    setRate(batch.exchange_rate != null ? String(batch.exchange_rate) : "");
  }, [batch]);

  const state = settlementState(batch, members);
  const st = STATE_LABEL[state];

  const foreignTotal = members.reduce((s, m) => s + (m.cost_foreign_amount ?? 0), 0);
  const checkoutFen = checkout ? safeFen(checkout) : null;
  const diff = checkoutFen != null ? foreignTotal - checkoutFen : null;

  const costTotal = members.reduce((s, m) => s + (m.buy_price_cny ?? 0), 0);
  const stockHolding = members
    .filter((m) => m.order_type === "stock" && (m.status === "in_stock" || m.status === "listed"))
    .reduce((s, m) => s + (m.buy_price_cny ?? 0), 0);
  const profitInfo = useMemo(() => {
    let sum = 0, incomplete = 0;
    for (const m of members) {
      const p = canonicalProfit(m);
      if (p.kind === "ok") sum += p.value;
      else if (p.kind === "incomplete") incomplete++;
    }
    return { sum, incomplete };
  }, [members]);

  function safeFen(v: string): number | null {
    try { return yuanToFen(v); } catch { return null; }
  }

  async function saveSettlement() {
    setError("");
    try {
      await updateBatch(db, batch.id, {
        checkout_foreign_amount: checkoutFen,
        exchange_rate: rate ? Number(rate) : null,
      });
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function removeMember(o: OrderRow) {
    await updateOrder(db, o.id, { batch_id: null });
    await onChanged();
  }

  async function doDeleteBatch() {
    if (!window.confirm(`确认删除团「${batch.name}」？成员单将变为散单。`)) return;
    await deleteBatch(db, batch.id);
    onBack();
  }

  const canAllocate = members.length > 0 && members.some((m) => m.buy_price_source !== "manual");

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>← 返回</Button>
        <h2 className="text-lg font-semibold">{batch.name}</h2>
        <span className={cn("text-sm font-medium", st.className)}>{st.text}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="text-destructive" onClick={doDeleteBatch}>删除团</Button>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-destructive">{error}</div>}

      {/* 结算区 */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label>外币成本合计</Label>
            <div className="py-1 text-lg font-semibold">{fenToYuan(foreignTotal)} {batch.currency}</div>
          </div>
          <div>
            <Label>实付总额（{batch.currency}）</Label>
            <Input className="w-36" value={checkout} onChange={(e) => setCheckout(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <Label>结算汇率</Label>
            <Input className="w-32" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="4.700000" />
          </div>
          <Button variant="outline" size="sm" onClick={saveSettlement}>保存结算信息</Button>
          <div className="flex-1" />
          <Button disabled={!canAllocate} onClick={() => setAllocOpen(true)}>结算分摊</Button>
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <span>
            结算差额：
            {diff != null ? (
              <span className={cn(diff !== 0 && "font-semibold text-orange-600")}>
                {fenToYuan(diff)} {batch.currency}{diff !== 0 && "（非 0，检查录单）"}
              </span>
            ) : "—"}
          </span>
          {batch.effective_rate != null && (
            <span>等效汇率：{batch.effective_rate}（含折扣/批次费，仅展示）</span>
          )}
        </div>
        <div className="flex flex-wrap gap-6 border-t pt-3 text-sm">
          <span>团成本：<b>{fenToYuan(costTotal)}</b>{state === "allocated" ? "（实际）" : "（预估）"}</span>
          <span>未售库存占用：<b>{fenToYuan(stockHolding)}</b></span>
          <span>
            团收益：<b>{fenToYuan(profitInfo.sum)}</b>
            {profitInfo.incomplete > 0 && (
              <span className="ml-2 text-orange-600">{profitInfo.incomplete} 单未补成本，统计不完整</span>
            )}
          </span>
        </div>
      </div>

      {/* 成员表 */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium">成员订单（{members.length}）</h3>
        <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>+ 加订单</Button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="p-2">订单号</th><th className="p-2">商品</th><th className="p-2">买家</th>
            <th className="p-2">状态</th><th className="p-2 text-right">外币成本</th>
            <th className="p-2 text-right">买入价</th><th className="p-2">来源</th>
            <th className="p-2 text-right">收益</th><th className="p-2"></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const p = canonicalProfit(m);
            return (
              <tr key={m.id} className="border-b">
                <td className="p-2 font-mono text-xs">{m.order_no}</td>
                <td className="p-2">{m.product_name}{m.order_type === "stock" && "（囤）"}</td>
                <td className="p-2">{m.buyer_alias || m.buyer_wechat || ""}</td>
                <td className="p-2">{m.status}</td>
                <td className="p-2 text-right">{m.cost_foreign_amount != null ? `${fenToYuan(m.cost_foreign_amount)} ${m.cost_currency}` : "—"}</td>
                <td className="p-2 text-right">{m.buy_price_cny != null ? fenToYuan(m.buy_price_cny) : "—"}</td>
                <td className="p-2 text-xs text-muted-foreground">
                  {SOURCE_LABEL[m.buy_price_source]}
                </td>
                <td className="p-2 text-right">{p.kind === "ok" ? fenToYuan(p.value) : p.kind === "incomplete" ? "—" : ""}</td>
                <td className="p-2">
                  <Button size="sm" variant="ghost" onClick={() => removeMember(m)}>移出</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <AllocateDialog db={db} batch={batch} members={members} open={allocOpen} onClose={(done) => { setAllocOpen(false); if (done) onChanged(); }} />
      <OrderForm
        db={db}
        sites={sites}
        batches={batches}
        adjustmentGroups={adjGroups}
        order={null}
        open={addMemberOpen}
        presetBatch={batch}
        onClose={(saved) => { setAddMemberOpen(false); if (saved) onChanged(); }}
      />
    </div>
  );
}

function AllocateDialog({ db, batch, members, open, onClose }: { db: SqlDb; batch: BatchRow; members: OrderRow[]; open: boolean; onClose: (done: boolean) => void }) {
  const [mode, setMode] = useState<"checkout" | "manual">("checkout");
  const [manualRate, setManualRate] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ T: number; F: number; P: number; locked: OrderRow[]; zeros: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError("");
    setManualRate(batch.exchange_rate != null ? String(batch.exchange_rate) : "");
    setMode(batch.checkout_foreign_amount != null ? "checkout" : "manual");
  }, [open, batch]);

  // 预览：T/F/P 构成逐行列出（与 allocateBatch 共用 computeTarget，防漂移）
  useEffect(() => {
    if (!open) return;
    const mode_ = mode === "checkout" ? { mode } as const : { mode, rate: Number(manualRate) } as const;
    setPreview(previewAllocation(batch, members, mode_));
  }, [open, mode, manualRate, batch, members]);

  async function run() {
    setError("");
    try {
      await allocateBatch(db, batch.id, mode === "checkout" ? { mode } : { mode, rate: Number(manualRate) });
      onClose(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>结算分摊 · {batch.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>模式</Label>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "checkout" | "manual")}>
              <option value="checkout">按结账结算（实付总额 × 团汇率）</option>
              <option value="manual">手动汇率（Σ外币成本 × 输入汇率）</option>
            </Select>
          </div>
          {mode === "manual" && (
            <div>
              <Label>汇率</Label>
              <Input value={manualRate} onChange={(e) => setManualRate(e.target.value)} />
            </div>
          )}
          {mode === "checkout" && (batch.checkout_foreign_amount == null || batch.exchange_rate == null) && (
            <p className="text-sm text-orange-600">请先在结算区填写实付总额与结算汇率</p>
          )}
          {preview && (
            <div className="space-y-1 rounded-md bg-muted p-3 text-sm">
              <div>目标总额 T = <b>{fenToYuan(preview.T)}</b></div>
              <div>固定部分 F = {fenToYuan(preview.F)}{preview.locked.length > 0 && `（锁定 ${preview.locked.length} 单：${preview.locked.map((m) => m.order_no).join("、")}）`}</div>
              <div>可分摊池 P = T − F = <b className={cn(preview.P < 0 && "text-destructive")}>{fenToYuan(preview.P)}</b></div>
              {preview.P < 0 && <p className="text-destructive">固定成本超过目标总额，禁止分摊</p>}
              {preview.zeros > 0 && <p className="text-orange-600">P = 0：{preview.zeros} 单将被分出 0 成本</p>}
            </div>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>取消</Button>
          <Button onClick={run} disabled={!preview || preview.P < 0}>确认分摊</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
