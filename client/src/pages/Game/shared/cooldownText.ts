/**
 * 冷却时间前端共享格式化工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一把剩余冷却秒数格式化为紧凑中文文案，供洞府研修与伙伴招募复用，减少重复实现。
 * 2. 做什么：把“天/小时/分/秒”的展示规则收敛到单一入口，避免不同模块出现不一致的时间粒度。
 * 3. 不做什么：不判断业务是否处于冷却中，不拼接“剩余/可开始/可招募”等业务前缀，也不处理日期对象。
 *
 * 输入/输出：
 * - 输入：剩余冷却秒数。
 * - 输出：形如 `2天`、`1小时1分`、`59秒` 的紧凑文本。
 *
 * 数据流/状态流：
 * 服务端 `cooldownRemainingSeconds` -> 本模块格式化 -> 研修面板 / 招募面板状态展示。
 *
 * 关键边界条件与坑点：
 * 1. 秒数会先下取整并限制最小为 0，避免浮点秒或负数导致界面跳字。
 * 2. 只有更小单位确实存在剩余时才继续展示，避免出现 `2天0小时`、`1小时0分` 这类噪音文案。
 */
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export const formatGameCooldownRemaining = (
  cooldownRemainingSeconds: number,
): string => {
  const safeSeconds = Math.max(0, Math.floor(cooldownRemainingSeconds));
  if (safeSeconds >= DAY_SECONDS) {
    const days = Math.floor(safeSeconds / DAY_SECONDS);
    const hours = Math.floor((safeSeconds % DAY_SECONDS) / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${days}天${hours}小时${minutes}分`;
    if (hours > 0) return `${days}天${hours}小时`;
    return `${days}天`;
  }

  if (safeSeconds >= HOUR_SECONDS) {
    const hours = Math.floor(safeSeconds / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${hours}小时${minutes}分`;
    return `${hours}小时`;
  }

  if (safeSeconds >= MINUTE_SECONDS) {
    const minutes = Math.floor(safeSeconds / MINUTE_SECONDS);
    const seconds = safeSeconds % MINUTE_SECONDS;
    if (seconds > 0) return `${minutes}分${seconds}秒`;
    return `${minutes}分`;
  }

  return `${safeSeconds}秒`;
};
