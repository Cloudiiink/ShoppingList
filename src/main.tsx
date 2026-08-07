import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// [临时诊断] 检测 JS 上下文是否被创建多次（e2e 数据库锁排查用）
{
  const n = Number(localStorage.getItem("ot-boot-count") ?? "0") + 1;
  localStorage.setItem("ot-boot-count", String(n));
  const log = JSON.parse(localStorage.getItem("ot-boot-log") ?? "[]") as unknown[];
  log.push({ n, t: Date.now() });
  localStorage.setItem("ot-boot-log", JSON.stringify(log));
}

// E2E 兼容垫片：@wdio/tauri-service 的窗口焦点钩子等待
// window.__wdio_original_core__（本由其 JS 插件注入，会拦截 invoke 用于 mock）。
// 我们只用基础 WebDriver 操作，别名到 __TAURI__.core（需 withGlobalTauri），
// 让钩子快速完成/失败并跳过，避免每条 WebDriver 命令白等 5s。
{
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined;
  if (tauri?.core && !w.__wdio_original_core__) {
    w.__wdio_original_core__ = tauri.core;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
