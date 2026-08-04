import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { initDb } from "@/db/connection";

type BootState =
  | { kind: "booting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export default function App() {
  const [state, setState] = useState<BootState>({ kind: "booting" });

  useEffect(() => {
    initDb()
      .then(() => setState({ kind: "ready" }))
      .catch((e) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) })
      );
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
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">order-tracker</h1>
      <p className="text-muted-foreground">数据库就绪。</p>
      <Button>shadcn/ui 可用</Button>
    </div>
  );
}
