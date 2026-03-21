# Battle Card Responsive Scaling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 BattleArea 战斗卡片在不同容器尺寸下保持框体、字体、内边距、血蓝条与标签的等比例响应式缩放。

**Architecture:** 保留现有尺寸档位，扩展 `resolveBattleFieldLayout` 计算“最终渲染缩放倍率”，并在 `index.scss` 中把卡片所有关键尺寸 token 改为基于同一倍率派生。React 组件继续只传递布局结果，不在业务组件里复制缩放逻辑。

**Tech Stack:** React 19、TypeScript、SCSS、Vite

---

### Task 1: 扩展战斗布局缩放计算

**Files:**
- Modify: `client/src/pages/Game/modules/BattleArea/battleFieldLayout.ts`

**Step 1: 明确基准尺寸映射**
- 为 `showcase / wide / standard / compact / dense` 建立统一基准宽高映射。
- 宽度值复用现有卡片基准宽度，高度按卡片固定纵横比推导。

**Step 2: 计算最终渲染倍率**
- 基于有效槽位宽高计算可容纳倍率。
- 将可容纳倍率与稀疏场景放大倍率合并，得到最终卡片倍率。

**Step 3: 保持现有布局职责**
- 保留现有尺寸档位判定、状态标签显示判定与标签数量上限。
- 不把样式 token 计算塞进 TypeScript，只输出缩放结果。

### Task 2: 用统一倍率驱动卡片样式

**Files:**
- Modify: `client/src/pages/Game/modules/BattleArea/index.scss`

**Step 1: 抽出 raw token**
- 将卡片宽度、内边距、间距、字号、血蓝条、标签高度等尺寸改成 `*-raw` 变量。

**Step 2: 统一派生缩放 token**
- 在 `.battle-unit-card` 中通过 `calc(raw * var(--battle-card-scale))` 派生实际尺寸。
- 确保标题、血蓝条、状态标签、浮字与内部间距同步缩放。

**Step 3: 保持尺寸档位覆盖点单一**
- 各尺寸档位只覆盖 raw token，不直接覆盖派生值。
- 移动端媒体查询同样只改 raw token，避免重复缩放逻辑。

### Task 3: 接入组件并完成校验

**Files:**
- Modify: `client/src/pages/Game/modules/BattleArea/BattleTeamPanel.tsx`

**Step 1: 继续通过 style 注入缩放变量**
- 复用现有 `--battle-card-scale` 注入入口，不在 JSX 中增加第二套缩放参数。

**Step 2: 执行类型校验**
- 运行 `tsc -b`。
- 若失败，先修复本次改动带来的类型问题，再输出结果。
