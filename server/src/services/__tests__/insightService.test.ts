import test from 'node:test';
import assert from 'node:assert/strict';
import { isInsightUnlocked, resolveInsightInjectPlan } from '../insightService.js';
import type { InsightGrowthConfig } from '../staticConfigLoader.js';

const mockConfig: InsightGrowthConfig = {
  unlock_realm: '炼精化炁·养气期',
  cost_stage_levels: 50,
  cost_stage_base_exp: 500_000,
  bonus_pct_per_level: 0.0005,
};

test('isInsightUnlocked: 养气期及以上可解锁悟道', () => {
  assert.equal(isInsightUnlocked('凡人', null, mockConfig.unlock_realm), false);
  assert.equal(isInsightUnlocked('炼精化炁', '养气期', mockConfig.unlock_realm), true);
  assert.equal(isInsightUnlocked('炼精化炁·通脉期', null, mockConfig.unlock_realm), true);
});

test('resolveInsightInjectPlan: 经验不足时不产生注入等级', () => {
  const plan = resolveInsightInjectPlan({
    beforeLevel: 0,
    beforeProgressExp: 0,
    characterExp: 1_000_000,
    injectExpBudget: 499_999,
    config: mockConfig,
  });

  assert.equal(plan.actualInjectedLevels, 0);
  assert.equal(plan.spentExp, 499_999);
  assert.equal(plan.afterLevel, 0);
  assert.equal(plan.afterProgressExp, 499_999);
  assert.equal(plan.remainingExp, 500_001);
});

test('resolveInsightInjectPlan: 达到门槛后自动升级并结转到下一等级进度', () => {
  const plan = resolveInsightInjectPlan({
    beforeLevel: 0,
    beforeProgressExp: 450_000,
    characterExp: 100_000,
    injectExpBudget: 100_000,
    config: mockConfig,
  });

  assert.equal(plan.actualInjectedLevels, 1);
  assert.equal(plan.afterLevel, 1);
  assert.equal(plan.afterProgressExp, 50_000);
  assert.equal(plan.spentExp, 100_000);
  assert.equal(plan.remainingExp, 0);
  assert.equal(plan.beforeBonusPct < plan.afterBonusPct, true);
});

test('resolveInsightInjectPlan: 注入预算小于角色经验时应保留剩余角色经验', () => {
  const plan = resolveInsightInjectPlan({
    beforeLevel: 0,
    beforeProgressExp: 0,
    characterExp: 1_000_000,
    injectExpBudget: 500_000,
    config: mockConfig,
  });

  assert.equal(plan.actualInjectedLevels, 1);
  assert.equal(plan.afterLevel, 1);
  assert.equal(plan.afterProgressExp, 0);
  assert.equal(plan.spentExp, 500_000);
  assert.equal(plan.remainingExp, 500_000);
});
