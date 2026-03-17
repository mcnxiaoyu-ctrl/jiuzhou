/**
 * BattleArea 战斗结束后的自动推进策略。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一判定“结束后应调用 onNext、等待外部上下文补齐，还是走普通地图本地自动重开”。
 * 2. 做什么：把 `externalBattleId` 与 `onNext` 的组合语义收口到单一入口，避免 BattleArea 多个 effect 各写一遍并出现竞态。
 * 3. 不做什么：不负责设置定时器、不读写 React state，也不决定冷却时长。
 *
 * 输入/输出：
 * - 输入：`externalBattleId`（当前是否处于秘境/竞技场/重连等外部战斗上下文）、`hasOnNext`（是否已经具备推进下一场的回调）。
 * - 输出：`FinishedBattleAdvanceMode`，供调用方决定后续动作。
 *
 * 数据流/状态流：
 * - BattleArea 收到 finished state -> 本模块给出推进模式 -> BattleArea 决定等待 / 调 onNext / 本地自动重开。
 *
 * 关键边界条件与坑点：
 * 1. 只要仍持有外部 battleId，就不能因为 `onNext` 暂时为空而回退成本地自动重开，否则秘境会误走普通地图连战分支。
 * 2. 普通地图连战必须在“没有外部 battleId 且没有 onNext”时才生效，避免把不同战斗来源混在一起。
 */

export type FinishedBattleAdvanceMode =
  | 'wait_on_next'
  | 'use_on_next'
  | 'use_local_retry';

const hasExternalBattleContext = (externalBattleId: string | null | undefined): boolean => {
  return String(externalBattleId || '').trim().length > 0;
};

export const resolveFinishedBattleAdvanceMode = (params: {
  externalBattleId: string | null | undefined;
  hasOnNext: boolean;
}): FinishedBattleAdvanceMode => {
  if (params.hasOnNext) {
    return 'use_on_next';
  }
  if (hasExternalBattleContext(params.externalBattleId)) {
    return 'wait_on_next';
  }
  return 'use_local_retry';
};
