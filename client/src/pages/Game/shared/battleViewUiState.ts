/**
 * Game 战斗视图 UI 状态归一化规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一收口 Game 页在“进入战斗 / 退出战斗”时，`viewMode`、`topTab`、`infoTarget` 这三类壳状态的切换口径。
 * 2. 做什么：默认保持战斗链路不顺手关闭任何已打开的信息弹窗，避免怪物/玩家信息窗口被被动同步自动关闭。
 * 3. 做什么：允许显式业务动作声明“本次切视图需要关闭信息窗”，例如从怪物信息窗主动点击攻击。
 * 4. 不做什么：不负责战斗 session、回合数、战斗对象或 socket 数据同步，只负责归一化壳状态。
 *
 * 输入/输出：
 * - 输入：当前 Game 页 UI 状态，以及目标视图模式。
 * - 输出：下一份 UI 状态快照。
 *
 * 数据流/状态流：
 * - Game 页 battle session / realtime / 战斗入口动作 -> 本模块纯函数 -> React state setter 写回页面壳状态。
 *
 * 关键边界条件与坑点：
 * 1. 进入或退出战斗时都必须把 `topTab` 归到 `map`，否则移动端可能停留在 `room` 标签下，看起来像战斗页被遮住。
 * 2. 默认必须原样透传 `infoTarget`；只有显式传入关闭选项时才允许清空，否则会再次把“保留信息弹窗”规则打散。
 */

export type GameViewMode = 'map' | 'battle';
export type GameTopTab = 'map' | 'room';

export interface BattleViewUiState<TInfoTarget> {
  viewMode: GameViewMode;
  topTab: GameTopTab;
  infoTarget: TInfoTarget | null;
}

export const resolveBattleViewUiState = <TInfoTarget>(
  current: BattleViewUiState<TInfoTarget>,
  nextViewMode: GameViewMode,
  options?: {
    preserveInfoTarget?: boolean;
  },
): BattleViewUiState<TInfoTarget> => {
  const preserveInfoTarget = options?.preserveInfoTarget ?? true;
  return {
    ...current,
    viewMode: nextViewMode,
    topTab: 'map',
    infoTarget: preserveInfoTarget ? current.infoTarget : null,
  };
};
