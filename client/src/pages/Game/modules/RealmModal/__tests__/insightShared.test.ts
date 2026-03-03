import { describe, expect, it } from 'vitest';
import {
  buildInsightBonusPctByLevel,
  calcInsightCostByLevel,
  calcInsightProgressPct,
  simulateInsightInjectByExp,
  type InsightGrowthStageConfig,
} from '../insightShared';

const mockGrowth: InsightGrowthStageConfig = {
  costStageLevels: 50,
  costStageBaseExp: 500_000,
  bonusPctPerLevel: 0.0005,
};

describe('insightShared', () => {
  it('calcInsightCostByLevel: 单级消耗按 50 级分段递增', () => {
    expect(calcInsightCostByLevel(1, mockGrowth)).toBe(500_000);
    expect(calcInsightCostByLevel(50, mockGrowth)).toBe(500_000);
    expect(calcInsightCostByLevel(51, mockGrowth)).toBe(1_000_000);
    expect(calcInsightCostByLevel(101, mockGrowth)).toBe(1_500_000);
  });

  it('simulateInsightInjectByExp: 经验不足升级时应累计到当前级进度', () => {
    const preview = simulateInsightInjectByExp({
      currentLevel: 0,
      currentProgressExp: 0,
      injectExp: 120_000,
      growth: mockGrowth,
    });

    expect(preview.appliedExp).toBe(120_000);
    expect(preview.gainedLevels).toBe(0);
    expect(preview.afterLevel).toBe(0);
    expect(preview.afterProgressExp).toBe(120_000);
    expect(preview.nextLevelCostExp).toBe(500_000);
  });

  it('simulateInsightInjectByExp: 达到门槛后应自动升级并结转', () => {
    const preview = simulateInsightInjectByExp({
      currentLevel: 0,
      currentProgressExp: 450_000,
      injectExp: 100_000,
      growth: mockGrowth,
    });

    expect(preview.appliedExp).toBe(100_000);
    expect(preview.gainedLevels).toBe(1);
    expect(preview.afterLevel).toBe(1);
    expect(preview.afterProgressExp).toBe(50_000);
    expect(preview.nextLevelCostExp).toBe(500_000);
  });

  it('buildInsightBonusPctByLevel: 加成为固定单级线性增长', () => {
    expect(buildInsightBonusPctByLevel(0, mockGrowth.bonusPctPerLevel)).toBe(0);
    expect(buildInsightBonusPctByLevel(10, mockGrowth.bonusPctPerLevel)).toBe(0.005);
  });

  it('calcInsightProgressPct: 进度百分比应在 0~100 内', () => {
    expect(calcInsightProgressPct(0, 500_000)).toBe(0);
    expect(calcInsightProgressPct(250_000, 500_000)).toBe(50);
    expect(calcInsightProgressPct(999_999, 500_000)).toBe(100);
  });

  it('simulateInsightInjectByExp: 大额经验可跨多级并返回正确加成增量', () => {
    const preview = simulateInsightInjectByExp({
      currentLevel: 0,
      currentProgressExp: 0,
      injectExp: 1_500_000,
      growth: mockGrowth,
    });

    expect(preview.appliedExp).toBe(1_500_000);
    expect(preview.gainedLevels).toBe(3);
    expect(preview.afterLevel).toBe(3);
    expect(preview.afterProgressExp).toBe(0);
    expect(preview.gainedBonusPct).toBe(0.0015);
  });
});
