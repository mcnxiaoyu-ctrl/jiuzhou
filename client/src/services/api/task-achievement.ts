import api from './core';

export type TaskCategory = 'main' | 'side' | 'daily' | 'event';

export type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

export type TaskObjectiveDto = {
  id: string;
  type: string;
  text: string;
  done: number;
  target: number;
  params?: Record<string, unknown>;
};

export type TaskRewardDto =
  | { type: 'silver'; name: string; amount: number }
  | { type: 'spirit_stones'; name: string; amount: number }
  | { type: 'item'; itemDefId: string; name: string; icon: string | null; amount: number; amountMax?: number };

export type TaskOverviewRowDto = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  mapId: string | null;
  roomId: string | null;
  status: TaskStatus;
  tracked: boolean;
  description: string;
  objectives: TaskObjectiveDto[];
  rewards: TaskRewardDto[];
};

export type TaskOverviewResponse = {
  success: boolean;
  message: string;
  data?: { tasks: TaskOverviewRowDto[] };
};

export const getTaskOverview = (category?: TaskCategory): Promise<TaskOverviewResponse> => {
  return api.get('/task/overview', { params: { category } });
};

export type BountyTaskSourceType = 'daily' | 'player';

export type BountyTaskOverviewRowDto = Omit<TaskOverviewRowDto, 'category'> & {
  category: 'bounty';
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

export type BountyTaskOverviewResponse = {
  success: boolean;
  message: string;
  data?: { tasks: BountyTaskOverviewRowDto[] };
};

export const getBountyTaskOverview = (): Promise<BountyTaskOverviewResponse> => {
  return api.get('/task/bounty/overview');
};

export type SetTaskTrackedResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string; tracked: boolean };
};

export const setTaskTracked = (taskId: string, tracked: boolean): Promise<SetTaskTrackedResponse> => {
  return api.post('/task/track', { taskId, tracked });
};

export type ClaimTaskRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    taskId: string;
    rewards: Array<
      | { type: 'silver'; amount: number }
      | { type: 'spirit_stones'; amount: number }
      | { type: 'item'; itemDefId: string; qty: number; itemIds?: number[]; itemName?: string; itemIcon?: string }
    >;
  };
};

export const claimTaskReward = (taskId: string): Promise<ClaimTaskRewardResponse> => {
  return api.post('/task/claim', { taskId });
};

export type NpcTalkTaskStatus = 'locked' | 'available' | 'accepted' | 'turnin' | 'claimable' | 'claimed';

export type NpcTalkTaskOption = {
  taskId: string;
  title: string;
  category: TaskCategory;
  status: NpcTalkTaskStatus;
};

export type NpcTalkResponse = {
  success: boolean;
  message: string;
  data?: { npcId: string; npcName: string; lines: string[]; tasks: NpcTalkTaskOption[] };
};

export const npcTalk = (npcId: string): Promise<NpcTalkResponse> => {
  return api.post('/task/npc/talk', { npcId });
};

export type NpcAcceptTaskResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string };
};

export const acceptTaskFromNpc = (npcId: string, taskId: string): Promise<NpcAcceptTaskResponse> => {
  return api.post('/task/npc/accept', { npcId, taskId });
};

export type NpcSubmitTaskResponse = {
  success: boolean;
  message: string;
  data?: { taskId: string };
};

export const submitTaskToNpc = (npcId: string, taskId: string): Promise<NpcSubmitTaskResponse> => {
  return api.post('/task/npc/submit', { npcId, taskId });
};

export type AchievementListStatus = 'in_progress' | 'completed' | 'claimed' | 'claimable' | 'all';

export type AchievementTrackType = 'counter' | 'flag' | 'multi';

export type AchievementRewardView =
  | { type: 'silver' | 'spirit_stones' | 'exp'; amount: number }
  | { type: 'item'; itemDefId: string; qty: number; itemName?: string; itemIcon?: string | null };

export type AchievementItemDto = {
  id: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  points: number;
  icon: string | null;
  hidden: boolean;
  status: 'in_progress' | 'completed' | 'claimed';
  claimable: boolean;
  trackType: AchievementTrackType;
  trackKey: string;
  progress: {
    current: number;
    target: number;
    percent: number;
    done: boolean;
    status: 'in_progress' | 'completed' | 'claimed';
    progressData?: Record<string, number | boolean | string>;
  };
  rewards: AchievementRewardView[];
  titleId: string | null;
  sortWeight: number;
};

export type AchievementPointsInfoDto = {
  total: number;
  byCategory: {
    combat: number;
    cultivation: number;
    exploration: number;
    social: number;
    collection: number;
  };
};

export type AchievementListResponse = {
  success: boolean;
  message: string;
  data?: {
    achievements: AchievementItemDto[];
    total: number;
    page: number;
    limit: number;
    points: AchievementPointsInfoDto;
  };
};

export const getAchievementList = (params?: {
  category?: string;
  status?: AchievementListStatus;
  page?: number;
  limit?: number;
}): Promise<AchievementListResponse> => {
  return api.get('/achievement/list', { params });
};

export type AchievementDetailResponse = {
  success: boolean;
  message: string;
  data?: {
    achievement: AchievementItemDto;
    progress: AchievementItemDto['progress'];
  };
};

export const getAchievementDetail = (achievementId: string): Promise<AchievementDetailResponse> => {
  return api.get(`/achievement/${achievementId}`);
};

export type ClaimAchievementResponse = {
  success: boolean;
  message: string;
  data?: {
    achievementId: string;
    rewards: AchievementRewardView[];
    title?: {
      id: string;
      name: string;
      rarity: string;
      color: string | null;
      icon: string | null;
    };
  };
};

export const claimAchievementReward = (achievementId: string): Promise<ClaimAchievementResponse> => {
  return api.post('/achievement/claim', { achievementId });
};

export type AchievementPointRewardDto = {
  id: string;
  threshold: number;
  name: string;
  description: string;
  rewards: AchievementRewardView[];
  title?: {
    id: string;
    name: string;
    rarity: string;
    color: string | null;
    icon: string | null;
  };
  claimable: boolean;
  claimed: boolean;
};

export type AchievementPointsRewardListResponse = {
  success: boolean;
  message: string;
  data?: {
    totalPoints: number;
    claimedThresholds: number[];
    rewards: AchievementPointRewardDto[];
  };
};

export const getAchievementPointsRewards = (): Promise<AchievementPointsRewardListResponse> => {
  return api.get('/achievement/points/rewards');
};

export type ClaimAchievementPointsRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    threshold: number;
    rewards: AchievementRewardView[];
    title?: {
      id: string;
      name: string;
      rarity: string;
      color: string | null;
      icon: string | null;
    };
  };
};

export const claimAchievementPointsReward = (threshold: number): Promise<ClaimAchievementPointsRewardResponse> => {
  return api.post('/achievement/points/claim', { threshold });
};

export type TitleInfoDto = {
  id: string;
  name: string;
  description: string;
  rarity: string;
  color: string | null;
  icon: string | null;
  effects: Record<string, number>;
  isEquipped: boolean;
  obtainedAt: string;
};

export type TitleListResponse = {
  success: boolean;
  message: string;
  data?: { titles: TitleInfoDto[]; equipped: string };
};

export const getTitleList = (): Promise<TitleListResponse> => {
  return api.get('/title/list');
};

export type EquipTitleResponse = {
  success: boolean;
  message: string;
};

export const equipTitle = (titleId: string): Promise<EquipTitleResponse> => {
  return api.post('/title/equip', { titleId });
};
