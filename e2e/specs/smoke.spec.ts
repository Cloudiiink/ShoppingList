/**
 * 冒烟 E2E（CI-only，macOS 嵌入式 WebDriver）。
 * 覆盖：启动序列、加站点、开团、issue #10 Bug 1（团内加订单保存）、
 * issue #10 Bug 2（备份后全站可用）。
 * 站点/团名带时间戳，避免重复运行撞 UNIQUE 约束。
 *
 * 选择器注意：嵌入式驱动只支持 W3C 标准定位策略（css/xpath/link text/tag），
 * 不支持 wdio 扩展文本选择器（`button=文本`、`*=部分文本`），一律用 XPath。
 */

const RUN_ID = Date.now().toString(36);
const SITE = `E2E站-${RUN_ID}`;
const BATCH = `E2E团-${RUN_ID}`;

const byText = (tag: string, text: string) =>
  `//${tag}[normalize-space()="${text}"]`;
const byTextContains = (tag: string, text: string) =>
  `//${tag}[contains(normalize-space(),"${text}")]`;

/** 项目表单无 htmlFor：按 label 文本找同容器内第一个表单控件 */
async function field(label: string) {
  const l = await $(byText("label", label));
  await l.waitForExist();
  const parent = await l.parentElement();
  const input = await parent.$("input, select, textarea");
  if (!input) throw new Error(`label「${label}」同容器内没有表单控件`);
  return input;
}

async function navTo(name: string) {
  const btn = await $(byText("button", name));
  await btn.waitForExist();
  await btn.click();
}

async function expectNoClosedPool() {
  await expect($("body")).not.toHaveText(/closed pool/);
  await expect($("body")).not.toHaveText(/初始化失败/);
}

describe("order-tracker 冒烟", () => {
  it("诊断：页面加载状态", async () => {
    await browser.pause(10_000);
    try {
      console.log("[diag] URL:", await browser.getUrl());
    } catch (e) {
      console.log("[diag] getUrl failed:", String(e));
    }
    try {
      console.log(
        "[diag] BOOT LOG:",
        await browser.execute(() => localStorage.getItem("ot-boot-log"))
      );
      console.log(
        "[diag] BOOT STEPS:",
        await browser.execute(() => localStorage.getItem("ot-boot-steps"))
      );
    } catch (e) {
      console.log("[diag] boot log failed:", String(e));
    }
    try {
      const body = await $("body");
      console.log("[diag] BODY TEXT:", JSON.stringify(await body.getText()));
    } catch (e) {
      console.log("[diag] body getText failed:", String(e));
    }
  });

  it("启动：初始化完成、五个导航出现", async () => {
    await (await $(byTextContains("nav", "order-tracker"))).waitForExist({
      timeout: 60_000,
    });
    for (const n of ["订单", "团", "库存", "统计", "设置"]) {
      await expect($(byText("button", n))).toExist();
    }
  });

  it("设置页：添加网站", async () => {
    await navTo("设置");
    const input = await field("新网站名");
    await input.setValue(SITE);
    await (await $(byText("button", "添加"))).click();
    await (await $(byTextContains("td", SITE))).waitForExist();
  });

  it("团页：开团", async () => {
    await navTo("团");
    await (await $(byText("button", "新建团"))).click();
    await (await field("团名 *")).setValue(BATCH);
    await (
      await field("网站 *（一团一站，成员单必须同站）")
    ).selectByVisibleText(SITE);
    await (await $(byText("button", "创建"))).click();
    await (await $(byText("td", BATCH))).waitForExist();
  });

  it("issue #10 Bug 1 回归：团详情加订单可保存", async () => {
    await (await $(byText("td", BATCH))).click();
    await (await $(byText("button", "+ 加订单"))).click();

    await (await field("商品名 *")).setValue("E2E 商品");
    await (await field("买家微信 *")).setValue("wx-e2e");
    await (await field("卖出价（元）*")).setValue("600");
    await (await field("外币金额")).setValue("100");
    await (await field("汇率")).setValue("5");
    await (await $(byText("button", "保存"))).click();

    await (await $(byTextContains("h3", "成员订单（1）"))).waitForExist();
    await expect($(byText("td", "E2E 商品"))).toExist();
  });

  it("issue #10 Bug 2 回归：立即备份后所有页面仍可用", async () => {
    await navTo("设置");
    await (await $(byText("button", "立即备份"))).click();
    await (await $(byTextContains("div", "备份完成"))).waitForExist({
      timeout: 30_000,
    });

    // 旧 bug 下此处全站 closed pool；逐页验证
    await navTo("订单");
    await (await $(byText("button", "新建订单"))).waitForExist();
    await expectNoClosedPool();

    await navTo("团");
    await (await $(byText("td", BATCH))).waitForExist();
    await expectNoClosedPool();

    await navTo("库存");
    await (await $(byTextContains("span", "库存总成本"))).waitForExist();
    await expectNoClosedPool();

    await navTo("统计");
    await expectNoClosedPool();

    await navTo("设置");
    await (await $(byText("button", "立即备份"))).waitForExist();
    await expectNoClosedPool();
  });
});
