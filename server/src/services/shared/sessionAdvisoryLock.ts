import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';

/**
 * 会话级 advisory lock 统一执行入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装 `pg_try_advisory_lock` / `pg_advisory_unlock` 的同连接执行协议，避免后台任务在连接池里散落手写“拿锁/解锁”。
 * 2. 做什么：把“拿到锁才执行回调”的控制流收口成单一入口，减少重复的 `lockAcquired` 状态管理。
 * 3. 不做什么：不负责事务管理，不替代事务级 `pg_advisory_xact_lock`，也不吞掉回调内部抛出的业务异常。
 *
 * 输入/输出：
 * - 输入：双整数 lock key，以及拿锁成功后的异步回调。
 * - 输出：返回 `{ acquired, result }`；未拿到锁时 `acquired=false`，不会执行回调。
 *
 * 数据流/状态流：
 * 调用方 -> 本模块独占连接 -> 同一连接 `pg_try_advisory_lock`
 * -> 拿锁成功后把该 `client` 传给回调执行 SQL
 * -> 同一连接 `pg_advisory_unlock`
 * -> 释放连接回池。
 *
 * 关键边界条件与坑点：
 * 1. 会话级 advisory lock 必须在同一条数据库连接上成对获取/释放；若改回 `pool.query()` 分散执行，会重新出现 “you don't own a lock of type ExclusiveLock” 告警。
 * 2. 回调执行期间不能提前释放 client；否则锁仍挂在后台连接上，后续请求会遇到幽灵锁争用。
 */

export interface SessionAdvisoryLockExecutionResult<T> {
  acquired: boolean;
  result: T | null;
}

export const withSessionAdvisoryLock = async <T>(
  key1: number,
  key2: number,
  callback: (client: PoolClient) => Promise<T>,
): Promise<SessionAdvisoryLockExecutionResult<T>> => {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    const lockRes = await client.query<{ locked?: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [key1, key2],
    );
    lockAcquired = lockRes.rows[0]?.locked === true;
    if (!lockAcquired) {
      return {
        acquired: false,
        result: null,
      };
    }

    return {
      acquired: true,
      result: await callback(client),
    };
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2]);
      }
    } finally {
      client.release();
    }
  }
};
