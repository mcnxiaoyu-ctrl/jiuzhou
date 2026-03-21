# 战斗单位头像背景设计

## 目标
- 让 `BattleArea` 中的 `player` 与 `partner` 单位卡片支持头像背景。
- 保持 `monster` / `npc` / `summon` 的现有纯色框体，不引入默认底图。
- 保证正式战斗快照、本地预览态、重连态都走同一条单位数据链路。

## 现状问题
- 前端 `BattleUnit` 视图模型没有头像字段。
- 服务端战斗快照里的 `BattleUnit` / `BattleUnitDto` 也没有头像字段，BattleArea 无法从正式战斗状态直接拿到头像。
- 项目里已经有玩家头像 URL 解析链 `resolveAvatarUrl`，但战斗卡片还没有可复用的头像背景判定入口。

## 方案
### 1. 单位数据链路补齐头像
- 服务端 `BattleUnit` 增加可选 `avatar` 字段。
- `battleFactory` 在构建 `player` / `partner` 单位时透传 `avatar`。
- 前端 `BattleUnitDto -> BattleUnit` 统一保留 `avatar` 字段。

### 2. 本地预览态保持同口径
- `Game/index.tsx` 中本地预览生成的 `BattleUnit` 也补齐 `unitType` 与 `avatar`。
- 这样本地预览和正式战斗都能复用 BattleArea 的同一套背景渲染逻辑。

### 3. 背景渲染收口
- 新增纯函数模块，根据 `unitType + avatar` 决定是否显示背景图与最终 URL。
- `BattleUnitCard` 只消费该纯函数结果，并渲染一层背景图 + 遮罩。
- 背景层保持低干扰，继续保证名字、血蓝条、状态标签可读。

## 边界
- 不为无头像的玩家或伙伴追加默认图片。
- 不为怪物、NPC、召唤物推断或拼接图片。
- 不引入新的请求；只复用现有战斗快照、本地角色数据、伙伴数据。

## 验证
- 新增纯函数测试锁定“只有 player / partner 使用头像背景”。
- 新增服务端测试锁定 `createPVEBattle` 会把 player / partner 的 avatar 带入战斗单位。
- 最终执行 `tsc -b` 做类型校验。
