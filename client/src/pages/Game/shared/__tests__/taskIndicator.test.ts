import { describe, expect, it } from 'vitest';

import type {
  BountyTaskOverviewRowDto,
  TaskOverviewRowDto,
} from '../../../../services/api';
import {
  countCompletableBountyTaskOverviewRows,
  countCompletableTaskOverviewRows,
  getNextBountyTaskExpiryTs,
  isTaskIndicatorListCategory,
} from '../taskIndicator';

describe('taskIndicator', () => {
  it('普通任务角标应只统计 side/daily/event 中可完成的任务', () => {
    const tasks = [
      { id: 'main-1', category: 'main', status: 'claimable' },
      { id: 'side-1', category: 'side', status: 'turnin' },
      { id: 'daily-1', category: 'daily', status: 'claimable' },
      { id: 'event-1', category: 'event', status: 'ongoing' },
    ] as TaskOverviewRowDto[];

    expect(countCompletableTaskOverviewRows(tasks)).toBe(2);
  });

  it('悬赏任务角标应只按可完成状态统计', () => {
    const nowTs = Date.parse('2026-03-17T12:00:00.000Z');
    const tasks = [
      { id: 'bounty-1', status: 'turnin', sourceType: 'player', expiresAt: null },
      { id: 'bounty-2', status: 'claimable', sourceType: 'daily', expiresAt: '2026-03-17T12:30:00.000Z' },
      { id: 'bounty-3', status: 'claimable', sourceType: 'daily', expiresAt: '2026-03-17T11:59:59.000Z' },
      { id: 'bounty-4', status: 'completed', sourceType: 'player', expiresAt: null },
    ] as BountyTaskOverviewRowDto[];

    expect(countCompletableBountyTaskOverviewRows(tasks, nowTs)).toBe(2);
  });

  it('任务入口列表分类判断应排除主线', () => {
    expect(isTaskIndicatorListCategory('side')).toBe(true);
    expect(isTaskIndicatorListCategory('main')).toBe(false);
  });

  it('应返回最近一个未来的日常悬赏过期时间', () => {
    const nowTs = Date.parse('2026-03-17T12:00:00.000Z');
    const tasks = [
      { id: 'bounty-1', sourceType: 'daily', expiresAt: '2026-03-17T12:30:00.000Z' },
      { id: 'bounty-2', sourceType: 'daily', expiresAt: '2026-03-17T12:05:00.000Z' },
      { id: 'bounty-3', sourceType: 'player', expiresAt: null },
      { id: 'bounty-4', sourceType: 'daily', expiresAt: '2026-03-17T11:55:00.000Z' },
    ] as BountyTaskOverviewRowDto[];

    expect(getNextBountyTaskExpiryTs(tasks, nowTs)).toBe(Date.parse('2026-03-17T12:05:00.000Z'));
  });
});
