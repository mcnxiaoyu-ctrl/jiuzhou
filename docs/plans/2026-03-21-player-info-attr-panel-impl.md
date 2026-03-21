# Player Info Attr Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为玩家信息弹窗新增“属性”展示，并复用现有 `stats` 网格渲染链路。

**Architecture:** 服务端在 `infoTargetService` 的玩家详情分支统一组装 `stats`，前端 `InfoModal` 只负责复用现有属性网格 UI 展示，不再在组件内散落属性映射逻辑。测试优先锁定玩家详情 DTO 的属性输出口径，再做最小前端接线。

**Tech Stack:** TypeScript、React、Ant Design、Node.js `node:test`

---

### Task 1: 锁定玩家详情属性 DTO

**Files:**
- Modify: `server/src/services/infoTargetService.ts`
- Modify: `server/src/services/roomObjectService.ts`
- Test: `server/src/services/__tests__/infoTargetPlayerStats.test.ts`

**Step 1: 先写失败测试**

- 新增 `infoTargetPlayerStats.test.ts`
- 直接调用 `getInfoTargetDetail('player', ...)`
- Mock 数据库查询、月卡状态与角色计算快照
- 断言玩家详情中存在 `stats`，且百分比属性按 `%` 展示

**Step 2: 说明约束**

- 仓库规范禁止主动运行测试命令，因此本任务只补测试文件，不执行 `test` 脚本
- 最终只执行要求中的 `tsc -b`

**Step 3: 写最小实现**

- 为 `player` 类型补充可选 `stats`
- 在 `infoTargetService` 内新增玩家属性组装 helper
- 优先复用 `characterAttrRegistry` 的标签与百分比规则

### Task 2: 接前端玩家属性页签

**Files:**
- Modify: `client/src/services/api/world.ts`
- Modify: `client/src/pages/Game/modules/InfoModal/index.tsx`

**Step 1: 复用现有 UI 结构**

- 为玩家详情类型补充 `stats`
- 提取 `renderStatsGrid`，供怪物/玩家共用
- 在玩家页签里新增“属性”页

**Step 2: 保持最小样式改动**

- 继续使用已有 `info-modal-grid` 与 `info-kv`
- 不新增分叉样式，不改现有弹窗布局

### Task 3: 类型校验

**Files:**
- Verify: `tsc -b`

**Step 1: 执行校验**

- 运行 `tsc -b`
- 记录成功或失败结果

**Step 2: 输出交付信息**

- 汇总变更文件
- 明确说明抽取的复用单元
- 附上 `tsc -b` 结果
