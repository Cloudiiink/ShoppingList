import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 应用内确认对话框（替代 window.confirm）。
 * 背景：Tauri macOS 的 WKWebView 不实现 JS 弹窗，window.confirm() 是 no-op
 * 返回 undefined，`if (!confirm(...)) return;` 会静默拦截所有操作（issue #10 Bug 3）。
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "确认删除？", danger: true }))) return;
 */

interface ConfirmOptions {
  title: string;
  body?: string;
  /** 确认按钮文案，默认「确认」 */
  confirmText?: string;
  /** 危险操作：确认按钮红色 */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => {
  throw new Error("useConfirm 必须在 ConfirmDialogProvider 内使用");
});

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve });
    });
  }, []);

  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state != null} onOpenChange={(o) => !o && close(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{state?.title}</DialogTitle>
          </DialogHeader>
          {state?.body && (
            <p className="text-sm text-muted-foreground">{state.body}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)}>
              取消
            </Button>
            <Button
              variant={state?.danger ? "destructive" : "default"}
              onClick={() => close(true)}
            >
              {state?.confirmText ?? "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
