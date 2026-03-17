/**
 * 任务入口角标共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一定义“哪些任务分类会出现在任务入口列表”和“哪些状态算可完成”，让 Game 页角标与 TaskModal 使用同一套口径。
 * 2. 做什么：分别提供普通任务与悬赏任务的可完成数量计算，避免页面层再次散落 `category/status` 判断。
 * 3. 不做什么：不发起接口请求、不管理 React state，也不处理主线任务独立面板的进度口径。
 *
 * 输入/输出：
 * - 输入：普通任务 `TaskOverviewRowDto[]`、悬赏任务 `BountyTaskOverviewRowDto[]`，或单个任务状态/分类。
 * - 输出：分类布尔判断、状态布尔判断、可完成数量数字。
 *
 * 数据流/状态流：
 * - `/task/overview` / `/task/bounty/overview` 响应 -> 本文件过滤分类与状态 -> Game 页功能角标 / TaskModal 保持一致。
 *
 * 关键边界条件与坑点：
 * 1. 普通任务角标必须排除 `main`，因为主线展示与刷新走独立面板，不能把两套来源混在同一个数字里。
 * 2. 日常委托有过期时间，角标与 TaskModal 都必须按同一套 `expiresAt` 口径排除已过期条目，否则同一时刻会出现“面板已消失但角标还在”的漂移。
 * 3. “可完成”只认 `turnin/claimable`，不能把 `ongoing` 视作红点，否则会误导玩家把进行中任务当成可领奖。
 */
import type {
  BountyTaskOverviewRowDto,
  TaskOverviewRowDto,
  TaskStatus,
} from '../../../services/api';

export type TaskIndicatorListCategory = Extract<
  TaskOverviewRowDto['category'],
  'side' | 'daily' | 'event'
>;

type BountyTaskIndicatorRow = {
  status: TaskStatus;
  sourceType?: BountyTaskOverviewRowDto['sourceType'];
  expiresAt?: string | null;
};

const TASK_INDICATOR_COMPLETABLE_STATUS: ReadonlySet<TaskStatus> = new Set([
  'turnin',
  'claimable',
]);

export const isTaskIndicatorListCategory = (
  category: TaskOverviewRowDto['category'],
): category is TaskIndicatorListCategory => {
  return category === 'side' || category === 'daily' || category === 'event';
};

export const isTaskIndicatorCompletableStatus = (
  status: TaskStatus,
): boolean => {
  return TASK_INDICATOR_COMPLETABLE_STATUS.has(status);
};

export const getBountyTaskRemainingSeconds = (
  expiresAt: string | null | undefined,
  nowTs: number,
): number | null => {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - nowTs) / 1000));
};

export const hasExpiredBountyTaskOverviewRow = (
  task: BountyTaskIndicatorRow,
  nowTs: number,
): boolean => {
  if (task.sourceType !== 'daily') return false;
  if (!task.expiresAt) return false;
  const remainingSeconds = getBountyTaskRemainingSeconds(task.expiresAt, nowTs);
  return remainingSeconds == null || remainingSeconds <= 0;
};

export const isActiveBountyTaskOverviewRow = (
  task: BountyTaskIndicatorRow,
  nowTs: number,
): boolean => {
  if (task.sourceType !== 'daily') return true;
  if (!task.expiresAt) return true;
  const remainingSeconds = getBountyTaskRemainingSeconds(task.expiresAt, nowTs);
  return remainingSeconds != null && remainingSeconds > 0;
};

export const countCompletableTaskOverviewRows = (
  tasks: TaskOverviewRowDto[],
): number => {
  return tasks.reduce((total, task) => {
    if (!isTaskIndicatorListCategory(task.category)) return total;
    return isTaskIndicatorCompletableStatus(task.status) ? total + 1 : total;
  }, 0);
};

export const countCompletableBountyTaskOverviewRows = (
  tasks: BountyTaskIndicatorRow[],
  nowTs: number = Date.now(),
): number => {
  return tasks.reduce((total, task) => (
    isActiveBountyTaskOverviewRow(task, nowTs) && isTaskIndicatorCompletableStatus(task.status) ? total + 1 : total
  ), 0);
};

export const getNextBountyTaskExpiryTs = (
  tasks: BountyTaskIndicatorRow[],
  nowTs: number = Date.now(),
): number | null => {
  let nextExpiryTs: number | null = null;
  for (const task of tasks) {
    if (task.sourceType !== 'daily' || !task.expiresAt) continue;
    const expiryTs = Date.parse(task.expiresAt);
    if (!Number.isFinite(expiryTs) || expiryTs <= nowTs) continue;
    if (nextExpiryTs == null || expiryTs < nextExpiryTs) {
      nextExpiryTs = expiryTs;
    }
  }
  return nextExpiryTs;
};
