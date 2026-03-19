/**
 * 队友战斗回放上下文失效判定。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 `teamBattleId` 何时必须失效的规则收口到单一纯函数，避免 `Game` 页在 team:update、leaveTeam、队长变更等多个分支里重复拼条件。
 * 2. 做什么：专门处理“队伍还在，但 leader 或我的队伍身份已经变化”这类瞬时切换，避免旧的队友战斗回放把玩家重新拉回一场已经结束的战斗。
 * 3. 不做什么：不读写 React state，不发请求，也不直接判断 battle 是否仍然存在。
 *
 * 输入/输出：
 * - 输入：当前是否存在 `teamBattleId`，以及队伍变更前后的 teamId / leaderId / role。
 * - 输出：是否应立即清空当前的队友战斗回放上下文。
 *
 * 数据流/状态流：
 * - Game 页拿到新的队伍概览 -> 调本函数判断旧回放是否仍有效 -> 无效时清掉 `teamBattleId` 并退出 battle 视图。
 *
 * 关键边界条件与坑点：
 * 1. 初次加载队伍数据时不能误判成“leader 变化”，否则会把正常的队友观战上下文清掉。
 * 2. 只有“仍在同一支队伍、仍是普通成员、leader 未变”时，旧的队友回放才允许继续保留；其余情况都必须失效。
 */

export type TeamBattleReplayIdentity = {
  teamId: string | null;
  leaderId: number | null;
  role: 'leader' | 'member' | null;
};

export const shouldResetTeamBattleReplayContext = (params: {
  battleId: string | null;
  previous: TeamBattleReplayIdentity | null;
  current: TeamBattleReplayIdentity;
}): boolean => {
  if (!params.battleId) return false;
  if (!params.previous) return false;

  const { previous, current } = params;
  if (!current.teamId) {
    return true;
  }

  if (current.role !== 'member') {
    return true;
  }

  if (previous.teamId !== current.teamId) {
    return true;
  }

  return previous.leaderId !== current.leaderId;
};
