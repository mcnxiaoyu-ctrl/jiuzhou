import type { TeamInfo, TeamMember } from '../../../services/teamApi';

/**
 * 队伍身份判定共享纯函数。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“当前角色在当前队伍里到底是队长、队员还是已不在队伍中”的判断集中到单一入口，避免 `Game` 页与 `TeamModal` 各自维护一套口径。
 * 2. 做什么：优先以 `leaderId` 判定队长身份，再用 `members` 判定“是否仍在队伍中”，避免队长转移瞬间 `members.role` 比 `leaderId` 慢半拍时误判成普通队员。
 * 3. 不做什么：不发请求、不读写 React state，也不负责生成队伍列表展示数据。
 *
 * 输入/输出：
 * - 输入：当前角色 ID，与当前队伍概览 `teamInfo`。
 * - 输出：`leader` / `member` / `null`。
 *
 * 数据流/状态流：
 * `/team/my` / 首页概览返回 `teamInfo` -> 页面调用本函数 -> 统一派生是否在队伍、是否为队长、回放上下文身份。
 *
 * 关键边界条件与坑点：
 * 1. 如果 `teamInfo` 不存在或没有 `id`，必须直接返回 `null`，不能把旧页面状态延续成“仍在队伍中”。
 * 2. 正常情况下自己应当出现在 `members` 中；若 `leaderId === characterId` 但成员列表暂未对齐，这里仍返回队长，专门用于抹平队长转移瞬间的响应时序。
 */

export type CurrentCharacterTeamRole = TeamMember['role'] | null;

const findCurrentCharacterTeamMember = (
  characterId: number | null,
  teamInfo: TeamInfo | null,
): TeamMember | null => {
  if (!teamInfo?.id || !characterId) {
    return null;
  }

  return teamInfo.members.find((member) => member.characterId === characterId) ?? null;
};

export const resolveCurrentCharacterTeamRole = (params: {
  characterId: number | null;
  teamInfo: TeamInfo | null;
}): CurrentCharacterTeamRole => {
  const { characterId, teamInfo } = params;
  if (!teamInfo?.id || !characterId) {
    return null;
  }

  if (teamInfo.leaderId === characterId) {
    return 'leader';
  }

  const currentMember = findCurrentCharacterTeamMember(characterId, teamInfo);
  if (currentMember) {
    return 'member';
  }

  return null;
};

export const isCurrentCharacterTeamLeader = (params: {
  characterId: number | null;
  teamInfo: TeamInfo | null;
}): boolean => {
  return resolveCurrentCharacterTeamRole(params) === 'leader';
};
