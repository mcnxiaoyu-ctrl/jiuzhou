/**
 * 合道一期数据完整性测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定合道一期主线、地图、秘境、怪物、掉落与套装的关键引用关系，避免新增一批 seed 后出现断链。
 * - 做什么：额外验证新 Boss 能被怪物运行时解析，并把 reflect_damage 技能正确带入战斗层。
 * - 不做什么：不执行真实战斗，不验证随机掉率统计，也不覆盖 UI 展示文案。
 *
 * 输入/输出：
 * - 输入：chapter7 / dialogue7 / dungeon14 / map / npc / monster / item / drop_pool / item_set 等种子，以及怪物运行时解析函数。
 * - 输出：引用存在性断言、套装闭环断言、运行时解析成功断言。
 *
 * 数据流/状态流：
 * - 先用 seedTestUtils 统一读取并构建对象索引；
 * - 再从主线与秘境种子提取目标 ID，回查 map/npc/monster/item/dungeon/drop_pool；
 * - 最后通过 resolveOrderedMonsters 走一次战斗层解析，确认反伤技能不是“只写进 JSON 没法加载”。
 *
 * 关键边界条件与坑点：
 * 1) 掉落校验必须同时覆盖普通池与公共池，否则很容易漏掉公共池里引用的新装备。
 * 2) 主线与秘境引用的是跨文件 ID，任何一处命名漂移都会让内容在运行期静默失效，因此测试要把这条链路一次性锁死。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDungeonDefinitions, getDungeonDifficultiesByDungeonId } from '../staticConfigLoader.js';
import { resolveOrderedMonsters } from '../battle/shared/monsters.js';
import { getDungeonDefById } from '../dungeon/shared/configLoader.js';
import { getEnabledMainQuestChapterById } from '../mainQuest/shared/questConfig.js';
import { getRoomInMap, getRoomsInMap, isMapEnabled } from '../mapService.js';
import {
  asArray,
  asObject,
  asText,
  buildObjectMap,
  collectMergedPoolItemIds,
  loadSeed,
} from './seedTestUtils.js';

const HEDAO_DUNGEON_FILE = 'dungeon_qi_cultivation_14.json';
const HEDAO_DUNGEON_ID = 'dungeon-lianshen-xuanjian-sitian-gong';
const HEDAO_BOSS_ID = 'monster-boss-hedao-xuanjian-zhenjun';
const HEDAO_SET_IDS = ['set-zhaogu', 'set-xuanlv', 'set-suijing'] as const;
const HEDAO_SET_DROP_IDS = {
  bossPoolId: 'dp-hedao-boss-xuanjian-zhenjun',
  nightmarePoolId: 'dp-dungeon-jingxu-nm',
  weapon: 'set-suijing-weapon',
  head: 'set-suijing-head',
  artifact: 'set-suijing-artifact',
  hardDifficultyId: 'dd-jingxu-sitian-h',
  nightmareDifficultyId: 'dd-jingxu-sitian-nm',
} as const;
const HEDAO_MONSTER_IDS = [
  'monster-hedao-jingjia-guard',
  'monster-hedao-zheguang-lingguan',
  'monster-elite-hedao-beishi-xunling',
  'monster-elite-hedao-jingyu-sipan',
  HEDAO_BOSS_ID,
] as const;

test('合道一期主线、地图与秘境应统一处于开放态', async () => {
  const mainQuestSeed = loadSeed('main_quest_chapter7.json');
  const mapSeed = loadSeed('map_def.json');
  const dungeonSeed = loadSeed(HEDAO_DUNGEON_FILE);

  const chapterById = buildObjectMap(asArray(mainQuestSeed.chapters), 'id');
  const mapById = buildObjectMap(asArray(mapSeed.maps), 'id');
  const chapter = chapterById.get('mq-chapter-7');
  const map = mapById.get('map-dadao-jingxu');
  const dungeonDef = asObject(asObject(asArray(dungeonSeed.dungeons)[0])?.def);

  assert.ok(chapter, '缺少第七章章节定义');
  assert.equal(chapter?.enabled, true, '第七章应开启，保证还虚期玩家能继续推进主线');
  assert.notEqual(getEnabledMainQuestChapterById('mq-chapter-7'), null, '运行时应暴露第七章章节');

  assert.ok(map, '缺少大道镜墟地图定义');
  assert.equal(map?.enabled, true, '大道镜墟地图应开启');
  assert.equal(
    isMapEnabled(map as { enabled?: boolean | null }),
    true,
    '地图可用性判定应识别大道镜墟为开启态',
  );
  assert.ok((await getRoomsInMap('map-dadao-jingxu')).length > 0, '开启地图后应返回房间列表');
  assert.notEqual(await getRoomInMap('map-dadao-jingxu', 'room-jingxu-dukou'), null, '开启地图后应返回房间详情');

  assert.ok(dungeonDef, '缺少玄鉴司天宫秘境定义');
  assert.equal(dungeonDef?.enabled, true, '玄鉴司天宫秘境应开启');
  assert.notEqual(getDungeonDefById(HEDAO_DUNGEON_ID), null, '运行时应暴露玄鉴司天宫秘境');
});

test('第七章主线目标应只引用已存在地图/NPC/怪物/物品/秘境', () => {
  const mainQuestSeed = loadSeed('main_quest_chapter7.json');
  const dialogueSeed = loadSeed('dialogue_main_chapter7.json');
  const mapSeed = loadSeed('map_def.json');
  const npcSeed = loadSeed('npc_def.json');
  const monsterSeed = loadSeed('monster_def.json');
  const itemSeed = loadSeed('item_def.json');
  const dungeonSeed = loadSeed(HEDAO_DUNGEON_FILE);

  const chapterById = buildObjectMap(asArray(mainQuestSeed.chapters), 'id');
  const sectionById = buildObjectMap(asArray(mainQuestSeed.sections), 'id');
  const dialogueById = buildObjectMap(asArray(dialogueSeed.dialogues), 'id');
  const mapById = buildObjectMap(asArray(mapSeed.maps), 'id');
  const npcById = buildObjectMap(asArray(npcSeed.npcs), 'id');
  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const itemById = buildObjectMap(asArray(itemSeed.items), 'id');
  const dungeonDef = asObject(asObject(asArray(dungeonSeed.dungeons)[0])?.def);
  const dungeonDefId = asText(dungeonDef?.id);

  assert.ok(chapterById.get('mq-chapter-7'), '缺少第七章章节定义');
  assert.equal(dungeonDefId, HEDAO_DUNGEON_ID);
  assert.equal(asArray(mainQuestSeed.sections).length, 6, '第七章应包含6个任务节');

  for (const sectionId of ['main-7-001', 'main-7-002', 'main-7-003', 'main-7-004', 'main-7-005', 'main-7-006']) {
    const section = sectionById.get(sectionId);
    assert.ok(section, `缺少任务节: ${sectionId}`);
    assert.ok(mapById.get(asText(section?.map_id)), `${sectionId} 引用了不存在地图`);
    assert.ok(npcById.get(asText(section?.npc_id)), `${sectionId} 引用了不存在 NPC`);
    assert.ok(dialogueById.get(asText(section?.dialogue_id)), `${sectionId} 引用了不存在对话`);

    for (const objectiveEntry of asArray(section?.objectives)) {
      const objective = asObject(objectiveEntry);
      assert.ok(objective, `${sectionId} 存在非法 objectives 条目`);
      const type = asText(objective.type);
      const params = asObject(objective.params);
      assert.ok(params, `${sectionId} 的目标参数缺失`);
      if (type === 'kill_monster') {
        assert.ok(monsterById.get(asText(params.monster_id)), `${sectionId} 引用了不存在怪物`);
      }
      if (type === 'collect') {
        assert.ok(itemById.get(asText(params.item_id)), `${sectionId} 引用了不存在物品`);
      }
      if (type === 'dungeon_clear') {
        assert.equal(asText(params.dungeon_id), HEDAO_DUNGEON_ID);
      }
      if (type === 'talk_npc') {
        assert.ok(npcById.get(asText(params.npc_id)), `${sectionId} talk_npc 引用了不存在 NPC`);
      }
    }
  }
});

test('合道一期秘境应只引用已存在怪物定义且可被静态加载器读到', () => {
  const dungeonSeed = loadSeed(HEDAO_DUNGEON_FILE);
  const monsterSeed = loadSeed('monster_def.json');
  const monsterIds = new Set(
    asArray(monsterSeed.monsters)
      .map((row) => {
        const monster = asObject(row);
        return asText(monster?.id);
      })
      .filter(Boolean),
  );

  const referencedMonsterIds = new Set<string>();
  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonEntry);
    assert.ok(dungeon, '秘境条目必须是对象');
    for (const difficultyEntry of asArray(dungeon.difficulties)) {
      const difficulty = asObject(difficultyEntry);
      assert.ok(difficulty, '秘境难度条目必须是对象');
      for (const stageEntry of asArray(difficulty.stages)) {
        const stage = asObject(stageEntry);
        assert.ok(stage, '秘境关卡条目必须是对象');
        for (const waveEntry of asArray(stage.waves)) {
          const wave = asObject(waveEntry);
          assert.ok(wave, '秘境波次条目必须是对象');
          for (const monsterEntry of asArray(wave.monsters)) {
            const monster = asObject(monsterEntry);
            assert.ok(monster, '秘境怪物条目必须是对象');
            const monsterId = asText(monster.monster_def_id);
            if (monsterId) referencedMonsterIds.add(monsterId);
          }
        }
      }
    }
  }

  assert.ok(referencedMonsterIds.size > 0, '玄鉴司天宫应至少引用1个怪物');
  for (const monsterId of referencedMonsterIds) {
    assert.equal(monsterIds.has(monsterId), true, `秘境引用了不存在怪物: ${monsterId}`);
  }

  const dungeonDefs = getDungeonDefinitions();
  const dungeonDef = dungeonDefs.find((entry) => entry.id === HEDAO_DUNGEON_ID);
  assert.ok(dungeonDef, '静态加载器未读到玄鉴司天宫定义');
  assert.equal(getDungeonDifficultiesByDungeonId(HEDAO_DUNGEON_ID).length, 3, '玄鉴司天宫应包含3个难度');
});

test('合道一期怪物掉落池与套装引用应完整闭环', () => {
  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const commonPoolSeed = loadSeed('drop_pool_common.json');
  const itemSeed = loadSeed('item_def.json');
  const equipSeed = loadSeed('equipment_def.json');
  const itemSetSeed = loadSeed('item_set.json');
  const dungeonSeed = loadSeed(HEDAO_DUNGEON_FILE);

  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');
  const commonPoolById = buildObjectMap(asArray(commonPoolSeed.pools), 'id');
  const equipById = buildObjectMap(asArray(equipSeed.items), 'id');
  const setById = buildObjectMap(asArray(itemSetSeed.sets), 'id');

  const validItemIds = new Set<string>();
  for (const row of asArray(itemSeed.items)) {
    const item = asObject(row);
    const id = asText(item?.id);
    if (id) validItemIds.add(id);
  }
  for (const row of asArray(equipSeed.items)) {
    const equip = asObject(row);
    const id = asText(equip?.id);
    if (id) validItemIds.add(id);
  }

  assert.ok(commonPoolById.get('dp-common-monster-hedao'), '缺少公共掉落池 dp-common-monster-hedao');

  for (const monsterId of HEDAO_MONSTER_IDS) {
    const monster = monsterById.get(monsterId);
    assert.ok(monster, `缺少怪物定义: ${monsterId}`);
    const dropPoolId = asText(monster?.drop_pool_id);
    assert.ok(dropPoolId, `${monsterId} 缺少 drop_pool_id`);
    assert.ok(dropPoolById.get(dropPoolId), `${monsterId} 引用了不存在掉落池: ${dropPoolId}`);

    const mergedItemIds = collectMergedPoolItemIds(dropPoolId, dropPoolById, commonPoolById);
    for (const itemDefId of mergedItemIds) {
      assert.equal(validItemIds.has(itemDefId), true, `${dropPoolId} 引用了不存在物品: ${itemDefId}`);
    }
  }

  for (const setId of HEDAO_SET_IDS) {
    const setDef = setById.get(setId);
    assert.ok(setDef, `缺少套装定义: ${setId}`);
    const pieces = asArray(setDef.pieces);
    assert.equal(pieces.length, 8, `${setId} 应包含8件装备`);
    for (const pieceEntry of pieces) {
      const piece = asObject(pieceEntry);
      assert.ok(piece, `${setId} 存在非法 pieces 条目`);
      const itemDefId = asText(piece.item_def_id);
      assert.ok(itemDefId, `${setId} 存在空 item_def_id`);
      const equip = equipById.get(itemDefId);
      assert.ok(equip, `${setId} 引用了不存在装备: ${itemDefId}`);
      assert.equal(asText(equip?.set_id), setId, `${itemDefId} 的 set_id 应为 ${setId}`);
    }
  }

  const bossPool = dropPoolById.get(HEDAO_SET_DROP_IDS.bossPoolId);
  assert.ok(bossPool, '缺少玄鉴真君掉落池');
  const bossPoolItemIds = collectMergedPoolItemIds(HEDAO_SET_DROP_IDS.bossPoolId, dropPoolById, commonPoolById);
  assert.equal(bossPoolItemIds.has(HEDAO_SET_DROP_IDS.weapon), true, 'Boss 掉落池缺少物理套装武器');
  assert.equal(bossPoolItemIds.has(HEDAO_SET_DROP_IDS.artifact), true, 'Boss 掉落池缺少物理套装法宝');

  const nightmarePool = dropPoolById.get(HEDAO_SET_DROP_IDS.nightmarePoolId);
  assert.ok(nightmarePool, '缺少玄鉴司天宫噩梦掉落池');
  const nightmarePoolItemIds = collectMergedPoolItemIds(HEDAO_SET_DROP_IDS.nightmarePoolId, dropPoolById, commonPoolById);
  assert.equal(nightmarePoolItemIds.has(HEDAO_SET_DROP_IDS.head), true, '噩梦掉落池缺少物理套装头部');

  const dungeonByDifficultyId = new Map<string, ReturnType<typeof asObject>>();
  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonEntry);
    if (!dungeon) continue;
    for (const difficultyEntry of asArray(dungeon.difficulties)) {
      const difficulty = asObject(difficultyEntry);
      const difficultyId = asText(difficulty?.id);
      if (!difficultyId || !difficulty) continue;
      dungeonByDifficultyId.set(difficultyId, difficulty);
    }
  }

  const hardDifficulty = dungeonByDifficultyId.get(HEDAO_SET_DROP_IDS.hardDifficultyId);
  const nightmareDifficulty = dungeonByDifficultyId.get(HEDAO_SET_DROP_IDS.nightmareDifficultyId);
  assert.ok(hardDifficulty, '缺少困难难度定义');
  assert.ok(nightmareDifficulty, '缺少噩梦难度定义');

  const hardFirstClearItems = asArray(asObject(hardDifficulty?.first_clear_rewards)?.items);
  const nightmareFirstClearItems = asArray(asObject(nightmareDifficulty?.first_clear_rewards)?.items);
  assert.equal(
    hardFirstClearItems.some((entry) => asText(asObject(entry)?.item_def_id) === HEDAO_SET_DROP_IDS.weapon),
    true,
    '困难首通奖励缺少物理套装武器',
  );
  assert.equal(
    nightmareFirstClearItems.some((entry) => asText(asObject(entry)?.item_def_id) === HEDAO_SET_DROP_IDS.artifact),
    true,
    '噩梦首通奖励缺少物理套装法宝',
  );
});

test('合道一期 Boss 应可被运行时解析并携带反伤技能', () => {
  const resolved = resolveOrderedMonsters([HEDAO_BOSS_ID]);
  assert.equal(resolved.success, true, resolved.success ? '' : resolved.error);
  if (!resolved.success) return;

  const bossSkills = resolved.monsterSkillsMap[HEDAO_BOSS_ID] ?? [];
  const reflectSkill = bossSkills.find((skill) => skill.id === 'sk-fantian-mingjing');
  assert.ok(reflectSkill, '玄鉴真君缺少返天明镜运行时技能');
  assert.equal(
    reflectSkill?.effects.some((effect) => effect.type === 'buff' && effect.buffKind === 'reflect_damage'),
    true,
    '返天明镜应包含 reflect_damage Buff',
  );
});
