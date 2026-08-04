import { useCallback, useEffect, useState } from "react";
import { initDb } from "@/db/connection";
import { listSites } from "@/db/sites";
import { OrdersPage } from "@/pages/orders/OrdersPage";
import { BatchesPage } from "@/pages/batches/BatchesPage";
import { InventoryPage } from "@/pages/inventory/InventoryPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { newestBackupAgeDays } from "@/lib/backupFiles";
import { cn } from "@/lib/utils";
import type { SiteRow, SqlDb } from "@/db/types";

type BootState =
  | { kind: "booting" }
  | { kind: "ready"; db: SqlDb; sites: SiteRow[] }
  | { kind: "error"; message: string };

const NAV = ["订单", "团", "库存", "统计", "设置"] as const;
type Page = (typeof NAV)[number];

const PAGE_TICKET: Record<Page, string | null> = {
  订单: null,
  团: null,
  库存: null,
  统计: "Ticket #6",
  设置: null,
};

export default function App() {
  const [state, setState] = useState<BootState>({ kind: "booting" });
  const [page, setPage] = useState<Page>("订单");
  const [backupReminder, setBackupReminder] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const db = await initDb();
        const sites = await listSites(db);
        setState({ kind: "ready", db, sites });
        // 7 天未备份 → 非阻塞提示（fs 不可用的环境静默跳过）
        try {
          const age = await newestBackupAgeDays();
          if (age === null) setBackupReminder("还没有任何备份，建议到设置页立即备份");
          else if (age > 7) setBackupReminder(`已 ${Math.floor(age)} 天未备份`);
        } catch { /* ignore */ }
      } catch (e) {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }, []);

  const onSitesChanged = useCallback((sites: SiteRow[]) => {
    setState((s) => (s.kind === "ready" ? { ...s, sites } : s));
  }, []);

  if (state.kind === "booting") {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        正在初始化数据库…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <h1 className="text-lg font-semibold text-destructive">初始化失败</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <nav className="flex items-center gap-1 border-b px-4 py-2">
        <span className="mr-4 font-bold">order-tracker</span>
        {NAV.map((n) => (
          <button
            key={n}
            onClick={() => setPage(n)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              page === n ? "bg-primary text-primary-foreground" : "hover:bg-accent"
            )}
          >
            {n}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto">
        {backupReminder && (
          <div className="flex items-center justify-between bg-orange-50 px-4 py-2 text-sm text-orange-700">
            <span>{backupReminder}</span>
            <button onClick={() => setBackupReminder(null)}>知道了</button>
          </div>
        )}
        {page === "订单" ? (
          <OrdersPage db={state.db} sites={state.sites} />
        ) : page === "团" ? (
          <BatchesPage db={state.db} sites={state.sites} />
        ) : page === "库存" ? (
          <InventoryPage db={state.db} sites={state.sites} />
        ) : page === "设置" ? (
          <SettingsPage db={state.db} onSitesChanged={onSitesChanged} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {page}页将在 {PAGE_TICKET[page]} 实现
          </div>
        )}
      </main>
    </div>
  );
}
