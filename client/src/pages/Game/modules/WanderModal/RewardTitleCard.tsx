import type { FC } from 'react';
import { Tag } from 'antd';
import { formatTitleEffectsText } from '../../shared/titleEffectText';

/**
 * 云游终幕称号展示卡片
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一展示云游终幕发放的称号名称、描述、颜色与属性效果，供当前幕结果区和故事回顾区复用。
 * 2. 做什么：复用正式称号共享格式化工具，保证云游称号和其他称号页的属性文案口径一致。
 * 3. 不做什么：不处理请求、不决定称号是否发放，也不推导装备状态。
 *
 * 输入 / 输出：
 * - 输入：称号名称、描述、颜色、属性映射，以及可选的标签文案。
 * - 输出：可直接渲染的称号详情卡片。
 *
 * 数据流 / 状态流：
 * - 云游幕次 DTO / 阅读流条目 -> 本组件
 * - 本组件统一格式化效果文本并完成展示
 *
 * 复用设计说明：
 * 1. 当前幕完成态和故事回顾终幕都会展示同一份称号详情，集中到单组件后可避免两处手写结构和效果文案。
 * 2. 高变更点只有称号展示样式和字段顺序，收口后后续只需维护一个入口。
 *
 * 关键边界条件与坑点：
 * 1. 只有在 name 非空时才应渲染卡片；调用方必须先确保称号确已生成，不能拿空壳字段来占位。
 * 2. `effects` 可能为空对象，属性文案仍必须走共享格式化工具，不能页面侧自己拼字符串。
 */

interface WanderRewardTitleCardProps {
  label?: string;
  name: string;
  description: string | null;
  color: string | null;
  effects: Record<string, number>;
}

const WanderRewardTitleCard: FC<WanderRewardTitleCardProps> = ({
  label = '终幕称号',
  name,
  description,
  color: _color,
  effects,
}) => {
  return (
    <div className="wander-reward-title-card">
      <div className="wander-reward-title-head">
        <span className="wander-reward-title-label">{label}</span>
        <Tag className="wander-reward-title-tag">
          {name}
        </Tag>
      </div>
      {description ? <div className="wander-reward-title-desc">{description}</div> : null}
      <div className="wander-reward-title-effects">{formatTitleEffectsText(effects)}</div>
    </div>
  );
};

export default WanderRewardTitleCard;
