/**
 * 月卡展示规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定月卡奖励图标与状态展示文案，防止后续再次把灵石奖励画成金币或把无业务含义的进度条塞回来。
 * 2. 做什么：验证三种核心状态的按钮文案和提示文案都由共享模块统一产出。
 * 3. 不做什么：不渲染 React 组件、不请求接口，也不覆盖 Ant Design 弹窗布局。
 *
 * 输入/输出：
 * - 输入：月卡展示共享模块的纯函数参数。
 * - 输出：奖励图标、状态值、提示文案与按钮文案断言。
 *
 * 数据流/状态流：
 * 共享纯函数输入 -> `monthCardDisplay.ts` -> 测试断言。
 *
 * 关键边界条件与坑点：
 * 1. 灵石奖励图标必须固定为 `IMG_LINGSHI`，否则 UI 会退回成错误的金币袋资源。
 * 2. 已到期与未激活的操作语义不同，不能共用同一套按钮文案，否则用户会误判“续期”和“首次激活”。
 */

import { describe, expect, it } from 'vitest';

import { IMG_LINGSHI } from '../../../shared/imageAssets';
import {
  buildMonthCardIndicator,
  buildMonthCardDailyRewards,
  buildMonthCardPanelState,
  getMonthCardPrivileges,
} from '../monthCardDisplay';

describe('monthCardDisplay', () => {
  it('每日灵石奖励应使用统一的灵石图标', () => {
    const rewards = buildMonthCardDailyRewards(10000);

    expect(rewards).toEqual([
      {
        id: 'spirit-stones',
        name: '灵石',
        icon: IMG_LINGSHI,
        amount: 10000,
        type: 'spiritStone',
      },
    ]);
  });

  it('激活中的月卡应展示剩余天数、到期时间与续期按钮文案', () => {
    const state = buildMonthCardPanelState({
      active: true,
      isExpired: false,
      daysLeft: 12,
      expireAt: '2026-03-30T08:00:00.000Z',
    });

    expect(state.title).toBe('月卡状态');
    expect(state.statusValue).toBe('剩余 12 天');
    expect(state.statusHint).toContain('到期时间：');
    expect(state.actionLabel).toBe('使用续期');
  });

  it('未激活的月卡应给出激活提示', () => {
    const state = buildMonthCardPanelState({
      active: false,
      isExpired: false,
      daysLeft: 0,
      expireAt: null,
    });

    expect(state.statusValue).toBe('未激活');
    expect(state.statusHint).toBe('背包有月卡道具时可点击“使用”激活。');
    expect(state.actionLabel).toBe('使用');
  });

  it('已到期的月卡应给出续期提示', () => {
    const state = buildMonthCardPanelState({
      active: false,
      isExpired: true,
      daysLeft: 0,
      expireAt: '2026-03-01T08:00:00.000Z',
    });

    expect(state.statusValue).toBe('已到期');
    expect(state.statusHint).toBe('背包有月卡道具时可点击“使用续期”叠加天数。');
    expect(state.actionLabel).toBe('使用续期');
  });

  it('今日奖励未领取时应展示月卡红点', () => {
    expect(buildMonthCardIndicator({ active: true, canClaim: true })).toEqual({
      badgeDot: true,
      tooltip: '今日月卡奖励待领取',
    });
    expect(buildMonthCardIndicator({ active: true, canClaim: false })).toEqual({
      badgeDot: false,
    });
  });

  it('月卡特权列表应展示体力恢复与福源加成', () => {
    const privileges = getMonthCardPrivileges({
      cooldownReductionRate: 0.1,
      staminaRecoveryRate: 0.1,
      fuyuanBonus: 20,
      idleMaxDurationHours: 12,
    });

    expect(privileges.map((item) => item.description)).toEqual([
      '激活期间每日可领取灵石奖励',
      '伙伴招募冷却缩短 10%',
      '洞府研修冷却缩短 10%',
      '离线挂机时长延长至 12 小时',
      '体力恢复速度提升 10%',
      '福源提升 20',
    ]);
  });
});
