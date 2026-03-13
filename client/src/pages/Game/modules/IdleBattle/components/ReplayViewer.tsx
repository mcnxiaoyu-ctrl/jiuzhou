/**
 * ReplayViewer — 挂机战斗回放查看器
 *
 * 作用：
 *   以 Modal 形式展示一次挂机会话的所有战斗批次及其详细日志。
 *   包含两个子区域：
 *     - BatchList：战斗批次列表，支持按胜/败/全部筛选（属性 16 验证点）
 *     - BattleLogPanel：选中批次的战斗日志，复用 logFormatterFast 格式化
 *   关闭时调用 onClose（外层负责调用 markIdleSessionViewed）。
 *
 * 输入/输出：
 *   - session: 当前查看的会话（null 时 Modal 不显示）
 *   - batches: 该会话的所有战斗批次摘要
 *   - selectedBatchId: 当前选中的批次 ID
 *   - selectedBatchDetail: 当前选中批次的详细日志
 *   - onSelectBatch: 选中批次回调
 *   - onClose: 关闭回调
 *
 * 数据流：
 *   useIdleBattle.selectedSession → props.session → Modal open
 *   useIdleBattle.sessionBatches → props.batches → BatchList 渲染
 *   useIdleBattle.selectedBatchDetail → props.selectedBatchDetail → BattleLogPanel 渲染
 *   用户点击批次 → onSelectBatch → useIdleBattle.selectBatch → selectedBatchDetail 更新
 *
 * 关键边界条件：
 *   1. batches 为空时展示空状态，不报错
 *   2. 日志格式化复用 formatBattleLogLineFast，过滤 null 结果（round_start/round_end 等）
 *   3. 筛选逻辑为纯派生计算（useMemo），不引入额外状态
 */

import React, { useMemo, useState } from 'react';
import { Modal, Tag, Empty, Segmented } from 'antd';
import { TrophyOutlined, FrownOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { formatBattleLogLineFast } from '../../BattleArea/logFormatterFast';
import type {
  IdleSessionDto,
  IdleBatchDetailDto,
  IdleBatchSummaryDto,
} from '../types';
import './ReplayViewer.scss';

// ============================================
// 常量
// ============================================

type BatchFilter = 'all' | 'win' | 'lose';

const FILTER_OPTIONS: Array<{ value: BatchFilter; label: React.ReactNode }> = [
  { value: 'all', label: <><UnorderedListOutlined /> 全部</> },
  { value: 'win', label: <><TrophyOutlined /> 胜利</> },
  { value: 'lose', label: <><FrownOutlined /> 失败</> },
];

const RESULT_LABEL: Record<IdleBatchSummaryDto['result'], string> = {
  attacker_win: '胜',
  defender_win: '败',
  draw: '平',
};

const RESULT_COLOR: Record<IdleBatchSummaryDto['result'], string> = {
  attacker_win: 'success',
  defender_win: 'error',
  draw: 'default',
};

// ============================================
// 子组件：BatchList
// ============================================

interface BatchListProps {
  batches: IdleBatchSummaryDto[];
  filter: BatchFilter;
  selectedBatchId: string | null;
  onSelect: (batchId: string) => void;
}

/**
 * 战斗批次列表
 * 复用点：filter 逻辑在此处集中，BattleLogPanel 不感知筛选状态
 */
const BatchList: React.FC<BatchListProps> = ({ batches, filter, selectedBatchId, onSelect }) => {
  // 纯派生计算，不引入额外 state（属性 16 验证点：筛选结果正确性）
  const filtered = useMemo(() => {
    if (filter === 'all') return batches;
    if (filter === 'win') return batches.filter((b) => b.result === 'attacker_win');
    return batches.filter((b) => b.result === 'defender_win');
  }, [batches, filter]);

  if (filtered.length === 0) {
    return <Empty description="暂无战斗记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div className="replay-batch-list">
      {filtered.map((batch) => (
        <div
          key={batch.id}
          className={`replay-batch-item${selectedBatchId === batch.id ? ' is-selected' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(batch.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(batch.id);
            }
          }}
        >
          <div className="replay-batch-item-head">
            <span className="replay-batch-index">#{batch.batchIndex + 1}</span>
            <Tag color={RESULT_COLOR[batch.result]} className="replay-batch-result">
              {RESULT_LABEL[batch.result]}
            </Tag>
            <span className="replay-batch-rounds">{batch.roundCount}回合</span>
          </div>
          <div className="replay-batch-item-rewards">
            {batch.result === 'attacker_win' && (
              <>
                <span className="replay-batch-exp">修为+{batch.expGained.toLocaleString()}</span>
                <span className="replay-batch-silver">银两+{batch.silverGained.toLocaleString()}</span>
              </>
            )}
            {batch.itemCount > 0 && (
              <span className="replay-batch-items">物品×{batch.itemCount}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================
// 子组件：BattleLogPanel
// ============================================

interface BattleLogPanelProps {
  selectedBatchId: string | null;
  batch: IdleBatchDetailDto | null;
}

/**
 * 战斗日志面板
 * 复用 formatBattleLogLineFast，与在线战斗日志格式一致
 */
const BattleLogPanel: React.FC<BattleLogPanelProps> = ({ selectedBatchId, batch }) => {
  if (!batch) {
    return (
      <div className="replay-log-empty">
        <Empty
          description={selectedBatchId ? '战斗日志加载中' : '选择左侧战斗批次查看日志'}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  const lines = (batch.battleLog ?? [])
    .map((entry) => formatBattleLogLineFast(entry))
    .filter((line): line is string => line !== null && line.trim().length > 0);

  return (
    <div className="replay-log-panel">
      <div className="replay-log-header">
        <span>第 {batch.batchIndex + 1} 场战斗日志</span>
        <Tag color={RESULT_COLOR[batch.result]}>{RESULT_LABEL[batch.result]}</Tag>
        <span className="replay-log-header-meta">{batch.roundCount} 回合 · {lines.length} 条日志</span>
      </div>
      <div className="replay-log-body">
        {lines.length === 0 ? (
          <Empty description="暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          lines.map((line, i) => (
            <div key={i} className="replay-log-line">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// ============================================
// 主组件：ReplayViewer
// ============================================

interface ReplayViewerProps {
  session: IdleSessionDto | null;
  batches: IdleBatchSummaryDto[];
  selectedBatchId: string | null;
  selectedBatchDetail: IdleBatchDetailDto | null;
  onSelectBatch: (batchId: string | null) => void;
  onClose: () => void;
}

const ReplayViewer: React.FC<ReplayViewerProps> = ({
  session,
  batches,
  selectedBatchId,
  selectedBatchDetail,
  onSelectBatch,
  onClose,
}) => {
  const [filter, setFilter] = useState<BatchFilter>('all');

  const winCount = useMemo(() => batches.filter((b) => b.result === 'attacker_win').length, [batches]);
  const loseCount = useMemo(() => batches.filter((b) => b.result === 'defender_win').length, [batches]);

  const handleClose = () => {
    setFilter('all');
    onClose();
  };

  return (
    <Modal
      open={session !== null}
      onCancel={handleClose}
      footer={null}
      width={860}
      centered
      destroyOnHidden
      title={
        session ? (
          <div className="replay-modal-title">
            <span>挂机回放</span>
            <span className="replay-modal-title-meta">
              共 {batches.length} 场 · 胜 {winCount} / 败 {loseCount}
            </span>
          </div>
        ) : '挂机回放'
      }
      classNames={{ body: 'replay-modal-body' }}
    >
      {/* 筛选器 */}
      <div className="replay-filter-bar">
        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={(v) => setFilter(v as BatchFilter)}
          size="small"
        />
      </div>

      {/* 主体：左侧批次列表 + 右侧日志 */}
      <div className="replay-content">
        <div className="replay-content-left">
          <BatchList
            batches={batches}
            filter={filter}
            selectedBatchId={selectedBatchId}
            onSelect={onSelectBatch}
          />
        </div>
        <div className="replay-content-right">
          <BattleLogPanel selectedBatchId={selectedBatchId} batch={selectedBatchDetail} />
        </div>
      </div>
    </Modal>
  );
};

export default ReplayViewer;
