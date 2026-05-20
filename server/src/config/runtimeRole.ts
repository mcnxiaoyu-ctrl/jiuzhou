/**
 * 服务运行角色配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解释 `JIUZHOU_RUNTIME_ROLE`，用于拆分 HTTP API 进程与后台调度 worker 进程。
 * 2. 做什么：提供启动流水线可读的布尔判断，避免各处直接比较字符串。
 * 3. 不做什么：不读取 Docker service 配置，不修改端口，不决定副本数量。
 *
 * 输入 / 输出：
 * - 输入：环境变量 `JIUZHOU_RUNTIME_ROLE`。
 * - 输出：`all | api | worker` 之一，以及启动决策函数。
 *
 * 数据流 / 状态流：
 * process.env -> resolveJiuzhouRuntimeRole -> startupPipeline -> 按角色启动 HTTP、请求型 Worker、挂机执行 Worker、恢复任务或后台调度。
 *
 * 复用设计说明：
 * - 运行角色是部署级高频变化点，集中在 config 模块后，后续新增 worker 类型不需要散改 startupPipeline。
 *
 * 关键边界条件与坑点：
 * 1. 默认必须是 `all`，保持当前部署行为。
 * 2. 非法值必须回落到 `all`，避免环境变量写错导致服务不监听或后台任务不跑。
 * 3. AI 招募、洞府研修、云游、洗髓和归契当前仍是请求创建后在本进程入队，不能放到独立 worker 角色，否则 API 无法投递新任务。
 * 4. 挂机执行循环已改为 RabbitMQ 命令投递，worker 角色必须承接 WorkerPool 与历史会话恢复，API 角色不能再启动挂机计算线程。
 * 5. 定时调度、增量刷写与在线战斗延迟结算不依赖 HTTP 请求内存队列，适合放到 worker 角色独立运行。
 */

export type JiuzhouRuntimeRole = 'all' | 'api' | 'worker';

export const resolveJiuzhouRuntimeRole = (): JiuzhouRuntimeRole => {
  const role = String(process.env.JIUZHOU_RUNTIME_ROLE ?? '').trim();
  if (role === 'api' || role === 'worker' || role === 'all') return role;
  return 'all';
};

export const shouldStartHttpServer = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'api';
};

export const shouldStartOnlineSettlementRunner = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldStartRequestBoundJobWorkers = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'api';
};

export const shouldStartWorkerPool = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldStartIdleExecutionWorker = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldStartScheduledBackgroundServices = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldRecoverHttpBattleState = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'api';
};

export const shouldRecoverIdleSessions = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};
