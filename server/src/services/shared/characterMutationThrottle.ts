/**
 * 角色突变短限流
 *
 * 作用：
 * 1. 做什么：为高频角色突变接口提供 Redis SET NX PX 短窗口限流。
 * 2. 不做什么：不替代业务冷却、不记录失败次数、不做验证码或风控判定。
 *
 * 输入/输出：
 * - 输入：角色 ID、业务 scope、窗口毫秒数。
 * - 输出：是否允许继续执行。
 *
 * 数据流/状态流：
 * 路由/服务热路径 -> acquireCharacterMutationThrottle -> Redis NX key -> 允许时进入 DB 锁。
 *
 * 复用设计说明：
 * - 资源采集先复用该入口，后续如果其他角色突变接口出现同类抖动，可以只扩展 scope。
 * - key 结构集中在这里，避免各业务服务重复拼 Redis key。
 *
 * 关键边界条件与坑点：
 * 1. 只做短窗口防抖，不承诺强一致；真正的业务状态仍由数据库行锁和事务保证。
 * 2. key 必须带角色 ID 和 scope，不能按 IP 限流，否则同出口玩家会互相影响。
 */
import { redis } from '../../config/redis.js';

export type CharacterMutationThrottleScope = 'map-resource-gather';

const buildCharacterMutationThrottleKey = (
  characterId: number,
  scope: CharacterMutationThrottleScope,
): string => {
  return `character:mutation-throttle:${scope}:${Math.floor(characterId)}`;
};

export const acquireCharacterMutationThrottle = async (params: {
  characterId: number;
  scope: CharacterMutationThrottleScope;
  windowMs: number;
}): Promise<boolean> => {
  const characterId = Math.floor(params.characterId);
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const result = await redis.set(
    buildCharacterMutationThrottleKey(characterId, params.scope),
    '1',
    'PX',
    windowMs,
    'NX',
  );
  return result === 'OK';
};
