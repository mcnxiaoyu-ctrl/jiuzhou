# 功法详情移动端紧凑化与技能展开实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让功法详情弹窗在移动端更紧凑，并让每个技能支持点击查看完整内容，避免摘要被截断后信息不可达。

**Architecture:** 继续复用 `TechniqueDetailPanel` 作为角色与伙伴功法详情的单一 UI 入口，把移动端技能摘要/完整内容的切换规则收口到共享层。样式层只调整共享弹窗与移动端层卡片密度，不新增第二套详情容器。

**Tech Stack:** React 19、TypeScript、Ant Design、SCSS、Vitest

---

### Task 1: 锁定移动端技能展开规则

**Files:**
- Modify: `client/src/pages/Game/modules/TechniqueModal/skillDetailShared.tsx`
- Test: `client/src/pages/Game/modules/TechniqueModal/__tests__/skillDetailShared.test.ts`

**Step 1: 写失败测试**

为共享技能详情模块补测试，验证：
- 移动端摘要文本仍保持单行紧凑版本
- 新增的“完整内容行”会保留描述、消耗与全部效果

**Step 2: 运行测试确认失败**

Run: `pnpm --dir client exec vitest run src/pages/Game/modules/TechniqueModal/__tests__/skillDetailShared.test.ts`

**Step 3: 写最小实现**

在共享技能详情模块新增“移动端展开内容”构建函数，供 `TechniqueDetailPanel` 直接复用。

**Step 4: 再次运行测试确认通过**

Run: `pnpm --dir client exec vitest run src/pages/Game/modules/TechniqueModal/__tests__/skillDetailShared.test.ts`

### Task 2: 改造共享功法详情面板

**Files:**
- Modify: `client/src/pages/Game/shared/TechniqueDetailPanel.tsx`
- Modify: `client/src/pages/Game/shared/TechniqueDetailPanel.scss`

**Step 1: 在共享面板接入移动端技能展开状态**

为每层技能项提供点击展开/收起能力，默认只展示紧凑摘要。

**Step 2: 收紧移动端布局**

压缩弹窗 body、层卡片、加成行、技能项间距与字号，保持可读前提下降低纵向高度。

**Step 3: 保持桌面端与其他复用入口不变**

桌面端 tooltip 与表格视图不改口径，避免额外回归风险。

### Task 3: 做最终校验

**Files:**
- Verify: `client/tsconfig.json`
- Verify: `tsconfig.json`

**Step 1: 执行 TypeScript 构建校验**

Run: `tsc -b`

**Step 2: 记录结果**

若失败，列出具体报错文件、原因与最小修复建议；若成功，直接在交付说明中写明通过。
