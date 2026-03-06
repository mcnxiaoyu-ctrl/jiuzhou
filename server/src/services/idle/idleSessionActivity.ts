/**
 * idleSessionActivity — 挂机会话活跃态判定工具
 *
 * 作用：
 *   统一封装“哪些 stopping 会话已经失去执行循环承接，应被视为孤儿”的判定规则，
 *   避免在 IdleSessionService、路由或其他业务模块里重复书写同一条状态判断。
 *   不负责数据库查询、不负责更新状态，只返回可供上层收敛的 sessionId 列表。
 *
 * 输入/输出：
 *   - 输入：最小会话视图（id / characterId / status）和执行循环探针
 *   - 输出：应被收敛的孤儿 stopping 会话 ID 列表
 *
 * 数据流：
 *   DB 查询得到 stopping 会话最小视图 → resolveOrphanStoppingSessionIds
 *   → IdleSessionService 根据返回的 sessionId 批量更新为 interrupted
 *
 * 关键边界条件与坑点：
 *   1. 只处理 status='stopping' 的会话；active 会话即使暂无执行循环，也不在这里直接判死。
 *   2. 判定依据只依赖进程内执行循环探针，保持纯函数，方便单测和复用。
 *   3. 返回顺序与输入顺序一致，便于上层在日志或批处理时保留原始遍历顺序。
 *   4. 本模块不做去重；调用方若传入重复 sessionId，会按输入重复返回。
 */

export interface IdleSessionActivitySnapshot {
  id: string;
  characterId: number;
  status: 'active' | 'stopping' | 'completed' | 'interrupted';
}

/**
 * 识别“已进入 stopping，但当前没有任何执行循环承接”的孤儿会话。
 *
 * 复用点：
 *   - IdleSessionService 在状态查询、启动互斥、组队互斥前调用
 *   - 单测直接验证该纯函数，避免把数据库和 Redis 依赖带入测试
 *
 * 为什么这样设计能减少重复：
 *   把孤儿判定从 Service 的数据库逻辑中剥离后，所有需要识别 stopping 孤儿的入口
 *   都只复用这一处纯函数，不再散落重复的状态判断和执行循环探针调用。
 */
export function resolveOrphanStoppingSessionIds(
  sessions: IdleSessionActivitySnapshot[],
  hasExecutionLoop: (sessionId: string) => boolean,
): string[] {
  const orphanSessionIds: string[] = [];

  for (const session of sessions) {
    if (session.status !== 'stopping') {
      continue;
    }
    if (hasExecutionLoop(session.id)) {
      continue;
    }
    orphanSessionIds.push(session.id);
  }

  return orphanSessionIds;
}
