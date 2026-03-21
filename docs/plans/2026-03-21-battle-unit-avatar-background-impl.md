# Battle Unit Avatar Background Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 BattleArea 的玩家与伙伴单位卡片显示头像背景，并沿正式战斗与本地预览共用同一条头像数据链路。

**Architecture:** 服务端先给 battle unit 补齐可选 `avatar` 字段，前端再把 `BattleUnitDto` 统一映射到 `BattleUnit.avatar`。BattleUnitCard 不直接判断业务来源，只通过一个纯函数模块决定是否渲染头像背景层。

**Tech Stack:** TypeScript、React、SCSS、Node test、Vitest

---

### Task 1: 锁定头像数据链路行为

**Files:**
- Create: `server/src/services/__tests__/battleUnitAvatar.test.ts`
- Create: `client/src/pages/Game/modules/__tests__/battleUnitBackground.test.ts`

**Step 1: 写服务端测试**
- 断言 `createPVEBattle` 生成的主玩家与伙伴单位会保留 avatar。
- 断言怪物单位不会携带 avatar。

**Step 2: 写前端纯函数测试**
- 断言 `player` / `partner` 且有 avatar 时返回可用背景 URL。
- 断言空 avatar 或其它单位类型返回 `undefined`。

### Task 2: 补齐服务端 battle unit 头像字段

**Files:**
- Modify: `server/src/battle/types.ts`
- Modify: `server/src/battle/battleFactory.ts`
- Modify: `server/src/services/shared/partnerBattleMember.ts`
- Modify: `server/src/services/__tests__/battleTestUtils.ts`

**Step 1: 扩展类型**
- 给 `BattleUnit` 与 `CharacterData` 增加可选 `avatar`。

**Step 2: 统一构建**
- `createCharacterUnit` 只在 `player` / `partner` 上透传 avatar。
- 伙伴战斗成员构建时把伙伴头像带入 `CharacterData`。

### Task 3: 接入前端背景层

**Files:**
- Modify: `client/src/services/api/combat-realm.ts`
- Modify: `client/src/pages/Game/modules/BattleArea/types.ts`
- Modify: `client/src/pages/Game/modules/BattleArea/index.tsx`
- Create: `client/src/pages/Game/modules/BattleArea/battleUnitBackground.ts`
- Modify: `client/src/pages/Game/modules/BattleArea/BattleUnitCard.tsx`
- Modify: `client/src/pages/Game/modules/BattleArea/index.scss`

**Step 1: 补齐前端类型与本地预览映射**
- `BattleUnitDto` / `BattleUnit` 增加 `avatar`。
- 本地预览构建 `BattleUnit` 时补 `unitType` 与 `avatar`。

**Step 2: 新增纯函数入口**
- 根据 `unitType + avatar` 返回背景图 URL 或 `undefined`。
- 不做默认图兜底。

**Step 3: 渲染背景层**
- `BattleUnitCard` 在卡片底层插入头像背景层。
- SCSS 增加遮罩、透明度与选中/死亡态兼容样式。

### Task 4: 类型校验

**Files:**
- Modify: `无`

**Step 1: 执行校验**
- 运行 `tsc -b`。
- 若失败，优先修复本次头像字段链路导致的类型错误。
