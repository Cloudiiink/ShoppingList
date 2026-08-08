import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => cleanup());

// jsdom 缺口补丁（Radix Dialog 等需要）；node 环境下跳过
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// 汇率查询默认 mock：任何 import @/lib/rates 的组件拿到固定汇率 5.0，
// 个别用例可用 vi.mocked(fetchRate).mockRejectedValueOnce(...) 覆盖
vi.mock("@/lib/rates", () => ({
  fetchRate: vi.fn(async () => 5.0),
  refreshAllRates: vi.fn(async () => {}),
}));
