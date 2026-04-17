import type { PoolClient, QueryResult } from 'pg';
import { getTransactionClient, isInTransaction } from '../config/database.js';

/**
 * Inventory Mutex — 角色背包互斥锁工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：在事务内为角色背包写操作提供"按角色串行化"的 advisory xact lock。
 * - 不做什么：不负责事务开启与提交，不负责业务重试策略，不负责吞掉锁超时异常。
 *
 * 输入/输出：
 * - lockCharacterInventoryMutex(characterId)
 *   输入角色 ID，输出为 Promise<void>（成功即表示已拿到互斥锁）。
 *   内部从当前事务上下文提取连接并加锁，调用方须处于事务上下文。
 * - lockCharacterInventoryMutexByClient(client, characterId)
 *   输入显式事务连接与角色 ID，在已持有 client 的长调用链中避免重复依赖上下文推断。
 * - lockCharacterInventoryMutexes(characterIds) / lockCharacterInventoryMutexesByClient(client, characterIds)
 *   输入角色 ID 列表，内部先去重排序后逐个加锁，输出 Promise<void>。
 *
 * 数据流/状态流：
 * - 调用方进入事务后调用本模块；
 * - 本模块使用 `pg_advisory_xact_lock` 直接阻塞等待锁；
 * - 事务提交/回滚后，xact lock 由 PostgreSQL 自动释放。
 *
 * 关键边界条件与坑点：
 * 1. 必须在事务上下文中使用（xact lock 生命周期绑定事务），否则锁会在语句结束后立即失效或语义不符合预期。
 * 2. 多角色加锁必须按升序统一顺序，避免不同调用链加锁顺序反转导致的死锁环。
 */
const INVENTORY_MUTEX_NAMESPACE = 3101;
type InventoryMutexQueryRunner = Pick<PoolClient, 'query'>;

const normalizeCharacterIds = (characterIds: number[]): number[] =>
  [...new Set(characterIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

const waitForCharacterInventoryMutexWithRunner = async (
  runner: InventoryMutexQueryRunner,
  characterId: number,
): Promise<number> => {
  const sql = 'SELECT pg_advisory_xact_lock($1::integer, $2::integer)';
  const params: [number, number] = [INVENTORY_MUTEX_NAMESPACE, characterId];
  const startedAt = Date.now();
  await runner.query(sql, params) as QueryResult;
  return Math.max(0, Date.now() - startedAt);
};

/**
 * 获取单个角色背包互斥锁（阻塞轮询直到成功或超时）
 * 使用统一 query() 入口，无需传入 client
 */
export const lockCharacterInventoryMutexByClient = async (
  client: PoolClient,
  characterId: number
): Promise<number> => {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`角色背包互斥锁参数错误: characterId=${String(characterId)}`);
  }
  return await waitForCharacterInventoryMutexWithRunner(client, characterId);
};

/**
 * 获取单个角色背包互斥锁（从当前事务上下文自动提取连接）
 */
export const lockCharacterInventoryMutex = async (
  characterId: number
): Promise<number> => {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`角色背包互斥锁参数错误: characterId=${String(characterId)}`);
  }
  if (!isInTransaction()) {
    throw new Error('角色背包互斥锁必须在事务上下文中获取，请通过 @Transactional 方法调用');
  }
  const client = getTransactionClient();
  if (!client) {
    throw new Error('角色背包互斥锁获取失败：事务连接不存在');
  }
  return await lockCharacterInventoryMutexByClient(client, characterId);
};

/**
 * 获取多个角色背包互斥锁（按升序逐个加锁，避免死锁）
 */
export const lockCharacterInventoryMutexesByClient = async (
  client: PoolClient,
  characterIds: number[]
): Promise<void> => {
  const ids = normalizeCharacterIds(characterIds);
  for (const characterId of ids) {
    await lockCharacterInventoryMutexByClient(client, characterId);
  }
};

/**
 * 获取多个角色背包互斥锁（从当前事务上下文自动提取连接）
 */
export const lockCharacterInventoryMutexes = async (
  characterIds: number[]
): Promise<void> => {
  if (!isInTransaction()) {
    throw new Error('角色背包互斥锁必须在事务上下文中获取，请通过 @Transactional 方法调用');
  }
  const client = getTransactionClient();
  if (!client) {
    throw new Error('角色背包互斥锁获取失败：事务连接不存在');
  }
  const ids = normalizeCharacterIds(characterIds);
  for (const characterId of ids) {
    await lockCharacterInventoryMutexByClient(client, characterId);
  }
};
