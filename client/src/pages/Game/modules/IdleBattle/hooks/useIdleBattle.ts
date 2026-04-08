/**
 * useIdleBattle Hook — 离线挂机战斗状态管理
 *
 * 作用：
 *   封装挂机战斗的完整状态流：会话管理、配置读写、Socket 实时更新。
 *   不包含任何 UI 渲染逻辑，所有状态通过 UseIdleBattleReturn 暴露给组件层。
 *
 * 输入/输出：
 *   - 无参数（依赖 gameSocket 单例和 idleBattleApi）
 *   - 返回 UseIdleBattleReturn 接口，包含状态、配置与操作能力
 *
 * 数据流：
 *   mount → loadStatus → 初始化活跃会话状态
 *   打开挂机面板/显式刷新配置 → loadConfig → 初始化或同步挂机配置
 *   gameSocket.onIdleUpdate → 更新 activeSession 实时收益
 *   gameSocket.onIdleFinished → 清空 activeSession
 *   activeSession.status === 'stopping' → 静默轮询 getIdleStatus → 主动收敛停止态
 *   断线 30s 后 → getIdleProgress → 补全进度
 *
 * 关键边界条件：
 *   1. 断线检测：监听 gameSocket 连接状态，断线超过 RECONNECT_PROGRESS_DELAY_MS 后
 *      自动调用 getIdleProgress 补全进度（避免频繁请求）
 *   2. 不保留批次级历史 / 回放状态，前端只维护会话级摘要
 *   3. stopping 状态必须主动向服务端收敛，不能只依赖 idle:finished 事件
 *   4. Socket 事件只更新内存状态，不重新请求 DB（减少服务端压力）
 *   5. saveConfig 与 startIdle 均为乐观更新：先更新本地状态，失败时回滚
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { gameSocket } from '../../../../../services/gameSocket';
import { getUnifiedApiErrorMessage, toUnifiedApiError } from '../../../../../services/api';
import { SILENT_API_REQUEST_CONFIG } from '../../../../../services/api/requestConfig';
import type { IdleUpdatePayload, IdleFinishedPayload } from '../../../../../services/gameSocket';
import {
  startIdleSession,
  stopIdleSession,
  getIdleHistory,
  getIdleStatus,
  getIdleProgress,
  getIdleConfig,
  updateIdleConfig,
} from '../api/idleBattleApi';
import type {
  IdleSessionDto,
  IdleConfigDto,
} from '../types';
import { BASE_IDLE_MAX_DURATION_MS } from '../utils/idleDurationOptions';

// ============================================
// 常量
// ============================================

/** 断线后延迟多久触发进度补全（ms） */
const RECONNECT_PROGRESS_DELAY_MS = 30_000;

/** 停止中状态向服务端收敛的轮询间隔（ms） */
const STOPPING_STATUS_SYNC_INTERVAL_MS = 1_500;

/** 默认配置（未从服务端加载时的初始值） */
const DEFAULT_CONFIG: IdleConfigDto = {
  mapId: null,
  roomId: null,
  maxDurationMs: 3_600_000,
  autoSkillPolicy: { slots: [] },
  targetMonsterDefId: null,
  includePartnerInBattle: true,
};

type ConfigSyncMode = 'replace' | 'preserveDraft';

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
  maxDurationLimitMs: number;
  monthCardActive: boolean;
  setConfig: (patch: Partial<IdleConfigDto>) => void;
  refreshConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;

  // 操作
  startIdle: () => Promise<void>;
  stopIdle: () => Promise<void>;
  history: IdleSessionDto[];
  loadHistory: () => Promise<void>;

}

interface UseIdleBattleOptions {
  initialSession?: IdleSessionDto | null;
  deferInitialStatusLoad?: boolean;
}

// ============================================
// Hook 实现
// ============================================

export function useIdleBattle(options?: UseIdleBattleOptions): UseIdleBattleReturn {
  const initialSession = options?.initialSession;
  const deferInitialStatusLoad = options?.deferInitialStatusLoad === true;
  const [activeSession, setActiveSession] = useState<IdleSessionDto | null>(initialSession ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [config, setConfigState] = useState<IdleConfigDto>(DEFAULT_CONFIG);
  const [maxDurationLimitMs, setMaxDurationLimitMs] = useState(BASE_IDLE_MAX_DURATION_MS);
  const [monthCardActive, setMonthCardActive] = useState(false);
  const [history, setHistory] = useState<IdleSessionDto[]>([]);

  // 断线时间戳（用于计算是否需要补全进度）
  const disconnectedAtRef = useRef<number | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const monthCardActiveRef = useRef(monthCardActive);
  const configSyncingRef = useRef(false);
  const hasLoadedConfigRef = useRef(false);
  const hasHydratedConfigRef = useRef(false);
  const stoppingStatusSyncInFlightRef = useRef(false);

  // ============================================
  // 初始化：只加载当前挂机状态
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

  const loadConfig = useCallback(async (mode: ConfigSyncMode = 'replace') => {
    try {
      const res = await getIdleConfig();
      hasLoadedConfigRef.current = true;
      if (mode === 'replace') {
        hasHydratedConfigRef.current = true;
      }
      setMaxDurationLimitMs(res.maxDurationLimitMs);
      setMonthCardActive(res.monthCardActive);
      monthCardActiveRef.current = res.monthCardActive;
      setConfigState((prev) => {
        if (mode === 'replace') {
          return res.config;
        }
        return {
          ...prev,
          maxDurationMs: Math.min(prev.maxDurationMs, res.maxDurationLimitMs),
        };
      });
    } catch (err) {
      setError(getUnifiedApiErrorMessage(err, '加载挂机配置失败'));
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await getIdleHistory();
      setHistory(res.history);
    } catch (err) {
      setHistory([]);
      setError(getUnifiedApiErrorMessage(err, '加载挂机历史失败'));
    }
  }, []);

  useEffect(() => {
    if (initialSession === undefined) return;
    setActiveSession(initialSession);
  }, [initialSession]);

  useEffect(() => {
    if (deferInitialStatusLoad) {
      setIsLoading(true);
      return;
    }
    if (initialSession !== undefined) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void loadStatus().finally(() => setIsLoading(false));
  }, [deferInitialStatusLoad, initialSession, loadStatus]);

  useEffect(() => {
    monthCardActiveRef.current = monthCardActive;
  }, [monthCardActive]);

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
      void loadHistory();
    });
    return unsubscribe;
  }, [loadHistory]);

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
              setActiveSession(res.session);
              void loadHistory();
            } catch (error) {
              setError(getUnifiedApiErrorMessage(error, '同步挂机进度失败'));
            }
          })();
        }
      }
    });

    return unsubscribeConnect;
  }, [loadHistory]);

  // 监听 socket 断线（通过 isSocketConnected 轮询不合适，改为监听 error 事件作为断线信号）
  useEffect(() => {
    const unsubscribeError = gameSocket.onError(() => {
      if (disconnectedAtRef.current === null) {
        disconnectedAtRef.current = Date.now();
      }
    });
    return unsubscribeError;
  }, []);

  useEffect(() => {
    const unsubscribe = gameSocket.onCharacterUpdate((character) => {
      if (!character) return;
      if (!hasLoadedConfigRef.current) return;
      if (character.monthCardActive === monthCardActiveRef.current) return;
      if (configSyncingRef.current) return;

      configSyncingRef.current = true;
      void loadConfig('preserveDraft').finally(() => {
        configSyncingRef.current = false;
      });
    });
    return unsubscribe;
  }, [loadConfig]);


  // ============================================
  // 配置管理
  // ============================================

  const setConfig = useCallback((patch: Partial<IdleConfigDto>) => {
    setConfigState((prev) => ({ ...prev, ...patch }));
  }, []);

  const refreshConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadConfig(hasHydratedConfigRef.current ? 'preserveDraft' : 'replace');
    } finally {
      setIsLoading(false);
    }
  }, [loadConfig]);

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
        includePartnerInBattle: config.includePartnerInBattle,
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
      // 乐观更新：先切到 stopping，再由统一的停止态收敛逻辑确认最终结束。
      setActiveSession((prev) => prev ? { ...prev, status: 'stopping' } : null);
    } catch (err) {
      setError(getUnifiedApiErrorMessage(err, '停止挂机失败'));
    }
  }, []);

  /**
   * 主动收敛“停止中”状态。
   *
   * 作用：
   * - 统一承接“stop 请求成功后”和“idle:finished 事件丢失后”的状态校准逻辑；
   * - 只复用已有 getIdleStatus 接口，不新增第二套停止态接口或页面侧分叉判断；
 * - 会话一旦不再停留在同一个 stopping 会话上，立即收敛为服务端最新状态。
   *
   * 输入/输出：
   * - 输入：正在收敛的 sessionId
 * - 输出：无；内部按需更新 activeSession
   *
   * 边界条件：
   * 1. 同一时刻只允许一个 stopping 状态同步请求在飞，避免慢网下产生并发轮询。
   * 2. 静默请求只关闭自动 toast，不吞 Promise reject；这里只在轮询场景下选择不覆盖当前错误文案。
   */
  const syncStoppingStatus = useCallback(async (sessionId: string): Promise<void> => {
    if (stoppingStatusSyncInFlightRef.current) {
      return;
    }

    stoppingStatusSyncInFlightRef.current = true;
    try {
      const res = await getIdleStatus(SILENT_API_REQUEST_CONFIG);
      const currentSession = res.session;
      if (currentSession?.id === sessionId && currentSession.status === 'stopping') {
        return;
      }

      setActiveSession(currentSession);
      void loadHistory();
    } catch {
      // stopping 收敛轮询保持静默，等待下一轮重试，避免重复打断玩家。
    } finally {
      stoppingStatusSyncInFlightRef.current = false;
    }
  }, [loadHistory]);

  useEffect(() => {
    if (!activeSession || activeSession.status !== 'stopping') {
      return;
    }

    const sessionId = activeSession.id;
    void syncStoppingStatus(sessionId);
    const timer = setInterval(() => {
      void syncStoppingStatus(sessionId);
    }, STOPPING_STATUS_SYNC_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [activeSession?.id, activeSession?.status, syncStoppingStatus]);

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
    maxDurationLimitMs,
    monthCardActive,
    setConfig,
    refreshConfig,
    saveConfig,

    startIdle,
    stopIdle,
    history,
    loadHistory,
  };
}
