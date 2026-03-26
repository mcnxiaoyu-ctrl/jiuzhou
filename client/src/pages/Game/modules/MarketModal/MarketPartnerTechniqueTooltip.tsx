/**
 * 坊市伙伴功法悬浮详情
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中渲染坊市伙伴详情里单门功法的悬浮层，统一展示功法描述、当前层数与已解锁技能。
 * 2. 做什么：复用共享技能区，避免购买详情、预览弹层和列表组件各自重复拼接技能文案。
 * 3. 不做什么：不负责 Tooltip 触发、不拉取数据，也不处理功法列表布局。
 *
 * 输入/输出：
 * - 输入：`technique` 伙伴功法 DTO。
 * - 输出：可直接作为 antd `Tooltip.title` 的 React 节点。
 *
 * 数据流/状态流：
 * 坊市伙伴 DTO -> MarketPartnerTechniqueList -> 本组件 -> Tooltip 悬浮层。
 *
 * 关键边界条件与坑点：
 * 1. 这里只能展示伙伴当前层数已解锁的技能，不能回退到静态全量技能定义，否则会和真实战斗能力脱节。
 * 2. Tooltip 高度受视口限制，技能区必须走紧凑版展示，避免在较短窗口里出现难以阅读的超长浮层。
 */
import type { FC } from 'react';
import type { PartnerTechniqueDto } from '../../../../services/api';
import { TechniqueSkillSection } from '../../shared/TechniqueSkillSection';
import { formatPartnerTechniqueLayerLabel } from '../../shared/partnerDisplay';

export const MARKET_PARTNER_TECHNIQUE_TOOLTIP_CLASS_NAMES = {
  root: 'market-partner-technique-tooltip-overlay game-tooltip-surface-root',
  container: 'market-partner-technique-tooltip-overlay-container game-tooltip-surface-container',
} as const;

interface MarketPartnerTechniqueTooltipProps {
  technique: PartnerTechniqueDto;
}

const MarketPartnerTechniqueTooltip: FC<MarketPartnerTechniqueTooltipProps> = ({ technique }) => {
  return (
    <div className="market-partner-technique-tooltip">
      <div className="market-partner-technique-tooltip__header">
        <div className="market-partner-technique-tooltip__name">{technique.name}</div>
        <div className="market-partner-technique-tooltip__layer">
          {formatPartnerTechniqueLayerLabel(technique)}
        </div>
      </div>
      <div className="market-partner-technique-tooltip__desc">
        {technique.description || '暂无描述'}
      </div>
      <TechniqueSkillSection
        title="已解锁技能"
        emptyText="当前层暂无已解锁技能"
        skills={technique.skills}
        loading={false}
        error={null}
        variant="tooltip"
      />
    </div>
  );
};

export default MarketPartnerTechniqueTooltip;
