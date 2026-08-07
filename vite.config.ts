import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // 组件测试在各自文件首行用 `// @vitest-environment jsdom` 声明；
    // 全局保持 node，现有 db 测试零影响
    setupFiles: ["src/test/setup.ts"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
  },
});
