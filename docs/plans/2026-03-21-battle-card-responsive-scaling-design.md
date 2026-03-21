# 战斗框体等比例响应式缩放设计

## 目标
- 让 `BattleArea` 里的战斗单位卡片在不同容器尺寸下保持“框体与内部内容同倍率缩放”。
- 保留现有 `showcase / wide / standard / compact / dense` 尺寸档位，不重写整套布局规则。
- 避免继续出现“卡片外框缩了，但字号、内边距、血蓝条、标签高度没有同步缩放”的视觉失衡。

## 现状问题
- `BattleTeamPanel` 通过 `resolveBattleFieldLayout` 计算 `cardScale`，并把它写入 `--battle-card-scale`。
- 现有 `index.scss` 只把 `--battle-card-scale` 用在卡片宽度上。
- 卡片内部大量尺寸仍由尺寸档位的固定 token 控制，例如：
  - `--battle-card-padding-block`
  - `--battle-name-size`
  - `--battle-bar-height`
  - `--battle-status-tag-height`
- 结果是：当卡片宽度因为容器缩小或稀疏放大而变化时，内部内容并没有走同一套比例，响应式表现是离散且失衡的。

## 设计方案
### 1. 单一缩放入口
- 继续由 `battleFieldLayout.ts` 统一输出卡片缩放系数。
- 缩放系数不再只是“稀疏场景放大倍率”，而是“最终渲染倍率”：
  - 先按尺寸档位拿到基准卡片尺寸
  - 再根据可用槽位宽高算出可容纳倍率
  - 最后与稀疏放大倍率取更严格的一侧，得到最终倍率

### 2. 样式层统一派生
- 在 `.battle-unit-card` 中保留一套“原始 token”，例如 `--battle-name-size-raw`、`--battle-bar-height-raw`。
- 所有实际使用的 token 都由 `raw * --battle-card-scale` 派生。
- 这样卡片宽度、内边距、间距、字号、血蓝条、状态标签、浮字位移会走同一比例。

### 3. 复用边界
- 布局计算仍只收口在 `battleFieldLayout.ts`。
- 样式派生仍只收口在 `index.scss` 的 `.battle-unit-card` 变量区。
- `BattleUnitCard.tsx` 和 `BattleTeamPanel.tsx` 只负责消费结果，不额外拼第二套缩放判断。

## 边界与取舍
- 不引入 `transform: scale(...)`，避免点击区域、文字清晰度与布局占位分离。
- 不删除现有尺寸档位，避免一次性把整个战斗布局改成连续插值，降低回归风险。
- 不额外引入兼容分支；缩放口径以现有战斗卡片结构为唯一数据源。

## 验证方式
- 静态检查 `BattleArea` 相关 TypeScript 类型能通过。
- 执行 `tsc -b`，确认本次改动未破坏现有类型链路。
