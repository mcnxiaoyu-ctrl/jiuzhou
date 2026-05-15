/**
 * 服务运行角色配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解释 `JIUZHOU_RUNTIME_ROLE`，用于拆分 HTTP API 进程与后台 worker 进程。
 * 2. 做什么：提供启动流水线可读的布尔判断，避免各处直接比较字符串。
 * 3. 不做什么：不读取 Docker service 配置，不修改端口，不决定副本数量。
 *
 * 输入 / 输出：
 * - 输入：环境变量 `JIUZHOU_RUNTIME_ROLE`。
 * - 输出：`all | api | worker` 之一，以及启动决策函数。
 *
 * 数据流 / 状态流：
 * process.env -> resolveJiuzhouRuntimeRole -> startupPipeline -> 按角色启动 HTTP 或后台任务。
 *
 * 复用设计说明：
 * - 运行角色是部署级高频变化点，集中在 config 模块后，后续新增 worker 类型不需要散改 startupPipeline。
 *
 * 关键边界条件与坑点：
 * 1. 默认必须是 `all`，保持当前部署行为。
 * 2. 非法值必须回落到 `all`，避免环境变量写错导致服务不监听或后台任务不跑。
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

export const shouldStartGeneralBackgroundWorkers = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};
