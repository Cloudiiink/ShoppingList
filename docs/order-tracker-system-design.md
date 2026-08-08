# 订单管理系统 - 系统设计文档（v2.6 定稿）

> v2.1：并入 Codex 审查的 10 项 Critical 决策（金额整数化、状态转移矩阵、备份安全等）
> v2.2：并入第二轮审查的 6 项 Critical 决策（统一汇率升级为结算分摊、buy_price_source、ProfitResult 三态、团收益归一 canonical_profit、四态派生、团成员币种不变量）
> v2.3：并入第三轮审查的 8 项 Blocker 决策（转移闸门如实描述、refunded 判定提前、stock lost 计亏损、回退清 shipped_at 按目标状态、手动汇率四态锚点、分摊分母与边界、禁止纯人民币成员入团、batch_allocated 冻结）
> v2.4：并入第三轮审查的 6 项 High 风险决策（STRICT 表 + canonical DDL、adjustments DDL 约束、跨表不变量 db/ 事务校验、settlement_updated_at 过期检测、汇率归一化、条件不变量双闸）
> v2.5：并入第三轮审查的 8 项 Medium + 3 项 Minor 决策（UTC ISO-8601 时间戳、五步启动序列、备份秒级命名 + 先校验后清理 + fs plugin、手动恢复与威胁模型、转售出允许 consumed、迁移单事务、订单号格式过滤、索引去重、伪码字段名统一、db/ 目录树补 backup/export）
> v2.6：CI/CD 决策（GitHub Actions 测试 + tauri-action 打包发布，本地不装 Rust；vitest + better-sqlite3 测试策略）

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
| 打包/发布 | **GitHub Actions CI**：push/PR 跑测试；打 tag 触发 `tauri-apps/tauri-action` 在 macos runner 构建 dmg → 发布到 GitHub Releases；无签名、无自动更新 | **本地不装 Rust 工具链**，编译全在 CI；首次安装需 `xattr -cr` 清 quarantine（"已损坏"提示），见使用手册 |
| 测试 | vitest + Testing Library + WebdriverIO | ①rules.ts 纯函数单测；②db/ SQL 层 better-sqlite3 集成测试（预编译二进制，不需 Rust）；③页面 jsdom 交互测试（真库当 prop，StatsPage 除外）；④E2E 仅 CI（嵌入式 WebDriver，debug 构建）；详见 §9 测试策略 |

> **权衡（已确认接受）**：本地无 Rust ⇒ 无法 `tauri dev` 跑完整 app；UI 开发用 `vite dev` 纯前端 + mock db/ 层，完整验证靠 CI。

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
    backup.ts    ← 备份（VACUUM INTO + 快照校验 + 旧文件清理）
    export.ts    ← CSV 导出查询
```

UI 组件中禁止出现任何 SQL 字符串，一切读写经过 `db/` 模块——业务规则有且只有一个家。

### 时间戳约定（全局）

- **一律存 UTC ISO-8601**（`new Date().toISOString()`，如 `2026-08-04T13:30:00.000Z`）：字典序 = 时间序，stale 检测 / 取最新直接字符串比较
- 显示与**月度归属**按本地时区换算（自用单时区；换算函数集中在 rules.ts，如 `utcToLocalMonth()`）
- 任何代码不得手写其他格式入库

### 金额表示（全局约定）

- **所有金额存 INTEGER 最小货币单位**：人民币存「分」，外币（AUD/USD/HKD 均为 2 位小数）存其最小单位。¥123.45 → `12345`
- `exchange_rate` / `effective_rate` 保留 REAL，约定 6 位小数
- **汇率归一化**：rules.ts 提供 `normRate()`——输入统一 round 到 6 位小数再入库；汇率比较一律用归一化后的值；金额换算（外币最小单位 × 汇率 → 分）用十进制安全实现（整数放大法），round half-up，避开二进制浮点边界
- UI 层负责 ×100 / ÷100 换算，数据层只见整数；TS 中用单位化命名（如 `fenToYuan`）提醒
- 结算差额等比较均为整数精确比较
- **所有表使用 SQLite STRICT 模式**（≥3.37），INTEGER 列写入非整数直接报错；canonical DDL 见 §3.6

### 数据库位置

`~/Library/Application Support/com.cloudiiink.shoppinglist/tracker.db`

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
| `adjustments` | TEXT (JSON) | 收支调整明细，见下方存储契约；DDL 约束 `NOT NULL DEFAULT '[]'` + `json_valid` + `json_type='array'` |
| `note` | TEXT | 备注（lost 的赔偿进展等记这里） |
| `created_at` / `updated_at` | TEXT | updated_at = 任意字段变更时间 |
| `settlement_updated_at` | TEXT | **仅结算相关字段**（cost_foreign_amount / cost_currency / buy_price_cny / buy_price_source / batch_id）变更时由 db/ 层更新；分摊过期检测用，改备注/快递单号不触发 |

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
| `allocated_checkout` | INTEGER | 分摊时使用的 checkout 金额（过期检测用）；**手动汇率模式分摊存 NULL**（该分摊不锚定 checkout） |
| `allocated_rate` | REAL | 分摊时使用的团汇率（过期检测用） |
| `allocated_member_count` | INTEGER | 分摊时的成员数（过期检测用：成员增减使其与当前不符） |
| `discount_note` | TEXT | 折扣来源说明 |
| `note` | TEXT | 如「外币记账卡，等 8 月账单」 |
| `created_at` | TEXT | |

**团成员不变量**（唯一合法成员类型）：

| 成员类型 | 条件 | 分摊中的角色 |
|---|---|---|
| 外币成员 | cost_foreign_amount 与 cost_currency 同填，且 currency == 团币种 | source ∈ {estimated, batch_allocated} 参与分摊池分配；source = manual 进固定部分 F |

- **纯人民币成员禁止入团**（业务上团里全是同一外币的货）：入团校验要求外币成本必填且币种 == 团币种；纯人民币单只能做散单
- 散单 = batch_id 为空的单；散单可以是纯人民币单
- 从团页「+ 加订单」创建的单币种自动锁定为团币种

**结算四态（派生，不落库）——按分摊锚点分支：**

- checkout 模式锚点 = checkout + 团汇率；手动汇率模式锚点 = 团汇率（allocated_checkout 存 NULL，表示该分摊不锚定 checkout）

| 状态 | 条件 | UI 术语 |
|---|---|---|
| 未结算 | 团汇率缺 | 「预估」 |
| 已结算未分摊 | 团汇率已填，allocated_at 为空 | 「待分摊」 |
| 已分摊 | allocated_rate == 当前团汇率，且（allocated_checkout 非空时 allocated_checkout == 当前 checkout），且成员无结算相关变更（见下） | 「已分摊」（订单/月度数字 = 实际） |
| 分摊过期 | 上述任一条不满足，或任一成员 `settlement_updated_at > allocated_at`（结算字段被改），或当前成员数 ≠ `allocated_member_count`（成员增减） | 「待重新分摊」（橙色提示） |

### 3.3 `products` / `sites`

- **products**：id、name UNIQUE、default_site_id → sites.id、last_cost（分）、use_count
- **sites**：id、name UNIQUE、color；被引用时禁止删除（RESTRICT）

### 3.4 索引

| 表 | 索引 |
|---|---|
| orders | (status)、(shipped_at)、(batch_id)、(order_type, status)、(site_id) |
| batches / products / sites | 无额外索引 |

> UNIQUE(order_no) / UNIQUE(name) 由列级 UNIQUE 约束自动建索引，不再重复声明。

### 3.5 迁移

`PRAGMA user_version` 记录结构版本，应用启动时按顺序执行迁移脚本（`src/db/migrate.ts`），脚本进 git。

- **每个迁移脚本在单事务内执行**，`PRAGMA user_version = N` 作为事务最后一步同事务提交
- 任一步失败 → 整体回滚，app 弹错误提示并阻止进入主界面（user_version 永不出现「半迁移」状态）

### 3.6 Canonical DDL（唯一权威建表语句）

```sql
CREATE TABLE sites (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
) STRICT;

CREATE TABLE products (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  default_site_id INTEGER REFERENCES sites(id),
  last_cost       INTEGER,              -- 分
  use_count       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE batches (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL UNIQUE,
  site_id                 INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  currency                TEXT NOT NULL CHECK (currency IN ('AUD','USD','HKD')),
  exchange_rate           REAL,          -- 权威结算汇率；normRate() 归一化后入库
  checkout_foreign_amount INTEGER,       -- 外币最小单位
  effective_rate          REAL,          -- 纯展示
  allocated_at            TEXT,
  allocated_checkout      INTEGER,       -- 手动汇率模式分摊存 NULL
  allocated_rate          REAL,
  allocated_member_count  INTEGER,       -- 分摊时成员数（过期检测）
  discount_note           TEXT,
  note                    TEXT,
  created_at              TEXT NOT NULL
) STRICT;

CREATE TABLE orders (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no               TEXT NOT NULL UNIQUE,
  order_type             TEXT NOT NULL CHECK (order_type IN ('customer','stock')),
  status                 TEXT NOT NULL,
  batch_id               INTEGER REFERENCES batches(id),
  buyer_wechat           TEXT,
  buyer_alias            TEXT,
  region                 TEXT,
  product_name           TEXT NOT NULL,
  product_note           TEXT,
  site_id                INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  reserved_at            TEXT,
  ordered_at             TEXT NOT NULL,
  shipped_at             TEXT,
  closed_at              TEXT,
  converted_from_stock_at TEXT,
  tracking_no            TEXT,
  cost_foreign_amount    INTEGER,        -- 外币最小单位
  cost_currency          TEXT,
  exchange_rate          REAL,           -- 订单层预估；normRate() 归一化后入库
  buy_price_cny          INTEGER,        -- 分
  buy_price_source       TEXT NOT NULL DEFAULT 'estimated'
                         CHECK (buy_price_source IN ('estimated','manual','batch_allocated')),
  sell_price_cny         INTEGER,        -- 分
  shipping_fee           INTEGER,        -- 分
  adjustments            TEXT NOT NULL DEFAULT '[]'
                         CHECK (json_valid(adjustments) AND json_type(adjustments) = 'array'),
  note                   TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  settlement_updated_at  TEXT,           -- 仅结算相关字段变更时更新
  -- 外币字段同空同填
  CHECK ((cost_foreign_amount IS NULL) = (cost_currency IS NULL)),
  -- 枚举域：status 必须是类型内合法值（不管跳变，跳变由 rules.ts 转移矩阵把守）
  CHECK (
    (order_type = 'customer' AND status IN ('paid_pending_ship','shipped','done','refunded','lost'))
    OR (order_type = 'stock' AND status IN ('in_stock','listed','consumed','lost'))
  ),
  -- 条件不变量：customer 必有买家与卖出价；stock 必有买入价
  CHECK (order_type <> 'customer' OR (buyer_wechat IS NOT NULL AND sell_price_cny IS NOT NULL)),
  CHECK (order_type <> 'stock' OR buy_price_cny IS NOT NULL)
) STRICT;

CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_shipped_at  ON orders(shipped_at);
CREATE INDEX idx_orders_batch_id    ON orders(batch_id);
CREATE INDEX idx_orders_type_status ON orders(order_type, status);
CREATE INDEX idx_orders_site_id     ON orders(site_id);
```

**校验双闸分工**：DB（DDL/CHECK）管结构存在性（非空、枚举、同空同填、JSON 形状、STRICT 类型）；rules.ts 管语义（转移矩阵、状态门槛如转 shipped/lost 前 buy_price 必填、金额运算）。db/ 模块所有写入口统一过 `validateOrder()`，与 DB 约束同规则但不互相替代。

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

**两道闸（如实描述）**：① **转移闸** = 数据层 `canTransition(type, from, to)` 前置校验（`db/rules.ts` 唯一实现），UI 下拉只列合法目标——所有写路径被 `src/db/` 铁律收敛，此闸必然经过；② **枚举域 CHECK** = 建表约束，只校验 status 是类型内合法枚举值（防绕过 db/ 模块的手写 SQL 写坏数据），**不校验跳变合法性**（SQLite CHECK 看不到旧行值，不引入触发器以避免转移矩阵双份真源）：

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
4. **回退目标是 `paid_pending_ship` → 一律清空 `shipped_at`**（无论来源是 shipped/done/lost/refunded；发货视作未发生；`tracking_no` 保留）
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
  status = refunded         → ok(0)（恒全额退款，无需成本信息；先于缺成本判断）
  order_type = stock:
    status ∈ {in_stock, listed}  → excluded（在库 = 资金占用，非损益）
    status = consumed            → excluded（自用，无盈亏）
    status = lost                → ok(−(buy_price_cny + shipping_fee + Σ cost 侧 adjustments))，按 closed_at 归月
  buy_price_cny 为空         → incomplete
  status = lost             → ok(−(buy_price_cny + shipping_fee + Σ cost 侧 adjustments))
  status ∈ {paid_pending_ship, shipped, done} →
      ok((sell_price_cny + Σ revenue 侧 adjustments)
         − buy_price_cny − COALESCE(shipping_fee, 0) − Σ cost 侧 adjustments)
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

**表单脏标记联动**：汇率联动**仅作用于 `source = estimated`**（预估器无权碰已结算数字）——estimated 单随汇率/外币成本联动预填 buy_price_cny；手动改过后置 `manual`、永久脱钩，旁显「已手动修改」标记；**`batch_allocated` 冻结**，只有显式「结算分摊」或手改（降级为 manual）才能改它。编辑已分摊单的外币成本后，db/ 层更新其 settlement_updated_at，该团经过期检测自然变为「待重新分摊」。手改永远最高优先级。

### 5.3 结算分摊（对账机制）

汇率只决定总额，**分摊决定每单**（逐单乘法必有尾差，禁用）。团页操作「**结算分摊**」，弹窗两模式：

| 模式 | 目标总额 T |
|---|---|
| 手动汇率 | T = Σ(外币成员成本) × 输入汇率 → 取整到分（只取整这一次） |
| 按结账结算（默认） | T = checkout_foreign × 团汇率 → 取整到分 |

**分摊算法（单事务）：**

```
① 固定部分 F = Σ(source=manual 的成员) 的 buy_price_cny   ← 一分钱不动
② 可分摊池 P = T − F
③ 按权重分摊到每个可分摊单（source ∈ {estimated, batch_allocated} 的成员）：
     单_i = floor(P × 外币成本_i ÷ Σ可分摊单的外币成本)   ← 分母只含收款人
     余下几分 → 最大余数法逐分补齐（并列按 order_id 小者优先）
④ 写入：buy_price_cny = 分摊值，buy_price_source = 'batch_allocated'
⑤ 事务内校验：Σ(分摊后 buy_price_cny) ≡ T，不等则回滚
⑥ 更新 batches：allocated_at / allocated_checkout（手动模式存 NULL）/ allocated_rate / allocated_member_count / effective_rate
```

- 前置条件：Σ外币成员成本 > 0，否则按钮置灰；checkout 填了但无外币成员 → 禁止并提示
- **边界规则**：
  - **可分摊池为空**（所有成员都是 manual）→ 按钮置灰，提示「所有成员成本均已手动锁定，无可分摊单」
  - **P < 0**（固定成本超过 T）→ 禁止分摊，提示「固定成本 ¥F 已超过目标总额 ¥T，请检查 manual 成本或 checkout/汇率」
  - **P = 0** → 允许执行（Σ≡T 仍成立），确认弹窗明示将分出零成本的单
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
- **转为售出**：合法来源 = `in_stock` / `listed` / `consumed`（自用后又卖掉的真实场景）；`lost` 不可转（找回需先按矩阵回退 in_stock）。弹补填表单（买家微信 + 卖出价必填，alias/region/batch 可改，成本与购买日锁定）；提交单事务：清 `closed_at`（consumed 时有值）→ `order_type→customer`、`status→paid_pending_ship`、写 `converted_from_stock_at`

### 6.4 统计页

- **卡片 ×4**：本月收益（canonical_profit，按 shipped_at 月，含 incomplete 提示）、待发货（附最早等待天数）、库存占用（成本+件数）、未结算团数
- **图表 ×2**：近 12 个月收益柱状图（含 lost 亏损红段堆叠）、按团收益横向对比（已分摊实心 / 未分摊半透明）
- **异常账本**：退款单数与退回总额（Σ sell_price）、丢失单数与亏损总额（Σ 所有 lost 单——customer + stock——的 |canonical_profit|，复用唯一收益实现）；月份筛选器默认「全部时间」，退款/丢失按 `closed_at` 月过滤

### 6.5 设置页

- 网站管理（增删改 + 颜色）；被订单/团/商品引用的网站禁止删除（RESTRICT），界面提示引用数
- **导出 CSV**：订单全字段（adjustments 展开为 JSON 字符串，含 batch_name 列）；金额导出为「元」两位小数（导出时换算，人读友好）；不单独出团文件、不出 xlsx、不出库存导出
- **备份**：「立即备份」流程（实现在 `src/db/backup.ts`，文件操作用 @tauri-apps/plugin-fs、scope 限备份目录）：
  1. `VACUUM INTO` 生成一致性快照，同目录命名 `tracker-YYYYMMDD-HHmmss.db.backup`（秒级防碰撞）
  2. 对新快照执行 `PRAGMA integrity_check`，失败则删快照并报错，**不动旧备份**
  3. 校验通过后才枚举 `tracker-*.db.backup`，删旧**保留最新 2 份**
  - 启动时检测到 7 天未备份 → 非阻塞提示
  - **威胁模型**：同目录双份只防逻辑损坏（误删/写坏数据），**不防丢电脑/硬盘故障**；恢复 = 退出 app → 用备份文件替换 `tracker.db` → 重启；建议用户定期手动把备份拷到 iCloud/外置盘
- 数据库位置显示

---

## 7. 其他业务规则

1. **订单编号** = 创建日期 + 当日序号（全类型统一递增，`BEGIN IMMEDIATE` 事务内取当日最大序号 +1，唯一约束兜底防冲突），补录历史单时编号日期 ≠ 下单日期属正常。手改仅校验**非空 + 唯一**；序号生成只统计符合 `^\d{8}-\d+$` 且日期段 = 创建日的编号，不规则手改号不参与序号生成、不报错
2. **一团一站一币种**：成员单 site_id 必须匹配团；成员外币成本必填且币种必须匹配团；外币字段同空同填（CHECK 约束）。**跨表一致性由 db/ 层事务内校验强制**（入团/换团/转售出/编辑单的写路径在事务内比对 site 与币种；不用触发器，保持规则单份真源于 rules.ts）
3. **一单至多一个团**；囤货单也允许挂 batch_id（可空）
4. **历史数据不做导入器**，进行中业务手动补录（开荒期熟悉系统）
5. 汇率联网查询仅服务订单层预估；团层权威汇率永远手填
6. **收益计算唯一实现**于 `db/rules.ts`（canonical_profit），团收益 = Σ 成员结果，页面/导出/统计不得各自实现
7. **effective_rate 纯展示**，任何金额计算不得引用

---

## 8. 开发计划

**启动序列（写死，实现不得乱序）**：main.rs 仅注册 tauri-plugin-sql（无自定义 command）→ 前端启动 `Database.load('sqlite:tracker.db')` 单例（自动落 App Support 目录，全程复用同一连接）→ 执行并**验证** `PRAGMA foreign_keys = ON` → 跑 migrate（§3.5）→ 就绪渲染主界面。任何一步失败 = 弹错误阻止进入。

1. **项目脚手架**：Tauri 2 + React + TS + Vite + Tailwind + shadcn/ui，tauri-plugin-sql 接入（含上述启动序列）
2. **数据库**：建表（含 CHECK 约束与外键）+ 索引 + `user_version` 迁移框架
3. **db/ 数据层**：CRUD + 转移矩阵与兜底规则 + canonical_profit + 结算分摊算法 + 金额换算 helper + 事务封装
4. **订单页**：列表（默认视图/筛选/行变色/提醒条）+ 新建编辑表单（汇率联动、adjustments 编辑器、发货弹窗）
5. **团页**：列表 + 详情（结算区 + 结算分摊 + 成员订单）
6. **库存页** + 转售出流程
7. **统计页**：卡片 + 图表 + 异常账本
8. **设置页**：网站管理、CSV 导出、备份
9. **打磨**：表单校验、空状态、错误处理
10. **CI/CD**：GitHub Actions workflow——push/PR 跑 vitest 单测 + better-sqlite3 集成测试；`v*` tag 触发 tauri-action 构建 dmg 并发布 GitHub Release

---

## 9. 已关闭的设计争议（决策记录）

| 议题 | 决策 |
|---|---|
| payment_ratio vs status | 删 payment_ratio，付款状态由 status 单源表达（业务前提：买家全款预付） |
| refunded 语义 | 恒为全额退款，收益 = 0；**判定先于缺成本检查**（退款无需成本信息） |
| 部分折让/折扣 | 走 `adjustments`：kind=revenue 负数 = 让利买家；kind=cost 负数 = 供应商折扣 |
| 丢失/亏损 | 独立 `lost` 终态，收益 = −全成本，不记赔偿字段；转 lost 硬校验 buy_price；**stock lost 同样计负全成本、按 closed_at 归月**（stock 的 in_stock/listed/consumed 保持 excluded） |
| 收益归属月份 | 按 `shipped_at` 月；lost 按 `closed_at` 月 |
| NULL 语义 | shipped/lost 门槛硬校验 buy_price；shipping COALESCE 0；adjustments 恒为数组（**DDL 强制 NOT NULL DEFAULT '[]' + json_valid + json_type='array'**）；incomplete 三态显式提示 |
| 收益函数 | 状态感知的 canonical_profit（ProfitResult 三态），全局唯一实现；团收益 = Σ 成员结果，无第二公式 |
| 外币成本 | 单金额 + 币种（整数最小单位），同空同填 |
| 金额表示 | 全部 INTEGER 最小单位（分/外币分），汇率保留 REAL；**STRICT 表强制整数存储，canonical DDL 见 §3.6；汇率经 normRate() 归一化 6 位小数，金额换算用十进制安全实现** |
| buy_price 来源 | `buy_price_source` 三态（estimated/manual/batch_allocated），手改最高优先级；**汇率联动仅作用 estimated，batch_allocated 冻结**（仅显式重分摊或手改降级可改） |
| 团折扣与对账 | **结算分摊**：汇率定总额 T，加权分摊 + 最大余数法 + 事务校验 Σ≡T；分母只含可分摊单外币成本；空池置灰 / P<0 禁止并提示 / P=0 允许但明示；retroactive 已确认 |
| 等效汇率 | `effective_rate` 落库但纯展示，不参与计算 |
| 结算状态 | 四态派生：预估/待分摊/已分摊/待重新分摊；**按锚点分支**：手动模式锚 rate、allocated_checkout 存 NULL；checkout 模式锚 checkout+rate；**过期检测用 settlement_updated_at（仅结算字段变更才更新）+ allocated_member_count（成员增减检测）** |
| 校验双闸 | **DB 管结构存在性（STRICT/CHECK/外键），rules.ts 管语义（转移矩阵/状态门槛/金额运算）**；db/ 写入口统一 validateOrder()；跨表不变量（一团一站一币种）由 db/ 事务内校验强制，不用触发器 |
| 团口径 | 团成本 / 未售库存占用 / 团收益（=Σ canonical_profit）三行 |
| 一团一站一币种 | 硬约束，site_id 外键 + 挂团校验（防录入错误）；**禁止纯人民币成员入团**（外币成本必填且币种==团币种，纯人民币单只能做散单）；sites 删除 RESTRICT |
| 状态机 | 显式转移矩阵 + CHECK 约束两道闸（**如实描述：转移闸 = rules.ts 前置校验；CHECK 只管枚举域、不管跳变**，不引入触发器以避免矩阵双份真源）；终态可回退 |
| 回退时间戳 | 回退清 closed_at；**目标是 paid_pending_ship 一律清 shipped_at（无论来源状态）**、保留 tracking_no |
| done 进入条件 | 纯手动 + 邮费未填软确认 |
| 默认视图 | 进行中单 ∪ 最新活跃团（按 id 去重） |
| 数据访问层 | tauri-plugin-sql + `src/db/` 铁律（不用 sqlx/Rust commands）；**五步启动序列**：plugin 注册 → load 单例 → **serialize() 串行化** → 验证 foreign_keys → migrate → 就绪；**serialize 的原因（issue #10）**：plugin-sql 底层 sqlx 池默认多连接、无 busy_timeout，串行化逼池只建 1 条物理连接，手工 BEGIN/COMMIT 事务与 connection-local PRAGMA 才安全 |
| 时间戳约定 | **UTC ISO-8601 入库**（字典序=时间序）；显示与月度归属按本地时区换算，换算函数在 rules.ts |
| 迁移事务性 | 每个迁移单事务执行，user_version 同事务最后提交；失败整体回滚并阻止进入主界面 |
| 订单号手改 | 手改仅校验非空+唯一；序号生成只统计符合 `^\d{8}-\d+$` 且日期段=创建日的编号 |
| 转售出来源 | in_stock / listed / **consumed** 可转（清 closed_at）；lost 不可转，需先回退 in_stock |
| 历史数据 | 不做导入器，手动补录 |
| 备份 | `VACUUM INTO` + 秒级时间戳命名 + **integrity_check 通过后才删旧**、保留 2 份 + 7 天提醒；文件操作走 fs plugin（scope 限备份目录）；**威胁模型：只防逻辑损坏，恢复为手动替换文件** |
| 分发 | **GitHub CI 构建 + Releases 发布 dmg**（tauri-action，macos runner）；本地不装 Rust（权衡：无法本地 tauri dev，UI 靠 vite dev + mock）；无签名无自动更新，首次安装 `xattr -cr` 清 quarantine |
| 测试策略（issue #10 后补强） | 三层：①vitest（better-sqlite3 内存库跑真实 migrate+约束，共享 `db/testUtils.ts`）；②jsdom 组件交互测试（Testing Library，**db 层不 mock** 用真库当 prop；StatsPage 除外——Recharts 不在 jsdom 渲染，其逻辑由 stats.test.ts 覆盖）；③E2E 仅 CI：`tauri-plugin-wdio-webdriver`（`cfg(debug_assertions)` 门控，release 零侵入）+ `@wdio/tauri-service` embedded provider，macOS runner debug 构建跑冒烟（含 #10 双回归）；`npm test` 恒为纯 vitest，E2E 走 `npm run test:e2e` |
| plugin-sql 两个坑（issue #10） | ①guest-js `close(db?)` 传参数而非 this.path——无参 close 会关**全部**连接池，必须 `close(conn.path)`；②默认池多连接（见数据访问层行 serialize 决策） |
| 原生 JS 弹窗禁用（issue #10 Bug 3） | **Tauri macOS 的 WKWebView 不实现 alert/confirm/prompt**（no-op 返回 undefined），`if(!confirm())return` 会静默拦截。一律用应用内对话框：`components/ConfirmDialog.tsx` 的 `useConfirm()`（Promise 化确认框，挂 ConfirmDialogProvider），代码中禁止出现原生 confirm/alert |
| 锁错误自愈（issue #10 后续，e2e 排查产物） | **根因（CI 取证）**：sqlx 归还连接走 Rust 异步任务，下一条语句的 acquire 可能抢在归还完成前 → 池膨胀 → FIFO 空闲队列把手工 BEGIN…COMMIT 的语句轮转到不同连接（WAL 下报 database is locked / no such table）。**防御三层**：①所有写事务（createOrder/shipOrder/转售出/删团/分摊/migrate）打成**单 execute 多语句批量**（`db/transaction.ts` executeBatch；sqlx-sqlite 单连接顺序执行整串，一次 acquire 完成整个事务）；②serialize 外壳每语句 1ms 间隙，让归还任务先完成、池保持单连接；③withLockRetry 退避重放 + 持续锁 recoverPool 关池重建兜底；启动序列另有 ROLLBACK 清悬挂事务 + 重试 |
