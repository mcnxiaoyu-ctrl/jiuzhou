import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Requirement = {
  type?: string;
  min?: number;
  minCount?: number;
  minLayer?: number;
  dungeonId?: string;
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
    flat?: Record<string, number>;
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

test('证道->历劫突破配置应满足历劫期前置/消耗/奖励口径，并要求先完成第九章主线', () => {
  const seed = loadSeed();
  const entry = (seed.breakthroughs ?? []).find(
    (row) => row.from === '炼虚合道·证道期' && row.to === '炼虚合道·历劫期',
  );
  assert.ok(entry, '缺少 证道期->历劫期 突破条目');

  const requirements = entry.requirements ?? [];
  assert.equal(requirements.some((row) => row.type === 'version_locked'), false, '历劫期突破不应再保留版本锁');

  const expReq = requirements.find((row) => row.type === 'exp_min');
  assert.equal(expReq?.min, 7_600_000);

  const techniqueReq = requirements.find((row) => row.type === 'techniques_count_min_layer');
  assert.equal(techniqueReq?.minCount, 3);
  assert.equal(techniqueReq?.minLayer, 9);

  const dungeonReq = requirements.find((row) => row.type === 'dungeon_clear_min');
  assert.equal(dungeonReq?.dungeonId, 'dungeon-lianxu-wanlei-jiegong');
  assert.equal(dungeonReq?.minCount, 4);

  const chapterReq = requirements.find((row) => row.type === 'main_quest_chapter_completed');
  assert.equal(chapterReq?.chapterId, 'mq-chapter-9');

  const leishaReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-jieyun-leisha');
  const jieyinReq = requirements.find((row) => row.type === 'item_qty_min' && row.itemDefId === 'mat-wanlei-jieyin');
  assert.equal(leishaReq?.qty, 36);
  assert.equal(jieyinReq?.qty, 8);

  const costs = entry.costs ?? [];
  const spiritStoneCost = costs.find((row) => row.type === 'spirit_stones');
  const expCost = costs.find((row) => row.type === 'exp');
  const itemCost = costs.find((row) => row.type === 'items');
  assert.equal(spiritStoneCost?.amount, 40_000);
  assert.equal(expCost?.amount, 7_600_000);
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-jieyun-leisha' && row.qty === 24),
    true,
  );
  assert.equal(
    itemCost?.items?.some((row) => row.itemDefId === 'mat-wanlei-jieyin' && row.qty === 5),
    true,
  );

  assert.equal(entry.rewards?.attributePoints, 38);
  assert.equal(entry.rewards?.flat?.max_qixue, 550);
  assert.equal(entry.rewards?.pct?.max_qixue, 0.33);
  assert.equal(entry.rewards?.pct?.max_lingqi, 0.33);
  assert.equal(entry.rewards?.pct?.wugong, 0.23);
  assert.equal(entry.rewards?.pct?.fagong, 0.23);
  assert.equal(entry.rewards?.pct?.wufang, 0.23);
  assert.equal(entry.rewards?.pct?.fafang, 0.23);
  assert.equal(entry.rewards?.addPercent?.kongzhi_kangxing, 0.13);
});

test('历劫->成圣突破应继续保持版本锁', () => {
  const seed = loadSeed();
  const entry = (seed.breakthroughs ?? []).find(
    (row) => row.from === '炼虚合道·历劫期' && row.to === '炼虚合道·成圣期',
  );
  assert.ok(entry, '缺少 历劫期->成圣期 突破条目');
  assert.equal(
    (entry.requirements ?? []).some((row) => row.type === 'version_locked'),
    true,
    '成圣期突破仍应保持版本锁',
  );
});
