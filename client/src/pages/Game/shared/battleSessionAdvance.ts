/**
 * BattleSession 推进模式共享策略。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一收口 Game 页对 battle session 的“自动推进 / 手动继续 / 不可控等待”判定，避免 effect、按钮展示、战斗模式计算各写一套条件。
 * 2. 做什么：把“自动推进失败后降级为手动继续”封成单一纯函数，确保秘境与普通 PVE 共用同一恢复策略，减少重复判断。
 * 3. 不做什么：不直接发请求、不操作 React state，也不决定地图本地战斗如何续战。
 *
 * 输入/输出：
 * - 输入：battle session、当前是否在队伍中、是否队长、以及当前 session 的自动推进失败锁定 key。
 * - 输出：当前 session 应采用的推进模式，以及用于对齐失败锁定的稳定 session key。
 *
 * 数据流/状态流：
 * - Game 收到 session -> 本模块计算 session key / 推进模式 -> BattleArea 与自动推进 effect 复用同一结果。
 *
 * 关键边界条件与坑点：
 * 1. 自动推进失败的锁定必须绑定到稳定 session key，而不是只绑 sessionId；否则 battleId/nextAction 改变时会把旧失败状态误复用到新阶段。
 * 2. 队伍跟随者即使本地拿到了 `canAdvance=true` 的快照，也不能被当成推进者；真正推进权只属于单人或队长视角。
 */
import type { BattleSessionSnapshotDto } from '../../../services/api/battleSession';
import type { BattleAdvanceMode } from '../modules/BattleArea/autoNextPolicy';

export const DEFAULT_BATTLE_SESSION_AUTO_ADVANCE_DELAY_MS = 200;
export const TOWER_BATTLE_SESSION_AUTO_ADVANCE_DELAY_MS = 1000;

export const buildBattleSessionAdvanceKey = (
  session: BattleSessionSnapshotDto | null | undefined,
): string => {
  if (!session) return '';
  return [
    session.sessionId,
    session.currentBattleId ?? '',
    session.status,
    session.nextAction,
    session.lastResult ?? '',
  ].join('|');
};

const canControlBattleSession = (params: {
  inTeam: boolean;
  isTeamLeader: boolean;
}): boolean => {
  return !params.inTeam || params.isTeamLeader;
};

/**
 * BattleSession 自动推进延迟策略。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把不同会话类型的自动推进等待时间集中到单一纯函数，避免 Game 页 effect 再写一套 `if (tower)` 的分支。
 * 2. 做什么：明确千层塔胜利后保留 1 秒展示窗口，再自动进入下一层；其他会话继续沿用原有短延迟。
 * 3. 不做什么：不判断当前 session 是否允许自动推进；是否自动推进仍由 `resolveBattleSessionAdvanceMode` 负责。
 *
 * 输入/输出：
 * - 输入：当前 battle session 快照。
 * - 输出：自动推进前端等待毫秒数。
 *
 * 数据流/状态流：
 * - Game 拿到 active session -> 共享策略返回 delay -> 自动推进定时器按该 delay 触发 advance。
 *
 * 关键边界条件与坑点：
 * 1. 只有千层塔“继续下一层”需要拉长到 1 秒；塔的 `return_to_map` 结束态不能误用这个延迟去暗示自动结束。
 * 2. 延迟策略必须和推进模式解耦；后续若新增会话类型，只需要改本模块，不要在页面层散落条件判断。
 */
export const getBattleSessionAutoAdvanceDelayMs = (
  session: BattleSessionSnapshotDto | null | undefined,
): number => {
  if (session?.type === 'tower' && session.nextAction === 'advance') {
    return TOWER_BATTLE_SESSION_AUTO_ADVANCE_DELAY_MS;
  }
  return DEFAULT_BATTLE_SESSION_AUTO_ADVANCE_DELAY_MS;
};

export const resolveBattleSessionAdvanceMode = (params: {
  session: BattleSessionSnapshotDto | null | undefined;
  inTeam: boolean;
  isTeamLeader: boolean;
  blockedAutoAdvanceSessionKey: string;
}): Extract<
  BattleAdvanceMode,
  'none' | 'auto_session' | 'auto_session_cooldown' | 'manual_session'
> => {
  const session = params.session;
  if (!session?.canAdvance) {
    return 'none';
  }

  if (!canControlBattleSession(params)) {
    return 'none';
  }

  const sessionKey = buildBattleSessionAdvanceKey(session);
  if (sessionKey && sessionKey === params.blockedAutoAdvanceSessionKey) {
    return 'manual_session';
  }

  if (session.type === 'tower' && session.nextAction === 'return_to_map') {
    return 'manual_session';
  }

  if (session.type === 'pve' && session.nextAction === 'advance') {
    return 'auto_session_cooldown';
  }

  return 'auto_session';
};
