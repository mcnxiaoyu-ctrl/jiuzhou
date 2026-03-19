/**
 * BattleSession 运行时存储。
 *
 * 作用：
 * - 统一管理 sessionId -> session record 与 battleId -> sessionId 索引；
 * - 提供会话创建、更新、battle 绑定/解绑、快照查询的单一入口。
 *
 * 不做什么：
 * - 不直接发起 battle；
 * - 不直接做秘境/PVP 业务结算。
 *
 * 输入/输出：
 * - 输入：BattleSessionRecord 或局部 patch。
 * - 输出：BattleSessionRecord / BattleSessionSnapshot / 查询结果。
 *
 * 数据流：
 * session service -> runtime -> route/socket/ticker/settlement 共享读取
 *
 * 边界条件：
 * 1) battle 重新绑定时必须先移除旧索引，避免一个 session 同时指向多个 currentBattleId。
 * 2) snapshot 仅暴露稳定字段，不向外泄露 createdAt/updatedAt 等内部运行时细节。
 */

import type { BattleSessionRecord, BattleSessionSnapshot } from './types.js';

export const battleSessionById = new Map<string, BattleSessionRecord>();
export const battleSessionIdByBattleId = new Map<string, string>();

const now = (): number => Date.now();

export const toBattleSessionSnapshot = (
  session: BattleSessionRecord,
): BattleSessionSnapshot => ({
  sessionId: session.sessionId,
  type: session.type,
  ownerUserId: session.ownerUserId,
  participantUserIds: session.participantUserIds.slice(),
  currentBattleId: session.currentBattleId,
  status: session.status,
  nextAction: session.nextAction,
  canAdvance: session.canAdvance,
  lastResult: session.lastResult,
  context: session.context,
});

export const getBattleSessionRecord = (
  sessionId: string,
): BattleSessionRecord | null => {
  return battleSessionById.get(sessionId) ?? null;
};

export const getBattleSessionSnapshot = (
  sessionId: string,
): BattleSessionSnapshot | null => {
  const session = getBattleSessionRecord(sessionId);
  return session ? toBattleSessionSnapshot(session) : null;
};

export const getBattleSessionSnapshotByBattleId = (
  battleId: string,
): BattleSessionSnapshot | null => {
  const sessionId = battleSessionIdByBattleId.get(battleId);
  if (!sessionId) return null;
  return getBattleSessionSnapshot(sessionId);
};

export const createBattleSessionRecord = (
  session: Omit<BattleSessionRecord, 'createdAt' | 'updatedAt'>,
): BattleSessionRecord => {
  const created = {
    ...session,
    createdAt: now(),
    updatedAt: now(),
  };
  battleSessionById.set(created.sessionId, created);
  if (created.currentBattleId) {
    battleSessionIdByBattleId.set(created.currentBattleId, created.sessionId);
  }
  return created;
};

export const updateBattleSessionRecord = (
  sessionId: string,
  patch: Partial<Omit<BattleSessionRecord, 'sessionId' | 'createdAt'>>,
): BattleSessionRecord | null => {
  const current = battleSessionById.get(sessionId);
  if (!current) return null;

  const nextCurrentBattleId =
    patch.currentBattleId === undefined ? current.currentBattleId : patch.currentBattleId;
  if (current.currentBattleId && current.currentBattleId !== nextCurrentBattleId) {
    battleSessionIdByBattleId.delete(current.currentBattleId);
  }

  const next: BattleSessionRecord = {
    ...current,
    ...patch,
    currentBattleId: nextCurrentBattleId,
    updatedAt: now(),
  };
  battleSessionById.set(sessionId, next);

  if (next.currentBattleId) {
    battleSessionIdByBattleId.set(next.currentBattleId, sessionId);
  }

  return next;
};

export const bindBattleToSession = (
  sessionId: string,
  battleId: string,
): BattleSessionRecord | null => {
  return updateBattleSessionRecord(sessionId, { currentBattleId: battleId });
};

export const clearBattleFromSession = (
  sessionId: string,
): BattleSessionRecord | null => {
  return updateBattleSessionRecord(sessionId, { currentBattleId: null });
};

export const deleteBattleSessionRecord = (
  sessionId: string,
): boolean => {
  const current = battleSessionById.get(sessionId);
  if (!current) return false;
  if (current.currentBattleId) {
    battleSessionIdByBattleId.delete(current.currentBattleId);
  }
  return battleSessionById.delete(sessionId);
};

export const listBattleSessionRecords = (): BattleSessionRecord[] => {
  return [...battleSessionById.values()];
};
