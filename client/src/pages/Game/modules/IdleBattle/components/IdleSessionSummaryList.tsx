/**
 * IdleSessionSummaryList — 挂机会话级汇总列表
 *
 * 作用：
 *   仅展示已结束挂机会话的汇总结果，包括总场次、胜负、修为、银两与奖励汇总，
 *   作为“关闭单场回放后”的历史查看入口。
 *   不做会话选择、不做详情跳转、不承载任何批次级交互。
 *
 * 输入/输出：
 *   - history：已结束挂机会话列表（由 useIdleBattle 保证倒序）
 *   - isLoading：历史加载状态
 *   - onRefresh：手动刷新回调
 *
 * 数据流：
 *   useIdleBattle.history -> 本组件渲染会话级摘要
 *   用户点击刷新 -> onRefresh -> 重新拉取 session 级历史
 *
 * 复用设计说明：
 *   回放下线后，历史展示收敛为单一会话级组件，避免在面板里散落统计、奖励文案和空态逻辑。
 *   奖励物品文案统一在这里汇总，后续若首页或弹窗也需要同口径展示，可直接复用该组件或内部格式化函数。
 *
 * 关键边界条件与坑点：
 *   1. rewardItems 可能为空，必须明确展示“无物品掉落”，避免和“尚未加载”混淆。
 *   2. 奖励文案需要截断，避免大量掉落物导致移动端列表高度失控。
 */

import React from 'react';
import { Button, Empty, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { IdleSessionDto, RewardItemEntryDto } from '../types';
import './IdleSessionSummaryList.scss';

const STATUS_LABEL: Record<IdleSessionDto['status'], string> = {
  active: '进行中',
  stopping: '停止中',
  completed: '已完成',
  interrupted: '已中断',
};

const STATUS_COLOR: Record<IdleSessionDto['status'], string> = {
  active: 'processing',
  stopping: 'warning',
  completed: 'success',
  interrupted: 'default',
};

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
};

const formatDuration = (startedAt: string, endedAt: string | null): string => {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}时${minutes}分`;
  }
  return `${minutes}分`;
};

const formatRewardSummary = (items: RewardItemEntryDto[]): string => {
  if (items.length === 0) {
    return '无物品掉落';
  }
  const summary = items.map((item) => `${item.itemName}×${item.quantity}`).join('、');
  return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
};

interface IdleSessionSummaryListProps {
  history: IdleSessionDto[];
  isLoading: boolean;
  onRefresh: () => void;
}

const IdleSessionSummaryList: React.FC<IdleSessionSummaryListProps> = ({
  history,
  isLoading,
  onRefresh,
}) => {
  return (
    <div className="idle-session-summary-list">
      <div className="idle-session-summary-list__header">
        <div>
          <div className="idle-session-summary-list__title">最近挂机记录</div>
          <div className="idle-session-summary-list__subtitle">仅保留会话级汇总，不再提供单场回放</div>
        </div>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined spin={isLoading} />}
          onClick={onRefresh}
          disabled={isLoading}
        >
          刷新记录
        </Button>
      </div>

      <Spin spinning={isLoading}>
        {history.length === 0 ? (
          <Empty
            description="暂无挂机记录"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            className="idle-session-summary-list__empty"
          />
        ) : (
          <div className="idle-session-summary-list__items">
            {history.map((session) => (
              <div key={session.id} className="idle-session-summary-card">
                <div className="idle-session-summary-card__head">
                  <div className="idle-session-summary-card__meta">
                    <Tag color={STATUS_COLOR[session.status]}>{STATUS_LABEL[session.status]}</Tag>
                    <span>{formatDate(session.startedAt)}</span>
                    <span>{formatDuration(session.startedAt, session.endedAt)}</span>
                  </div>
                  {session.targetMonsterName && (
                    <span className="idle-session-summary-card__monster">目标：{session.targetMonsterName}</span>
                  )}
                </div>

                <div className="idle-session-summary-card__stats">
                  <span>总场次 {session.totalBattles}</span>
                  <span>胜 {session.winCount}</span>
                  <span>败 {session.loseCount}</span>
                  <span>修为 +{session.totalExp.toLocaleString()}</span>
                  <span>银两 +{session.totalSilver.toLocaleString()}</span>
                </div>

                <div className="idle-session-summary-card__reward">
                  <span className="idle-session-summary-card__reward-label">奖励汇总</span>
                  <span className="idle-session-summary-card__reward-text">
                    {formatRewardSummary(session.rewardItems)}
                  </span>
                </div>

                {session.bagFullFlag && (
                  <div className="idle-session-summary-card__warn">背包空间不足时，部分物品已通过邮件补发</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Spin>
    </div>
  );
};

export default IdleSessionSummaryList;
