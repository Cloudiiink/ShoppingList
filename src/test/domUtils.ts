import { screen } from "@testing-library/react";

/**
 * 项目表单没有 htmlFor 关联：按 label 文本找同容器内的第一个表单控件。
 * label 为精确字符串或正则（如 /买入价/，避开动态徽标文本）。
 */
export function field(label: string | RegExp): HTMLElement {
  const el = screen.getByText(label, { selector: "label" });
  const input = el.parentElement?.querySelector("input, select, textarea");
  if (!input) throw new Error(`label「${String(label)}」同容器内没有表单控件`);
  return input as HTMLElement;
}
