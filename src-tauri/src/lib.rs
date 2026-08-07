/// 启动序列第 1 步：仅注册 tauri-plugin-sql，无自定义 command。
/// 全部数据访问在前端 src/db/（纯 TS 数据层决策）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init());

    // E2E 专用：嵌入式 WebDriver 服务器（仅 debug 构建，release 不含此插件）
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
