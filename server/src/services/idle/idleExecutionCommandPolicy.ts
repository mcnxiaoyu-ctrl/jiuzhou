/**
 * 挂机执行命令决策策略
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中判断 RabbitMQ start 命令是否应该在当前进程启动执行循环。
 * 2. 做什么：把会话状态过滤和本地循环去重从消费回调中抽离，避免 worker 内重复散写判断。
 * 3. 不做什么：不查询数据库，不启动战斗循环，不发布或消费 RabbitMQ 消息。
 *
 * 输入 / 输出：
 * - 输入：按 sessionId 查询到的最小会话快照，以及当前进程是否已有该 session 的执行循环。
 * - 输出：`start` 或明确的跳过原因，供 worker 入口记录与分支处理。
 *
 * 数据流 / 状态流：
 * idleExecutionWorker -> idleSessionService.getIdleSessionById -> 本模块决策 ->
 * startExecutionLoop 或跳过重复/失效命令。
 *
 * 复用设计说明：
 * - RabbitMQ 至少一次投递会带来重复 start 的高频边界，把幂等规则集中在这里后，worker 和测试共用同一入口。
 * - 会话状态是挂机生命周期的高频变化点，集中判断可避免后续新增消费入口时把 active/stopping 口径写散。
 *
 * 关键边界条件与坑点：
 * 1. `stopping` 仍允许启动执行循环，用于服务重启后恢复并完成收尾 flush/解锁。
 * 2. 已注册本地循环时必须跳过，RabbitMQ 重投或 API 重试不能制造重复 setTimeout 链。
 */

export type IdleExecutionCommandSessionStatus =
  | 'active'
  | 'stopping'
  | 'completed'
  | 'interrupted';

export interface IdleExecutionStartSessionSnapshot {
  id: string;
  status: IdleExecutionCommandSessionStatus;
}

export type IdleExecutionStartAction =
  | 'start'
  | 'skip_missing'
  | 'skip_registered'
  | 'skip_inactive';

export const resolveIdleExecutionStartAction = (
  session: IdleExecutionStartSessionSnapshot | null,
  hasLocalExecutionLoop: boolean,
): IdleExecutionStartAction => {
  if (!session) {
    return 'skip_missing';
  }

  if (hasLocalExecutionLoop) {
    return 'skip_registered';
  }

  if (session.status !== 'active' && session.status !== 'stopping') {
    return 'skip_inactive';
  }

  return 'start';
};
