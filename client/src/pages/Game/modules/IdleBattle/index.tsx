/**
 * IdleBattleModule — 离线挂机战斗模块入口
 *
 * 作用：
 *   组合 useIdleBattle Hook 与所有 UI 子组件，对外暴露两个接口：
 *     1. IdleBattlePanel：完整的挂机面板（仅保留配置）
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
 *   useIdleBattle（单例 Hook）→ 分发给 IdleConfigPanel / IdleStatusIndicator
 *
 * 关键边界条件：
 *   1. IdleBattlePanel 和 IdleBattleStatusBar 共享同一个 useIdleBattle 实例，
 *      需由父组件（Game/index.tsx）在同一层调用 Hook，通过 props 传入
 *   2. 面板只保留会话级配置与状态，不再承载历史回放逻辑
 */

import React, { useEffect } from 'react';
import { Alert } from 'antd';
import { useIdleBattle, type UseIdleBattleReturn } from './hooks/useIdleBattle';
import IdleConfigPanel from './components/IdleConfigPanel';
import IdleStatusIndicator from './components/IdleStatusIndicator';
import IdleSessionSummaryList from './components/IdleSessionSummaryList';
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
 * 完整挂机面板：仅保留配置区
 * 由父组件传入 idle（useIdleBattle 返回值），避免重复创建 Hook 实例
 */
export const IdleBattlePanel: React.FC<IdleBattlePanelProps> = ({ idle }) => {
  const {
    activeSession,
    isLoading,
    error,
    config,
    maxDurationLimitMs,
    monthCardActive,
    setConfig,
    refreshConfig,
    saveConfig,
    startIdle,
    stopIdle,
    history,
    loadHistory,
  } = idle;

  const isStopping = activeSession?.status === 'stopping';

  useEffect(() => {
    void refreshConfig();
    void loadHistory();
  }, [loadHistory, refreshConfig]);

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

      <IdleConfigPanel
        config={config}
        maxDurationLimitMs={maxDurationLimitMs}
        monthCardActive={monthCardActive}
        isActive={activeSession !== null && !isStopping}
        isStopping={isStopping}
        isLoading={isLoading}
        onConfigChange={setConfig}
        onStart={startIdle}
        onStop={stopIdle}
        onSave={saveConfig}
      />

      <IdleSessionSummaryList
        history={history}
        isLoading={isLoading}
        onRefresh={loadHistory}
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
  compact?: boolean;
}

/**
 * 嵌入 game-header 的状态指示器
 * activeSession 为 null 时不渲染（返回 null）
 */
export const IdleBattleStatusBar: React.FC<IdleBattleStatusBarProps> = ({
  idle,
  onOpenPanel,
  compact = false,
}) => {
  if (!idle.activeSession) return null;

  return (
    <IdleStatusIndicator
      activeSession={idle.activeSession}
      onOpenPanel={onOpenPanel}
      compact={compact}
    />
  );
};
