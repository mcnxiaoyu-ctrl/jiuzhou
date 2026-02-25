import type { Server as HttpServer } from 'http';
import { testConnection, pool } from '../config/database.js';
import { closeRedis, testRedisConnection } from '../config/redis.js';
import { initTables } from '../models/initTables.js';
import { initGameTimeService } from '../services/gameTimeService.js';
import { recoverBattlesFromRedis } from '../domains/battle/index.js';
import { cleanupUndefinedItemDataOnStartup } from '../services/itemDataCleanupService.js';
import { recoverActiveIdleSessions, flushAllBuffers } from '../services/idle/idleBattleExecutor.js';

export interface StartServerOptions {
  httpServer: HttpServer;
  host: string;
  port: number;
}

/**
 * 服务启动流水线（连接检查 -> 表初始化 -> 启动恢复 -> 监听端口）
 */
export const startServerWithPipeline = async (options: StartServerOptions): Promise<void> => {
  console.log('\n🎮 九州修仙录 服务启动中...\n');

  const dbConnected = await testConnection();
  if (!dbConnected) {
    throw new Error('数据库连接失败，服务启动终止');
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    console.warn('⚠ Redis 连接失败，战斗状态将不会持久化');
  }

  await initTables();
  await cleanupUndefinedItemDataOnStartup();
  await initGameTimeService();

  if (redisConnected) {
    console.log('正在恢复战斗状态...');
    await recoverBattlesFromRedis();
  }

  await recoverActiveIdleSessions();

  await new Promise<void>((resolve, reject) => {
    options.httpServer.listen(options.port, options.host, () => {
      console.log(`🚀 服务已启动: http://${options.host}:${options.port} (或 http://localhost:${options.port})\n`);
      resolve();
    });
    options.httpServer.once('error', reject);
  });
};

/**
 * 注册优雅关闭信号处理。
 */
export const registerGracefulShutdown = (httpServer: HttpServer): void => {
  const gracefulShutdown = async (signal: string): Promise<void> => {
    console.log(`\n收到 ${signal} 信号，开始优雅关闭...`);

    httpServer.close(() => {
      console.log('HTTP 服务已关闭');
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await closeRedis();
      console.log('Redis 连接已关闭');
    } catch (error) {
      console.error('关闭 Redis 连接失败:', error);
    }

    await flushAllBuffers();

    try {
      await pool.end();
      console.log('数据库连接池已关闭');
    } catch (error) {
      console.error('关闭数据库连接池失败:', error);
    }

    console.log('服务已关闭');
    process.exit(0);
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
};

