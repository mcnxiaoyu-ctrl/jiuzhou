import { describe, expect, it } from 'vitest';
import type { TechniqueResearchJobDto } from '../../../../../services/api/technique';
import {
  getSkillMobileDetailContent,
  getSkillCardSections,
  getSkillInlineDetailItems,
  mapResearchPreviewSkillToDetail,
} from '../skillDetailShared';

const createPreviewSkill = (): NonNullable<TechniqueResearchJobDto['preview']>['skills'][number] => ({
  id: 'skill-jinghong-1',
  name: '惊鸿步·1式',
  description: '惊鸿步的第1式。',
  icon: '/assets/skills/icon_skill_01.png',
  costLingqi: 12,
  costLingqiRate: 0.15,
  costQixue: 0,
  costQixueRate: 0,
  cooldown: 1,
  targetType: 'single_enemy',
  targetCount: 1,
  damageType: 'physical',
  element: 'jin',
  effects: [
    {
      type: 'buff',
      buffKey: 'buff-dodge-next',
      duration: 2,
      value: 1,
      valueType: 'flat',
    },
    {
      type: 'damage',
      damageType: 'physical',
      element: 'jin',
      scaleRate: 0.92,
      scaleAttr: 'wugong',
      valueType: 'scale',
    },
    {
      type: 'mark',
      operation: 'apply',
      markId: 'moon_echo',
      maxStacks: 3,
      duration: 2,
    },
  ],
});

describe('skillDetailShared', () => {
  it('mapResearchPreviewSkillToDetail: 应将研修草稿技能 DTO 适配为共享详情结构', () => {
    const detail = mapResearchPreviewSkillToDetail(createPreviewSkill());

    expect(detail).toMatchObject({
      id: 'skill-jinghong-1',
      name: '惊鸿步·1式',
      icon: '/assets/skills/icon_skill_01.png',
      description: '惊鸿步的第1式。',
      cost_lingqi: 12,
      cost_lingqi_rate: 0.15,
      cooldown: 1,
      target_type: 'single_enemy',
      target_count: 1,
      damage_type: 'physical',
      element: 'jin',
    });
  });

  it('getSkillCardSections: 应拆出顶部元信息、信息网格与摘要区，并保留全部 effects', () => {
    const sections = getSkillCardSections(mapResearchPreviewSkillToDetail(createPreviewSkill()));

    expect(sections.metaItems).toStrictEqual([
      { label: '灵气', value: '12 + 15%最大灵气' },
      { label: '冷却', value: '1回合' },
    ]);

    expect(sections.gridItems).toStrictEqual([
      { label: '目标', value: '单体敌人' },
      { label: '数量', value: '1' },
      { label: '伤害', value: '物理' },
      { label: '五行', value: '金', valueClassName: 'game-element-text game-element--jin' },
    ]);

    expect(sections.summaryItems.map((item) => item.value)).toStrictEqual([
      '惊鸿步的第1式。',
      '施加增益：下一次闪避（数值 1），持续2回合',
      '造成物理伤害，金属性，倍率 92%（物攻）',
      '施加月痕印记（每次+1层，上限3层，持续2回合；被消耗时返还灵气并强化下一次技能）',
    ]);
  });

  it('getSkillInlineDetailItems: 应保留全部 effects，不因描述与元信息截断后续效果', () => {
    const items = getSkillInlineDetailItems(mapResearchPreviewSkillToDetail(createPreviewSkill()));

    expect(items.filter((item) => item.isEffect).map((item) => item.value)).toStrictEqual([
      '施加增益：下一次闪避（数值 1），持续2回合',
      '造成物理伤害，金属性，倍率 92%（物攻）',
      '施加月痕印记（每次+1层，上限3层，持续2回合；被消耗时返还灵气并强化下一次技能）',
    ]);
  });

  it('getSkillMobileDetailContent: 应同时输出紧凑摘要与可展开的完整详情', () => {
    const content = getSkillMobileDetailContent(mapResearchPreviewSkillToDetail(createPreviewSkill()));

    expect(content.summary).toBe(
      '惊鸿步的第1式。 · 灵气消耗:12 + 15%最大灵气 · 冷却回合:1回合 · 目标类型:单体敌人 · 目标数量:1 · 施加增益：下一次闪避（数值 1），持续2回合 · 造成物理伤害，金属性，倍率 92%（物攻） · 施加月痕印记（每次+1层，上限3层，持续2回合；被消耗时返还灵气并强化下一次技能）',
    );
    expect(content.detailItems.map((item) => item.label)).toStrictEqual([
      '描述',
      '灵气消耗',
      '冷却回合',
      '目标类型',
      '目标数量',
      '效果1',
      '效果2',
      '效果3',
    ]);
    expect(content.detailItems.map((item) => item.value)).toContain('惊鸿步的第1式。');
    expect(content.detailItems.map((item) => item.value)).toContain('12 + 15%最大灵气');
    expect(content.detailItems.map((item) => item.value)).toContain('造成物理伤害，金属性，倍率 92%（物攻）');
  });
});
