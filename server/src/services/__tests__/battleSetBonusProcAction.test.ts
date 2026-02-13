import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerSetBonusEffects } from '../../battle/modules/setBonus.js';
import { executeSkill } from '../../battle/modules/skill.js';
import type {
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleSkill,
  BattleState,
  BattleUnit,
} from '../../battle/types.js';

const createAttrs = () => ({
  max_qixue: 1200,
  max_lingqi: 240,
  wugong: 300,
  fagong: 220,
  wufang: 120,
  fafang: 110,
  sudu: 100,
  mingzhong: 9500,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 0,
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
});

const createUnit = (id: string, name: string, effects: BattleSetBonusEffect[] = []): BattleUnit => {
  const attrs = createAttrs();
  return {
    id,
    name,
    type: 'player',
    sourceId: Number(id.replace(/\D/g, '')) || 1,
    baseAttrs: { ...attrs },
    currentAttrs: { ...attrs },
    qixue: attrs.max_qixue,
    lingqi: 80,
    shields: [],
    buffs: [],
    skills: [],
    skillCooldowns: {},
    setBonusEffects: effects,
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

const createState = (attacker: BattleUnit, defender: BattleUnit): BattleState => ({
  battleId: 'battle-test-proc',
  battleType: 'pve',
  teams: {
    attacker: {
      odwnerId: 1,
      units: [attacker],
      totalSpeed: attacker.currentAttrs.sudu,
    },
    defender: {
      odwnerId: 2,
      units: [defender],
      totalSpeed: defender.currentAttrs.sudu,
    },
  },
  roundCount: 1,
  currentTeam: 'attacker',
  currentUnitIndex: 0,
  phase: 'action',
  firstMover: 'attacker',
  logs: [],
  randomSeed: 1,
  randomIndex: 0,
});

const assertActionLog = (
  log: BattleLogEntry | undefined
): Extract<BattleLogEntry, { type: 'action' }> => {
  if (!log) {
    assert.fail('缺少触发日志');
  }
  if (log.type !== 'action') {
    assert.fail(`期望 action 日志，实际为 ${log.type}`);
  }
  return log;
};

test('触发词条命中后应产出独立action日志', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-100-proc_zhuihun',
    setName: '赤焰枪·追魂斩',
    pieceCount: 1,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
      chance: 10000,
      value: 120,
      damage_type: 'true',
    },
  };
  const owner = createUnit('player-1', '测试剑修', [effect]);
  const target = createUnit('monster-1', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, { target, damage: 150 });
  const actionLog = assertActionLog(logs[0]);
  assert.match(actionLog.skillId, /^proc-/);
  assert.equal(actionLog.skillName, '赤焰枪·追魂斩');
  assert.equal(actionLog.actorName, '测试剑修');
  assert.equal(actionLog.targets.length, 1);
  assert.equal(actionLog.targets[0]?.targetName, '木桩妖');
  assert.equal(actionLog.targets[0]?.hits.length, 1);
  assert.ok((actionLog.targets[0]?.hits[0]?.damage ?? 0) > 0);
});

test('灵气触发词条应在独立action日志中记录资源变化', () => {
  const effect: BattleSetBonusEffect = {
    setId: 'affix-101-proc_lingchao',
    setName: '玄玉佩·灵潮息',
    pieceCount: 1,
    trigger: 'on_turn_start',
    target: 'self',
    effectType: 'resource',
    params: {
      chance: 10000,
      resource_type: 'lingqi',
      value: 18,
    },
  };
  const owner = createUnit('player-2', '测试法修', [effect]);
  owner.lingqi = 50;
  const target = createUnit('monster-2', '木桩妖', []);
  const state = createState(owner, target);

  const logs = triggerSetBonusEffects(state, 'on_turn_start', owner);
  const actionLog = assertActionLog(logs[0]);
  assert.equal(actionLog.targets.length, 1);
  assert.deepEqual(actionLog.targets[0]?.resources, [{ type: 'lingqi', amount: 18 }]);
  assert.equal(owner.lingqi, 68);
});

test('技能与词条触发日志应按时机排序（主动作在前，on_skill触发在后）', () => {
  const onSkillEffect: BattleSetBonusEffect = {
    setId: 'affix-201-proc_lingchao',
    setName: '青玉冠·灵潮息',
    pieceCount: 1,
    trigger: 'on_skill',
    target: 'self',
    effectType: 'resource',
    params: {
      chance: 10000,
      resource_type: 'lingqi',
      value: 10,
    },
  };
  const owner = createUnit('player-3', '测试道修', [onSkillEffect]);
  owner.lingqi = 40;
  const target = createUnit('monster-3', '木桩妖', []);
  const state = createState(owner, target);
  const skill: BattleSkill = {
    id: 'skill-test-normal',
    name: '试剑式',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'physical',
    element: 'none',
    effects: [
      {
        type: 'damage',
        value: 80,
        valueType: 'flat',
      },
    ],
    triggerType: 'active',
    aiPriority: 50,
  };

  const result = executeSkill(state, owner, skill, [target.id]);
  assert.equal(result.success, true);
  assert.equal(state.logs.length >= 2, true);

  const firstLog = state.logs[0];
  const secondLog = state.logs[1];
  const firstAction = assertActionLog(firstLog);
  const secondAction = assertActionLog(secondLog);

  assert.equal(firstAction.skillId, 'skill-test-normal');
  assert.match(secondAction.skillId, /^proc-/);
  assert.equal(secondAction.skillName, '青玉冠·灵潮息');
});
