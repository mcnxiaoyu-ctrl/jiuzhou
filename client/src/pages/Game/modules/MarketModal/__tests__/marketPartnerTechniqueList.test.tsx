/**
 * 坊市伙伴功法列表回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定坊市伙伴详情里功法卡片的交互协议，确保列表项会渲染成可点击入口，而不会直接把详情内联到主面板里。
 * 2. 做什么：把“完整功法详情依赖显式来源协议”的约束固定在共享列表入口，避免购买预览与待上架预览再次分叉。
 * 3. 不做什么：不验证 antd Modal / Drawer 动画、不触发真实请求，也不覆盖购买按钮逻辑。
 *
 * 输入 / 输出：
 * - 输入：带有已解锁技能的 `PartnerTechniqueDto` 列表，以及完整详情展示模式。
 * - 输出：静态 HTML 片段；列表入口需可点击，但不会在初始渲染时直接输出完整详情。
 *
 * 数据流 / 状态流：
 * 伙伴详情 DTO + 来源协议 -> `MarketPartnerTechniqueList` -> 完整功法详情弹层。
 *
 * 复用设计说明：
 * 1. 直接针对共享列表组件做回归，购买预览、待上架预览、移动端预览都会一起受保护。
 * 2. 桌面端与移动端继续共用同一组件，只通过容器模式切换弹窗 / 抽屉，避免复制两套功法 UI。
 *
 * 关键边界条件与坑点：
 * 1. 技能名必须与功法名不同，才能确保断言命中的不是标题本身。
 * 2. 初始渲染不能直接带出完整详情，否则后续很容易又退化成主弹层过长。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PartnerTechniqueDto } from '../../../../../services/api';
import MarketPartnerTechniqueList from '../MarketPartnerTechniqueList';

const createTechnique = (): PartnerTechniqueDto => ({
  techniqueId: 'tech-mowu-linzhen',
  name: '玄雾鳞障',
  description: '墨鳞吐雾凝鳞成障，偏重护体续战。',
  icon: '/assets/partner/tech-mowu-linzhen.png',
  quality: '玄',
  currentLayer: 1,
  maxLayer: 4,
  skillIds: ['skill-mowu-huxin'],
  skills: [
    {
      id: 'skill-mowu-huxin',
      name: '墨雾护心',
      icon: '/assets/skills/icon_skill_31.png',
      description: '吐出护体墨雾，降低本回合所受伤害。',
      cooldown: 2,
      target_type: 'self',
      effects: [],
    },
  ],
  passiveAttrs: {},
  isInnate: true,
});

describe('MarketPartnerTechniqueList', () => {
  it('完整详情模式应渲染可点击功法入口而不是直接内联详情', () => {
    const html = renderToStaticMarkup(
      <MarketPartnerTechniqueList
        techniques={[createTechnique()]}
        detailDisplayMode="drawer"
        detailSource={{ kind: 'listing', listingId: 1 }}
      />,
    );

    expect(html).toContain('market-partner-technique-trigger');
    expect(html).not.toContain('层数加成与技能');
    expect(html).not.toContain('墨雾护心');
  });
});
