# ShoppingList

个人代购 + 囤货订单管理 macOS 桌面应用（Tauri 2 + React + SQLite）。GPL-3.0 协议开源。

## 安装

1. 从 [Releases](https://github.com/Cloudiiink/ShoppingList/releases) 下载最新的 `ShoppingList_x.y.z_universal.dmg`（通用包，Intel 和 Apple Silicon 均可用，要求 macOS 13+）
2. 打开 dmg，将 `ShoppingList.app` 拖入「应用程序」
3. **首次启动前必须执行**（应用未签名公证，不执行会报"已损坏，无法打开"）：

```bash
xattr -cr /Applications/ShoppingList.app
```

之后即可正常启动。

## 开发

```bash
npm ci
npm run dev        # 前端 Vite dev server
npm test           # 运行测试
```

- 设计文档（唯一权威）：`docs/order-tracker-system-design.md`
- 使用手册：`docs/user-guide.md`

## 发版

```bash
npm version x.y.z --no-git-tag-version
# 同步修改 src-tauri/tauri.conf.json 的 version
git commit -am "release vx.y.z"
git tag vx.y.z
git push origin main vx.y.z
```

CI（tauri-action）自动打包 `universal-apple-darwin` dmg 并发布到 Releases。
