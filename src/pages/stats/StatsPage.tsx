import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Select } from "@/components/ui/select";
import { listOrders } from "@/db/orders";
import { listBatches, listMembers } from "@/db/batches";
import {
  abnormalLedger,
  batchProfitRows,
  incompleteCount,
  lastNMonths,
  monthlyProfit,
  pendingShipInfo,
  stockHolding,
  unsettledBatchCount,
} from "@/db/stats";
import { fenToYuan, utcToLocalMonth } from "@/db/rules";
import type { BatchRow, OrderRow, SqlDb } from "@/db/types";

export function StatsPage({ db }: { db: SqlDb }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [membersByBatch, setMembersByBatch] = useState<Map<number, OrderRow[]>>(new Map());
  const [ledgerMonth, setLedgerMonth] = useState<string>("all");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const [os, bs] = await Promise.all([listOrders(db), listBatches(db)]);
    setOrders(os);
    setBatches(bs);
    const map = new Map<number, OrderRow[]>();
    for (const b of bs) map.set(b.id, await listMembers(db, b.id));
    setMembersByBatch(map);
  }, [db]);

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  const months12 = useMemo(() => lastNMonths(12), []);
  const monthly = useMemo(() => monthlyProfit(orders), [orders]);
  const currentMonth = utcToLocalMonth(new Date().toISOString());
  const thisMonth = monthly.get(currentMonth) ?? { profit: 0, lost: 0 };
  const incomplete = useMemo(() => incompleteCount(orders), [orders]);
  const pending = useMemo(() => pendingShipInfo(orders), [orders]);
  const holding = useMemo(() => stockHolding(orders), [orders]);
  const unsettled = useMemo(() => unsettledBatchCount(batches, membersByBatch), [batches, membersByBatch]);

  const barData = months12.map((m) => {
    const b = monthly.get(m) ?? { profit: 0, lost: 0 };
    return { month: m.slice(2), 收益: b.profit / 100, 丢失亏损: b.lost / 100 };
  });

  const batchRows = useMemo(() => batchProfitRows(batches, membersByBatch), [batches, membersByBatch]);
  const batchData = batchRows.map((r) => ({
    name: r.name,
    收益: r.profit / 100,
    allocated: r.allocated,
  }));

  const ledger = useMemo(
    () => abnormalLedger(orders, ledgerMonth === "all" ? null : ledgerMonth),
    [orders, ledgerMonth]
  );
  const ledgerMonths = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      if ((o.status === "refunded" || o.status === "lost") && o.closed_at) {
        set.add(utcToLocalMonth(o.closed_at));
      }
    }
    return [...set].sort().reverse();
  }, [orders]);

  if (error) {
    return <div className="p-4 text-sm text-destructive">{error}</div>;
  }

  if (orders.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p>还没有任何订单。</p>
        <p className="text-sm">到订单页录第一单后，这里的收益卡片、图表和异常账本就有数据了。</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* 卡片 ×4 */}
      <div className="grid grid-cols-4 gap-3">
        <Card title="本月收益（发货口径）" value={`${fenToYuan(thisMonth.profit)} 元`}>
          {thisMonth.lost !== 0 && (
            <p className="text-xs text-red-600">丢失亏损 {fenToYuan(thisMonth.lost)} 元</p>
          )}
          {incomplete > 0 && (
            <p className="text-xs text-orange-600">{incomplete} 单未补成本，统计不完整</p>
          )}
        </Card>
        <Card title="待发货" value={`${pending.count} 单`}>
          {pending.count > 0 && <p className="text-xs text-muted-foreground">最早等待 {pending.oldestDays} 天</p>}
        </Card>
        <Card title="库存占用" value={`${fenToYuan(holding.cost)} 元`}>
          <p className="text-xs text-muted-foreground">{holding.count} 件</p>
        </Card>
        <Card title="未结算团" value={`${unsettled} 个`} />
      </div>

      {/* 图表 ×2 */}
      <div className="grid grid-cols-2 gap-4">
        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-medium">近 12 个月收益</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(v) => `${Number(v).toFixed(2)} 元`} />
              <Bar dataKey="收益" stackId="a" fill="#22c55e" />
              <Bar dataKey="丢失亏损" stackId="a" fill="#ef4444" />
            </BarChart>
          </ResponsiveContainer>
        </section>
        <section className="rounded-lg border p-4">
          <h3 className="mb-2 font-medium">按团收益对比（半透明 = 未分摊）</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={batchData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" fontSize={12} />
              <YAxis type="category" dataKey="name" fontSize={12} width={140} />
              <Tooltip formatter={(v) => `${Number(v).toFixed(2)} 元`} />
              <Bar dataKey="收益">
                {batchData.map((d, i) => (
                  <Cell key={i} fill="#3b82f6" fillOpacity={d.allocated ? 1 : 0.35} />
                ))}
                <LabelList dataKey="收益" position="right" fontSize={11} formatter={(v: unknown) => Number(v).toFixed(0)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      </div>

      {/* 异常账本 */}
      <section className="rounded-lg border p-4">
        <div className="mb-3 flex items-center gap-3">
          <h3 className="font-medium">异常账本</h3>
          <Select className="w-40" value={ledgerMonth} onChange={(e) => setLedgerMonth(e.target.value)}>
            <option value="all">全部时间</option>
            {ledgerMonths.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </Select>
        </div>
        <div className="flex gap-8 text-sm">
          <span>退款：<b>{ledger.refundCount}</b> 单，退回合计 <b>{fenToYuan(ledger.refundTotal)}</b> 元</span>
          <span>丢失：<b>{ledger.lostCount}</b> 单，亏损合计 <b className="text-red-600">{fenToYuan(ledger.lostTotal)}</b> 元</span>
        </div>
      </section>
    </div>
  );
}

function Card({ title, value, children }: { title: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-sm text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {children}
    </div>
  );
}
