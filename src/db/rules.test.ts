import { describe, it, expect } from "vitest";
import {
  normRate,
  foreignToFen,
  fenToYuan,
  yuanToFen,
  utcToLocalMonth,
} from "./rules";

describe("normRate", () => {
  it("归一化到 6 位小数", () => {
    expect(normRate(4.715)).toBe(4.715);
    expect(normRate(4.7151234)).toBe(4.715123);
    expect(normRate(4.7151236)).toBe(4.715124);
  });

  it("规避二进制浮点边界：归一化后可精确比较", () => {
    // 4.715 的原始二进制表示不是精确值，归一化后应稳定相等
    expect(normRate(4.715)).toBe(normRate(Number("4.715")));
  });
});

describe("foreignToFen（十进制安全，round half-up）", () => {
  it("整分无需取整", () => {
    expect(foreignToFen(10000, 4.7)).toBe(47000); // 100.00 × 4.7 = 470.00
  });

  it("half-up：0.5 分向上进", () => {
    // 1001 × 4.715 = 4719.715 → 4719.715 分→ 4719.715，取整 4720?
    // 1001 minor × 4.715 = 4719.715 分 → half-up = 4720
    expect(foreignToFen(1001, 4.715)).toBe(4720);
  });

  it("half-up 精确边界：恰好 .5 进位", () => {
    // 500 × 4.715 = 2357.5 → 2358
    expect(foreignToFen(500, 4.715)).toBe(2358);
  });

  it("浮点陷阱：4.715 存成 4.7149999… 也不许错方向", () => {
    // 500 × 4.715 若用浮点直接乘再 Math.round，可能得 2357
    expect(foreignToFen(500, 4.715)).toBe(2358);
  });

  it("拒绝负数外币成本", () => {
    expect(() => foreignToFen(-1, 4.7)).toThrow();
  });
});

describe("fenToYuan / yuanToFen", () => {
  it("分转元两位小数", () => {
    expect(fenToYuan(12345)).toBe("123.45");
    expect(fenToYuan(0)).toBe("0.00");
    expect(fenToYuan(-500)).toBe("-5.00");
  });

  it("元转分", () => {
    expect(yuanToFen("123.45")).toBe(12345);
    expect(yuanToFen("0.01")).toBe(1);
  });

  it("往返一致", () => {
    expect(yuanToFen(fenToYuan(98765))).toBe(98765);
  });
});

describe("utcToLocalMonth", () => {
  it("UTC 转本地月份 YYYY-MM", () => {
    // 本地时区为 +8（中国）：UTC 7 月 31 日 16:00 之后 = 本地 8 月
    const m = utcToLocalMonth("2026-07-31T17:00:00.000Z");
    expect(m).toMatch(/^\d{4}-\d{2}$/);
    // 具体值依赖运行机器时区；构造等价断言：
    const d = new Date("2026-07-31T17:00:00.000Z");
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expect(m).toBe(expected);
  });
});
