/**
 * 秘境服务类
 *
 * 作用：将秘境各子模块的函数包装为 class 方法，支持 @Transactional 装饰器。
 * 不做什么：不包含业务逻辑，仅委托调用。
 *
 * 数据流：读方法直接委托，写方法通过 @Transactional 保证事务原子性。
 *
 * 边界条件：
 * 1) joinDungeonInstance / startDungeonInstance / nextDungeonInstance 使用 @Transactional 保证事务原子性。
 * 2) 其他方法直接委托给对应独立函数。
 */

import { Transactional } from '../../decorators/transactional.js';
import {
  getDungeonCategories,
  getDungeonList,
  getDungeonPreview,
} from './definitions.js';
import {
  createDungeonInstance,
  joinDungeonInstance,
  getDungeonInstance,
} from './instance.js';
import {
  startDungeonInstance,
  nextDungeonInstance,
} from './combat.js';

class DungeonService {
  async getDungeonCategories() {
    return getDungeonCategories();
  }

  async getDungeonList(params: Parameters<typeof getDungeonList>[0]) {
    return getDungeonList(params);
  }

  async getDungeonPreview(dungeonId: string, difficultyRank?: number, userId?: number) {
    return getDungeonPreview(dungeonId, difficultyRank, userId);
  }

  async createDungeonInstance(userId: number, dungeonId: string, difficultyRank: number) {
    return createDungeonInstance(userId, dungeonId, difficultyRank);
  }

  @Transactional
  async joinDungeonInstance(userId: number, instanceId: string) {
    return joinDungeonInstance(userId, instanceId);
  }

  async getDungeonInstance(userId: number, instanceId: string) {
    return getDungeonInstance(userId, instanceId);
  }

  @Transactional
  async startDungeonInstance(userId: number, instanceId: string) {
    return startDungeonInstance(userId, instanceId);
  }

  @Transactional
  async nextDungeonInstance(userId: number, instanceId: string) {
    return nextDungeonInstance(userId, instanceId);
  }
}

export const dungeonService = new DungeonService();
