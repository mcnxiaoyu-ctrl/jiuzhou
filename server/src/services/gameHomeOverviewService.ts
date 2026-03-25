import { getAchievementClaimableCount } from './achievementService.js';
import { inventoryService, type InventoryItemWithDef } from '../domains/inventory/index.js';
import { getMainQuestProgress, type MainQuestProgressDto } from './mainQuest/index.js';
import { getPhoneBindingStatus, type PhoneBindingStatusDto } from './marketPhoneBindingService.js';
import { idleSessionService } from './idle/idleSessionService.js';
import { toIdleSessionView } from './idle/idleSessionView.js';
import { signInService } from './signInService.js';
import { realmService } from './realmService.js';
import {
  getCharacterTeam,
  getTeamApplications,
  type TeamApplicationListItem,
  type TeamInfo,
} from './teamService.js';
import {
  getBountyTaskOverviewSummary,
  getTaskOverviewSummary,
  type BountyTaskOverviewSummaryDto,
  type TaskOverviewSummaryDto,
} from './taskService.js';

/**
 * 首页概览聚合服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把首页首屏需要的账号安全、签到红点、成就可领奖数、任务概览、主线追踪和队伍摘要收敛为单一读取入口。
 * 2. 做什么：复用各领域现有 service 的单一真值来源，避免前端首页把同一批初始化规则拆成多次请求、各自拼装。
 * 3. 不做什么：不改写任何领域 DTO，不做业务兜底转换，也不处理 HTTP 响应。
 *
 * 输入/输出：
 * - 输入：`userId`、`characterId`。
 * - 输出：首页概览 DTO，供首页首屏初始化直接消费。
 *
 * 数据流/状态流：
 * 首页请求 -> 本服务并发读取签到/成就/手机号/任务/主线/队伍 -> 聚合为统一 DTO -> 路由返回前端。
 *
 * 关键边界条件与坑点：
 * 1. 首页概览只做“聚合”，各子领域的业务判断仍必须继续复用原 service，不能在这里重新实现一套轻量版规则。
 * 2. 队伍申请未读数仍依赖前端本地已读时间戳，因此这里返回申请列表原始摘要，由前端沿用原有已读口径计算，而不是在服务端另造一份状态。
 */

type TeamRole = 'leader' | 'member' | null;
type RealmOverviewData = NonNullable<Awaited<ReturnType<typeof realmService.getOverview>>['data']>;

export interface GameHomeOverviewDto {
  signIn: {
    currentMonth: string;
    signedToday: boolean;
  };
  achievement: {
    claimableCount: number;
  };
  phoneBinding: PhoneBindingStatusDto;
  realmOverview: RealmOverviewData | null;
  equippedItems: InventoryItemWithDef[];
  idleSession: Record<string, unknown> | null;
  team: {
    info: TeamInfo | null;
    role: TeamRole;
    applications: TeamApplicationListItem[];
  };
  task: {
    tasks: TaskOverviewSummaryDto[];
    bountyTasks: BountyTaskOverviewSummaryDto[];
  };
  mainQuest: MainQuestProgressDto;
}

const buildCurrentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const normalizeTeamRole = (value: string | null | undefined): TeamRole => {
  if (value === 'leader') return 'leader';
  if (value === 'member') return 'member';
  return null;
};

const loadTeamOverview = async (characterId: number): Promise<GameHomeOverviewDto['team']> => {
  const teamResult = await getCharacterTeam(characterId);
  if (!teamResult.success) {
    return {
      info: null,
      role: null,
      applications: [],
    };
  }

  const info = teamResult.data ?? null;
  const role = normalizeTeamRole(teamResult.role);
  if (!info || role !== 'leader') {
    return {
      info,
      role,
      applications: [],
    };
  }

  const applicationsResult = await getTeamApplications(info.id, characterId);
  if (!applicationsResult.success) {
    return {
      info,
      role,
      applications: [],
    };
  }

  return {
    info,
    role,
    applications: applicationsResult.data ?? [],
  };
};

export const getGameHomeOverview = async (
  userId: number,
  characterId: number,
): Promise<GameHomeOverviewDto> => {
  const currentMonth = buildCurrentMonth();
  const [
    signInOverviewResult,
    claimableCount,
    phoneBinding,
    realmOverviewResult,
    equippedItemsResult,
    idleSession,
    team,
    taskOverview,
    bountyTaskOverview,
    mainQuest,
  ] = await Promise.all([
    signInService.getOverview(userId, currentMonth),
    getAchievementClaimableCount(characterId),
    getPhoneBindingStatus(userId),
    realmService.getOverview(userId),
    inventoryService.getInventoryItemsWithDefs(characterId, 'equipped', 1, 200),
    idleSessionService.getActiveIdleSession(characterId),
    loadTeamOverview(characterId),
    getTaskOverviewSummary(characterId),
    getBountyTaskOverviewSummary(characterId),
    getMainQuestProgress(characterId),
  ]);

  if (!signInOverviewResult.success || !signInOverviewResult.data) {
    throw new Error(signInOverviewResult.message || '读取签到概览失败');
  }

  return {
    signIn: {
      currentMonth,
      signedToday: signInOverviewResult.data.signedToday,
    },
    achievement: {
      claimableCount,
    },
    phoneBinding,
    realmOverview: realmOverviewResult.success ? (realmOverviewResult.data ?? null) : null,
    equippedItems: equippedItemsResult.items,
    idleSession: idleSession ? toIdleSessionView(idleSession) : null,
    team,
    task: {
      tasks: taskOverview.tasks,
      bountyTasks: bountyTaskOverview.tasks,
    },
    mainQuest,
  };
};
