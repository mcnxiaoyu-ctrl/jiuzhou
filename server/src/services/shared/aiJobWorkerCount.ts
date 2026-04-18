/**
 * AI 任务 worker 默认并发共享配置
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护 AI 类异步任务 worker 池的默认并发数，并提供统一的环境变量解析函数。
 * 2) 做什么：让伙伴招募、洞府研修、云游奇遇共用同一套默认并发口径，避免各 runner 各自硬编码默认值。
 * 3) 不做什么：不决定具体业务是否启用 worker，也不处理超时、队列或失败回退。
 *
 * 输入 / 输出：
 * - 输入：环境变量原始值。
 * - 输出：合法 worker 并发数；当环境变量缺失、非法或小于等于 0 时，返回统一默认值。
 *
 * 数据流 / 状态流：
 * `process.env.*_WORKER_COUNT` -> 本模块解析 -> 各业务 runner 初始化 worker 池并发数。
 *
 * 复用设计说明：
 * 1) 伙伴招募、洞府研修、云游奇遇都属于 AI 后台任务，默认并发策略一致，集中在这里最能减少重复维护。
 * 2) 后续若默认并发继续调整，只需改一处，避免文档、代码和环境示例发生漂移。
 *
 * 关键边界条件与坑点：
 * 1) 这里只负责“默认值回退”，不限制显式配置更大的并发数；生产并发仍由环境变量控制。
 * 2) 解析时必须先做整数化与有限值校验，避免把空串、NaN 或小数直接带入 worker 池配置。
 */
export const DEFAULT_AI_JOB_WORKER_COUNT = 10;

export const resolveAiJobWorkerCount = (raw: string | undefined): number => {
  const configured = Math.floor(Number(raw));
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AI_JOB_WORKER_COUNT;
  }
  return configured;
};
