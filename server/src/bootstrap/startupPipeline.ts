import type { Server as HttpServer } from "http";
import { cpus } from "os";
import { testConnection, pool } from "../config/database.js";
import { closeRedis, testRedisConnection } from "../config/redis.js";
import { initTables } from "../models/initTables.js";
import {
  initGameTimeService,
  stopGameTimeService,
} from "../services/gameTimeService.js";
import { recoverBattlesFromRedis } from "../domains/battle/index.js";
import { itemDataCleanupService } from "../services/itemDataCleanupService.js";
import { clearAllAvatarsOnce } from "./clearAvatars.js";
import {
  recoverActiveIdleSessions,
  flushAllBuffers,
  stopAllExecutionLoops,
} from "../services/idle/idleBattleExecutorWorker.js";
import {
  initArenaWeeklySettlementService,
  stopArenaWeeklySettlementService,
} from "../services/arenaWeeklySettlementService.js";
import { stopBattleService } from "../services/battle/index.js";
import {
  startCleanupWorker,
  stopCleanupWorker,
} from "../workers/cleanupWorker.js";
import {
  startMarketListingAutoCancelWorker,
  stopMarketListingAutoCancelWorker,
} from "../workers/marketListingAutoCancelWorker.js";
import {
  initializeWorkerPool,
  shutdownWorkerPool,
} from "../workers/workerPool.js";
import {
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
} from "../services/staticConfigLoader.js";
import {
  initializeTechniqueGenerationJobRunner,
  shutdownTechniqueGenerationJobRunner,
} from "../services/techniqueGenerationJobRunner.js";
import {
  initializePartnerRecruitJobRunner,
  shutdownPartnerRecruitJobRunner,
} from "../services/partnerRecruitJobRunner.js";
import {
  initializePartnerFusionJobRunner,
  shutdownPartnerFusionJobRunner,
} from "../services/partnerFusionJobRunner.js";
import {
  initializePartnerReboneJobRunner,
  shutdownPartnerReboneJobRunner,
} from "../services/partnerReboneJobRunner.js";
import {
  initializeWanderJobRunner,
  shutdownWanderJobRunner,
} from "../services/wanderJobRunner.js";
import {
  warmupOnlineBattleProjectionService,
} from "../services/onlineBattleProjectionService.js";
import {
  recoverBattleSessionsFromProjection,
} from "../services/battleSession/index.js";
import { warmupFrozenTowerPoolCache } from "../services/tower/frozenPool.js";
import { dungeonExpiredInstanceCleanupService } from "../services/dungeonExpiredInstanceCleanupService.js";
import {
  initializeOnlineBattleSettlementRunner,
  shutdownOnlineBattleSettlementRunner,
} from "../services/onlineBattleSettlementRunner.js";
import { getGameServer } from "../game/gameServer.js";
import {
  initializeAfdianMessageRetryService,
  stopAfdianMessageRetryService,
} from "../services/afdianMessageRetryService.js";
import { ensurePerformanceIndexes } from "../services/shared/performanceIndexes.js";
import {
  initializeRankSnapshotNightlyRefreshScheduler,
  stopRankSnapshotNightlyRefreshScheduler,
} from "../services/rankSnapshotNightlyRefreshScheduler.js";
import {
  initializeCharacterSettlementResourceDeltaService,
  shutdownCharacterSettlementResourceDeltaService,
} from "../services/shared/characterSettlementResourceDeltaService.js";
import {
  initializeCharacterItemGrantDeltaService,
  shutdownCharacterItemGrantDeltaService,
} from "../services/shared/characterItemGrantDeltaService.js";
import {
  initializeCharacterItemInstanceMutationService,
  shutdownCharacterItemInstanceMutationService,
} from "../services/shared/characterItemInstanceMutationService.js";
import {
  initializeTaskProgressDeltaFlushService,
  shutdownTaskProgressDeltaFlushService,
} from "../services/taskService.js";
import {
  initializeEventLoopMonitor,
  stopEventLoopMonitor,
} from "../services/eventLoopMonitorService.js";
import { closeRabbitMqConnection } from "../services/shared/rabbitMqConnection.js";
import {
  resolveJiuzhouRuntimeRole,
  shouldRecoverHttpBattleState,
  shouldRecoverIdleSessions,
  shouldStartScheduledBackgroundServices,
  shouldStartHttpServer,
  shouldStartOnlineSettlementRunner,
  shouldStartRequestBoundJobWorkers,
  shouldStartWorkerPool,
} from "../config/runtimeRole.js";

export interface StartServerOptions {
  httpServer: HttpServer;
  host: string;
  port: number;
}

const formatStepDuration = (durationMs: number): string => {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(2)}s`;
};

const runStartupStep = async <T>(
  label: string,
  task: () => Promise<T>,
): Promise<T> => {
  const startAt = Date.now();
  console.log(`→ ${label}`);
  const result = await task();
  console.log(`✓ ${label}（耗时 ${formatStepDuration(Date.now() - startAt)}）`);
  return result;
};

/**
 * 服务启动流水线
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按运行角色串联数据库/Redis 检查、静态配置预热、后台服务启动、状态恢复、HTTP 监听和优雅关闭。
 * 2. 做什么：集中管理 worker 角色专属后台能力，包括 cleanup worker、在线战斗延迟结算和坊市自动下架 RabbitMQ 消费者。
 * 3. 不做什么：不实现具体业务逻辑，不直接消费 RabbitMQ 消息，也不在这里拼装 SQL 或请求参数。
 *
 * 输入 / 输出：
 * - 输入：HTTP server、host、port，以及 `JIUZHOU_RUNTIME_ROLE` 等运行环境变量。
 * - 输出：启动时完成必要初始化；关闭时按顺序停止后台任务、刷写缓冲区并关闭外部连接。
 *
 * 数据流 / 状态流：
 * runtimeRole -> guard helper -> 启动对应服务 -> registerGracefulShutdown -> stop worker/service -> close RabbitMQ/Redis/PostgreSQL。
 *
 * 复用设计说明：
 * - 启动/关闭顺序是进程级共享规则，集中在这里避免 API 角色、worker 角色和未来后台服务各自散写生命周期。
 * - 具体能力通过启动/停止函数接入，startupPipeline 只负责编排，减少和业务 service 的直接耦合。
 *
 * 关键边界条件与坑点：
 * 1. 只有 worker/all 角色能启动独立后台消费者，API 角色不能消费 RabbitMQ 自动下架任务。
 * 2. 关闭时必须先停消费者再关 RabbitMQ 连接，并且 RabbitMQ 要在 Redis/数据库连接池之前关闭。
 */
export const startServerWithPipeline = async (
  options: StartServerOptions,
): Promise<void> => {
  console.log("\n🎮 九州修仙录 服务启动中...\n");
  const runtimeRole = resolveJiuzhouRuntimeRole();
  console.log(`运行角色: ${runtimeRole}`);

  const dbConnected = await testConnection();
  if (!dbConnected) {
    throw new Error("数据库连接失败，服务启动终止");
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    console.warn("⚠ Redis 连接失败，战斗状态将不会持久化");
  }

  await runStartupStep("生成功法快照刷新", refreshGeneratedTechniqueSnapshots);
  await runStartupStep("动态伙伴快照失效", refreshGeneratedPartnerSnapshots);
  await runStartupStep("数据准备", initTables);
  await runStartupStep("性能索引同步", ensurePerformanceIndexes);
  if (shouldStartScheduledBackgroundServices(runtimeRole)) {
    await runStartupStep("角色资源 Delta 聚合器初始化", initializeCharacterSettlementResourceDeltaService);
    await runStartupStep("角色物品授予 Delta 聚合器初始化", initializeCharacterItemGrantDeltaService);
    await runStartupStep("角色实例 Mutation 聚合器初始化", initializeCharacterItemInstanceMutationService);
    await runStartupStep("角色软进度 Delta 聚合器初始化", initializeTaskProgressDeltaFlushService);
  }
  await runStartupStep("头像清理检查", clearAllAvatarsOnce);
  await runStartupStep("异常物品数据清理", () => itemDataCleanupService.cleanupUndefinedItemDataOnStartup());

  if (shouldStartWorkerPool(runtimeRole)) {
    // 初始化 Worker 池
    console.log("正在初始化 Worker 池...");
    const cpuCount = cpus().length;
    const workerCount = process.env.IDLE_WORKER_COUNT
      ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
      : Math.max(1, cpuCount - 1);

    console.log(`  - CPU 核心数: ${cpuCount}，启动 ${workerCount} 个 Worker`);
    console.log("  - 挂机战斗怪物解析复用普通战斗服务配置");

    await runStartupStep("Worker 池初始化", () =>
      initializeWorkerPool({
        workerCount,
      }),
    );
    console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）\n`);
  }
  if (shouldStartRequestBoundJobWorkers(runtimeRole)) {
    await runStartupStep("洞府研修 worker 协调器初始化", initializeTechniqueGenerationJobRunner);
    console.log("✓ 洞府研修 worker 协调器已就绪\n");
    await runStartupStep("AI 伙伴招募 worker 协调器初始化", initializePartnerRecruitJobRunner);
    console.log("✓ AI 伙伴招募 worker 协调器已就绪\n");
    await runStartupStep("三魂归契 worker 协调器初始化", initializePartnerFusionJobRunner);
    console.log("✓ 三魂归契 worker 协调器已就绪\n");
    await runStartupStep("归元洗髓 worker 协调器初始化", initializePartnerReboneJobRunner);
    console.log("✓ 归元洗髓 worker 协调器已就绪\n");
    await runStartupStep("云游奇遇 worker 协调器初始化", initializeWanderJobRunner);
    console.log("✓ 云游奇遇 worker 协调器已就绪\n");
  }
  const expiredDungeonCleanupSummary = await runStartupStep(
    "过期秘境实例收口",
    () => dungeonExpiredInstanceCleanupService.runCleanupOnce(),
  );
  console.log(
    `✓ 过期秘境实例已收口（preparing ${expiredDungeonCleanupSummary.abandonedPreparingCount} / running ${expiredDungeonCleanupSummary.abandonedRunningCount} / 结算保护 ${expiredDungeonCleanupSummary.protectedInstanceCount}）\n`,
  );
  const frozenTowerPoolSummary = await runStartupStep(
    "千层塔冻结怪物池预热",
    warmupFrozenTowerPoolCache,
  );
  console.log(
    `✓ 千层塔冻结怪物池已预热（冻结前沿 ${frozenTowerPoolSummary.frontier.frozenFloorMax}）\n`,
  );
  const onlineBattleWarmupSummary = await runStartupStep(
    "在线战斗投影预热",
    warmupOnlineBattleProjectionService,
  );
  console.log(
    `✓ 在线战斗投影已预热（活跃角色 ${onlineBattleWarmupSummary.characterCount} / 竞技场 ${onlineBattleWarmupSummary.arenaCount} / 秘境 ${onlineBattleWarmupSummary.dungeonCount} / 千层塔 ${onlineBattleWarmupSummary.towerCount}）\n`,
  );
  if (shouldStartOnlineSettlementRunner(runtimeRole)) {
    await runStartupStep("在线战斗延迟结算协调器初始化", initializeOnlineBattleSettlementRunner);
    console.log("✓ 在线战斗延迟结算协调器已就绪\n");
  }
  await runStartupStep("事件循环监控初始化", initializeEventLoopMonitor);
  console.log("✓ 事件循环监控已就绪\n");
  if (shouldStartScheduledBackgroundServices(runtimeRole)) {
    await runStartupStep("爱发电私信重试调度器初始化", initializeAfdianMessageRetryService);
    console.log("✓ 爱发电私信重试调度器已就绪\n");
    await runStartupStep("角色排行榜快照夜间刷新调度器初始化", initializeRankSnapshotNightlyRefreshScheduler);
    console.log("✓ 角色排行榜快照夜间刷新调度器已就绪\n");

    await runStartupStep("游戏时间服务初始化", initGameTimeService);
    await runStartupStep("竞技场周结算服务初始化", async () => {
      initArenaWeeklySettlementService();
    });
    await runStartupStep("清理 Worker 启动", async () => {
      await startCleanupWorker();
    });
    await runStartupStep("坊市自动下架 RabbitMQ Worker 启动", async () => {
      await startMarketListingAutoCancelWorker();
    });
  }

  if (shouldRecoverHttpBattleState(runtimeRole) && redisConnected) {
    await runStartupStep("战斗状态恢复", async () => {
      console.log("正在恢复战斗状态...");
      await recoverBattlesFromRedis();
    });
    await runStartupStep("战斗会话恢复", async () => {
      const recoveredSessionCount = await recoverBattleSessionsFromProjection();
      console.log(`✓ 已恢复 ${recoveredSessionCount} 条战斗会话`);
    });
  }

  if (shouldRecoverIdleSessions(runtimeRole)) {
    await runStartupStep("挂机会话恢复", recoverActiveIdleSessions);
  }

  if (shouldStartHttpServer(runtimeRole)) {
    await new Promise<void>((resolve, reject) => {
      options.httpServer.listen(options.port, options.host, () => {
        console.log(
          `🚀 服务已启动: http://${options.host}:${options.port} (或 http://localhost:${options.port})\n`,
        );
        resolve();
      });
      options.httpServer.once("error", reject);
    });
  } else {
    console.log("✓ Worker 角色不监听 HTTP 端口\n");
  }
};

/**
 * 注册优雅关闭信号处理。
 */
export const registerGracefulShutdown = (httpServer: HttpServer): void => {
  let shutdownPromise: Promise<void> | null = null;

  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

      // 1. 停止接受新请求
      httpServer.close(() => {
        console.log("✓ HTTP 服务已关闭");
      });

      await getGameServer().shutdown();
      console.log("✓ 游戏 Socket 服务已关闭");

      // 2. 停止所有后台任务和定时器
      console.log("正在停止后台服务...");

      stopEventLoopMonitor();
      console.log("✓ 事件循环监控已停止");

      await stopGameTimeService();
      console.log("✓ 游戏时间服务已停止");

      stopArenaWeeklySettlementService();
      console.log("✓ 竞技场结算服务已停止");

      stopCleanupWorker();
      console.log("✓ 清理 Worker 已停止");

      await stopMarketListingAutoCancelWorker();
      console.log("✓ 坊市自动下架 RabbitMQ Worker 已停止");

      stopBattleService();
      console.log("✓ 战斗服务已停止");

      stopAllExecutionLoops();
      console.log("✓ 挂机执行循环已停止");

      // 3. 关闭 Worker 池
      await shutdownTechniqueGenerationJobRunner();
      console.log("✓ 洞府研修 worker 协调器已关闭");

      await shutdownPartnerRecruitJobRunner();
      console.log("✓ AI 伙伴招募 worker 协调器已关闭");

      await shutdownPartnerFusionJobRunner();
      console.log("✓ 三魂归契 worker 协调器已关闭");

      await shutdownPartnerReboneJobRunner();
      console.log("✓ 归元洗髓 worker 协调器已关闭");

      await shutdownWanderJobRunner();
      console.log("✓ 云游奇遇 worker 协调器已关闭");

      await shutdownOnlineBattleSettlementRunner();
      console.log("✓ 在线战斗延迟结算协调器已关闭");

      stopAfdianMessageRetryService();
      console.log("✓ 爱发电私信重试调度器已关闭");

      stopRankSnapshotNightlyRefreshScheduler();
      console.log("✓ 角色排行榜快照夜间刷新调度器已关闭");

      await shutdownWorkerPool();
      console.log("✓ Worker 池已关闭");

      // 4. 等待现有操作完成（给一点时间让正在执行的操作完成）
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 5. 刷新所有缓冲区
      await flushAllBuffers();
      console.log("✓ 挂机缓冲区已刷写");

      await shutdownCharacterSettlementResourceDeltaService();
      console.log("✓ 角色资源 Delta 聚合器已停止");

      await shutdownCharacterItemGrantDeltaService();
      console.log("✓ 角色物品授予 Delta 聚合器已停止");

      await shutdownCharacterItemInstanceMutationService();
      console.log("✓ 角色实例 Mutation 聚合器已停止");

      await shutdownTaskProgressDeltaFlushService();
      console.log("✓ 角色软进度 Delta 聚合器已停止");

      // 6. 关闭外部连接
      await closeRabbitMqConnection();
      console.log("✓ RabbitMQ 连接已关闭");

      await closeRedis();
      console.log("✓ Redis 连接已关闭");

      await pool.end();
      console.log("✓ 数据库连接池已关闭");

      console.log("✓ 服务已完全关闭");
      process.exit(0);
    })();

    await shutdownPromise;
  };

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
};
