import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Requirement = {
  type?: string;
  title?: string;
  reason?: string;
  min?: number;
  minCount?: number;
  minLayer?: number;
  dungeonId?: string;
  difficultyId?: string;
  chapterId?: string;
  itemDefId?: string;
  qty?: number;
};

type Cost = {
  type?: string;
  amount?: number;
  items?: Array<{ itemDefId?: string; qty?: number }>;
};

type Breakthrough = {
  from?: string;
  to?: string;
  requirements?: Requirement[];
  costs?: Cost[];
  rewards?: {
    attributePoints?: number;
    pct?: Record<string, number>;
    addPercent?: Record<string, number>;
  };
};

type RealmBreakthroughSeed = {
  breakthroughs?: Breakthrough[];
};

const loadSeed = (): RealmBreakthroughSeed => {
  const candidatePaths = [
    resolve(process.cwd(), 'server/src/data/seeds/realm_breakthrough.json'),
    resolve(process.cwd(), 'src/data/seeds/realm_breakthrough.json'),
  ];
  const seedPath = candidatePaths.find((filePath) => existsSync(filePath));
  assert.ok(seedPath, '未找到 realm_breakthrough.json');
  return JSON.parse(readFileSync(seedPath, 'utf-8')) as RealmBreakthroughSeed;
};

test('还虚->合道突破配置应满足合道一期前置/消耗/奖励口径', () => {
  const seed = loadSeed();
  const entry = (seed.breakthroughs ?? []).find(
    (row) => row.from === '炼神返虚·还虚期' && row.to === '炼神返虚·合道期',
  );
  assert.ok(entry, '缺少 还虚期->合道期 突破条目');

  const requirements = entry.requirements ?? [];
  const versionLockedReq = requirements.find((row) => row.type === 'version_locked');
  assert.equal(versionLockedReq, undefined, '合道期突破不应继续保留版本锁前置');

  const expReq = requirements.find((row) => row.type === 'exp_min');
  assert.equal(expReq?.min, 4_300_000);

  const mainSubTechniqueReq = requirements.find((row) => row.type === 'main_and_sub_technique_layer_min');
  assert.equal(mainSubTechniqueReq?.minLayer, 8);

  const techniqueReq = requirements.find((row) => row.type === 'techniques_count_min_layer');
  assert.equal(techniqueReq?.minCount, 2);
  assert.equal(techniqueReq?.minLayer, 9);

  const dungeonReq = requirements.find((row) => row.type === 'dungeon_clear_min');
  assert.equal(dungeonReq?.dungeonId, 'dungeon-lianshen-xuanjian-sitian-gong');
  assert.equal(dungeonReq?.difficultyId, 'dd-jingxu-sitian-h');
  assert.equal(dungeonReq?.minCount, 3);

  const chapterReq = requirements.find((row) => row.type === 'main_quest_chapter_completed');
  assert.equal(chapterReq?.chapterId, 'mq-chapter-7');

  const xuanshaReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-daojing-xuansha');
  const qiyinReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-hedao-qiyin');
  assert.equal(xuanshaReq?.qty, 20);
  assert.equal(qiyinReq?.qty, 4);

  const costs = entry.costs ?? [];
  const spiritStoneCost = costs.find((row) => row.type === 'spirit_stones');
  const expCost = costs.find((row) => row.type === 'exp');
  const itemCost = costs.find((row) => row.type === 'items');
  assert.equal(spiritStoneCost?.amount, 19_000);
  assert.equal(expCost?.amount, 4_300_000);
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-daojing-xuansha' && row.qty === 14),
    true,
  );
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-hedao-qiyin' && row.qty === 3),
    true,
  );

  assert.equal(entry.rewards?.attributePoints, 30);
  assert.equal(entry.rewards?.pct?.max_qixue, 0.28);
  assert.equal(entry.rewards?.pct?.max_lingqi, 0.28);
  assert.equal(entry.rewards?.pct?.wugong, 0.18);
  assert.equal(entry.rewards?.pct?.fagong, 0.18);
  assert.equal(entry.rewards?.pct?.wufang, 0.18);
  assert.equal(entry.rewards?.pct?.fafang, 0.18);
  assert.equal(entry.rewards?.addPercent?.kongzhi_kangxing, 0.095);
});
