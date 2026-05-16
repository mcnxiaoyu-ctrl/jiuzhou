/**
 * 物品坊市自动下架 RabbitMQ Worker
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为启动流水线提供物品坊市自动下架启动补偿与 RabbitMQ 消费者的进程级启停入口。
 * 2. 做什么：启动时先补偿历史 active 挂单，再启动消费者处理后续到期消息。
 * 3. 不做什么：不声明队列拓扑，不处理单条消息，不读写数据库，也不参与 cleanupWorker 的定时任务调度。
 *
 * 输入 / 输出：
 * - 输入：无显式参数，运行时配置由底层 RabbitMQ 队列封装读取。
 * - 输出：`startMarketListingAutoCancelWorker()` 执行启动补偿并启动消费者；`stopMarketListingAutoCancelWorker()` 停止消费者。
 *
 * 数据流 / 状态流：
 * startupPipeline -> startMarketListingAutoCancelWorker -> runStartupReconcileOnce -> marketListingAutoCancelService.startConsumer
 * shutdown -> stopMarketListingAutoCancelWorker -> marketListingAutoCancelService.stopConsumer。
 *
 * 复用设计说明：
 * - worker 复用补偿 service 与消费 service 的公开入口，避免 startupPipeline、cleanupWorker 和业务 service 之间交叉持有实现细节。
 * - 后续若增加 worker 角色开关或启动日志，只需改本入口，不需要复制消费 handler。
 *
 * 关键边界条件与坑点：
 * 1. API 角色不应启动本 worker，角色判断由 startupPipeline 统一控制，避免多进程重复消费。
 * 2. 启动补偿必须在消费者启动前执行，确保历史挂单先补齐延迟消息或立即下架。
 * 3. stop 必须委托 service 返回的停止函数，确保 RabbitMQ consumerTag 被取消后再关闭共享连接。
 */
import { marketListingAutoCancelReconcileService } from '../services/marketListingAutoCancelReconcileService.js';
import { marketListingAutoCancelService } from '../services/marketListingAutoCancelService.js';

export const startMarketListingAutoCancelWorker = async (): Promise<void> => {
  await marketListingAutoCancelReconcileService.runStartupReconcileOnce();
  await marketListingAutoCancelService.startConsumer();
};

export const stopMarketListingAutoCancelWorker = async (): Promise<void> => {
  await marketListingAutoCancelService.stopConsumer();
};
