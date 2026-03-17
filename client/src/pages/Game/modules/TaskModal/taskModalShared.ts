/**
 * 任务弹窗共享数据模型与 DTO 映射。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一任务弹窗的分类常量、展示文案、加载状态工厂和接口 DTO -> UI 数据映射，避免 `TaskModal` 内重复散落同类转换。
 * 2. 做什么：把“普通任务只按 side/daily/event 分类加载、悬赏单独加载”的边界集中到一个模块，并统一把总览结果分发回分类列表，减少后续新增刷新路径时复制判断。
 * 3. 不做什么：不发起接口请求，不管理 React state，不负责任何弹窗 UI 渲染与交互副作用。
 *
 * 输入/输出：
 * - 输入：任务/悬赏 overview 接口返回的 DTO 数组，以及弹窗分类 key。
 * - 输出：任务弹窗使用的 `TaskItem`、分类标签、空状态工厂与类型守卫。
 *
 * 数据流/状态流：
 * `/task/overview` 或 `/task/bounty/overview` 响应 -> 本文件完成字段归一化、分类裁剪与列表分发 -> `TaskModal` / `MainQuestPanel` 消费统一数据结构。
 *
 * 关键边界条件与坑点：
 * 1. 主线页签由 `MainQuestPanel` 独占，普通任务 overview 即便返回 `main` 分类，也必须在这里统一丢弃，避免业务组件再写一遍过滤。
 * 2. 悬赏任务的剩余时间可能来自 `expiresAt` 或 `remainingSeconds`，需要在映射时统一补齐，避免详情区和列表区各自推算。
 * 3. 左侧分类红点与右侧任务列表必须共用同一份分发结果，不能一边按总览算、一边按当前页签算，否则会出现切页前后状态漂移。
 */
import type {
  BountyTaskOverviewRowDto,
  TaskObjectiveDto,
  TaskOverviewRowDto,
  TaskRewardDto,
} from '../../../../services/api';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import { resolveIconUrl } from '../../shared/resolveIcon';
import { isTaskIndicatorListCategory } from '../../shared/taskIndicator';

export type TaskCategory = 'main' | 'side' | 'daily' | 'event' | 'bounty';

export type TaskListCategory = 'side' | 'daily' | 'event';

export type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

export type TaskReward = { id: string; name: string; icon: string; amount: number; amountMax?: number };

export type TaskObjective = {
  text: string;
  done: number;
  total: number;
  mapName?: string | null;
  mapNameType?: 'map' | 'dungeon' | null;
};

export type TaskItem = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId?: string | null;
  status: TaskStatus;
  tracked: boolean;
  desc: string;
  objectives: TaskObjective[];
  rewards: TaskReward[];
  expiresAt?: string | null;
  sourceType?: 'daily' | 'player';
  remainingSeconds?: number | null;
};

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  main: '主线任务',
  side: '支线任务',
  daily: '日常任务',
  event: '活动任务',
  bounty: '悬赏任务',
};

export const TASK_CATEGORY_SHORT_LABELS: Record<TaskCategory, string> = {
  main: '主线',
  side: '支线',
  daily: '日常',
  event: '活动',
  bounty: '悬赏',
};

export const TASK_STATUS_TEXT: Record<TaskStatus, string> = {
  ongoing: '进行中',
  turnin: '可提交',
  claimable: '可领取',
  completed: '已完成',
};

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  ongoing: 'blue',
  turnin: 'purple',
  claimable: 'gold',
  completed: 'default',
};

export const TASK_CATEGORY_KEYS: TaskCategory[] = ['main', 'side', 'daily', 'event', 'bounty'];

export const TASK_LIST_CATEGORY_KEYS: TaskListCategory[] = ['side', 'daily', 'event'];

export const isTaskListCategory = (category: TaskCategory): category is TaskListCategory => {
  return category === 'side' || category === 'daily' || category === 'event';
};

export const createEmptyTaskRowsByCategory = (): Record<TaskListCategory, TaskItem[]> => ({
  side: [],
  daily: [],
  event: [],
});

export const createEmptyTaskLoadedState = (): Record<TaskCategory, boolean> => ({
  main: false,
  side: false,
  daily: false,
  event: false,
  bounty: false,
});

const resolveRewardAmount = (amount: number): number => {
  return Number.isFinite(amount) ? amount : 0;
};

const mapTaskObjectives = (objectives: TaskObjectiveDto[]): TaskObjective[] => {
  return objectives
    .map((objective) => ({
      text: objective.text,
      done: resolveRewardAmount(objective.done),
      total: Number.isFinite(objective.target) ? objective.target : 1,
      mapName: objective.mapName,
      mapNameType: objective.mapNameType,
    }))
    .filter((objective) => objective.text);
};

const mapTaskRewards = (taskId: string, rewards: TaskRewardDto[]): TaskReward[] => {
  return rewards.map((reward) => {
    if (reward.type === 'item') {
      return {
        id: reward.itemDefId,
        name: reward.name || reward.itemDefId,
        icon: resolveIconUrl(reward.icon),
        amount: Number.isFinite(reward.amount) ? reward.amount : 1,
        ...(typeof reward.amountMax === 'number' && reward.amountMax > reward.amount ? { amountMax: reward.amountMax } : {}),
      };
    }

    return {
      id: `${taskId}:${reward.type}`,
      name: reward.name || (reward.type === 'silver' ? '银两' : '灵石'),
      icon: reward.type === 'silver' ? tongqianIcon : lingshiIcon,
      amount: resolveRewardAmount(reward.amount),
    };
  });
};

const resolveTaskOverviewCategory = (category: TaskOverviewRowDto['category']): TaskListCategory | null => {
  if (isTaskIndicatorListCategory(category)) {
    return category;
  }
  return null;
};

const mapTaskOverviewRow = (task: TaskOverviewRowDto): TaskItem | null => {
  const category = resolveTaskOverviewCategory(task.category);
  if (!category) return null;

  return {
    id: task.id,
    category,
    title: task.title,
    realm: task.realm || '凡人',
    giverNpcId: task.giverNpcId,
    status: task.status,
    tracked: task.tracked,
    desc: task.description,
    objectives: mapTaskObjectives(task.objectives || []),
    rewards: mapTaskRewards(task.id, task.rewards || []),
  };
};

export const mapTaskOverviewRows = (tasks: TaskOverviewRowDto[]): TaskItem[] => {
  return tasks.flatMap((task) => {
    const mapped = mapTaskOverviewRow(task);
    return mapped ? [mapped] : [];
  });
};

export const groupTaskOverviewRowsByCategory = (
  tasks: TaskOverviewRowDto[],
): Record<TaskListCategory, TaskItem[]> => {
  const grouped = createEmptyTaskRowsByCategory();
  for (const task of mapTaskOverviewRows(tasks)) {
    if (!isTaskListCategory(task.category)) continue;
    grouped[task.category].push(task);
  }
  return grouped;
};

export const mapBountyTaskOverviewRows = (tasks: BountyTaskOverviewRowDto[]): TaskItem[] => {
  return tasks.map((task) => ({
    id: task.id,
    category: 'bounty',
    title: task.title,
    realm: task.realm || '凡人',
    giverNpcId: task.giverNpcId,
    status: task.status,
    tracked: task.tracked,
    desc: task.description,
    objectives: mapTaskObjectives(task.objectives || []),
    rewards: mapTaskRewards(task.id, task.rewards || []),
    expiresAt: task.expiresAt || (typeof task.remainingSeconds === 'number' ? new Date(Date.now() + task.remainingSeconds * 1000).toISOString() : null),
    sourceType: task.sourceType,
    remainingSeconds: typeof task.remainingSeconds === 'number' ? Math.max(0, Math.floor(task.remainingSeconds)) : null,
  }));
};
