# Market Auto Cancel RabbitMQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 RabbitMQ 延迟队列和死信队列实现坊市物品上架后 72 小时未售出的实时自动下架。

**Architecture:** 上架事务内写入挂单后，立即用 RabbitMQ publisher confirm 发布一个 72 小时延迟消息；发布失败则回滚上架，避免出现“挂单成功但没有自动下架任务”。消息到期后由 worker 消费并调用现有 `marketService.cancelExpiredMarketListing`。RabbitMQ 负责延迟投递、ack、nack 和死信；PostgreSQL 仍是挂单事实源，消费时必须幂等检查挂单状态。若挂单事务提交失败但消息已确认，消费者 72 小时后应把不存在的挂单视为幂等成功并 ack。当前已产生的 DB-backed dead-letter 半成品必须移除，不保留数据库死信表。

**Tech Stack:** TypeScript ESM、Express、PostgreSQL、RabbitMQ、amqplib、Prisma schema、现有 cleanup worker / runtime role、`pnpm exec tsc -b`。

---

## Scope And Constraints

- 方案采用 RabbitMQ，不用 Redis Streams，不用数据库死信表。
- 不执行 Git 写操作；本计划中的 checkpoint 只描述文件边界，不包含 `git add/commit`。
- 不运行 `dev`、`start`、`build`、`test`；实现完成后只执行 `pnpm exec tsc -b`。
- 上架次数 100、同时上架 30、公开列表/购买过期拦截等前序规则保留。
- 自动下架主路径不能依赖定时扫描 DB；DB 扫描最多作为后续人工修复脚本，不在本任务实现。

## File Structure

- Modify: `server/package.json`
  - 增加 `amqplib` 和 `@types/amqplib`。
- Modify: `docker-stack.yml`
  - 增加 RabbitMQ 服务。
  - 给 server / server_worker 注入 `RABBITMQ_URL`。
- Modify: `server/.env.example`
  - 增加 RabbitMQ 自动下架相关配置。
- Modify: `server/prisma/schema.prisma`
  - 删除中断前误加的 `market_listing_auto_cancel_dead_letter` 模型。
- Create: `server/src/services/shared/rabbitMqConnection.ts`
  - 管理 RabbitMQ 连接和 channel。
- Create: `server/src/services/shared/marketListingAutoCancelQueue.ts`
  - 声明 exchange / queue / dlq / routing key，封装 publish、consume、ack/nack。
- Modify: `server/src/services/marketService.ts`
  - 上架事务内写入挂单后投递 72 小时延迟消息，并等待 RabbitMQ confirm；发布失败则回滚上架。
  - 保留 `cancelExpiredMarketListing` 作为消费者调用入口。
- Replace: `server/src/services/marketListingAutoCancelService.ts`
  - 从“定时扫描 DB”改为 RabbitMQ consumer。
  - 消费到期消息后调用 `marketService.cancelExpiredMarketListing`。
  - 对已售出/已下架/不存在的挂单 ack；对业务异常 nack，让 RabbitMQ DLQ 接管。
- Modify: `server/src/workers/cleanupWorker.ts`
  - 移除自动下架作为 cleanup 定时任务的接入。
- Create: `server/src/workers/marketListingAutoCancelWorker.ts`
  - 在 worker runtime 启动 RabbitMQ 消费。
- Modify: `server/src/bootstrap/startupPipeline.ts`
  - 在 `server_worker` 角色启动自动下架消费 worker。
- Modify: `server/src/services/__tests__/marketListingRulesPolicy.test.ts`
  - 删除 DB 死信表断言，改为 RabbitMQ 交换机、延迟队列、DLQ、worker 接入静态断言。
- Create: `server/src/services/__tests__/marketListingAutoCancelRabbitMqPolicy.test.ts`
  - 独立锁定 RabbitMQ 拓扑和禁止 DB 扫描。

---

### Task 1: 清除 DB-backed Dead Letter 半成品

**Files:**
- Modify: `server/prisma/schema.prisma`
- Modify: `server/src/services/__tests__/marketListingRulesPolicy.test.ts`

- [ ] **Step 1: 移除 Prisma 死信表模型**

删除 `server/prisma/schema.prisma` 中整段：

```prisma
model market_listing_auto_cancel_dead_letter {
  id                  BigInt    @id @default(autoincrement())
  listing_id          BigInt
  seller_user_id      Int?
  seller_character_id Int?
  status              String    @default("retrying") @db.VarChar(16)
  attempt_count       Int       @default(0)
  last_error          String?
  last_attempt_at     DateTime? @db.Timestamptz(6)
  next_retry_at       DateTime? @default(now()) @db.Timestamptz(6)
  resolved_at         DateTime? @db.Timestamptz(6)
  created_at          DateTime  @default(now()) @db.Timestamptz(6)
  updated_at          DateTime  @default(now()) @db.Timestamptz(6)

  @@unique([listing_id], map: "uq_market_listing_auto_cancel_dlq_listing")
  @@index([status, next_retry_at, id], map: "idx_market_listing_auto_cancel_dlq_retry")
  @@index([status, updated_at], map: "idx_market_listing_auto_cancel_dlq_status_updated")
}
```

- [ ] **Step 2: 改写规则静态测试中的死信断言**

在 `server/src/services/__tests__/marketListingRulesPolicy.test.ts` 删除 `自动下架死信队列表必须写入 Prisma schema` 测试，并把自动下架测试改成：

```ts
test('自动下架任务必须使用 RabbitMQ 延迟队列和死信队列', () => {
  const queueSource = readSource('../shared/marketListingAutoCancelQueue.ts');
  const serviceSource = readSource('../marketListingAutoCancelService.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');
  const startupSource = readSource('../../bootstrap/startupPipeline.ts');

  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_EXCHANGE/u);
  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE/u);
  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_DLQ/u);
  assert.match(queueSource, /x-dead-letter-exchange/u);
  assert.match(queueSource, /x-message-ttl/u);
  assert.match(serviceSource, /marketService\.cancelExpiredMarketListing/u);
  assert.doesNotMatch(serviceSource, /FROM market_listing[\s\S]*listed_at <=/u);
  assert.doesNotMatch(cleanupWorkerSource, /marketListingAutoCancelService/u);
  assert.match(startupSource, /startMarketListingAutoCancelWorker/u);
});
```

- [ ] **Step 3: 仅做静态检查**

Run: `rg -n "market_listing_auto_cancel_dead_letter|marketListingAutoCancelDeadLetter" server`

Expected: 无输出。

---

### Task 2: 增加 RabbitMQ 依赖与部署配置

**Files:**
- Modify: `server/package.json`
- Modify: `docker-stack.yml`
- Modify: `server/.env.example`

- [ ] **Step 1: 增加依赖**

在 `server/package.json`：

```json
"dependencies": {
  "amqplib": "^0.10.8"
}
```

在 `devDependencies`：

```json
"@types/amqplib": "^0.10.7"
```

保持现有依赖排序风格，避免改动无关字段。

- [ ] **Step 2: 增加 Docker RabbitMQ 服务**

在 `docker-stack.yml` 的 `x-server-environment-base` 加：

```yaml
  RABBITMQ_URL: "amqp://rabbitmq:5672"
```

在 `services` 下增加：

```yaml
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
    networks:
      - jiuzhou_net
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
    deploy:
      replicas: 1
      update_config:
        order: stop-first
      placement:
        constraints:
          - node.role == manager
```

在 `volumes` 增加：

```yaml
  rabbitmq_data:
    external: true
    name: jiuzhou_rabbitmq_data
```

- [ ] **Step 3: 增加 env 示例**

在 `server/.env.example` 追加：

```dotenv
# RabbitMQ 延迟队列：用于坊市 72 小时未售出自动下架
RABBITMQ_URL=amqp://localhost:5672
MARKET_LISTING_AUTO_CANCEL_QUEUE_ENABLED=true
MARKET_LISTING_AUTO_CANCEL_PREFETCH=8
```

- [ ] **Step 4: 仅做静态检查**

Run: `rg -n "RABBITMQ_URL|rabbitmq|amqplib|MARKET_LISTING_AUTO_CANCEL_QUEUE_ENABLED" server/package.json docker-stack.yml server/.env.example`

Expected: 能看到依赖、环境变量和 docker 服务配置。

---

### Task 3: RabbitMQ 连接封装

**Files:**
- Create: `server/src/services/shared/rabbitMqConnection.ts`

- [ ] **Step 1: 创建连接模块**

Create `server/src/services/shared/rabbitMqConnection.ts`:

```ts
/**
 * RabbitMQ 连接共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中管理 RabbitMQ connection/channel，给延迟队列生产者和消费者复用。
 * 2. 做什么：提供 confirm channel，保证上架事务内的延迟消息发布可以等待 broker 确认。
 * 3. 不做什么：不声明具体业务 exchange / queue，也不处理业务消息格式。
 *
 * 输入/输出：
 * - 输入：`RABBITMQ_URL` 环境变量。
 * - 输出：可复用的 confirm channel，以及关闭连接的函数。
 *
 * 数据流/状态流：
 * 调用方 -> getRabbitMqConfirmChannel -> 懒连接 RabbitMQ -> 创建 confirm channel -> 调用方声明拓扑并发布消息。
 *
 * 复用设计说明：
 * - RabbitMQ 连接属于进程级资源，集中管理可以避免每个业务 worker 重复建连接、重复处理关闭流程。
 * - 当前由坊市自动下架队列复用，后续其他延迟任务也可复用同一连接入口。
 *
 * 关键边界条件与坑点：
 * 1. URL 未配置时直接抛错，让部署错误尽早暴露，不能静默降级成 DB 扫描。
 * 2. Confirm channel 断开后必须清空缓存，下次调用重新连接。
 */
import amqplib, { type ConfirmChannel, type Connection } from 'amqplib';

const RABBITMQ_LOG_SCOPE = 'RabbitMQ';

let cachedConnection: Connection | null = null;
let cachedConfirmChannel: ConfirmChannel | null = null;

const getRabbitMqUrl = (): string => {
  const url = process.env.RABBITMQ_URL?.trim();
  if (!url) {
    throw new Error('RABBITMQ_URL 未配置，无法启动 RabbitMQ 延迟队列');
  }
  return url;
};

const clearCachedRabbitMqState = (): void => {
  cachedConfirmChannel = null;
  cachedConnection = null;
};

export const getRabbitMqConfirmChannel = async (): Promise<ConfirmChannel> => {
  if (cachedConfirmChannel) return cachedConfirmChannel;

  const connection = await amqplib.connect(getRabbitMqUrl());
  connection.on('error', (error) => {
    console.error(`[${RABBITMQ_LOG_SCOPE}] 连接异常:`, error);
    clearCachedRabbitMqState();
  });
  connection.on('close', () => {
    clearCachedRabbitMqState();
  });

  const channel = await connection.createConfirmChannel();
  channel.on('error', (error) => {
    console.error(`[${RABBITMQ_LOG_SCOPE}] channel 异常:`, error);
    cachedConfirmChannel = null;
  });
  channel.on('close', () => {
    cachedConfirmChannel = null;
  });

  cachedConnection = connection;
  cachedConfirmChannel = channel;
  return channel;
};

export const closeRabbitMqConnection = async (): Promise<void> => {
  const channel = cachedConfirmChannel;
  const connection = cachedConnection;
  cachedConfirmChannel = null;
  cachedConnection = null;

  if (channel) {
    await channel.close();
  }
  if (connection) {
    await connection.close();
  }
};
```

- [ ] **Step 2: 仅做类型导入检查**

Run: `rg -n "getRabbitMqConfirmChannel|closeRabbitMqConnection|createConfirmChannel" server/src/services/shared/rabbitMqConnection.ts`

Expected: 能看到连接和关闭函数。

---

### Task 4: RabbitMQ 延迟队列和 DLQ 拓扑

**Files:**
- Create: `server/src/services/shared/marketListingAutoCancelQueue.ts`

- [ ] **Step 1: 创建业务队列模块**

Create `server/src/services/shared/marketListingAutoCancelQueue.ts`:

```ts
/**
 * 物品坊市自动下架 RabbitMQ 队列模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：声明 72 小时延迟队列、到期消费队列和死信队列，并封装消息发布/消费协议。
 * 2. 做什么：把 RabbitMQ exchange / routing key / TTL / DLX 配置集中到单一入口，避免服务层散落队列名。
 * 3. 不做什么：不执行业务下架，不读取数据库，也不决定消息是否幂等成功。
 *
 * 输入/输出：
 * - 输入：listingId、listedAtIso、delayMs。
 * - 输出：发布确认、消费者消息体，以及 ack/nack 操作。
 *
 * 数据流/状态流：
 * marketService 上架成功 -> publishMarketListingAutoCancelMessage 写入 delay queue
 * -> TTL 到期 -> RabbitMQ dead-letter 到 due queue -> worker consume -> ack / reject 到 DLQ。
 *
 * 复用设计说明：
 * - 延迟队列和死信队列的拓扑是高频运维变化点，集中后服务层只关心业务消息。
 * - 当前被 `marketService` 生产者和 `marketListingAutoCancelService` 消费者复用。
 *
 * 关键边界条件与坑点：
 * 1. 延迟队列使用 per-message expiration，必须配合 `x-dead-letter-exchange` 把到期消息投到 due queue。
 * 2. 消费失败时用 `reject(requeue=false)` 进入 DLQ，不能无限 requeue 阻塞队头。
 */
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { getRabbitMqConfirmChannel } from './rabbitMqConnection.js';

export const MARKET_LISTING_AUTO_CANCEL_EXCHANGE = 'market.listing.auto-cancel';
export const MARKET_LISTING_AUTO_CANCEL_DLX = 'market.listing.auto-cancel.dlx';
export const MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE = 'market.listing.auto-cancel.delay';
export const MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE = 'market.listing.auto-cancel.due';
export const MARKET_LISTING_AUTO_CANCEL_DLQ = 'market.listing.auto-cancel.dlq';
export const MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY = 'market.listing.auto-cancel.delay';
export const MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY = 'market.listing.auto-cancel.due';
export const MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY = 'market.listing.auto-cancel.dead';

export type MarketListingAutoCancelMessage = {
  listingId: number;
  listedAtIso: string;
  scheduledAtIso: string;
};

export type MarketListingAutoCancelConsumedMessage = {
  raw: ConsumeMessage;
  payload: MarketListingAutoCancelMessage;
};

const MARKET_LISTING_AUTO_CANCEL_DELAY_MS = 72 * 60 * 60 * 1000;

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getMarketListingAutoCancelDelayMs = (): number => MARKET_LISTING_AUTO_CANCEL_DELAY_MS;

export const getMarketListingAutoCancelPrefetch = (): number => {
  return parsePositiveInteger(process.env.MARKET_LISTING_AUTO_CANCEL_PREFETCH, 8);
};

export const isMarketListingAutoCancelQueueEnabled = (): boolean => {
  const raw = process.env.MARKET_LISTING_AUTO_CANCEL_QUEUE_ENABLED;
  if (raw === undefined) return true;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
};

export const assertMarketListingAutoCancelTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  await channel.assertExchange(MARKET_LISTING_AUTO_CANCEL_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(MARKET_LISTING_AUTO_CANCEL_DLX, 'direct', { durable: true });
  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
      'x-dead-letter-routing-key': MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY,
    },
  });
  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': MARKET_LISTING_AUTO_CANCEL_DLX,
      'x-dead-letter-routing-key': MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY,
    },
  });
  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DLQ, { durable: true });
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE,
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY,
  );
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE,
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY,
  );
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DLQ,
    MARKET_LISTING_AUTO_CANCEL_DLX,
    MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY,
  );
};

export const publishMarketListingAutoCancelMessage = async (params: {
  listingId: number;
  listedAt: Date;
}): Promise<void> => {
  const channel = await getRabbitMqConfirmChannel();
  await assertMarketListingAutoCancelTopology(channel);

  const delayMs = getMarketListingAutoCancelDelayMs();
  const payload: MarketListingAutoCancelMessage = {
    listingId: params.listingId,
    listedAtIso: params.listedAt.toISOString(),
    scheduledAtIso: new Date(params.listedAt.getTime() + delayMs).toISOString(),
  };
  const published = channel.publish(
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY,
    Buffer.from(JSON.stringify(payload), 'utf8'),
    {
      contentType: 'application/json',
      deliveryMode: 2,
      expiration: String(delayMs),
      messageId: `market-listing-auto-cancel:${params.listingId}`,
      timestamp: Math.floor(Date.now() / 1000),
    },
  );
  if (!published) {
    await new Promise<void>((resolve) => channel.once('drain', resolve));
  }
  await channel.waitForConfirms();
};

export const readMarketListingAutoCancelMessage = (
  raw: ConsumeMessage,
): MarketListingAutoCancelMessage | null => {
  const decoded = JSON.parse(raw.content.toString('utf8')) as {
    listingId?: number;
    listedAtIso?: string;
    scheduledAtIso?: string;
  };
  if (!Number.isInteger(decoded.listingId) || decoded.listingId <= 0) return null;
  if (typeof decoded.listedAtIso !== 'string' || !decoded.listedAtIso) return null;
  if (typeof decoded.scheduledAtIso !== 'string' || !decoded.scheduledAtIso) return null;
  return {
    listingId: decoded.listingId,
    listedAtIso: decoded.listedAtIso,
    scheduledAtIso: decoded.scheduledAtIso,
  };
};
```

- [ ] **Step 2: 仅做静态检查**

Run: `rg -n "x-dead-letter-exchange|expiration|waitForConfirms|MARKET_LISTING_AUTO_CANCEL_DLQ" server/src/services/shared/marketListingAutoCancelQueue.ts`

Expected: 能看到延迟队列、DLX、DLQ 和 confirm publish。

---

### Task 5: 上架事务内发布延迟消息

**Files:**
- Modify: `server/src/services/marketService.ts`

- [ ] **Step 1: 引入发布函数**

在 `marketService.ts` import 区加入：

```ts
import { publishMarketListingAutoCancelMessage } from "./shared/marketListingAutoCancelQueue.js";
```

- [ ] **Step 2: 上架事务内写入挂单后发布消息**

在 `createMarketListing` 的 `INSERT INTO market_listing ... RETURNING id` 改成返回 `id, listed_at`，并在事务内等待 RabbitMQ confirm：

```ts
    const listingId = Number(listingResult.rows[0].id);
    const listedAt = new Date(listingResult.rows[0].listed_at);
    await publishMarketListingAutoCancelMessage({
      listingId,
      listedAt,
    });
    await invalidateMarketListingsCache();
    return {
      success: true,
      message: `上架成功，已收取${listingFeeSilver.toString()}银两手续费（未卖出下架将退还）`,
      data: { listingId },
    };
```

注意：这里故意不使用 `afterTransactionCommit`。在不使用 DB outbox 的前提下，RabbitMQ 发布失败必须让上架事务失败并回滚；事务提交失败产生的孤儿消息由消费者幂等 ack，比“挂单成功但没有延迟任务”更可控。

- [ ] **Step 3: 仅做静态检查**

Run: `rg -n "RETURNING id, listed_at|publishMarketListingAutoCancelMessage|listedAt" server/src/services/marketService.ts`

Expected: 能看到事务内使用插入返回的 `listed_at` 发布延迟消息。

---

### Task 6: RabbitMQ 消费服务替换扫描服务

**Files:**
- Replace: `server/src/services/marketListingAutoCancelService.ts`

- [ ] **Step 1: 替换服务实现**

Replace `server/src/services/marketListingAutoCancelService.ts` with:

```ts
/**
 * 物品坊市 RabbitMQ 自动下架消费服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：消费 RabbitMQ 到期消息，触发 72 小时未售出物品挂单自动下架。
 * 2. 做什么：成功或幂等终态 ack，异常失败 reject 到 RabbitMQ DLQ。
 * 3. 不做什么：不扫描数据库发现过期任务，不直接更新 `market_listing`，不复制物品返还逻辑。
 *
 * 输入/输出：
 * - 输入：RabbitMQ due queue 中的 `listingId/listedAtIso/scheduledAtIso`。
 * - 输出：ack / reject，并通过 `marketService.cancelExpiredMarketListing` 产生业务副作用。
 *
 * 数据流/状态流：
 * delay queue 到期 -> due queue -> 本服务 consume -> marketService.cancelExpiredMarketListing
 * -> 成功 ack；已终态 ack；异常 reject(requeue=false) -> RabbitMQ DLQ。
 *
 * 复用设计说明：
 * - 取消逻辑集中复用 `marketService`，避免自动下架另写 SQL、邮件、手续费退款。
 * - RabbitMQ 拓扑集中在 queue 模块，本服务只处理业务消费语义。
 *
 * 关键边界条件与坑点：
 * 1. “已售出/已下架/不存在”是幂等成功，必须 ack，否则旧消息会在 DLQ 中制造噪音。
 * 2. 非幂等异常进入 DLQ 后不自动重排，避免异常挂单持续冲击业务锁。
 */
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { scheduleSafeCharacterUpdate } from '../middleware/pushUpdate.js';
import { marketService } from './marketService.js';
import { getRabbitMqConfirmChannel } from './shared/rabbitMqConnection.js';
import {
  assertMarketListingAutoCancelTopology,
  getMarketListingAutoCancelPrefetch,
  isMarketListingAutoCancelQueueEnabled,
  MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE,
  readMarketListingAutoCancelMessage,
} from './shared/marketListingAutoCancelQueue.js';

const MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE = 'MarketListingAutoCancel';

const IDEMPOTENT_SUCCESS_MESSAGES = new Set([
  '上架记录不存在',
  '该上架记录不可下架',
]);

class MarketListingAutoCancelService {
  private channel: ConfirmChannel | null = null;
  private consumerTag: string | null = null;

  async startConsumer(): Promise<void> {
    if (!isMarketListingAutoCancelQueueEnabled()) {
      console.log(`[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] RabbitMQ 自动下架队列未启用`);
      return;
    }
    if (this.consumerTag) return;

    const channel = await getRabbitMqConfirmChannel();
    await assertMarketListingAutoCancelTopology(channel);
    channel.prefetch(getMarketListingAutoCancelPrefetch());

    const consumeResult = await channel.consume(
      MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE,
      (message) => {
        if (!message) return;
        void this.handleMessage(channel, message);
      },
      { noAck: false },
    );

    this.channel = channel;
    this.consumerTag = consumeResult.consumerTag;
    console.log(`[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] RabbitMQ 消费者已启动`);
  }

  async stopConsumer(): Promise<void> {
    if (!this.channel || !this.consumerTag) return;
    await this.channel.cancel(this.consumerTag);
    this.consumerTag = null;
  }

  private async handleMessage(
    channel: ConfirmChannel,
    message: ConsumeMessage,
  ): Promise<void> {
    const payload = readMarketListingAutoCancelMessage(message);
    if (!payload) {
      channel.reject(message, false);
      return;
    }

    try {
      const result = await marketService.cancelExpiredMarketListing({
        listingId: payload.listingId,
        now: new Date(payload.scheduledAtIso),
      });
      if (result.success) {
        scheduleSafeCharacterUpdate(result.sellerUserId);
        channel.ack(message);
        return;
      }
      if (IDEMPOTENT_SUCCESS_MESSAGES.has(result.message)) {
        channel.ack(message);
        return;
      }

      console.error(
        `[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] 自动下架失败，进入 DLQ: listingId=${payload.listingId}, message=${result.message}`,
      );
      channel.reject(message, false);
    } catch (error) {
      console.error(
        `[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] 自动下架异常，进入 DLQ: listingId=${payload.listingId}`,
        error,
      );
      channel.reject(message, false);
    }
  }
}

export const marketListingAutoCancelService = new MarketListingAutoCancelService();
```

- [ ] **Step 2: 仅做静态检查**

Run: `rg -n "startConsumer|channel\\.ack|channel\\.reject|FROM market_listing|listed_at <=" server/src/services/marketListingAutoCancelService.ts`

Expected: 有 `startConsumer/ack/reject`；没有 DB 扫描 SQL。

---

### Task 7: Worker 启动接入，移除 cleanup 定时任务

**Files:**
- Create: `server/src/workers/marketListingAutoCancelWorker.ts`
- Modify: `server/src/workers/cleanupWorker.ts`
- Modify: `server/src/bootstrap/startupPipeline.ts`

- [ ] **Step 1: 新建 worker 包装入口**

Create `server/src/workers/marketListingAutoCancelWorker.ts`:

```ts
/**
 * 物品坊市自动下架 worker 入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：给启动管线提供 RabbitMQ 自动下架消费者的启动/停止入口。
 * 2. 做什么：隔离 worker 生命周期，避免 startupPipeline 直接依赖业务 service 细节。
 * 3. 不做什么：不声明 RabbitMQ 拓扑，不处理单条消息，不执行下架业务。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：启动或停止 RabbitMQ 消费者。
 *
 * 数据流/状态流：
 * startupPipeline(worker role) -> startMarketListingAutoCancelWorker -> marketListingAutoCancelService.startConsumer。
 *
 * 复用设计说明：
 * - 和 cleanupWorker、idle worker 一样保留 worker 层入口，后续停机管理或 runtime role 调整不需要改业务 service。
 *
 * 关键边界条件与坑点：
 * 1. 只在 worker runtime 启动，避免 API 实例同时消费自动下架任务。
 * 2. 停止时只取消 consumer，不关闭全局 RabbitMQ 连接，避免影响同进程其他 RabbitMQ 业务。
 */
import { marketListingAutoCancelService } from '../services/marketListingAutoCancelService.js';

export const startMarketListingAutoCancelWorker = async (): Promise<void> => {
  await marketListingAutoCancelService.startConsumer();
};

export const stopMarketListingAutoCancelWorker = async (): Promise<void> => {
  await marketListingAutoCancelService.stopConsumer();
};
```

- [ ] **Step 2: 从 cleanupWorker 移除自动下架任务**

在 `server/src/workers/cleanupWorker.ts` 删除：

```ts
import { marketListingAutoCancelService } from '../services/marketListingAutoCancelService.js';
```

删除 `marketListingAutoCancelSchedule` 变量，删除 `market-listing-auto-cancel` job，删除日志分支。

- [ ] **Step 3: 启动管线接入 worker role**

在 `server/src/bootstrap/startupPipeline.ts` 引入：

```ts
import { startMarketListingAutoCancelWorker } from "../workers/marketListingAutoCancelWorker.js";
```

在只启动 worker 后台任务的位置增加：

```ts
  await runStartupStep("物品坊市自动下架 RabbitMQ 消费者", startMarketListingAutoCancelWorker);
```

必须放在 `shouldStartScheduledBackgroundServices(runtimeRole)` 分支内，不能让 API 实例消费。

- [ ] **Step 4: 仅做静态检查**

Run: `rg -n "startMarketListingAutoCancelWorker|market-listing-auto-cancel|marketListingAutoCancelService" server/src/bootstrap/startupPipeline.ts server/src/workers/cleanupWorker.ts server/src/workers/marketListingAutoCancelWorker.ts`

Expected: `startupPipeline` 和新 worker 有启动入口；`cleanupWorker` 无自动下架引用。

---

### Task 8: 静态策略测试更新

**Files:**
- Create: `server/src/services/__tests__/marketListingAutoCancelRabbitMqPolicy.test.ts`
- Modify: `server/src/services/__tests__/marketListingRulesPolicy.test.ts`

- [ ] **Step 1: 新增 RabbitMQ 策略测试**

Create `server/src/services/__tests__/marketListingAutoCancelRabbitMqPolicy.test.ts`:

```ts
/**
 * 物品坊市 RabbitMQ 自动下架策略静态测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定自动下架必须使用 RabbitMQ 延迟队列和 DLQ，而不是 DB 扫描或数据库死信表。
 * 2. 做什么：锁定上架事务内发布延迟消息，避免 RabbitMQ 发布失败后仍留下不会自动下架的挂单。
 * 3. 不做什么：不连接 RabbitMQ，不执行真实消费，不验证 broker 运维配置。
 *
 * 输入/输出：
 * - 输入：队列模块、坊市服务、消费服务、启动管线源码文本。
 * - 输出：静态断言。
 *
 * 数据流/状态流：
 * 源码文本 -> 匹配 RabbitMQ 拓扑、发布时机、消费 ack/reject 和启动入口 -> 断言主路径实时队列化。
 *
 * 复用设计说明：
 * - 把“不能退回 DB 扫描”的架构规则集中在一个测试文件，避免后续清理任务改动时重新引入轮询主路径。
 *
 * 关键边界条件与坑点：
 * 1. 静态测试不能证明 RabbitMQ broker 已安装，只能保护代码结构。
 * 2. 若队列名或启动函数重命名，必须同步更新本测试。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('RabbitMQ 拓扑应包含延迟队列、到期队列和 DLQ', () => {
  const source = readSource('../shared/marketListingAutoCancelQueue.ts');

  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_EXCHANGE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DLQ/u);
  assert.match(source, /'x-dead-letter-exchange'/u);
  assert.match(source, /expiration: String\(delayMs\)/u);
  assert.match(source, /waitForConfirms/u);
});

test('物品上架事务内必须发布自动下架延迟消息', () => {
  const source = readSource('../marketService.ts');

  assert.match(source, /publishMarketListingAutoCancelMessage/u);
  assert.match(
    source,
    /RETURNING id, listed_at[\s\S]*?const listingId = Number\(listingResult\.rows\[0\]\.id\);[\s\S]*?publishMarketListingAutoCancelMessage/u,
  );
  assert.doesNotMatch(source, /afterTransactionCommit\(async \(\) => \{[\s\S]*?publishMarketListingAutoCancelMessage/u);
});

test('自动下架消费者不应扫描 DB，应通过 ack 和 reject 进入 RabbitMQ DLQ', () => {
  const source = readSource('../marketListingAutoCancelService.ts');

  assert.match(source, /startConsumer/u);
  assert.match(source, /marketService\.cancelExpiredMarketListing/u);
  assert.match(source, /channel\.ack\(message\)/u);
  assert.match(source, /channel\.reject\(message, false\)/u);
  assert.doesNotMatch(source, /SELECT[\s\S]*FROM market_listing[\s\S]*listed_at/u);
});

test('自动下架消费者只能通过 worker 启动管线接入', () => {
  const startupSource = readSource('../../bootstrap/startupPipeline.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');

  assert.match(startupSource, /startMarketListingAutoCancelWorker/u);
  assert.doesNotMatch(cleanupWorkerSource, /marketListingAutoCancelService/u);
});
```

- [ ] **Step 2: 精简旧规则测试**

保留 `marketListingRulesPolicy.test.ts` 中：

- 规则常量集中测试。
- 上架 quota 测试。
- 公开列表/购买过期拦截测试。
- RabbitMQ 自动下架结构测试。

删除所有 `market_listing_auto_cancel_dead_letter`、`marketListingAutoCancelDeadLetter` 相关断言。

- [ ] **Step 3: 仅做静态检查**

Run: `rg -n "market_listing_auto_cancel_dead_letter|marketListingAutoCancelDeadLetter|SELECT[\\s\\S]*FROM market_listing[\\s\\S]*listed_at" server/src/services/__tests__ server/src/services/marketListingAutoCancelService.ts`

Expected: 无 DB 死信表引用；消费者没有 DB 扫描。

---

### Task 9: 类型校验和收口检查

**Files:**
- All modified files.

- [ ] **Step 1: 检查 RabbitMQ 依赖安装状态**

Run: `pnpm install --lockfile-only --filter ./server`

Expected: `pnpm-lock.yaml` 更新且没有启动项目。

If the user does not permit dependency install commands in the current execution context, stop and report that lockfile cannot be updated.

- [ ] **Step 2: 执行 TypeScript 构建校验**

Run: `pnpm exec tsc -b`

Expected: 成功，无输出。

- [ ] **Step 3: 最终静态检查**

Run: `rg -n "market_listing_auto_cancel_dead_letter|marketListingAutoCancelDeadLetter" server`

Expected: 无输出。

Run: `rg -n "publishMarketListingAutoCancelMessage|startMarketListingAutoCancelWorker|MARKET_LISTING_AUTO_CANCEL_DLQ|channel\\.reject\\(message, false\\)" server/src`

Expected: 能看到发布、worker 启动、DLQ 和 reject。

---

## Self-Review

- Spec coverage: 覆盖方案 1 RabbitMQ 延迟队列、DLQ、上架后实时投递、消费者到期下架、幂等 ack、异常 reject 到 DLQ、移除 DB 死信表半成品。
- Placeholder scan: 本计划没有 TBD/TODO/implement later；每个新增模块给出完整代码骨架。
- Type consistency: `publishMarketListingAutoCancelMessage`、`startMarketListingAutoCancelWorker`、`marketListingAutoCancelService.startConsumer`、`cancelExpiredMarketListing` 名称在任务间一致。

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-05-16-market-auto-cancel-rabbitmq.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
