/**
 * BattleArea 共享显示类型
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中定义 BattleArea 内部复用的“单位视图模型”和“战斗浮字”类型，避免主组件、卡片组件、队列面板各自声明同名结构。
 * - 做什么：给 BattleArea 对外导出的 `BattleUnit` 提供单一真源，减少 Game 页与 BattleArea 子组件之间的类型漂移。
 * - 不做什么：不负责服务端 DTO 定义，不承载布局算法或 UI 展示逻辑。
 *
 * 输入/输出：
 * - 输入：组件 props、战斗状态快照、动画浮字数据。
 * - 输出：供 BattleArea 主组件与子组件共享的 TypeScript 类型。
 *
 * 数据流/状态流：
 * - Game 页 / socket 战斗快照 -> 归一化成 BattleUnit
 * - BattleUnit -> BattleTeamPanel / BattleUnitCard 消费
 * - 伤害治疗事件 -> BattleFloatText -> BattleUnitCard 浮字动画
 *
 * 关键边界条件与坑点：
 * 1. `buffs` 必须保留为可选字段，因为本地预览态单位并不携带服务端战斗 Buff 快照。
 * 2. 这里只描述前端显示所需字段，禁止把 BattleState 全量结构直接透传到卡片组件，避免 UI 与服务端内部状态强耦合。
 */

import type { BattleBuffDto } from '../../../../services/api';

export type BattleUnit = {
  id: string;
  name: string;
  unitType?: 'player' | 'monster' | 'npc' | 'summon' | 'partner';
  formationOrder?: number;
  ownerUnitId?: string;
  avatar?: string | null;
  tag?: string;
  hp: number;
  maxHp: number;
  qi: number;
  maxQi: number;
  isPlayer?: boolean;
  monthCardActive?: boolean;
  buffs?: BattleBuffDto[];
};

export type BattleFloatText = {
  id: string;
  unitId: string;
  value: number;
  dx: number;
  createdAt: number;
};
