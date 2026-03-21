/**
 * 玩家信息面板属性回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定玩家详情接口会返回统一的 `stats` 属性列表，供信息弹窗直接复用。
 * 2. 做什么：验证百分比属性继续走服务端统一格式化口径，避免前端再各写一套转换逻辑。
 * 3. 不做什么：不覆盖装备、功法列表渲染，也不验证真实数据库中的角色成长计算。
 *
 * 输入/输出：
 * - 输入：玩家角色 ID，以及 mock 后的角色计算快照。
 * - 输出：玩家详情目标对象中的 `stats` 数组。
 *
 * 数据流/状态流：
 * - 测试 -> `getInfoTargetDetail('player')`
 * - 服务端读取玩家基础资料 -> 复用角色计算快照 -> 统一拼装属性列表
 * - 前端信息弹窗直接消费 `stats`
 *
 * 关键边界条件与坑点：
 * 1. 玩家详情不能直接读裸表属性列，否则装备/功法/称号加成会丢失，面板和战斗口径不一致。
 * 2. 比例属性必须继续输出百分比字符串，例如 `0.12` 应展示为 `12%`，不能把格式化责任散到前端。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import type { CharacterComputedRow } from '../characterComputedService.js';
import * as characterComputedService from '../characterComputedService.js';
import { getInfoTargetDetail } from '../infoTargetService.js';
import * as monthCardBenefits from '../shared/monthCardBenefits.js';

const buildComputedCharacter = (): CharacterComputedRow => ({
  id: 7,
  user_id: 70,
  nickname: '那个谁居然用了我的名字',
  title: '并肩先驱',
  gender: 'male',
  avatar: '/uploads/avatar/player-7.png',
  auto_cast_skills: true,
  auto_disassemble_enabled: false,
  auto_disassemble_rules: null,
  dungeon_no_stamina_cost: false,
  spirit_stones: 100,
  silver: 200,
  stamina: 9,
  realm: '炼神返虚',
  sub_realm: '养神期',
  exp: 300,
  attribute_points: 0,
  jing: 18,
  qi: 16,
  shen: 22,
  attribute_type: 'physical',
  attribute_element: 'huo',
  current_map_id: 'map-qingyun-village',
  current_room_id: 'room-village-center',
  max_qixue: 1800,
  max_lingqi: 960,
  wugong: 320,
  fagong: 120,
  wufang: 210,
  fafang: 180,
  mingzhong: 0.12,
  shanbi: 0.08,
  zhaojia: 0.04,
  baoji: 0.15,
  baoshang: 0.5,
  jianbaoshang: 0.18,
  jianfantan: 0.05,
  kangbao: 0.09,
  zengshang: 0.11,
  zhiliao: 0.03,
  jianliao: 0.02,
  xixue: 0.06,
  lengque: 0.1,
  kongzhi_kangxing: 0.13,
  jin_kangxing: 0.01,
  mu_kangxing: 0.02,
  shui_kangxing: 0.03,
  huo_kangxing: 0.04,
  tu_kangxing: 0.05,
  qixue_huifu: 12,
  lingqi_huifu: 7,
  sudu: 88,
  fuyuan: 14,
  stamina_max: 20,
  qixue: 1800,
  lingqi: 960,
});

test('玩家详情应返回统一属性列表并格式化百分比属性', async (t) => {
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM item_instance')) {
      return { rows: [] };
    }
    if (sql.includes('FROM character_technique')) {
      return { rows: [] };
    }
    assert.fail(`未预期的 SQL: ${sql}`);
  });

  t.mock.method(characterComputedService, 'getCharacterComputedByCharacterId', async (characterId: number) => {
    assert.equal(characterId, 7);
    return buildComputedCharacter();
  });

  t.mock.method(monthCardBenefits, 'getMonthCardActiveMapByCharacterIds', async (characterIds: number[]) => {
    assert.deepEqual(characterIds, [7]);
    return new Map([[7, true]]);
  });

  const target = await getInfoTargetDetail('player', '7');

  assert.ok(target);
  assert.equal(target.type, 'player');
  assert.equal(target.monthCardActive, true);

  const stats = target.stats ?? [];
  assert.ok(stats.length > 0);

  const maxQixue = stats.find((entry) => entry.label === '气血上限');
  const mingzhong = stats.find((entry) => entry.label === '命中');
  const kongzhiKangxing = stats.find((entry) => entry.label === '控制抗性');
  const qixueHuifu = stats.find((entry) => entry.label === '气血恢复');

  assert.deepEqual(maxQixue, { label: '气血上限', value: 1800 });
  assert.deepEqual(mingzhong, { label: '命中', value: '12%' });
  assert.deepEqual(kongzhiKangxing, { label: '控制抗性', value: '13%' });
  assert.deepEqual(qixueHuifu, { label: '气血恢复', value: 12 });
});
