/**
 * 竞技场投影共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证竞技场投影候选集会纳入“活跃但尚无竞技场历史”的角色，避免新角色被漏掉后既看不到次数也无法挑战。
 * 2. 做什么：验证默认竞技场投影的积分、次数与剩余次数由单一共享函数产出，避免预热链路与按需初始化链路各写一套。
 * 3. 不做什么：不连接数据库，不覆盖 Redis 读写，也不验证路由层的 HTTP 返回结构。
 *
 * 输入/输出：
 * - 输入：活跃角色 ID 集合、竞技场历史角色 ID 集合，以及单角色的积分/胜负场/今日已用次数。
 * - 输出：去重排序后的候选角色 ID 列表，以及标准化竞技场投影记录。
 *
 * 数据流/状态流：
 * 活跃角色/竞技场历史角色 -> 共享候选集函数 -> 竞技场预热与懒初始化入口
 * 积分/胜负场/今日已用次数 -> 共享投影构造函数 -> 状态接口 / 匹配校验 / 战报入口。
 *
 * 关键边界条件与坑点：
 * 1. 活跃角色没有任何竞技场表记录时，仍必须生成默认投影；否则前端只能拿到 `--`，后端也会把它误判为无次数。
 * 2. 今日已用次数超过上限时，剩余次数必须钳制到 0，不能出现负数；否则按钮禁用与服务端校验会继续分裂。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ARENA_DAILY_LIMIT,
  DEFAULT_ARENA_SCORE,
  buildArenaProjectionRecord,
  collectArenaProjectionCharacterIds,
} from '../shared/arenaProjection.js';

test('collectArenaProjectionCharacterIds: 活跃角色即使没有竞技场历史也必须进入投影初始化集合', () => {
  const characterIds = collectArenaProjectionCharacterIds({
    activeCharacterIds: [18, 7, 18],
    ratedCharacterIds: [9, 7],
    todayUsageCharacterIds: [12, 9],
  });

  assert.deepEqual(characterIds, [7, 9, 12, 18]);
});

test('buildArenaProjectionRecord: 无竞技场历史的角色应返回默认积分与完整挑战次数', () => {
  const projection = buildArenaProjectionRecord({
    characterId: 77,
    todayUsed: 0,
    records: [],
  });

  assert.equal(projection.characterId, 77);
  assert.equal(projection.score, DEFAULT_ARENA_SCORE);
  assert.equal(projection.winCount, 0);
  assert.equal(projection.loseCount, 0);
  assert.equal(projection.todayUsed, 0);
  assert.equal(projection.todayLimit, DEFAULT_ARENA_DAILY_LIMIT);
  assert.equal(projection.todayRemaining, DEFAULT_ARENA_DAILY_LIMIT);
  assert.deepEqual(projection.records, []);
});

test('buildArenaProjectionRecord: 已有战绩时应保留现有积分并正确收敛剩余次数', () => {
  const projection = buildArenaProjectionRecord({
    characterId: 88,
    score: 1260,
    winCount: 6,
    loseCount: 2,
    todayUsed: 23,
    records: [
      {
        id: 'arena-battle-1',
        ts: 1_742_000_000_000,
        opponentName: '对手甲',
        opponentRealm: '炼气期',
        opponentPower: 1234,
        result: 'win',
        deltaScore: 10,
        scoreAfter: 1260,
      },
    ],
  });

  assert.equal(projection.score, 1260);
  assert.equal(projection.winCount, 6);
  assert.equal(projection.loseCount, 2);
  assert.equal(projection.todayUsed, 23);
  assert.equal(projection.todayLimit, DEFAULT_ARENA_DAILY_LIMIT);
  assert.equal(projection.todayRemaining, 0);
  assert.equal(projection.records.length, 1);
});
