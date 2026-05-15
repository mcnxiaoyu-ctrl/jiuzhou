/**
 * 物品使用快速角色快照策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：用源码级断言锁定 useItem 的精准分段策略，避免简单消耗品回退成每次完整重载角色。
 * 2. 做什么：确认学习功法、解绑装备、背包扩容仍保留条件重载入口。
 * 3. 不做什么：不执行数据库事务、不模拟物品效果，也不启动服务。
 *
 * 输入 / 输出：
 * - 输入：itemService 源码文本。
 * - 输出：关键函数、慢日志分段与条件 reload 策略的静态断言结果。
 *
 * 数据流 / 状态流：
 * 读取源码 -> 检查快照合成函数与重载判定函数 -> 检查慢日志分段
 * -> 检查最终角色返回处是否按 shouldReloadCharacter 分流。
 *
 * 复用设计说明：
 * - 测试直接约束 itemService 的单一快照合成入口，防止 exp/silver/spiritStones 与 qixue/lingqi/stamina 的补丁逻辑分散到多个分支。
 * - 被 useItem 快路径和重载路径共同约束，后续新增简单消耗品效果时仍应复用同一策略。
 *
 * 关键边界条件与坑点：
 * 1. qixue/lingqi/stamina 不能按 delta 盲加，必须允许由资源服务返回值覆盖。
 * 2. 完整 reload 后只允许叠加 rewardDelta 中的延迟奖励，不手动修补运行时资源字段。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const assertSlowMarkFields = (
  source: string,
  markName: string,
  fields: readonly string[],
): void => {
  const marker = `slowLogger.mark('${markName}', {`;
  const startIndex = source.indexOf(marker);
  assert.notEqual(startIndex, -1);
  const endIndex = source.indexOf('});', startIndex);
  assert.notEqual(endIndex, -1);
  const markBlock = source.slice(startIndex, endIndex);

  for (const field of fields) {
    assert.match(markBlock, new RegExp(`\\b${field}\\b`, 'u'));
  }
};

test('useItem 应按效果类型选择快速快照或完整重载角色', () => {
  const source = readSource('../itemService.ts');

  assert.match(source, /const buildItemUseCharacterSnapshot = \(/u);
  assert.match(source, /const shouldReloadCharacterAfterUseItem = \(/u);

  assert.match(source, /slowLogger\.mark\('loadUseContext'\)/u);
  assert.match(source, /slowLogger\.mark\('lockInventoryMutex'\)/u);
  assert.match(source, /slowLogger\.mark\('applyUseEffects', \{[\s\S]*?effectCount[\s\S]*?lootItemCount[\s\S]*?hasLoot[\s\S]*?hasLearnTechnique[\s\S]*?hasLearnPartnerTechnique[\s\S]*?hasEquipmentUnbindEffect[\s\S]*?hasPartnerBaseAttrRerollEffect[\s\S]*?\}\)/u);
  assertSlowMarkFields(source, 'settleUseRewards', [
    'hasExpandEffect',
    'rewardDeltaExp',
    'rewardDeltaSilver',
    'rewardDeltaSpiritStones',
  ]);
  assertSlowMarkFields(source, 'writeUseBookkeeping', [
    'effectiveCdSec',
    'dailyLimit',
    'totalLimit',
  ]);
  assert.match(source, /slowLogger\.mark\('consumeUsedItem'\)/u);
  assertSlowMarkFields(source, 'applyRuntimeResources', [
    'hasPartnerTechniqueResult',
    'deltaQixue',
    'deltaLingqi',
    'deltaStamina',
  ]);
  assert.match(source, /slowLogger\.mark\('buildCharacterSnapshot', \{[\s\S]*?reloadedCharacter[\s\S]*?\}\)/u);
  assert.doesNotMatch(source, /slowLogger\.mark\('loadUpdatedCharacter'\)/u);

  assert.match(source, /const shouldReloadCharacter = shouldReloadCharacterAfterUseItem\(/u);
  assert.match(source, /if \(shouldReloadCharacter\) \{[\s\S]*?getCharacterComputedByCharacterId\(characterId, \{ bypassStaticCache: true \}\)[\s\S]*?\} else \{[\s\S]*?buildItemUseCharacterSnapshot/u);
});

test('useItem 快速快照应使用资源服务返回值覆盖运行时资源', () => {
  const source = readSource('../itemService.ts');

  assert.match(
    source,
    /appliedResourceDelta\s*=\s*await applyCharacterResourceDeltaByCharacterId\(characterId,\s*\{[\s\S]*?qixue:\s*deltaQixue[\s\S]*?lingqi:\s*deltaLingqi[\s\S]*?\}\)/u,
  );
  assert.match(source, /fastSnapshotDelta\.qixue\s*=\s*appliedResourceDelta\.qixue/u);
  assert.match(source, /fastSnapshotDelta\.lingqi\s*=\s*appliedResourceDelta\.lingqi/u);

  assert.match(
    source,
    /const staminaResult\s*=\s*await recoverStaminaByCharacterId\(characterId,\s*deltaStamina\)[\s\S]*?recoveredStamina\s*=\s*staminaResult/u,
  );
  assert.match(source, /fastSnapshotDelta\.stamina\s*=\s*recoveredStamina\.stamina/u);
});

test('角色重载策略只由结构性角色变化决定', () => {
  const source = readSource('../itemService.ts');

  assert.match(
    source,
    /const shouldReloadCharacterAfterUseItem = \(flags: ItemUseReloadFlags\): boolean => \{[\s\S]*?return flags\.hasLearnTechnique \|\| flags\.hasEquipmentUnbindEffect \|\| flags\.hasExpandEffect;[\s\S]*?\};/u,
  );
});

test('完整重载分支只叠加延迟奖励字段，不手动覆盖运行时资源', () => {
  const source = readSource('../itemService.ts');
  const reloadBranchMatch = source.match(
    /if \(shouldReloadCharacter\) \{(?<reloadBranch>[\s\S]*?)\n\s*\} else \{/u,
  );
  const reloadBranch = reloadBranchMatch?.groups?.reloadBranch ?? '';

  assert.match(reloadBranch, /buildItemUseCharacterSnapshot\(updatedCharBase,\s*\{[\s\S]*?exp:\s*rewardDelta\.exp[\s\S]*?silver:\s*rewardDelta\.silver[\s\S]*?spiritStones:\s*rewardDelta\.spiritStones[\s\S]*?\}\)/u);
  assert.doesNotMatch(reloadBranch, /\bqixue\s*:/u);
  assert.doesNotMatch(reloadBranch, /\blingqi\s*:/u);
  assert.doesNotMatch(reloadBranch, /\bstamina\s*:/u);
});
