import type { WebdriverIO } from "@wdio/types";

/**
 * E2E（CI-only）：嵌入式 WebDriver（tauri-plugin-wdio-webdriver，仅 debug 构建含）。
 * 本地无 Rust 跑不了；CI 见 .github/workflows/e2e.yml。
 * 被测二进制：npm run tauri build -- --debug --no-bundle 的产物。
 */
export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/specs/**/*.spec.ts"],
  maxInstances: 1,
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  // 嵌入式驱动 + service 钩子有额外延迟，默认 5s 等待太短
  waitforTimeout: 15_000,
  services: [
    [
      "@wdio/tauri-service",
      {
        // 嵌入式 WebDriver 服务器跑在 app 进程内（macOS 唯一免费方案），默认端口 4445
        driverProvider: "embedded",
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: "./src-tauri/target/debug/order-tracker",
      },
    } as WebdriverIO.Capabilities,
  ],
  mochaOpts: {
    timeout: 120_000, // 首次启动 webview 较慢
    ui: "bdd",
  },
  // 失败时 dump 页面文本，CI 无截图也能定位
  afterTest: async (_t, _c, { error }: { error?: Error }) => {
    if (!error) return;
    try {
      const text = await $("body").getText();
      console.log("[afterTest] BODY ON FAILURE:", JSON.stringify(text.slice(0, 500)));
    } catch {
      /* ignore */
    }
  },
  // 临时诊断：谁在持有数据库文件（排查 migrate 的 database is locked）
  before: async () => {
    const { execSync } = await import("node:child_process");
    const dir = `${process.env.HOME}/Library/Application Support/com.cloudiiink.ordertracker`;
    const run = (cmd: string) => {
      try {
        return execSync(cmd).toString();
      } catch {
        return "(none)";
      }
    };
    console.log("[diag-ps]", run("ps aux | grep '[o]rder-tracker'"));
    console.log("[diag-ls]", run(`ls -la '${dir}'`));
    console.log(
      "[diag-lsof]",
      run(`lsof '${dir}/tracker.db' '${dir}/tracker.db-wal' '${dir}/tracker.db-shm' 2>/dev/null`)
    );
  },
};
