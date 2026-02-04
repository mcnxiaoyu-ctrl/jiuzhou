/**
 * Redis 客户端配置
 */

import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 创建 Redis 客户端
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

redis.on('connect', () => {
  console.log('✓ Redis 连接成功');
});

redis.on('error', (err) => {
  console.error('✗ Redis 连接错误:', err.message);
});

redis.on('close', () => {
  console.log('Redis 连接已关闭');
});

/**
 * 测试 Redis 连接
 */
export const testRedisConnection = async (): Promise<boolean> => {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error('Redis 连接测试失败:', error);
    return false;
  }
};

/**
 * 关闭 Redis 连接
 */
export const closeRedis = async (): Promise<void> => {
  await redis.quit();
};
