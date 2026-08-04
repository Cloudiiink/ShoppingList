# 订单管理系统 - 系统设计文档（v2.2 定稿）

> v2.1：并入 Codex 审查的 10 项 Critical 决策（金额整数化、状态转移矩阵、备份安全等）
> v2.2：并入第二轮审查的 6 项 Critical 决策（统一汇率升级为结算分摊、buy_price_source、ProfitResult 三态、团收益归一 canonical_profit、四态派生、团成员币种不变量）

## 1. 项目概述

macOS 桌面应用（Tauri + React + SQLite），服务于个人代购 + 囤货业务，核心功能：

- **订单管理**：代购 / 囤货订单录入与状态跟踪
- **团（批次）管理**：开团维度归集订单，外币结账与收益结算
- **库存管理**：囤货记录、挂单状态、一键转售出
- **统计**：按月收益、按团对比、退款/亏损账本
- **设置**：网站管理、CSV 导出、数据库备份

---

## 2. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Tauri 2 + React 18 + TypeScript + Vite | |
| 样式/组件 | Tailwind CSS + shadcn/ui | |
| 图表 | Recharts | 统计页两个图 |
| 数据库 | SQLite via **tauri-plugin-sql** | 前端直连，不经 Rust；`PRAGMA foreign_keys = ON` |
| 汇率查询 | 前端 fetch open.er-api.com | 免 key，失败降级为手填 |
| 打包 | macOS dmg，**无签名、无自动更新** | 自用，首次右键打开 |

### 铁律：SQL 只许出现在 `src/db/`

```
src/
  db/
    orders.ts    ← 订单相关 SQL 的唯一位置
    batches.ts
    products.ts
    sites.ts
    rules.ts     ← 状态转移矩阵、时间戳规则、canonical_profit、结算分摊、金额换算的唯一实现
    migrate.ts   ← user_version 顺序迁移
```

UI 组件中禁止出现任何 SQL 字符串，一切读写经过 `db/` 模块——业务规则有且只有一个家。

### 金额表示（全局约定）

- **所有金额存 INTEGER 最小货币单位**：人民币存「分」，外币（AUD/USD/HKD 均为 2 位小数）存其最小单位。¥123.45 → `12345`
- `exchange_rate` / `effective_rate` 保留 REAL，约定 6 位小数
- 乘法取整：`外币最小单位 × 汇率 → 分`，round half-up，实现集中在 `db/rules.ts`
- UI 层负责 ×100 / ÷100 换算，数据层只见整数；TS 中用单位化命名（如 `fenToYuan`）提醒
- 结算差额等比较均为整数精确比较

### 数据库位置

`~/Library/Application Support/order-tracker/tracker.db`

---

## 3. 数据库设计

### 3.1 `orders` 订单主表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `order_no` | TEXT UNIQUE NOT NULL | 创建日期 + 当日序号（`20260720-3`），生成后与任何日期字段脱钩，允许手改（仅校验唯一性） |
| `order_type` | TEXT NOT NULL | `customer` / `stock` |
| `status` | TEXT NOT NULL | 见 §4 状态机；CHECK 约束限定类型内合法值 |
| `batch_id` | INTEGER NULL → batches.id | 所属团；空 = 散单 |
| `buyer_wechat` | TEXT | 买家微信号（customer 必填） |
| `buyer_alias` | TEXT | 买家备注名 |
| `region` | TEXT | 地区 |
| `product_name` | TEXT NOT NULL | |
| `product_note` | TEXT | 款式/尺码等 |
| `site_id` | INTEGER NOT NULL → sites.id | **外键**；sites 删除策略 `ON DELETE RESTRICT` |
| `reserved_at` | TEXT | 预订时间 |
| `ordered_at` | TEXT NOT NULL | 下单时间；囤货的 ordered_at = 原始购买日，转售出后不改变 |
| `shipped_at` | TEXT | 发货时间；**收益按此归属月份**；回退到 paid_pending_ship 时清空 |
| `closed_at` | TEXT | 进入终态（done/refunded/lost/consumed）时写入 |
| `converted_from_stock_at` | TEXT | 囤货转售出时间戳 |
| `tracking_no` | TEXT | 国内段快递单号，发货弹窗中填写（可空，面交跳过）；回退时**保留** |
| `cost_foreign_amount` | INTEGER | 外币成本（最小单位） |
| `cost_currency` | TEXT | 币种：AUD / USD / HKD；与 cost_foreign_amount **同空同填**（CHECK 约束） |
| `exchange_rate` | REAL | 下单时预估汇率，用于预填 buy_price_cny |
| `buy_price_cny` | INTEGER（分） | 人民币买入价；**转 shipped / lost 前必填**（硬校验） |
| `buy_price_source` | TEXT NOT NULL DEFAULT 'estimated' | `estimated`（自动算出）/ `manual`（手改，永久脱钩）/ `batch_allocated`（结算分摊写入；手改后降级为 manual） |
| `sell_price_cny` | INTEGER（分） | 卖出价（customer 创建必填） |
| `shipping_fee` | INTEGER（分） | 发货邮费；公式中未填按 0 |
| `adjustments` | TEXT (JSON) | 收支调整明细，见下方存储契约 |
| `note` | TEXT | 备注（lost 的赔偿进展等记这里） |
| `created_at` / `updated_at` | TEXT | updated_at 用于分摊过期检测 |

**`adjustments` 存储契约：**

```json
[{ "kind": "cost" | "revenue", "group": "...", "amount": -1000, "note": "..." }]
```

1. 入库前校验：必须是数组；每项 `kind` 必填（`cost`/`revenue`），`group` 非空字符串，`amount` 为整数（最小单位，**允许负数**），`note` 可空；缺项/类型错直接拒绝
2. 空则存 `'[]'`，禁止 NULL
3. 读取端解析失败视为数据损坏，显式报错，不静默当 0

语义：`kind=cost` 成本侧调整（负数 = 供应商折扣）；`kind=revenue` 收入侧调整（负数 = 让利给买家；正数 = 买家补款）

### 3.2 `batches` 团表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | |
| `name` | TEXT UNIQUE NOT NULL | 如 `202607-JAYD 一团` |
| `site_id` | INTEGER NOT NULL → sites.id | **一团一站，硬约束**：成员单 site_id 必须相等 |
| `currency` | TEXT NOT NULL | 团币种（AUD/USD/HKD），开团时选定；外币成员单 cost_currency 必须相等 |
| `exchange_rate` | REAL | **权威结算汇率**（信用卡实际汇率），未填 = 未结算 |
| `checkout_foreign_amount` | INTEGER（外币最小单位） | 网站实付总额，可空 |
| `effective_rate` | REAL | **等效汇率** = checkout × exchange_rate ÷ Σ成员外币成本；**纯展示**，标注"含折扣/批次费"，任何金额计算不得引用；无外币成员时留空 |
| `allocated_at` | TEXT | 上次分摊时间，NULL = 从未分摊 |
| `allocated_checkout` | INTEGER | 分摊时使用的 checkout 金额（过期检测用） |
| `allocated_rate` | REAL | 分摊时使用的团汇率（过期检测用） |
| `discount_note` | TEXT | 折扣来源说明 |
| `note` | TEXT | 如「外币记账卡，等 8 月账单」 |
| `created_at` | TEXT | |

**团成员不变量**（两种合法成员）：

| 成员类型 | 条件 | 分摊中的角色 |
|---|---|---|
| 外币成员 | cost_foreign_amount 与 cost_currency 同填，且 currency == 团币种 | 参与分摊池分配 |
| 纯人民币成员 | 两个外币字段同空 | 不参与分摊，buy_price 进固定部分 F |

- 外币成员币种 ≠ 团币种 → 拒绝入团（防录入错误；团内不存在混币种）
- 散单 = batch_id 为空的单（与成员类型无关）
- 从团页「+ 加订单」创建的单币种自动锁定为团币种

**结算四态（派生，不落库）：**

| 状态 | 条件 | UI 术语 |
|---|---|---|
| 未结算 | checkout 或团汇率缺 | 「预估」 |
| 已结算未分摊 | 结算信息齐，allocated_at 为空 | 「待分摊」 |
| 已分摊 | allocated_checkout/rate 与当前值一致 | 「已分摊」（订单/月度数字 = 实际） |
| 分摊过期 | allocated_checkout/rate 与当前不一致，或任一成员 `updated_at > allocated_at` | 「待重新分摊」（橙色提示） |

### 3.3 `products` / `sites`

- **products**：id、name UNIQUE、default_site_id → sites.id、last_cost（分）、use_count
- **sites**：id、name UNIQUE、color；被引用时禁止删除（RESTRICT）

### 3.4 索引

| 表 | 索引 |
|---|---|
| orders | UNIQUE(order_no)、(status)、(shipped_at)、(batch_id)、(order_type, status)、(site_id) |
| batches / products / sites | UNIQUE(name) |

### 3.5 迁移

`PRAGMA user_version` 记录结构版本，应用启动时按顺序执行迁移脚本（`src/db/migrate.ts`），脚本进 git。

---

## 4. 状态机

### 4.1 状态全集

**代购（customer）：** `paid_pending_ship` → `shipped` → `done`，异常终态 `refunded` / `lost`
**囤货（stock）：** `in_stock` ⇄ `listed`，终态 `consumed` / `lost`；售出即转为 customer 单

### 4.2 转移矩阵（唯一实现于 `db/rules.ts`）

| 类型 | 当前 | 允许目标 |
|---|---|---|
| customer | `paid_pending_ship` | `shipped` / `refunded` / `lost` |
| customer | `shipped` | `done` / `refunded` / `lost` / `paid_pending_ship`（回退） |
| customer | `done` | `shipped`（回退） |
| customer | `refunded` / `lost` | `paid_pending_ship` / `shipped`（纠错回退） |
| stock | `in_stock` | `listed` / `consumed` / `lost` |
| stock | `listed` | `in_stock` / `consumed` / `lost` |
| stock | `consumed` / `lost` | `in_stock`（纠错回退） |
| stock → customer | — | 禁止直接改状态；只能走「转售出」动作（单事务） |

**两道闸**：① 数据层 `canTransition(type, from, to)` 前置校验，UI 下拉只列合法目标；② 建表 CHECK 约束：

```sql
CHECK (
  (order_type = 'customer' AND status IN
    ('paid_pending_ship','shipped','done','refunded','lost'))
  OR
  (order_type = 'stock' AND status IN
    ('in_stock','listed','consumed','lost'))
)
```

### 4.3 流转图

```
代购: paid_pending_ship ──→ shipped ──→ done
           │  │              │
           │  │              ├─→ lost      （国内快递丢失）
           │  │              └─→ refunded  （买家拒收/退货退款）
           │  ├─→ lost       （国际运输丢失/转运丢件）
           │  └─→ refunded   （网站退单砍单/买家反悔）

囤货: in_stock ──→ listed ──售出──→ [转为 customer 单 paid_pending_ship]
        │  │         │
        │  │         └─→ in_stock（下架）
        │  └─→ lost   （库存遗失/损坏）
        └─→ consumed（自用，不计盈亏）
```

### 4.4 状态变更规则（兜底四条）

- **双入口**：专用按钮 + 编辑表单，均经 `db/rules.ts` 统一入口
1. 进 `shipped` → 补写 `shipped_at`（为空才写）
2. 进终态 → 补写 `closed_at`（为空才写）
3. 终态回退中间态 → 清空 `closed_at`
4. **从 `shipped`/`done` 回退到 `paid_pending_ship` → 清空 `shipped_at`**（发货视作未发生；`tracking_no` 保留）
- **硬校验门槛**：转 `shipped` 和转 `lost` 时 `buy_price_cny` 必填（货丢了说明买过它，成本必然已知），未填阻止并提示
- **done 纯手动**，无自动完结；邮费未填时点完结弹软确认：「邮费未填，收益将按 0 邮费计算，仍要完结？」

### 4.5 行变色

| 状态 | 颜色 |
|---|---|
| `paid_pending_ship` | 蓝色 |
| `shipped` | 浅绿 |
| `done` / `consumed` | 无色（默认行） |
| `refunded` / `lost` | 深红（统一） |
| `in_stock` | 紫色 |
| `listed` | 浅紫 |
| 邮费未填 | 该单元格橙色 |

---

## 5. 收益与结算

### 5.1 规范收益函数（唯一实现于 `db/rules.ts`，任何页面不得自行实现）

```ts
type ProfitResult =
  | { kind: 'ok'; value: Fen }   // 可计算
  | { kind: 'incomplete' }       // buy_price 未填 → UI 显示「—」，聚合时跳过并提示
  | { kind: 'excluded' }         // 不参与收益

canonical_profit(order): ProfitResult
  order_type = stock        → excluded
  status = consumed         → excluded（自用，无盈亏）
  buy_price 为空            → incomplete
  status = refunded         → ok(0)（恒全额退款）
  status = lost             → ok(−(buy + shipping + Σ cost 侧 adjustments))
  status ∈ {paid_pending_ship, shipped, done} →
      ok((sell + Σ revenue 侧 adjustments)
         − buy − COALESCE(shipping, 0) − Σ cost 侧 adjustments)
```

**聚合规则**：月度/团/统计页聚合时遇 `incomplete` → 跳过该单并显示「N 单未补成本，统计不完整」橙色提示，**绝不静默当 0**。

**口径规则**：

1. 月度归属：仅 `shipped_at` 非空的单进入月度统计；paid_pending_ship 可显示 profit 但不归属月份
2. lost 的亏损按 `closed_at` 月归属
3. refunded 进异常账本（单数 + Σ sell_price），不进收益曲线

### 5.2 两层汇率

| 层 | 字段 | 职能 |
|---|---|---|
| 订单层 | `orders.exchange_rate` | 预估器：下单时手填或联网查，预填 buy_price_cny |
| 团层 | `batches.exchange_rate` | 权威结算：信用卡实际汇率（即时转换卡付款时填；外币记账卡账单出来后填） |

**表单脏标记联动**：`buy_price_cny` 未被手改过（source ≠ manual）时随汇率/外币成本联动；手动改过后置 `manual`、永久脱钩，旁显「已手动修改」标记。手改永远最高优先级。

### 5.3 结算分摊（对账机制）

汇率只决定总额，**分摊决定每单**（逐单乘法必有尾差，禁用）。团页操作「**结算分摊**」，弹窗两模式：

| 模式 | 目标总额 T |
|---|---|
| 手动汇率 | T = Σ(外币成员成本) × 输入汇率 → 取整到分（只取整这一次） |
| 按结账结算（默认） | T = checkout_foreign × 团汇率 → 取整到分 |

**分摊算法（单事务）：**

```
① 固定部分 F = Σ(source=manual 的成员 + 纯人民币成员) 的 buy_price   ← 一分钱不动
② 可分摊池 P = T − F
③ 按权重分摊到每个可分摊单（source ∈ {estimated, batch_allocated} 的外币成员）：
     单_i = floor(P × 外币成本_i ÷ Σ外币成本)
     余下几分 → 最大余数法逐分补齐（并列按 order_id 小者优先）
④ 写入：buy_price = 分摊值，buy_price_source = 'batch_allocated'
⑤ 事务内校验：Σ(分摊后 buy_price) ≡ T，不等则回滚
⑥ 更新 batches：allocated_at / allocated_checkout / allocated_rate / effective_rate
```

- 前置条件：Σ外币成员成本 > 0，否则按钮置灰；checkout 填了但无外币成员 → 禁止并提示
- 幂等，可重复分摊；分摊后 Σ成员 buy_price 恒等于 T，**订单、月度、团三本账构造性对平**
- retroactive 更新历史月份数字为实际值（已确认接受）

### 5.4 团口径（三行展示，不落库）

| 行 | 内容 |
|---|---|
| 团成本 | Σ 成员 buy_price（未分摊=预估；已分摊=实际=T） |
| 未售库存占用 | Σ in_stock/listed 囤货单的 buy_price（资金占用，非损益） |
| **团收益** | **Σ canonical_profit(全部成员)**——无独立公式，与订单/月度同源 |

结算差额（Σ成员外币成本 − checkout_foreign，整数精确比较）仍展示，作为录单防呆高亮；等效汇率 effective_rate 展示在结算区（如「等效 4.71 vs 信用卡 4.82」）。

---

## 6. 页面设计

导航：**订单 / 团 / 库存 / 统计 / 设置**

### 6.1 订单页

- **默认视图** = 全部进行中单（paid_pending_ship + shipped，含散单）∪ **最新活跃团**（最新创建且仍有进行中订单的团）的全部订单；按订单 id 去重；无活跃团时退化为仅进行中单
- 筛选栏：视图切换（默认视图 / 指定团 / 全部 / 单状态）、买家、商品、网站、订单号；状态筛选默认「进行中」
- 提醒条：「有 N 条订单未填邮费」（**仅统计进行中单**）
- 行尾操作：编辑、标记发货、完结、退款、丢失、转售出（囤货单）、删除
- **标记发货弹窗**：快递单号（可空）+ 邮费 → 确认写 `shipped_at` + `tracking_no`（前置硬校验 buy_price 已填）
- 新建/编辑表单：
  - 批次下拉（可空 = 散单）；从团详情「+ 加订单」进入时自动带 batch_id / site / 币种锁定；挂散单入团校验 site 与币种一致
  - 状态下拉只列转移矩阵中的合法目标
  - 汇率区：外币金额 + 币种 + 汇率（「获取实时汇率」按钮）→ 脏标记联动预填 buy_price_cny；manual 单显示「已手动修改」
  - **adjustments 编辑器**：动态行（kind 切换 成本/收入，默认成本 + 分组联想历史值 + 金额可负 + 备注），负数行绿色，底部实时合计；分组+金额必填，空行提交时丢弃
  - 商品名联想 → 选中带出网站和上次成本（products upsert）
  - 必填：代购 = 买家微信 + 网站 + 商品名 + 下单时间 + 卖出价；囤货 = 网站 + 商品名 + 下单时间 + 买入价

### 6.2 团页

- 列表：团名、网站、订单数（进行中/总数）、外币成本合计、结算状态（预估/待分摊/已分摊/待重新分摊）、收益，按创建时间倒序
- 详情 = 结算区 + 成员订单表（复用订单列表组件，锁定筛选 = 本团）
- 结算区：外币成本合计 / 实付总额 + 汇率（手填）/ 结算差额（非 0 高亮）/ 等效汇率（展示用）/ 团口径三行（§5.4）/「结算分摊」按钮（§5.3）

### 6.3 库存页

- 显示 `stock` 单：in_stock 紫 / listed 浅紫
- 统计：库存总成本、件数
- **转为售出**：弹补填表单（买家微信 + 卖出价必填，alias/region/batch 可改，成本与购买日锁定）；提交单事务改写 `order_type→customer`、`status→paid_pending_ship`、写 `converted_from_stock_at`

### 6.4 统计页

- **卡片 ×4**：本月收益（canonical_profit，按 shipped_at 月，含 incomplete 提示）、待发货（附最早等待天数）、库存占用（成本+件数）、未结算团数
- **图表 ×2**：近 12 个月收益柱状图（含 lost 亏损红段堆叠）、按团收益横向对比（已分摊实心 / 未分摊半透明）
- **异常账本**：退款单数与退回总额（Σ sell_price）、丢失单数与亏损总额（Σ 全成本）；月份筛选器默认「全部时间」，退款/丢失按 `closed_at` 月过滤

### 6.5 设置页

- 网站管理（增删改 + 颜色）；被订单/团/商品引用的网站禁止删除（RESTRICT），界面提示引用数
- **导出 CSV**：订单全字段（adjustments 展开为 JSON 字符串，含 batch_name 列）；金额导出为「元」两位小数（导出时换算，人读友好）；不单独出团文件、不出 xlsx、不出库存导出
- **备份**：「立即备份」= `VACUUM INTO` 生成一致性快照，同目录时间戳命名 `tracker-YYYYMMDD-HHmm.db.backup`，**保留最新 2 份**自动删旧；启动时检测到 7 天未备份 → 非阻塞提示
- 数据库位置显示

---

## 7. 其他业务规则

1. **订单编号** = 创建日期 + 当日序号（全类型统一递增，`BEGIN IMMEDIATE` 事务内取当日最大序号 +1，唯一约束兜底防冲突），补录历史单时编号日期 ≠ 下单日期属正常
2. **一团一站一币种**：成员单 site_id 必须匹配团；外币成员币种必须匹配团；外币字段同空同填（CHECK 约束）
3. **一单至多一个团**；囤货单也允许挂 batch_id（可空）
4. **历史数据不做导入器**，进行中业务手动补录（开荒期熟悉系统）
5. 汇率联网查询仅服务订单层预估；团层权威汇率永远手填
6. **收益计算唯一实现**于 `db/rules.ts`（canonical_profit），团收益 = Σ 成员结果，页面/导出/统计不得各自实现
7. **effective_rate 纯展示**，任何金额计算不得引用

---

## 8. 开发计划

1. **项目脚手架**：Tauri 2 + React + TS + Vite + Tailwind + shadcn/ui，tauri-plugin-sql 接入
2. **数据库**：建表（含 CHECK 约束与外键）+ 索引 + `user_version` 迁移框架
3. **db/ 数据层**：CRUD + 转移矩阵与兜底规则 + canonical_profit + 结算分摊算法 + 金额换算 helper + 事务封装
4. **订单页**：列表（默认视图/筛选/行变色/提醒条）+ 新建编辑表单（汇率联动、adjustments 编辑器、发货弹窗）
5. **团页**：列表 + 详情（结算区 + 结算分摊 + 成员订单）
6. **库存页** + 转售出流程
7. **统计页**：卡片 + 图表 + 异常账本
8. **设置页**：网站管理、CSV 导出、备份
9. **打磨**：表单校验、空状态、错误处理
10. **打包**：macOS dmg

---

## 9. 已关闭的设计争议（决策记录）

| 议题 | 决策 |
|---|---|
| payment_ratio vs status | 删 payment_ratio，付款状态由 status 单源表达（业务前提：买家全款预付） |
| refunded 语义 | 恒为全额退款，收益 = 0 |
| 部分折让/折扣 | 走 `adjustments`：kind=revenue 负数 = 让利买家；kind=cost 负数 = 供应商折扣 |
| 丢失/亏损 | 独立 `lost` 终态，收益 = −全成本，不记赔偿字段；转 lost 硬校验 buy_price |
| 收益归属月份 | 按 `shipped_at` 月；lost 按 `closed_at` 月 |
| NULL 语义 | shipped/lost 门槛硬校验 buy_price；shipping COALESCE 0；adjustments 恒为数组；incomplete 三态显式提示 |
| 收益函数 | 状态感知的 canonical_profit（ProfitResult 三态），全局唯一实现；团收益 = Σ 成员结果，无第二公式 |
| 外币成本 | 单金额 + 币种（整数最小单位），同空同填 |
| 金额表示 | 全部 INTEGER 最小单位（分/外币分），汇率保留 REAL |
| buy_price 来源 | `buy_price_source` 三态（estimated/manual/batch_allocated），手改最高优先级 |
| 团折扣与对账 | **结算分摊**：汇率定总额 T，加权分摊 + 最大余数法 + 事务校验 Σ≡T；retroactive 已确认 |
| 等效汇率 | `effective_rate` 落库但纯展示，不参与计算 |
| 结算状态 | 四态派生：预估/待分摊/已分摊/待重新分摊（updated_at 近似失效检测） |
| 团口径 | 团成本 / 未售库存占用 / 团收益（=Σ canonical_profit）三行 |
| 一团一站一币种 | 硬约束，site_id 外键 + 挂团校验（防录入错误）；纯人民币单可入团不参与外币合计；sites 删除 RESTRICT |
| 状态机 | 显式转移矩阵 + CHECK 约束两道闸；终态可回退 |
| 回退时间戳 | 回退清 closed_at；回退到发货前清 shipped_at、保留 tracking_no |
| done 进入条件 | 纯手动 + 邮费未填软确认 |
| 默认视图 | 进行中单 ∪ 最新活跃团（按 id 去重） |
| 数据访问层 | tauri-plugin-sql + `src/db/` 铁律（不用 sqlx/Rust commands） |
| 历史数据 | 不做导入器，手动补录 |
| 备份 | `VACUUM INTO` + 同目录时间戳命名 + 保留 2 份 + 7 天提醒 |
| 分发 | dmg 无签名无自动更新 |
