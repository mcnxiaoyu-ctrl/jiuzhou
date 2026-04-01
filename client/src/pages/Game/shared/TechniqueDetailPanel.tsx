/**
 * 功法详情面板
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染功法头部信息，以及“每层加成 / 技能变化”的桌面表格和移动端卡片视图。
 * 2. 做什么：让角色已学功法详情与伙伴已学功法详情复用同一份展示结构，避免层数表格、移动端卡片和技能 tooltip 重复实现。
 * 3. 不做什么：不处理请求加载、不决定弹窗容器，也不计算功法层数据。
 *
 * 输入 / 输出：
 * - 输入：`detail` 归一化后的功法详情视图；`isMobile` 当前是否移动端。
 * - 输出：可直接放入 Modal / Drawer body 的详情节点。
 *
 * 数据流 / 状态流：
 * 详情接口 -> `buildTechniqueDetailView` -> 本组件 -> 角色功法 / 伙伴功法详情弹窗。
 *
 * 复用设计说明：
 * 1. 层数详情是这次功能的第二个真实复用点，因此把 UI 壳层抽成共享面板，角色和伙伴只保留各自请求与状态管理。
 * 2. 技能 tooltip 继续复用 `skillDetailShared`，避免技能摘要、效果文案和 tooltip 内容再次散落。
 * 3. 后续如果图鉴或坊市要补完整功法详情，也可以直接复用本面板，不需要重复抄表格与移动端布局。
 *
 * 关键边界条件与坑点：
 * 1. `detail` 为空时必须明确展示空态，不能渲染半个表头，否则用户会误以为请求还没结束。
 * 2. 移动端技能默认保持折叠，只展示标题与查看入口；完整内容按需展开，避免层卡片被冗余文案撑高。
 */
import { Table, Tag, Tooltip } from 'antd';
import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { getItemQualityLabel, getItemQualityTagClassName } from './itemQuality';
import {
  getSkillInlineDetailItems,
  renderSkillInlineDetailItems,
  renderSkillTooltip,
} from '../modules/TechniqueModal/skillDetailShared';
import type { TechniqueDetailBonus, TechniqueDetailSkill, TechniqueDetailView } from './techniqueDetailView';
import './TechniqueDetailPanel.scss';

type TechniqueDetailPanelProps = {
  detail: TechniqueDetailView | null;
  isMobile: boolean;
  emptyText?: string;
};

type TechniqueLayerRow = {
  layer: number;
  unlocked: boolean;
  bonuses: TechniqueDetailBonus[];
  skills: TechniqueDetailSkill[];
};

const SKILL_TOOLTIP_CLASS_NAMES = {
  root: 'skill-tooltip-overlay game-tooltip-surface-root',
  container: 'skill-tooltip-overlay-container game-tooltip-surface-container',
} as const;

const buildLayerRows = (detail: TechniqueDetailView): TechniqueLayerRow[] => {
  return detail.layers.map((layer) => ({
    layer: layer.layer,
    unlocked: layer.layer <= detail.layer,
    bonuses: layer.bonuses,
    skills: layer.skills,
  }));
};

const renderBonusList = (bonuses: TechniqueDetailBonus[], useMobileGrid = false) => {
  if (bonuses.length <= 0) {
    return <span className="tech-layer-cell-empty">无</span>;
  }

  return (
    <div className={`tech-layer-cell${useMobileGrid ? ' is-mobile-grid' : ''}`}>
      {bonuses.map((bonus) => (
        <div key={`${bonus.key}-${bonus.amount}`} className="tech-layer-cell-line">
          <span className="tech-layer-cell-k">{bonus.label}</span>
          <span className="tech-layer-cell-v">{bonus.value}</span>
        </div>
      ))}
    </div>
  );
};

const renderDesktopSkillList = (skills: TechniqueDetailSkill[]) => {
  if (skills.length <= 0) {
    return <span className="tech-layer-cell-empty">无</span>;
  }

  return (
    <div className="tech-layer-skill-cell">
      {skills.map((skill) => (
        <Tooltip key={skill.id} title={renderSkillTooltip(skill)} placement="top" classNames={SKILL_TOOLTIP_CLASS_NAMES}>
          <div className="tech-layer-skill-pill">
            <img className="tech-layer-skill-pill-icon" src={skill.icon} alt={skill.name} />
            <span className="tech-layer-skill-pill-name">{skill.name}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
};

const renderMobileSkillList = (
  layer: number,
  skills: TechniqueDetailSkill[],
  expandedSkillKey: string | null,
  onToggleSkill: (skillKey: string) => void,
) => {
  if (skills.length <= 0) {
    return <span className="tech-layer-cell-empty">无</span>;
  }

  return (
    <div className="tech-layer-mobile-skills">
      {skills.map((skill) => {
        const skillKey = `${layer}:${skill.id}`;
        const detailItems = getSkillInlineDetailItems(skill);
        const expanded = expandedSkillKey === skillKey;

        return (
          <div key={skill.id} className={`tech-layer-mobile-skill ${expanded ? 'is-expanded' : ''}`}>
            <button
              type="button"
              className="tech-layer-mobile-skill-trigger"
              aria-expanded={expanded}
              onClick={() => onToggleSkill(skillKey)}
            >
              <div className="tech-layer-mobile-skill-top">
                <img className="tech-layer-mobile-skill-icon" src={skill.icon} alt={skill.name} />
                <span className="tech-layer-mobile-skill-name">{skill.name}</span>
              </div>
              <span className="tech-layer-mobile-skill-action">{expanded ? '收起' : '查看完整内容'}</span>
            </button>

            {expanded ? (
              <div className="tech-layer-mobile-skill-detail">
                {renderSkillInlineDetailItems(detailItems)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

const TechniqueDetailPanel: FC<TechniqueDetailPanelProps> = ({
  detail,
  isMobile,
  emptyText = '未找到功法',
}) => {
  const [expandedSkillKey, setExpandedSkillKey] = useState<string | null>(null);

  useEffect(() => {
    setExpandedSkillKey(null);
  }, [detail?.id, isMobile]);

  if (!detail) {
    return <div className="tech-empty">{emptyText}</div>;
  }

  const layerRows = buildLayerRows(detail);
  const handleToggleSkill = (skillKey: string) => {
    setExpandedSkillKey((current) => (current === skillKey ? null : skillKey));
  };

  return (
    <div className="tech-detail">
      <div className="tech-detail-header">
        <img className="tech-detail-icon" src={detail.icon} alt={detail.name} />
        <div className="tech-detail-meta">
          <div className="tech-detail-name">
            <span>{detail.name}</span>
            <Tag className={getItemQualityTagClassName(detail.quality)}>{getItemQualityLabel(detail.quality)}</Tag>
            <Tag color="default">
              {detail.layer}层/{detail.layers.length}层
            </Tag>
          </div>
          {detail.tags.length > 0 ? (
            <div className="tech-detail-tags">
              {detail.tags.map((tag) => (
                <Tag key={tag} color="default">{tag}</Tag>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="tech-detail-desc">{detail.desc || '暂无描述'}</div>
      <div className="tech-detail-section-title">层数加成与技能</div>

      {isMobile ? (
        <div className="tech-layer-mobile-list">
          {layerRows.map((row) => (
            <div key={`layer-${row.layer}`} className={`tech-layer-mobile-item ${row.unlocked ? 'is-unlocked' : ''}`}>
              <div className="tech-layer-mobile-head">
                <div className="tech-layer-mobile-title">第{row.layer}层</div>
                <Tag color={row.unlocked ? 'green' : 'default'}>{row.unlocked ? '已解锁' : '未解锁'}</Tag>
              </div>

              <div className="tech-layer-mobile-section">
                <div className="tech-layer-mobile-label">加成</div>
                {renderBonusList(row.bonuses, true)}
              </div>

              <div className="tech-layer-mobile-section">
                <div className="tech-layer-mobile-label">技能变化</div>
                {renderMobileSkillList(row.layer, row.skills, expandedSkillKey, handleToggleSkill)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Table<TechniqueLayerRow>
          size="small"
          rowKey={(row) => String(row.layer)}
          pagination={false}
          className="tech-layer-table"
          columns={[
            {
              title: '层数',
              dataIndex: 'layer',
              key: 'layer',
              width: 70,
              render: (value: number) => `第${value}层`,
            },
            {
              title: '状态',
              dataIndex: 'unlocked',
              key: 'unlocked',
              width: 86,
              render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? '已解锁' : '未解锁'}</Tag>,
            },
            {
              title: '加成',
              dataIndex: 'bonuses',
              key: 'bonuses',
              render: (bonuses: TechniqueDetailBonus[]) => renderBonusList(bonuses),
            },
            {
              title: '技能变化',
              dataIndex: 'skills',
              key: 'skills',
              render: (skills: TechniqueDetailSkill[]) => renderDesktopSkillList(skills),
            },
          ]}
          dataSource={layerRows}
        />
      )}
    </div>
  );
};

export default TechniqueDetailPanel;
