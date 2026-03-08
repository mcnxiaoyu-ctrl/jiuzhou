import { describe, expect, it } from 'vitest';
import type { TechniqueResearchJobDto } from '../../../../../services/api/technique';
import {
  getSkillCardSections,
  mapResearchPreviewSkillToDetail,
} from '../skillDetailShared';

const createPreviewSkill = (): NonNullable<TechniqueResearchJobDto['preview']>['skills'][number] => ({
  id: 'skill-jinghong-1',
  name: '惊鸿步·1式',
  description: '惊鸿步的第1式。',
  icon: '/assets/skills/icon_skill_01.png',
  costLingqi: 12,
  costQixue: 0,
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
      cooldown: 1,
      target_type: 'single_enemy',
      target_count: 1,
      damage_type: 'physical',
      element: 'jin',
    });
  });

  it('getSkillCardSections: 应拆出顶部元信息、信息网格与摘要区', () => {
    const sections = getSkillCardSections(mapResearchPreviewSkillToDetail(createPreviewSkill()));

    expect(sections.metaItems).toStrictEqual([
      { label: '灵气', value: '12' },
      { label: '冷却', value: '1回合' },
    ]);

    expect(sections.gridItems).toStrictEqual([
      { label: '目标', value: '单体敌人' },
      { label: '数量', value: '1' },
      { label: '伤害', value: '物理' },
      { label: '五行', value: '金' },
    ]);

    expect(sections.summaryItems.map((item) => item.value)).toStrictEqual([
      '惊鸿步的第1式。',
      '施加增益：下一次闪避（数值 1），持续2回合',
      '造成物理伤害，金属性，倍率 92%（物攻）',
    ]);
  });
});
