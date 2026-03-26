/**
 * 功法技能展示区
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染功法相关技能区块，供功法书详情、物品 tooltip 与伙伴功法悬浮层复用。
 * 2. 做什么：集中处理加载中、错误、空态，以及“详情卡片版 / tooltip 紧凑明细版”两种展示形态。
 * 3. 不做什么：不负责拉取数据、不判断物品是不是功法书，也不处理学习交互。
 *
 * 输入/输出：
 * - 输入：`title` 标题、`emptyText` 空态文案、`skills` 技能数组、`loading` 加载态、`error` 错误文案、`variant` 展示形态。
 * - 输出：可直接插入详情面板或 tooltip 的 React 节点。
 *
 * 数据流/状态流：
 * useTechniqueSkillDetails / PartnerTechniqueDto.skills -> TechniqueSkillSection -> BagModal / Warehouse / Market / Partner Tooltip。
 *
 * 关键边界条件与坑点：
 * 1. 功法存在但无技能配置时不能静默隐藏，否则用户会误以为 tooltip 没生效，必须显式输出空态。
 * 2. tooltip 空间有限，不能复用完整卡片；需改为结构化紧凑明细，但仍要完整展示全部技能，避免信息缺失。
 */
import type { TechniqueSkillDetailLike } from '../modules/TechniqueModal/skillDetailShared';
import { renderSkillCardDetails, renderSkillInlineDetails } from '../modules/TechniqueModal/skillDetailShared';

interface TechniqueSkillSectionProps {
  title: string;
  emptyText: string;
  skills: TechniqueSkillDetailLike[];
  loading: boolean;
  error: string | null;
  variant: 'desktop' | 'mobile' | 'tooltip';
}

export const TechniqueSkillSection: React.FC<TechniqueSkillSectionProps> = ({
  title,
  emptyText,
  skills,
  loading,
  error,
  variant,
}) => {
  const cardClassName = `technique-skill-section__card technique-skill-section__card--${variant}`;

  return (
    <div className={`technique-skill-section technique-skill-section--${variant}`}>
      <div className="technique-skill-section__title">{title}</div>

      {loading ? (
        <div className="technique-skill-section__state">技能详情加载中...</div>
      ) : null}

      {!loading && error ? (
        <div className="technique-skill-section__state is-error">{error}</div>
      ) : null}

      {!loading && !error && skills.length <= 0 ? (
        <div className="technique-skill-section__state">{emptyText}</div>
      ) : null}

      {!loading && !error && skills.length > 0 ? (
        <div className="technique-skill-section__list">
          {variant === 'tooltip'
            ? skills.map((skill) => (
              <div key={skill.id} className="technique-skill-section__summary">
                <div className="technique-skill-section__summary-name">{skill.name}</div>
                <div className="technique-skill-section__inline">
                  {renderSkillInlineDetails(skill)}
                </div>
              </div>
            ))
            : skills.map((skill) => (
              <div key={skill.id} className={cardClassName}>
                {renderSkillCardDetails(skill)}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
};
