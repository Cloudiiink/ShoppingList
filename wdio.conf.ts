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
};
