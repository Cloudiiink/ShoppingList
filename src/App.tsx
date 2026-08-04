import { useEffect, useState } from "react";
import { initDb } from "@/db/connection";
import { listSites } from "@/db/sites";
import { OrdersPage } from "@/pages/orders/OrdersPage";
import { BatchesPage } from "@/pages/batches/BatchesPage";
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
  库存: "Ticket #4",
  统计: "Ticket #6",
  设置: "Ticket #7",
};

export default function App() {
  const [state, setState] = useState<BootState>({ kind: "booting" });
  const [page, setPage] = useState<Page>("订单");

  useEffect(() => {
    (async () => {
      try {
        const db = await initDb();
        const sites = await listSites(db);
        setState({ kind: "ready", db, sites });
      } catch (e) {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
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
        {page === "订单" ? (
          <OrdersPage db={state.db} sites={state.sites} />
        ) : page === "团" ? (
          <BatchesPage db={state.db} sites={state.sites} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {page}页将在 {PAGE_TICKET[page]} 实现
          </div>
        )}
      </main>
    </div>
  );
}
