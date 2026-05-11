import api from './core';
import type { MainQuestProgressDto } from '../mainQuestApi';
import type { TeamApplication, TeamInfo } from '../teamApi';
import type { IdleSessionDto } from '../../pages/Game/modules/IdleBattle/types';
import type { InventoryItemDto } from './inventory';
import type { RealmOverviewDto } from './combat-realm';
import type {
  TaskOverviewSummaryRowDto,
} from './task-achievement';

/**
 * 首页概览接口模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装首页首屏聚合概览请求，供 `Game/index.tsx` 单次初始化复用。
 * 2. 做什么：复用各领域原始 DTO 类型，避免首页再维护一套平行类型。
 * 3. 不做什么：不替代签到/成就/任务/队伍等详情接口；详情刷新仍走各自模块。
 *
 * 输入/输出：
 * - 输入：无额外参数，依赖当前登录态与角色上下文。
 * - 输出：首页概览 DTO。
 *
 * 数据流/状态流：
 * 首页进入 -> 调用本模块 -> 服务端聚合多个领域结果 -> 首页把结果分发到各自 UI 状态。
 *
 * 关键边界条件与坑点：
 * 1. 这里的任务与主线数据只用于首页首屏初始化，后续交互刷新不能偷懒继续依赖这份静态快照。
 * 2. 游戏内手机号绑定入口已移除，首页首屏不再携带账号安全状态，避免为不可见功能增加请求和缓存维护成本。
 */

export interface GameHomeOverviewDto {
  signIn: {
    currentMonth: string;
    signedToday: boolean;
  };
  achievement: {
    claimableCount: number;
  };
  realmOverview: RealmOverviewDto | null;
  equippedItems: InventoryItemDto[];
  idleSession: IdleSessionDto | null;
  team: {
    info: TeamInfo | null;
    role: 'leader' | 'member' | null;
    applications: TeamApplication[];
  };
  task: {
    tasks: TaskOverviewSummaryRowDto[];
  };
  mainQuest: MainQuestProgressDto;
}

export interface GameHomeOverviewResponse {
  success: boolean;
  message: string;
  data?: GameHomeOverviewDto;
}

export const getGameHomeOverview = (): Promise<GameHomeOverviewResponse> => {
  return api.get('/game/home-overview');
};
