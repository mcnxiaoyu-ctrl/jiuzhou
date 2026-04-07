import type { AxiosRequestConfig } from 'axios';
import api from './core';
import { withRequestParams } from './requestConfig';

type RequestConfig = AxiosRequestConfig;

export interface SignInRecordDto {
  date: string;
  signedAt: string;
  reward: number;
  isHoliday: boolean;
  holidayName: string | null;
}

export interface SignInOverviewResponse {
  success: boolean;
  message: string;
  data?: {
    today: string;
    signedToday: boolean;
    month: string;
    monthSignedCount: number;
    streakDays: number;
    records: Record<string, SignInRecordDto>;
  };
}

export const getSignInOverview = (month?: string): Promise<SignInOverviewResponse> => {
  return api.get('/signin/overview', { params: { month } });
};

export interface DoSignInResponse {
  success: boolean;
  message: string;
  data?: {
    date: string;
    reward: number;
    isHoliday: boolean;
    holidayName: string | null;
    spiritStones: number;
  };
}

export const doSignIn = (): Promise<DoSignInResponse> => {
  return api.post('/signin/do');
};

export interface MonthCardStatusResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    name: string;
    description: string | null;
    durationDays: number;
    dailySpiritStones: number;
    priceSpiritStones: number;
    benefits: {
      cooldownReductionRate: number;
      staminaRecoveryRate: number;
      fuyuanBonus: number;
      idleMaxDurationHours: number;
    };
    active: boolean;
    expireAt: string | null;
    daysLeft: number;
    today: string;
    lastClaimDate: string | null;
    canClaim: boolean;
    spiritStones: number;
  };
}

export const getMonthCardStatus = (
  monthCardId?: string,
  requestConfig?: RequestConfig,
): Promise<MonthCardStatusResponse> => {
  return api.get('/monthcard/status', withRequestParams(requestConfig, { monthCardId }));
};

export type BattlePassTaskDto = {
  id: string;
  code: string;
  name: string;
  description: string;
  taskType: 'daily' | 'weekly' | 'season';
  condition: unknown;
  targetValue: number;
  rewardExp: number;
  rewardExtra: unknown[];
  enabled: boolean;
  sortWeight: number;
  progressValue: number;
  completed: boolean;
  claimed: boolean;
};

export type BattlePassTasksOverviewDto = {
  seasonId: string;
  daily: BattlePassTaskDto[];
  weekly: BattlePassTaskDto[];
  season: BattlePassTaskDto[];
};

export type BattlePassTasksResponse = {
  success: boolean;
  message: string;
  data?: BattlePassTasksOverviewDto;
};

export const getBattlePassTasks = (seasonId?: string): Promise<BattlePassTasksResponse> => {
  return api.get('/battlepass/tasks', { params: { seasonId } });
};

export type CompleteBattlePassTaskResponse = {
  success: boolean;
  message: string;
  data?: {
    taskId: string;
    taskType: 'daily' | 'weekly' | 'season';
    gainedExp: number;
    exp: number;
    level: number;
    maxLevel: number;
    expPerLevel: number;
  };
};

export const completeBattlePassTask = (taskId: string): Promise<CompleteBattlePassTaskResponse> => {
  const encodedTaskId = encodeURIComponent(String(taskId || '').trim());
  return api.post(`/battlepass/tasks/${encodedTaskId}/complete`);
};

export type BattlePassStatusDto = {
  seasonId: string;
  seasonName: string;
  exp: number;
  level: number;
  maxLevel: number;
  expPerLevel: number;
  premiumUnlocked: boolean;
  claimedFreeLevels: number[];
  claimedPremiumLevels: number[];
};

export type BattlePassStatusResponse = {
  success: boolean;
  message: string;
  data?: BattlePassStatusDto;
};

export const getBattlePassStatus = (): Promise<BattlePassStatusResponse> => {
  return api.get('/battlepass/status');
};

export type BattlePassRewardItem =
  | {
      type: 'currency';
      currency: 'spirit_stones' | 'silver';
      amount: number;
      name: string;
      icon: null;
    }
  | {
      type: 'item';
      itemDefId: string;
      qty: number;
      name: string;
      icon: string | null;
    };

export type BattlePassRewardDto = {
  level: number;
  freeRewards: BattlePassRewardItem[];
  premiumRewards: BattlePassRewardItem[];
};

export type BattlePassRewardsResponse = {
  success: boolean;
  message: string;
  data?: BattlePassRewardDto[];
};

export const getBattlePassRewards = (seasonId?: string): Promise<BattlePassRewardsResponse> => {
  return api.get('/battlepass/rewards', { params: { seasonId } });
};

export type ClaimBattlePassRewardResponse = {
  success: boolean;
  message: string;
  data?: {
    level: number;
    track: 'free' | 'premium';
    rewards: BattlePassRewardItem[];
    spiritStones?: number;
    silver?: number;
  };
};

export const claimBattlePassReward = (level: number, track: 'free' | 'premium'): Promise<ClaimBattlePassRewardResponse> => {
  return api.post('/battlepass/claim', { level, track });
};

export interface MonthCardUseItemResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
  };
}

export const activateMonthCardItem = (params?: {
  monthCardId?: string;
  itemInstanceId?: number;
}): Promise<MonthCardUseItemResponse> => {
  return api.post('/monthcard/use-item', params || {});
};

export interface MonthCardClaimResponse {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    date: string;
    rewardSpiritStones: number;
    spiritStones: number;
  };
}

export const claimMonthCardReward = (monthCardId?: string): Promise<MonthCardClaimResponse> => {
  return api.post('/monthcard/claim', { monthCardId });
};
