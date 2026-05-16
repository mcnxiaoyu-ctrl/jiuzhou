/**
 * 物品坊市自动下架 RabbitMQ 消费服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：消费 RabbitMQ 到期队列消息，并复用 `marketService.cancelExpiredMarketListing` 执行物品坊市自动下架。
 * 2. 做什么：按取消结果区分幂等成功与调度异常，保证已售出、已手动下架或重复消息可以确认完成，未到期消息进入 DLQ 暴露调度问题。
 * 3. 不做什么：不扫描数据库，不声明 RabbitMQ 拓扑，不直接拼装下架 SQL，也不接管购买或手动下架流程。
 *
 * 输入 / 输出：
 * - 输入：RabbitMQ 消息中的 `listingId` 与 `listedAt`。
 * - 输出：`startConsumer()` 启动消费者，`stopConsumer()` 停止当前消费者；单条消息成功处理后由队列封装 ack。
 *
 * 数据流 / 状态流：
 * RabbitMQ due queue -> startMarketListingAutoCancelConsumer -> handler 计算到期 now
 * -> marketService.cancelExpiredMarketListing -> 成功后 scheduleSafeCharacterUpdate 刷新在线角色。
 *
 * 复用设计说明：
 * - RabbitMQ 拓扑、ack/reject 与 DLQ 规则集中复用 shared queue，业务层只维护自动下架结果判定。
 * - 自动下架与手动下架复用 marketService 的事务入口，物品迁移、邮件返还、手续费退回和缓存失效只有一个维护点。
 * - 幂等成功文案集中在本服务，避免 worker、queue handler 或 marketService 外层重复散落判断。
 *
 * 关键边界条件与坑点：
 * 1. `now` 使用消息 `listedAt + 72 小时`，避免 broker 延迟略早投递时被误判为未过期。
 * 2. `上架记录不存在` 与 `该上架记录不可下架` 是幂等成功，必须正常返回交给队列 ack，避免重复消息污染 DLQ。
 * 3. `该上架记录未到自动下架时间` 代表调度异常，必须抛错交给队列 reject(false) 并进入 DLQ。
 */
import { scheduleSafeCharacterUpdate } from '../middleware/pushUpdate.js';
import { marketService } from './marketService.js';
import {
  type MarketListingAutoCancelMessage,
  startMarketListingAutoCancelConsumer,
} from './shared/marketListingAutoCancelQueue.js';
import { MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS } from './shared/marketListingRules.js';

const MARKET_LISTING_AUTO_CANCEL_AFTER_MS =
  MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS * 60 * 60 * 1000;

const IDEMPOTENT_SUCCESS_MESSAGES = new Set<string>([
  '上架记录不存在',
  '该上架记录不可下架',
]);

const EARLY_DELIVERY_MESSAGE = '该上架记录未到自动下架时间';

const resolveExpirationNow = (message: MarketListingAutoCancelMessage): Date => {
  const listedAtMs = Date.parse(message.listedAt);
  if (Number.isNaN(listedAtMs)) {
    throw new Error(`坊市自动下架消息 listedAt 非法: ${message.listedAt}`);
  }
  return new Date(listedAtMs + MARKET_LISTING_AUTO_CANCEL_AFTER_MS);
};

class MarketListingAutoCancelService {
  private stopConsumerFn: (() => Promise<void>) | null = null;
  private startingConsumer: Promise<void> | null = null;

  private async handleMessage(
    message: MarketListingAutoCancelMessage,
  ): Promise<void> {
    const result = await marketService.cancelExpiredMarketListing({
      listingId: message.listingId,
      now: resolveExpirationNow(message),
    });

    if (result.success) {
      scheduleSafeCharacterUpdate(result.sellerUserId);
      return;
    }

    if (IDEMPOTENT_SUCCESS_MESSAGES.has(result.message)) {
      return;
    }

    if (result.message === EARLY_DELIVERY_MESSAGE) {
      throw new Error(
        `坊市自动下架消息过早投递: listingId=${message.listingId}`,
      );
    }

    throw new Error(
      `坊市自动下架失败: listingId=${message.listingId}, reason=${result.message}`,
    );
  }

  async startConsumer(): Promise<void> {
    if (this.stopConsumerFn) {
      return;
    }
    if (this.startingConsumer) {
      await this.startingConsumer;
      return;
    }

    this.startingConsumer = (async () => {
      this.stopConsumerFn = await startMarketListingAutoCancelConsumer(
        (message) => this.handleMessage(message),
      );
    })();

    try {
      await this.startingConsumer;
    } finally {
      this.startingConsumer = null;
    }
  }

  async stopConsumer(): Promise<void> {
    if (this.startingConsumer) {
      await this.startingConsumer;
    }

    const stopConsumerFn = this.stopConsumerFn;
    if (!stopConsumerFn) {
      return;
    }

    this.stopConsumerFn = null;
    await stopConsumerFn();
  }
}

export const marketListingAutoCancelService = new MarketListingAutoCancelService();
