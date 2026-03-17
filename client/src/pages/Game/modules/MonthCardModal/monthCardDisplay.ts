/**
 * 月卡弹窗展示规则共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护月卡奖励图标、特权文案、状态文案与按钮文案，避免这些高频变化点散落在弹窗组件里。
 * 2. 做什么：把“接口返回的权益数值 -> UI 文案”收敛到单一入口，减少前端重复硬编码百分比与加成值。
 * 3. 不做什么：不请求接口、不持有 React 状态，也不负责具体 DOM 布局。
 *
 * 输入/输出：
 * - 输入：月卡每日灵石数量、权益数值、是否激活、是否到期、剩余天数、到期时间。
 * - 输出：奖励展示数组、特权展示数组，以及右侧状态面板要渲染的标题/文案/按钮文案。
 *
 * 数据流/状态流：
 * 月卡接口状态 -> 本模块纯函数 -> MonthCardModal 组件渲染。
 *
 * 关键边界条件与坑点：
 * 1. 灵石奖励图标必须始终走共享资源 `IMG_LINGSHI`，不能在业务组件里再次回退成金币图。
 * 2. 月卡权益数值以后仍可能调整，因此百分比与福源加成必须来自接口数据，不能在组件里写死。
 */

import { IMG_LINGSHI } from '../../shared/imageAssets';

const pad2 = (value: number) => String(value).padStart(2, '0');

const formatExpireAt = (expireAt: string | null): string => {
  if (!expireAt) return '';
  const date = new Date(expireAt);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
};

const formatPercent = (ratio: number): string => {
  const percent = Math.max(0, Math.round(ratio * 100));
  return `${percent}%`;
};

const formatFlatNumber = (value: number): string => {
  return `${Math.max(0, Math.floor(value))}`;
};

export type MonthCardDailyReward = {
  id: string;
  name: string;
  icon: string;
  amount: number;
  type: 'spiritStone';
};

export type MonthCardBenefitDisplayInput = {
  cooldownReductionRate: number;
  staminaRecoveryRate: number;
  fuyuanBonus: number;
  idleMaxDurationHours: number;
};

export type MonthCardPrivilegeIconName =
  | 'GiftOutlined'
  | 'UsergroupAddOutlined'
  | 'ClockCircleOutlined'
  | 'ThunderboltOutlined'
  | 'StarOutlined'
  | 'FieldTimeOutlined';

export type MonthCardPrivilege = {
  id: string;
  name: string;
  description: string;
  iconName: MonthCardPrivilegeIconName;
};

export type MonthCardPanelStateInput = {
  active: boolean;
  isExpired: boolean;
  daysLeft: number;
  expireAt: string | null;
};

export type MonthCardPanelState = {
  title: string;
  statusValue: string;
  statusHint: string;
  actionLabel: '使用' | '使用续期';
};

export const getMonthCardPrivileges = (
  benefits: MonthCardBenefitDisplayInput,
): MonthCardPrivilege[] => {
  const privileges: MonthCardPrivilege[] = [
    {
      id: 'daily-reward',
      name: '每日灵石',
      description: '激活期间每日灵石奖励',
      iconName: 'GiftOutlined',
    },
  ];

  if (benefits.cooldownReductionRate > 0) {
    const percentText = formatPercent(benefits.cooldownReductionRate);
    privileges.push(
      {
        id: 'partner-cooldown',
        name: '招募加速',
        description: `伙伴招募冷却缩短 ${percentText}`,
        iconName: 'UsergroupAddOutlined',
      },
      {
        id: 'practice-cooldown',
        name: '研修加速',
        description: `洞府研修冷却缩短 ${percentText}`,
        iconName: 'ClockCircleOutlined',
      },
    );
  }

  if (benefits.idleMaxDurationHours > 0) {
    privileges.push({
      id: 'idle-duration',
      name: '挂机延时',
      description: `离线挂机时长延长`,
      iconName: 'FieldTimeOutlined',
    });
  }

  if (benefits.staminaRecoveryRate > 0) {
    privileges.push({
      id: 'stamina-recovery',
      name: '体力恢复',
      description: `体力恢复速度提升 ${formatPercent(benefits.staminaRecoveryRate)}`,
      iconName: 'ThunderboltOutlined',
    });
  }

  if (benefits.fuyuanBonus > 0) {
    privileges.push({
      id: 'fuyuan-bonus',
      name: '福源加持',
      description: `福源提升 ${formatFlatNumber(benefits.fuyuanBonus)}`,
      iconName: 'StarOutlined',
    });
  }

  return privileges;
};

export const buildMonthCardDailyRewards = (dailySpiritStones: number): MonthCardDailyReward[] => [
  {
    id: 'spirit-stones',
    name: '灵石',
    icon: IMG_LINGSHI,
    amount: dailySpiritStones,
    type: 'spiritStone',
  },
];

export const buildMonthCardPanelState = ({
  active,
  isExpired,
  daysLeft,
  expireAt,
}: MonthCardPanelStateInput): MonthCardPanelState => {
  if (active) {
    const expireText = formatExpireAt(expireAt);
    return {
      title: '月卡状态',
      statusValue: `剩余 ${Math.max(0, daysLeft)} 天`,
      statusHint: expireText ? `到期时间：${expireText}` : '月卡生效中，可每日领取一次奖励。',
      actionLabel: '使用续期',
    };
  }

  if (isExpired) {
    return {
      title: '月卡状态',
      statusValue: '已到期',
      statusHint: '背包有月卡道具时可点击“使用续期”叠加天数。',
      actionLabel: '使用续期',
    };
  }

  return {
    title: '月卡状态',
    statusValue: '未激活',
    statusHint: '背包有月卡道具时可点击“使用”激活。',
    actionLabel: '使用',
  };
};
