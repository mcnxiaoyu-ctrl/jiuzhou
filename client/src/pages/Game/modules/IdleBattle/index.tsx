/**
 * IdleBattleModule — 离线挂机战斗模块入口
 *
 * 作用：
 *   组合 useIdleBattle Hook 与所有 UI 子组件，对外暴露两个接口：
 *     1. IdleBattlePanel：完整的挂机面板（配置 + 历史列表 + 回放弹窗）
 *     2. IdleBattleStatusBar：嵌入 game-header 的状态指示器
 *   不包含任何业务逻辑，所有状态由 useIdleBattle 统一管理。
 *
 * 输入/输出：
 *   IdleBattlePanel:
 *     （无额外 props，idle 由父组件传入）
 *   IdleBattleStatusBar:
 *     - onOpenPanel: 点击指示器时打开面板的回调
 *
 * 数据流：
 *   useIdleBattle（单例 Hook）→ 分发给 IdleConfigPanel / IdleStatusIndicator /
 *   IdleHistoryList / ReplayViewer
 *
 * 关键边界条件：
 *   1. IdleBattlePanel 和 IdleBattleStatusBar 共享同一个 useIdleBattle 实例，
 *      需由父组件（Game/index.tsx）在同一层调用 Hook，通过 props 传入
 *   2. ReplayViewer 关闭时调用 selectSession(null)，同时 useIdleBattle 内部
 *      已处理 markIdleSessionViewed，无需在此重复调用
 */

import React, { useCallback } from 'react';
import { Alert, Tabs } from 'antd';
import { useIdleBattle, type UseIdleBattleReturn } from './hooks/useIdleBattle';
import IdleConfigPanel from './components/IdleConfigPanel';
import IdleStatusIndicator from './components/IdleStatusIndicator';
import IdleHistoryList from './components/IdleHistoryList';
import ReplayViewer from './components/ReplayViewer';
import './index.scss';

// ============================================
// 导出 Hook（供父组件在顶层调用）
// ============================================

export { useIdleBattle };
export type { UseIdleBattleReturn };

// ============================================
// IdleBattlePanel — 完整挂机面板
// ============================================

interface IdleBattlePanelProps {
  idle: UseIdleBattleReturn;
}

/**
 * 完整挂机面板：配置区 + 历史列表 + 回放弹窗
 * 由父组件传入 idle（useIdleBattle 返回值），避免重复创建 Hook 实例
 */
export const IdleBattlePanel: React.FC<IdleBattlePanelProps> = ({ idle }) => {
  const {
    activeSession,
    isLoading,
    error,
    config,
    setConfig,
    saveConfig,
    startIdle,
    stopIdle,
    history,
    loadHistory,
    selectedSession,
    selectSession,
    sessionBatches,
    selectedBatchId,
    selectedBatchDetail,
    selectBatch,
  } = idle;

  const isStopping = activeSession?.status === 'stopping';

  // 切换到"挂机历史"标签时自动加载历史列表
  const handleTabChange = useCallback((key: string) => {
    if (key === 'history') {
      void loadHistory();
    }
  }, [loadHistory]);

  return (
    <div className="idle-battle-panel">
      {/* 错误提示 */}
      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          className="idle-battle-error"
        />
      )}

      <Tabs
        defaultActiveKey="config"
        className="idle-battle-tabs"
        onChange={handleTabChange}
        items={[
          {
            key: 'config',
            label: '挂机配置',
            children: (
              <IdleConfigPanel
                config={config}
                isActive={activeSession !== null && !isStopping}
                isStopping={isStopping}
                isLoading={isLoading}
                onConfigChange={setConfig}
                onStart={startIdle}
                onStop={stopIdle}
                onSave={saveConfig}
              />
            ),
          },
          {
            key: 'history',
            label: '挂机历史',
            children: (
              <IdleHistoryList
                history={history}
                isLoading={isLoading}
                onSelectSession={selectSession}
                onRefresh={loadHistory}
              />
            ),
          },
        ]}
      />

      {/* 回放弹窗（selectedSession 非 null 时自动打开） */}
      <ReplayViewer
        session={selectedSession}
        batches={sessionBatches}
        selectedBatchId={selectedBatchId}
        selectedBatchDetail={selectedBatchDetail}
        onSelectBatch={selectBatch}
        onClose={() => selectSession(null)}
      />
    </div>
  );
};

// ============================================
// IdleBattleStatusBar — 状态栏指示器
// ============================================

interface IdleBattleStatusBarProps {
  idle: UseIdleBattleReturn;
  onOpenPanel?: () => void;
}

/**
 * 嵌入 game-header 的状态指示器
 * activeSession 为 null 时不渲染（返回 null）
 */
export const IdleBattleStatusBar: React.FC<IdleBattleStatusBarProps> = ({
  idle,
  onOpenPanel,
}) => {
  if (!idle.activeSession) return null;

  return (
    <IdleStatusIndicator
      activeSession={idle.activeSession}
      onOpenPanel={onOpenPanel}
    />
  );
};
