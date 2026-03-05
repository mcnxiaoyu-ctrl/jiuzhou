# 九州修仙录 - NPC / 怪物设计（字段策划）

> 版本：v0.1  
> 日期：2026-01-31  
> 目标：给出可落地的 NPC/怪物“策划设计 + 数据字段 + 刷新/掉落/行为”方案，支持九宫格地图与回合制战斗，并可逐步落库到 PostgreSQL（表/字段中文备注齐全）。

## 1. 设计原则

- 分层：**定义（静态配置）** 与 **实例（动态状态）** 分离；NPC/怪物默认以“常驻房间对象”的方式存在，实例层用于表达仇恨/功法装备/临时状态/事件阶段等动态信息，不以“死亡移除对象”为前提。
- 可读：策划字段尽量“所见即所得”，避免把核心规则埋在代码里；复杂规则用 JSONB 兜底。
- 可控：产出与强度必须可被运营调参（掉率、刷新、等级带、保底、精英/首领权重）。
- 可扩：对“对话树、商店、任务、AI、技能、掉落池、事件触发器”采用可组合的配置模块。
- 一致：与前端展示与交互对齐（InfoModal 的 `npc/monster` 字段），避免字段重复定义。
- 复用：NPC/怪物可装备功法以获得属性与技能，口径与玩家一致。
- 统一：NPC/怪物属性字段（属性ID）必须与玩家角色完全一致（参考 `server/src/models/characterTable.ts` 的字段集合）。

## 2. 核心概念

- **区域（Area）**：九宫格 `NW/N/NE/W/C/E/SW/S/SE`，属于“大世界”的最小分区。
- **房间对象（RoomObject）**：区域内可交互对象，包含 NPC/怪物/物品/玩家等（前端已有 `InfoTarget`）。
- **模板（Template）**：NPC/怪物的静态配置（名称、形象、境界、属性模板、掉落规则等）。
- **生成点（Spawn）**：某区域某时间段刷出哪些模板、数量、刷新周期、条件门槛。
- **掉落池（DropPool）**：可复用的掉落定义（权重/概率/保底/数量范围/绑定规则/掉落展示）。

## 3. NPC 设计

### 3.1 NPC 分类（建议）

- 剧情 NPC：对话、引导、剧情节点解锁（可带“任务链”）。
- 任务 NPC：发布/提交任务，提供任务进度检查与奖励领取。
- 商业 NPC：商店/回收/兑换（银两/灵石/材料/声望）。
- 功能 NPC：传送、仓库、邮箱、修炼加速、队伍大厅、宗门相关。
- 世界 NPC：提供区域信息、怪物情报、掉落提示（可触发事件）。

### 3.2 NPC 关键交互

- 交流：对话树（可选分支、条件、一次性对话、循环对话）。
- 购买/兑换：商店与兑换表（限购、刷新、动态价格可后续扩展）。
- 发布任务/交付：与任务系统关联（任务 ID、阶段、奖励、冷却）。
- 触发事件：触发“秘境入口 / 悬赏 / 野外事件 / 世界 Boss”。

### 3.3 NPC 前端展示字段（对齐现有 InfoModal）

```ts
type NpcInfo = {
  id: string;                // NPC唯一ID（策划ID）
  name: string;              // NPC名称
  title?: string;            // 称号
  gender?: string;           // 性别
  realm?: string;            // 境界（展示用）
  avatar?: string | null;    // 头像资源（可为URL或后端相对路径）
  desc?: string;             // 描述（对话简介/背景）
  drops?: Array<{            // 可选：战斗/事件掉落展示（例如可抢夺的世界NPC、护送目标等）
    name: string;
    quality: string;
    chance: string;
  }>;
};
```

## 4. 怪物设计

### 4.1 怪物分类（建议）

- 普通怪：高频产出，弱 AI，适合挂机。
- 精英怪：小概率刷新，属性更强，掉落更好，带 1-2 个技能或特性。
- 首领/Boss：有明确机制，掉落稀有，刷新周期长（可全服/区域）。
- 事件怪：由事件触发或限时出现（活动、任务、宗门战等）。
- 召唤物：由技能召唤，生命周期短（可不落库，纯战斗内生成）。

### 4.2 属性与强度（策划口径）

建议用“**境界档位**”控制强度区间：

- 境界：决定可挑战门槛与基础成长。

属性建议拆成两层：

- 模板基础属性：字段必须与玩家角色一致（例如 `qixue/max_qixue/lingqi/max_lingqi/wugong/fagong/wufang/fafang/mingzhong/shanbi/baoji/baoshang/sudu/...`）。
- 随机波动：用于减少重复感（例如同一怪物 ±5% 气血/物攻/法攻）

### 4.3 技能与 AI（回合制）

最低可落地的 AI 建议：

- 行为权重：普通攻击、技能A、技能B（按冷却与权重选择）
- 施放条件：血量阈值、回合数、目标状态（有/无护盾、是否被控）
- 技能效果：伤害/治疗/护盾/增益/减益/控制（与技能系统共用效果表达）

### 4.4 刷新与分布（九宫格）

生成点至少需要支持：

- 所属区域（九宫格）
- 刷新周期（秒/分钟），最大同时存在数量（用于“补齐数量”，不是死亡复活）
- 权重/概率：普通怪池 + 精英池 + Boss池
- 条件：玩家境界门槛、任务阶段、时间窗口（活动）

补充约束（本项目口径）：

- NPC/怪物默认不会死亡，会一直显示在所属区域的房间对象列表中
- “刷新”仅用于把数量补齐到 `max_alive`，例如被事件暂时移除/隐藏、或脚本主动清空后再补齐

### 4.5 怪物前端展示字段（对齐现有 InfoModal）

```ts
type MonsterInfo = {
  id: string;                // 怪物唯一ID（策划ID）
  name: string;              // 名称
  title?: string;            // 称号（妖兽/精英/首领）
  gender?: string;           // 一般为 "-"
  realm?: string;            // 境界（展示用）
  avatar?: string | null;    // 头像资源
  stats?: Array<{ label: string; value: string | number }>; // 展示用属性列表
  drops?: Array<{ name: string; quality: string; chance: string }>;
};
```

## 5. 数据结构与落库建议（PostgreSQL）

> 表名仅建议，落地时可按项目既有命名习惯调整。下表均给出中文备注口径，方便后续建表时直接写 COMMENT。

### 5.1 NPC 定义表（npc_def）

| 字段 | 类型（建议） | 允许为空 | 示例 | 中文备注 |
|---|---|---:|---|---|
| id | varchar(64) | 否 | `npc-merchant` | NPC配置ID |
| name | varchar(64) | 否 | `商会掌柜` | NPC名称 |
| title | varchar(64) | 是 | `掌柜` | NPC称号 |
| gender | varchar(16) | 是 | `男` | NPC性别 |
| realm | varchar(64) | 是 | `凡人` | NPC境界（展示） |
| avatar | varchar(256) | 是 | `/avatars/x.png` | NPC头像资源路径/URL |
| desc | text | 是 | `...` | NPC描述/简介 |
| base_attrs | jsonb | 是 | `{...}` | 基础属性（与玩家角色属性字段一致） |
| technique_slots | jsonb | 是 | `{"main":"tech-001","sub1":null,"sub2":null,"sub3":null}` | 功法装备栏位（与玩家一致） |
| technique_layers | jsonb | 是 | `{"tech-001":2}` | 功法修炼层数（用于计算加成与解锁技能） |
| skill_ids | jsonb | 是 | `["sk-001"]` | 技能ID列表（由功法/固有技能汇总） |
| talk_tree_id | varchar(64) | 是 | `talk-001` | 对话树ID |
| shop_id | varchar(64) | 是 | `shop-001` | 商店ID |
| exchange_id | varchar(64) | 是 | `ex-001` | 兑换表ID |
| quest_giver_id | varchar(64) | 是 | `qg-001` | 任务发布配置ID |
| enabled | boolean | 否 | true | 是否启用 |
| sort_weight | int | 否 | 0 | 排序权重 |
| version | int | 否 | 1 | 配置版本 |
| created_at | timestamptz | 否 | now | 创建时间 |
| updated_at | timestamptz | 否 | now | 更新时间 |

### 5.2 怪物定义表（monster_def）

| 字段 | 类型（建议） | 允许为空 | 示例 | 中文备注 |
|---|---|---:|---|---|
| id | varchar(64) | 否 | `monster-wolf` | 怪物配置ID |
| name | varchar(64) | 否 | `山野妖狼` | 怪物名称 |
| title | varchar(64) | 是 | `妖兽` | 称号（精英/首领等） |
| realm | varchar(64) | 是 | `凡人` | 境界（挑战门槛/展示） |
| level | int | 否 | 6 | 等级/档位 |
| avatar | varchar(256) | 是 | `/avatars/m.png` | 头像资源路径/URL |
| kind | varchar(32) | 否 | `normal` | 类型（normal/elite/boss/event） |
| element | varchar(16) | 是 | `无` | 五行/元素（金木水火土/无） |
| base_attrs | jsonb | 否 | `{...}` | 基础属性（与玩家角色属性字段一致） |
| ai_profile | jsonb | 是 | `{...}` | AI配置（技能权重、条件、优先级） |
| technique_slots | jsonb | 是 | `{"main":"tech-001","sub1":null,"sub2":null,"sub3":null}` | 功法装备栏位（与玩家一致） |
| technique_layers | jsonb | 是 | `{"tech-001":2}` | 功法修炼层数（用于计算加成与解锁技能） |
| skill_ids | jsonb | 是 | `["sk-001"]` | 技能ID列表（由功法/固有技能汇总） |
| drop_pool_id | varchar(64) | 是 | `dp-001` | 掉落池ID |
| enabled | boolean | 否 | true | 是否启用 |
| version | int | 否 | 1 | 配置版本 |
| created_at | timestamptz | 否 | now | 创建时间 |
| updated_at | timestamptz | 否 | now | 更新时间 |

### 5.3 刷新配置表（spawn_rule）

| 字段 | 类型（建议） | 允许为空 | 示例 | 中文备注 |
|---|---|---:|---|---|
| id | varchar(64) | 否 | `spawn-nw-001` | 刷新规则ID |
| area | varchar(8) | 否 | `NW` | 所属区域（九宫格） |
| pool_id | varchar(64) | 否 | `mp-001` | 怪物池/对象池ID |
| max_alive | int | 否 | 10 | 最大同时存在数量（常驻对象的“补齐上限”） |
| respawn_sec | int | 否 | 30 | 补齐检查周期（秒） |
| elite_chance | numeric(6,4) | 是 | 0.0200 | 精英额外概率 |
| boss_window | jsonb | 是 | `{...}` | Boss时间窗/事件窗 |
| req_realm_min | varchar(64) | 是 | `凡人` | 进入/触发所需最低境界 |
| enabled | boolean | 否 | true | 是否启用 |
| version | int | 否 | 1 | 配置版本 |

### 5.4 掉落池（drop_pool / drop_pool_entry）

`drop_pool`

| 字段 | 类型 | 备注（中文） |
|---|---|---|
| id | varchar(64) | 掉落池ID |
| name | varchar(64) | 掉落池名称 |
| mode | varchar(16) | 掉落模式（prob/weight） |
| version | int | 配置版本 |
| enabled | boolean | 是否启用 |

`drop_pool_entry`

| 字段 | 类型 | 备注（中文） |
|---|---|---|
| id | bigserial | 主键 |
| drop_pool_id | varchar(64) | 掉落池ID |
| item_def_id | varchar(64) | 物品定义ID |
| quality | char(1) | 品质（黄/玄/地/天） |
| chance | numeric(8,6) | 掉落概率（prob模式） |
| weight | int | 权重（weight模式） |
| qty_min | int | 最小数量 |
| qty_max | int | 最大数量 |
| bind_type | varchar(16) | 绑定规则（none/pickup/use/equip） |
| show_in_ui | boolean | 是否在前端掉落预览展示 |
| sort_order | int | 展示/结算顺序 |

## 6. 内容生产流程（策划到落地）

1. 先做模板：补齐 `npc_def` 与 `monster_def` 的核心字段（名称、境界、描述、头像、基础属性、掉落池）。
2. 再做分布：按九宫格配置 `spawn_rule`（普通池 + 精英池 + Boss窗）。
3. 最后补交互：NPC 的对话树/商店/任务关联逐步接入，怪物的 AI/技能逐步从“纯普攻”升级。

## 7. 示例配置（JSON 口径）

### 7.1 怪物定义示例

```json
{
  "id": "monster-wolf",
  "name": "山野妖狼",
  "title": "妖兽",
  "realm": "凡人",
  "level": 6,
  "kind": "normal",
  "element": "无",
  "base_attrs": { "qixue": 180, "max_qixue": 180, "wugong": 14, "wufang": 6, "sudu": 2 },
  "drop_pool_id": "dp-wolf-001"
}
```

### 7.2 刷新规则示例

```json
{
  "id": "spawn-nw-001",
  "area": "NW",
  "pool_id": "mp-newbie-001",
  "max_alive": 12,
  "respawn_sec": 30,
  "elite_chance": 0.02,
  "req_realm_min": "凡人",
  "enabled": true,
  "version": 1
}
```

## 8. 验收清单（上线前必须满足）

- NPC：可在九宫格区域正确显示、可点击打开信息面板、对话/商店/任务入口至少占位可扩展。
- 怪物：可按区域配置出现、可被“攻击”进入战斗、战斗结算能产出掉落（先走模拟也可）。
- 掉落：掉落预览与实际掉落规则一致；重要稀有物品可配保底与产出上限（可后续加）。
- 配置：所有表与字段都有中文备注口径；配置支持版本号与启用开关；可灰度上架。
