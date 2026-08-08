import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ConfirmDialogProvider } from "@/components/ConfirmDialog";

/** 渲染时包上 ConfirmDialogProvider（页面/表格内 useConfirm 所需） */
export function renderWithConfirm(ui: ReactElement) {
  return render(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>);
}
