/**
 * 秘境结算空名单告警回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“开战时显式固化的可领奖名单为空”属于合法无收益场景，推进结算时不应输出异常告警。
 * 2. 做什么：覆盖秘境免体力模式导致全员无奖励时的日志行为，避免正常流程持续刷 `WARN`。
 * 3. 不做什么：不验证真实 Redis/数据库落库，也不覆盖奖励内容分发细节。
 *
 * 输入/输出：
 * - 输入：running 中的秘境投影、显式空的 `rewardEligibleCharacterIds`、以及战斗已胜利的状态。
 * - 输出：`nextDungeonInstance` 成功进入 cleared，且不会调用 `dungeon.combat.warn`。
 *
 * 数据流/状态流：
 * - nextDungeonInstance 读取秘境投影
 * -> 复用 rewardEligibility 共享筛选工具解析显式空名单
 * -> 直接进入通关同步结算分支
 * -> 同步调用秘境真实结算服务，不输出“名单为空”的异常告警。
 *
 * 关键边界条件与坑点：
 * 1. 这里的空名单是“开战时明确固化为空”，不是字段缺失；测试要锁定这两者不能混为一谈。
 * 2. combat.ts 在模块加载时就会创建 scoped logger，所以必须先 mock logger 再动态导入被测模块，避免拿到真实 logger。
 */

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import * as battleService from '../battle/index.js';
import * as participantHelpers from '../dungeon/shared/participants.js';
import * as projectionService from '../onlineBattleProjectionService.js';
import * as stageData from '../dungeon/shared/stageData.js';
import * as dungeonSettlementService from '../dungeon/settlement.js';
import * as slowOperationLogger from '../../utils/slowOperationLogger.js';
import * as logger from '../../utils/logger.js';
import type { CharacterComputedRow } from '../characterComputedService.js';
import type { CharacterBattleLoadout } from '../battle/shared/profileCache.js';
import type {
  DungeonProjectionRecord,
  OnlineBattleCharacterSnapshot,
} from '../onlineBattleProjectionService.js';

const createSnapshot = (characterId: number, userId: number): OnlineBattleCharacterSnapshot => ({
  characterId,
  userId,
  computed: {
    nickname: '青玄',
    realm: '炼精化炁',
    sub_realm: '养气期',
    fuyuan: 1,
    dungeon_no_stamina_cost: true,
  } as CharacterComputedRow,
  loadout: {
    setBonusEffects: [],
    skills: [],
  } as CharacterBattleLoadout,
  activePartner: null,
  teamId: null,
  isTeamLeader: true,
});

test('nextDungeonInstance: 显式空可领奖名单时不应输出异常告警', async (t) => {
  const instanceId = 'dungeon-instance-empty-reward-eligible-list';
  const battleId = 'dungeon-battle-empty-reward-eligible-list';
  const creatorCharacterId = 1001;
  let dungeonCombatLogOutput = '';
  const dungeonCombatLogDestination = new Writable({
    write: (chunk, _encoding, callback) => {
      dungeonCombatLogOutput += String(chunk);
      callback();
    },
  });

  t.mock.method(logger, 'createScopedLogger', (scope: string) => {
    return logger.createLogger({
      scope,
      destination: scope === 'dungeon.combat'
        ? dungeonCombatLogDestination
        : new Writable({
            write: (_chunk, _encoding, callback) => {
              callback();
            },
          }),
    });
  });
  t.mock.method(slowOperationLogger, 'createSlowOperationLogger', () => ({
    mark: () => {},
    flush: () => {},
  }));

  const { nextDungeonInstance } = await import('../dungeon/combat.js');

  t.mock.method(participantHelpers, 'getUserAndCharacter', async (userId: number) => {
    assert.equal(userId, 1);
    return {
      ok: true as const,
      userId,
      characterId: creatorCharacterId,
      realm: '炼精化炁·养气期',
      teamId: null,
      isLeader: true,
    };
  });

  let updatedStatus = '';
  let dungeonClearSettled = false;

  t.mock.method(projectionService, 'getDungeonProjection', async (requestInstanceId: string) => {
    assert.equal(requestInstanceId, instanceId);
    return {
      instanceId,
      dungeonId: 'dungeon-test',
      difficultyId: 'difficulty-test',
      difficultyRank: 1,
      creatorCharacterId,
      teamId: null,
      status: 'running' as const,
      currentStage: 1,
      currentWave: 1,
      participants: [{ userId: 1, characterId: creatorCharacterId, role: 'leader' as const }],
      currentBattleId: battleId,
      rewardEligibleCharacterIds: [],
      startTime: '2026-03-25T06:20:00.000Z',
      endTime: null,
    };
  });

  t.mock.method(battleService, 'getBattleState', async (requestBattleId: string) => {
    assert.equal(requestBattleId, battleId);
    return {
      success: true as const,
      data: {
        result: 'attacker_win',
        logs: [],
        stats: {
          attacker: {
            damageDealt: 12,
          },
        },
      },
    };
  });

  t.mock.method(stageData, 'getStageAndWave', async (_difficultyId: string, stage: number, wave: number) => {
    assert.equal(stage, 1);
    assert.equal(wave, 1);
    return {
      ok: true as const,
      stageCount: 1,
      maxWaveIndexInStage: 1,
      wave: {
        monsters: [{ monster_def_id: 'monster-a', count: 1 }],
      },
    };
  });

  t.mock.method(projectionService, 'upsertDungeonProjection', async (projection: DungeonProjectionRecord) => {
    updatedStatus = projection.status;
    return projection;
  });

  t.mock.method(dungeonSettlementService, 'settleDungeonClearInDb', async () => {
    dungeonClearSettled = true;
    return 'settled';
  });

  t.mock.method(
    projectionService,
    'getOnlineBattleCharacterSnapshotsByCharacterIds',
    async (characterIds: number[]) => new Map(characterIds.map((characterId) => [
      characterId,
      createSnapshot(characterId, 1),
    ])),
  );

  const result = await nextDungeonInstance(1, instanceId);

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('预期推进秘境成功，但实际返回失败');
  }
  assert.equal(result.data.status, 'cleared');
  assert.equal(updatedStatus, 'cleared');
  assert.equal(dungeonClearSettled, true);
  assert.equal(
    dungeonCombatLogOutput.includes('实例可领奖名单为空，结算奖励将跳过'),
    false,
  );
});
