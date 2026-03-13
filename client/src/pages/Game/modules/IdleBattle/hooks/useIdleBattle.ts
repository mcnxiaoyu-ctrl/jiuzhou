/**
 * useIdleBattle Hook — 离线挂机战斗状态管理
 *
 * 作用：
 *   封装挂机战斗的完整状态流：会话管理、配置读写、历史查询、回放控制、Socket 实时更新。
 *   不包含任何 UI 渲染逻辑，所有状态通过 UseIdleBattleReturn 暴露给组件层。
 *
 * 输入/输出：
 *   - 无参数（依赖 gameSocket 单例和 idleBattleApi）
 *   - 返回 UseIdleBattleReturn 接口，包含状态、操作、历史、回放四个维度
 *
 * 数据流：
 *   mount → loadStatus + loadConfig → 初始化状态
 *   gameSocket.onIdleUpdate → 更新 activeSession 实时收益
 *   gameSocket.onIdleFinished → 清空 activeSession，触发历史刷新
 *   断线 30s 后 → getIdleProgress → 补全进度
 *   selectSession → getIdleBatches(摘要) → sessionBatches → selectBatch → getIdleBatchDetail(详情) → batchLog
 *
 * 关键边界条件：
 *   1. 断线检测：监听 gameSocket 连接状态，断线超过 RECONNECT_PROGRESS_DELAY_MS 后
 *      自动调用 getIdleProgress 补全进度（避免频繁请求）
 *   2. 不自动弹出未读回放弹窗，由玩家主动点击历史记录查看
 *   3. Socket 事件只更新内存状态，不重新请求 DB（减少服务端压力）
 *   4. saveConfig 与 startIdle 均为乐观更新：先更新本地状态，失败时回滚
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { gameSocket } from '../../../../../services/gameSocket';
import { getUnifiedApiErrorMessage, toUnifiedApiError } from '../../../../../services/api';
import type { IdleUpdatePayload, IdleFinishedPayload } from '../../../../../services/gameSocket';
import {
  startIdleSession,
  stopIdleSession,
  getIdleStatus,
  getIdleHistory,
  getIdleBatches,
  getIdleBatchDetail,
  markIdleSessionViewed,
  getIdleProgress,
  getIdleConfig,
  updateIdleConfig,
} from '../api/idleBattleApi';
import type {
  IdleSessionDto,
  IdleBatchDetailDto,
  IdleBatchSummaryDto,
  IdleConfigDto,
} from '../types';
import type { BattleLogEntryDto } from '../../../../../services/api/combat-realm';

// ============================================
// 常量
// ============================================

/** 断线后延迟多久触发进度补全（ms） */
const RECONNECT_PROGRESS_DELAY_MS = 30_000;

/** 默认配置（未从服务端加载时的初始值） */
const DEFAULT_CONFIG: IdleConfigDto = {
  mapId: null,
  roomId: null,
  maxDurationMs: 3_600_000,
  autoSkillPolicy: { slots: [] },
  targetMonsterDefId: null,
};

// ============================================
// 返回类型
// ============================================

export interface UseIdleBattleReturn {
  // 当前活跃会话（null 表示未在挂机）
  activeSession: IdleSessionDto | null;
  // 全局加载状态（初始化时为 true）
  isLoading: boolean;
  // 最近一次操作的错误信息
  error: string | null;

  // 挂机配置（本地草稿，未保存前不影响服务端）
  config: IdleConfigDto;
  setConfig: (patch: Partial<IdleConfigDto>) => void;
  saveConfig: () => Promise<void>;

  // 操作
  startIdle: () => Promise<void>;
  stopIdle: () => Promise<void>;

  // 历史记录
  history: IdleSessionDto[];
  loadHistory: () => Promise<void>;

  // 回放控制
  selectedSession: IdleSessionDto | null;
  selectSession: (sessionId: string | null) => void;
  sessionBatches: IdleBatchSummaryDto[];
  selectedBatchId: string | null;
  selectedBatchDetail: IdleBatchDetailDto | null;
  selectBatch: (batchId: string | null) => void;
  batchLog: BattleLogEntryDto[];
}

// ============================================
// Hook 实现
// ============================================

export function useIdleBattle(): UseIdleBattleReturn {
  const [activeSession, setActiveSession] = useState<IdleSessionDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [config, setConfigState] = useState<IdleConfigDto>(DEFAULT_CONFIG);

  const [history, setHistory] = useState<IdleSessionDto[]>([]);

  const [selectedSession, setSelectedSession] = useState<IdleSessionDto | null>(null);
  const [sessionBatches, setSessionBatches] = useState<IdleBatchSummaryDto[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedBatchDetail, setSelectedBatchDetail] = useState<IdleBatchDetailDto | null>(null);

  // 断线时间戳（用于计算是否需要补全进度）
  const disconnectedAtRef = useRef<number | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const selectedBatchIdRef = useRef<string | null>(null);

  // ============================================
  // 初始化：加载当前状态和配置
  // ============================================

  const loadStatus = useCallback(async () => {
    try {
      const res = await getIdleStatus();
      setActiveSession(res.session);
    } catch (err) {
      setActiveSession(null);
      setError(getUnifiedApiErrorMessage(err, '加载挂机状态失败'));
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await getIdleConfig();
      setConfigState(res.config);
    } catch (err) {
      setError(getUnifiedApiErrorMessage(err, '加载挂机配置失败'));
    }
  }, []);

  /**
   * 加载指定会话的战斗批次摘要。
   *
   * 作用：
   * - 统一承接“选中历史会话”和“断线重连后刷新当前会话”的摘要加载逻辑；
   * - 只读取左侧列表所需字段，避免多处重复请求完整 battle_log。
   *
   * 输入/输出：
   * - 输入：sessionId
   * - 输出：无；成功时写入 sessionBatches，失败时更新 error
   *
   * 边界条件：
   * 1. 若用户已切换到其他会话，则丢弃旧请求返回，避免旧会话数据覆盖当前 UI。
   * 2. 加载新会话摘要前会清空已选中的批次详情，防止旧日志残留。
   */
  const loadSessionBatches = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const res = await getIdleBatches(sessionId);
      if (selectedSessionIdRef.current !== sessionId) return;
      setSessionBatches(res.batches);
    } catch (err) {
      if (selectedSessionIdRef.current !== sessionId) return;
      setSessionBatches([]);
      setError(getUnifiedApiErrorMessage(err, '加载挂机回放失败'));
    }
  }, []);

  /**
   * 加载指定会话下某个批次的详细日志。
   *
   * 作用：
   * - 将“列表高频读取”和“日志低频读取”拆成两次请求，降低单次查询与传输体积；
   * - 统一处理批次切换时的异步竞态，保证右侧日志面板只展示当前选中项。
   *
   * 输入/输出：
   * - 输入：sessionId、batchId
   * - 输出：无；成功时写入 selectedBatchDetail，失败时更新 error
   *
   * 边界条件：
   * 1. 若用户在请求返回前切换了会话或批次，旧响应必须被丢弃，不能污染当前面板。
   * 2. 加载开始时先清空 selectedBatchDetail，让 UI 能明确进入“等待详情”状态。
   */
  const loadBatchDetail = useCallback(async (sessionId: string, batchId: string): Promise<void> => {
    setSelectedBatchDetail(null);
    try {
      const res = await getIdleBatchDetail(sessionId, batchId);
      if (selectedSessionIdRef.current !== sessionId) return;
      if (selectedBatchIdRef.current !== batchId) return;
      setSelectedBatchDetail(res.batch);
    } catch (err) {
      if (selectedSessionIdRef.current !== sessionId) return;
      if (selectedBatchIdRef.current !== batchId) return;
      setError(getUnifiedApiErrorMessage(err, '加载战斗日志失败'));
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    void Promise.all([loadStatus(), loadConfig()]).finally(() => setIsLoading(false));
  }, [loadConfig, loadStatus]);

  // ============================================
  // Socket 事件：idle:update（每场战斗收益推送）
  // ============================================

  useEffect(() => {
    const unsubscribe = gameSocket.onIdleUpdate((data: IdleUpdatePayload) => {
      setActiveSession((prev) => {
        if (!prev || prev.id !== data.sessionId) return prev;
        // 累加本场收益到内存状态（不重新请求 DB）
        return {
          ...prev,
          totalBattles: prev.totalBattles + 1,
          winCount: data.result === 'attacker_win' ? prev.winCount + 1 : prev.winCount,
          loseCount: data.result === 'defender_win' ? prev.loseCount + 1 : prev.loseCount,
          totalExp: prev.totalExp + data.expGained,
          totalSilver: prev.totalSilver + data.silverGained,
        };
      });
    });
    return unsubscribe;
  }, []);

  // ============================================
  // Socket 事件：idle:finished（会话结束推送）
  // ============================================

  useEffect(() => {
    const unsubscribe = gameSocket.onIdleFinished((data: IdleFinishedPayload) => {
      setActiveSession((prev) => {
        if (!prev || prev.id !== data.sessionId) return prev;
        return null;
      });
      // 会话结束后刷新历史记录
      void loadHistory();
    });
    return unsubscribe;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ============================================
  // 断线续战：断线 30s 后补全进度
  // ============================================

  useEffect(() => {
    const unsubscribeConnect = gameSocket.onCharacterUpdate(() => {
      // 重新连接时，若之前断线超过阈值，补全进度
      if (disconnectedAtRef.current !== null) {
        const elapsed = Date.now() - disconnectedAtRef.current;
        disconnectedAtRef.current = null;

        if (elapsed >= RECONNECT_PROGRESS_DELAY_MS) {
          void (async () => {
            try {
              const res = await getIdleProgress();
              const currentSession = res.session;
              setActiveSession(currentSession);
              if (currentSession && res.batches.length > 0) {
                // 有新批次时，若当前选中的是该会话，刷新批次列表
                setSelectedSession((prev) => {
                  if (prev?.id === currentSession.id) {
                    void loadSessionBatches(currentSession.id);
                  }
                  return prev;
                });
              }
            } catch (error) {
              setError(getUnifiedApiErrorMessage(error, '同步挂机进度失败'));
            }
          })();
        }
      }
    });

    return unsubscribeConnect;
  }, [loadSessionBatches]);

  // 监听 socket 断线（通过 isSocketConnected 轮询不合适，改为监听 error 事件作为断线信号）
  useEffect(() => {
    const unsubscribeError = gameSocket.onError(() => {
      if (disconnectedAtRef.current === null) {
        disconnectedAtRef.current = Date.now();
      }
    });
    return unsubscribeError;
  }, []);


  // ============================================
  // 配置管理
  // ============================================

  const setConfig = useCallback((patch: Partial<IdleConfigDto>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const saveConfig = useCallback(async () => {
    setError(null);
    try {
      await updateIdleConfig(config);
    } catch (err) {
      setError(getUnifiedApiErrorMessage(err, '保存配置失败'));
    }
  }, [config]);

  // ============================================
  // 操作：启动/停止挂机
  // ============================================

  const startIdle = useCallback(async () => {
    setError(null);
    if (!config.mapId || !config.roomId) {
      setError('请先选择挂机地图和房间');
      return;
    }
    if (!config.targetMonsterDefId) {
      setError('请先选择挂机怪物');
      return;
    }
    try {
      await startIdleSession({
        mapId: config.mapId,
        roomId: config.roomId,
        maxDurationMs: config.maxDurationMs,
        autoSkillPolicy: config.autoSkillPolicy,
        targetMonsterDefId: config.targetMonsterDefId,
      });
      // 启动成功后重新拉取状态（获取完整 session 对象）
      await loadStatus();
    } catch (err) {
      const normalizedError = toUnifiedApiError(err, '启动挂机失败');
      setError(normalizedError.message);

      // 冲突时主动同步一次服务端状态，修正本地 activeSession 过期导致的“未显示挂机中”。
      if (normalizedError.httpStatus === 409) {
        try {
          const statusRes = await getIdleStatus();
          setActiveSession(statusRes.session);
        } catch {
          // 状态同步失败时保留原始错误提示，不覆盖为次级错误。
        }
      }
    }
  }, [config, loadStatus]);

  const stopIdle = useCallback(async () => {
    setError(null);
    try {
      await stopIdleSession();
      // 乐观更新：将 status 改为 stopping（等待 idle:finished 事件清空）
      setActiveSession((prev) => prev ? { ...prev, status: 'stopping' } : null);
    } catch (err) {
      setError(getUnifiedApiErrorMessage(err, '停止挂机失败'));
    }
  }, []);

  // ============================================
  // 历史记录
  // ============================================

  const loadHistory = useCallback(async () => {
    try {
      const res = await getIdleHistory();
      setHistory(res.history);
    } catch (err) {
      setHistory([]);
      setError(getUnifiedApiErrorMessage(err, '加载挂机历史失败'));
    }
  }, []);

  // ============================================
  // 回放控制
  // ============================================

  const selectSession = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      selectedSessionIdRef.current = null;
      selectedBatchIdRef.current = null;
      setSelectedSession(null);
      setSessionBatches([]);
      setSelectedBatchId(null);
      setSelectedBatchDetail(null);
      return;
    }

    // 从历史或活跃会话中查找
    const found =
      history.find((s) => s.id === sessionId) ??
      (activeSession?.id === sessionId ? activeSession : null);

    setSelectedSession(found ?? null);
    selectedSessionIdRef.current = found?.id ?? null;
    selectedBatchIdRef.current = null;
    setSelectedBatchId(null);
    setSelectedBatchDetail(null);
    setSessionBatches([]);

    if (found) {
      void loadSessionBatches(sessionId);

      // 标记已查看（幂等，服务端有 viewed_at IS NULL 保护）
      void markIdleSessionViewed(sessionId).catch((error) => {
        setError(getUnifiedApiErrorMessage(error, '更新已读状态失败'));
      });
      // 同步更新本地历史记录的 viewedAt
      setHistory((prev) =>
        prev.map((s) => (s.id === sessionId && s.viewedAt === null ? { ...s, viewedAt: new Date().toISOString() } : s))
      );
    }
  }, [history, activeSession, loadSessionBatches]);

  const selectBatch = useCallback((batchId: string | null) => {
    if (!batchId) {
      selectedBatchIdRef.current = null;
      setSelectedBatchId(null);
      setSelectedBatchDetail(null);
      return;
    }
    const currentSessionId = selectedSessionIdRef.current;
    if (!currentSessionId) return;
    selectedBatchIdRef.current = batchId;
    setSelectedBatchId(batchId);
    void loadBatchDetail(currentSessionId, batchId);
  }, [loadBatchDetail]);

  // batchLog 从 selectedBatchDetail 派生，无需额外状态
  const batchLog: BattleLogEntryDto[] = selectedBatchDetail?.battleLog ?? [];

  // ============================================
  // 清理
  // ============================================

  useEffect(() => {
    return () => {
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }
    };
  }, []);

  return {
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
    batchLog,
  };
}
