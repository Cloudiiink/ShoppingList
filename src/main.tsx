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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
