/**
 * 战斗测试复用工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中构建 BattleUnit / BattleState / 默认属性，减少测试文件内重复样板代码。
 * - 不做什么：不封装业务断言、不隐藏关键输入，测试仍在各用例中显式表达触发条件。
 *
 * 输入/输出：
 * - 输入：单位标识、单位类型、可选属性覆盖、可选套装触发效果。
 * - 输出：可直接用于 battle 模块执行的 BattleUnit 与 BattleState。
 *
 * 数据流/状态流：
 * - 各测试文件 -> 调用 createUnit/createState -> 进入 skill.ts/setBonus.ts/mark.ts 执行。
 * - marks/shields/buffs 在此统一初始化，避免每个测试各自遗漏字段导致假阳性。
 *
 * 关键边界条件与坑点：
 * 1) 默认速度与命中需为有效正值，避免目标解析或命中判定被“0值”干扰。
 * 2) marks 容器必须显式初始化为空数组，保证印记测试不受 optional 字段分支影响。
 */

import type {
  BattleAttrs,
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleState,
  BattleUnit,
} from '../../battle/types.js';
import type { CharacterData, MonsterData } from '../../battle/battleFactory.js';
import { consumeBattleLogDelta } from '../../battle/logStream.js';

const BASE_ATTRS: BattleAttrs = {
  max_qixue: 1200,
  max_lingqi: 240,
  wugong: 300,
  fagong: 260,
  wufang: 140,
  fafang: 130,
  sudu: 120,
  mingzhong: 0.95,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 1.5,
  jianbaoshang: 0,
  jianfantan: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
};

const detectSourceId = (id: string): number | string => {
  const matched = /(\d+)/.exec(id);
  if (!matched) return id;
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) ? parsed : id;
};

export const createAttrs = (overrides: Partial<BattleAttrs> = {}): BattleAttrs => ({
  ...BASE_ATTRS,
  ...overrides,
});

/**
 * 为 battleFactory 构造最小合法角色数据。
 *
 * 复用点：
 * - 供 battleFactory / BattleEngine 联调用例复用，避免每个测试文件各写一份 CharacterData 样板。
 * - 高频变化点集中在 overrides，后续若基础属性口径调整，只需改这一处。
 */
export const createCharacterData = (
  id: number,
  overrides: Partial<CharacterData> = {},
): CharacterData => ({
  user_id: id,
  id,
  nickname: `角色${id}`,
  avatar: null,
  realm: '炼气一层',
  sub_realm: null,
  attribute_element: 'none',
  qixue: BASE_ATTRS.max_qixue,
  max_qixue: BASE_ATTRS.max_qixue,
  lingqi: BASE_ATTRS.max_lingqi,
  max_lingqi: BASE_ATTRS.max_lingqi,
  wugong: BASE_ATTRS.wugong,
  fagong: BASE_ATTRS.fagong,
  wufang: BASE_ATTRS.wufang,
  fafang: BASE_ATTRS.fafang,
  sudu: BASE_ATTRS.sudu,
  mingzhong: BASE_ATTRS.mingzhong,
  shanbi: BASE_ATTRS.shanbi,
  zhaojia: BASE_ATTRS.zhaojia,
  baoji: BASE_ATTRS.baoji,
  baoshang: BASE_ATTRS.baoshang,
  jianbaoshang: BASE_ATTRS.jianbaoshang,
  jianfantan: BASE_ATTRS.jianfantan,
  kangbao: BASE_ATTRS.kangbao,
  zengshang: BASE_ATTRS.zengshang,
  zhiliao: BASE_ATTRS.zhiliao,
  jianliao: BASE_ATTRS.jianliao,
  xixue: BASE_ATTRS.xixue,
  lengque: BASE_ATTRS.lengque,
  kongzhi_kangxing: BASE_ATTRS.kongzhi_kangxing,
  jin_kangxing: BASE_ATTRS.jin_kangxing,
  mu_kangxing: BASE_ATTRS.mu_kangxing,
  shui_kangxing: BASE_ATTRS.shui_kangxing,
  huo_kangxing: BASE_ATTRS.huo_kangxing,
  tu_kangxing: BASE_ATTRS.tu_kangxing,
  qixue_huifu: BASE_ATTRS.qixue_huifu,
  lingqi_huifu: BASE_ATTRS.lingqi_huifu,
  setBonusEffects: [],
  ...overrides,
});

/**
 * 为 battleFactory 构造最小合法怪物数据。
 *
 * 复用点：
 * - 供需要直接调用 createPVEBattle 的测试复用，统一最小 MonsterData 口径。
 * - 通过 base_attrs 局部覆盖控制怪物强度，避免测试文件各自拼接 base_attrs 结构。
 */
export const createMonsterData = (
  id: string,
  overrides: Partial<MonsterData> & { base_attrs?: Partial<MonsterData['base_attrs']> } = {},
): MonsterData => {
  const { base_attrs: baseAttrsOverrides, ...restOverrides } = overrides;
  return {
    id,
    name: `怪物${id}`,
    realm: '凡人',
    element: 'none',
    base_attrs: {
      max_qixue: 500,
      max_lingqi: 0,
      wugong: 60,
      fagong: 0,
      wufang: 30,
      fafang: 30,
      sudu: 80,
      mingzhong: 0.85,
      shanbi: 0,
      zhaojia: 0,
      baoji: 0,
      baoshang: 1.5,
      jianbaoshang: 0,
      jianfantan: 0,
      kangbao: 0,
      ...baseAttrsOverrides,
    },
    ai_profile: { skillIds: [], skillWeights: {}, phaseTriggers: [] },
    exp_reward: 100,
    silver_reward_min: 50,
    silver_reward_max: 100,
    ...restOverrides,
  };
};

export const createUnit = (args: {
  id: string;
  name: string;
  type?: BattleUnit['type'];
  attrs?: Partial<BattleAttrs>;
  setBonusEffects?: BattleSetBonusEffect[];
}): BattleUnit => {
  const attrs = createAttrs(args.attrs);
  return {
    id: args.id,
    name: args.name,
    type: args.type ?? 'player',
    sourceId: detectSourceId(args.id),
    baseAttrs: { ...attrs },
    currentAttrs: { ...attrs },
    qixue: attrs.max_qixue,
    lingqi: attrs.max_lingqi,
    shields: [],
    buffs: [],
    marks: [],
    momentum: null,
    skills: [],
    skillCooldowns: {},
    skillCooldownDiscountBank: {},
    setBonusEffects: args.setBonusEffects ?? [],
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
      killCount: 0,
    },
  };
};

export const createState = (args: {
  attacker: BattleUnit[];
  defender: BattleUnit[];
  battleType?: BattleState['battleType'];
  round?: number;
}): BattleState => {
  const attackerSpeed = args.attacker.reduce((sum, unit) => sum + unit.currentAttrs.sudu, 0);
  const defenderSpeed = args.defender.reduce((sum, unit) => sum + unit.currentAttrs.sudu, 0);
  return {
    battleId: 'battle-test',
    battleType: args.battleType ?? 'pve',
    teams: {
      attacker: {
        odwnerId: 1,
        units: args.attacker,
        totalSpeed: attackerSpeed,
      },
      defender: {
        odwnerId: 2,
        units: args.defender,
        totalSpeed: defenderSpeed,
      },
    },
    roundCount: args.round ?? 1,
    currentTeam: 'attacker',
    currentUnitId: null,
    phase: 'action',
    firstMover: 'attacker',
    randomSeed: 1,
    randomIndex: 0,
  };
};

export const consumeBattleLogs = (
  state: Pick<BattleState, 'battleId'>,
): BattleLogEntry[] => {
  return consumeBattleLogDelta(state.battleId).logs;
};

export const asActionLog = (
  log: BattleLogEntry | undefined,
): Extract<BattleLogEntry, { type: 'action' }> => {
  if (!log || log.type !== 'action') {
    throw new Error('期望 action 日志');
  }
  return log;
};
