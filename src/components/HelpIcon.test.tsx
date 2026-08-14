// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HelpIcon } from "./HelpIcon";
import { HelpIconsProvider } from "@/lib/helpIcons";

beforeEach(() => localStorage.clear());

describe("HelpIcon", () => {
  it("默认显示：说明文字在文档中", () => {
    render(
      <HelpIconsProvider>
        <HelpIcon text="测试说明" />
      </HelpIconsProvider>
    );
    expect(screen.getByText("测试说明")).toBeInTheDocument();
  });

  it("localStorage 记录关闭后不渲染", () => {
    localStorage.setItem("shoppinglist.showHelpIcons", "0");
    render(
      <HelpIconsProvider>
        <HelpIcon text="测试说明" />
      </HelpIconsProvider>
    );
    expect(screen.queryByText("测试说明")).toBeNull();
  });

  it("无 Provider 时兜底显示", () => {
    render(<HelpIcon text="兜底说明" />);
    expect(screen.getByText("兜底说明")).toBeInTheDocument();
  });
});
