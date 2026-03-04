/**
 * 九州修仙录 - 物品系统动态数据表
 *
 * 说明：
 * 1. 物品定义/词条池/套装/配方已改为静态 JSON 直读，不再建表。
 * 2. 仅保留运行时动态数据表（实例、冷却、使用计数）。
 */
import { query } from '../config/database.js';
import { runDbMigrationOnce } from './migrationHistoryTable.js';
import {
  normalizeGeneratedAffixModifiers,
  isRatioAttrKey,
  buildAffixValueAndModifiers,
  type AffixEffectType,
  type AffixParams,
} from '../services/shared/affixModifier.js';
import {
  convertPercentToRating,
  getEffectiveLevelByRealmRank,
  resolveRatingBaseAttrKey,
  toRatingAttrKey,
} from '../services/shared/affixRating.js';
import { QUALITY_MULTIPLIER_BY_RANK, resolveQualityRankFromName } from '../services/shared/itemQuality.js';
import { getRealmRankOneBasedForEquipment } from '../services/shared/realmRules.js';
import { getAffixPoolDefinitions, getItemDefinitionById, getItemDefinitions } from '../services/staticConfigLoader.js';

// ============================================
// 1. 物品实例表（动态）
// ============================================
const itemInstanceTableSQL = `
CREATE TABLE IF NOT EXISTS item_instance (
  id BIGSERIAL PRIMARY KEY,                           -- 物品实例ID
  owner_user_id BIGINT NOT NULL,                      -- 拥有者用户ID
  owner_character_id BIGINT,                          -- 拥有者角色ID（账号共享仓库可为空）
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）
  qty INTEGER NOT NULL DEFAULT 1,                     -- 数量（堆叠）
  quality CHAR(1),                                    -- 实例品质（装备生成结果；为空则按定义）
  quality_rank INTEGER,                               -- 实例品质排序值

  -- 绑定状态
  bind_type VARCHAR(16) NOT NULL DEFAULT 'none',      -- 实例绑定状态
  bind_owner_user_id BIGINT,                          -- 绑定到的用户ID
  bind_owner_character_id BIGINT,                     -- 绑定到的角色ID

  -- 位置信息
  location VARCHAR(16) NOT NULL DEFAULT 'bag',        -- 位置（bag/warehouse/equipped/mail/auction）
  location_slot INTEGER,                              -- 位置格子
  equipped_slot VARCHAR(32),                          -- 装备槽位（若已装备）

  -- 强化与精炼
  strengthen_level INTEGER DEFAULT 0,                 -- 强化等级
  refine_level INTEGER DEFAULT 0,                     -- 精炼等级

  -- 镶嵌与词条
  socketed_gems JSONB,                                -- 已镶嵌宝石信息
  random_seed BIGINT,                                 -- 随机种子
  affixes JSONB,                                      -- 随机词条结果
  identified BOOLEAN NOT NULL DEFAULT true,           -- 是否已鉴定
  affix_gen_version INTEGER NOT NULL DEFAULT 1,       -- 词条生成版本号
  affix_roll_meta JSONB,                              -- 词条生成元信息

  -- 其他
  custom_name VARCHAR(64),                            -- 自定义名称
  locked BOOLEAN NOT NULL DEFAULT false,              -- 是否锁定
  expire_at TIMESTAMPTZ,                              -- 实例过期时间

  -- 来源追溯
  obtained_from VARCHAR(128),                         -- 获取来源（drop/quest/shop/craft/mail/admin）
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID
  metadata JSONB,                                     -- 扩展字段

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE item_instance IS '物品实例表（动态数据）';
COMMENT ON COLUMN item_instance.id IS '物品实例ID';
COMMENT ON COLUMN item_instance.owner_user_id IS '拥有者用户ID';
COMMENT ON COLUMN item_instance.owner_character_id IS '拥有者角色ID';
COMMENT ON COLUMN item_instance.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_instance.qty IS '数量（堆叠数量）';
COMMENT ON COLUMN item_instance.location IS '位置（bag/warehouse/equipped/mail/auction）';
COMMENT ON COLUMN item_instance.location_slot IS '位置格子（从0开始）';
COMMENT ON COLUMN item_instance.equipped_slot IS '装备槽位（已装备时记录）';
COMMENT ON COLUMN item_instance.strengthen_level IS '强化等级';
COMMENT ON COLUMN item_instance.affixes IS '随机词条结果（JSONB）';
COMMENT ON COLUMN item_instance.locked IS '是否锁定（防误操作）';
COMMENT ON COLUMN item_instance.obtained_from IS '获取来源类型';

CREATE INDEX IF NOT EXISTS idx_item_instance_owner ON item_instance(owner_user_id, owner_character_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_item_def ON item_instance(item_def_id);
CREATE INDEX IF NOT EXISTS idx_item_instance_location ON item_instance(location);
CREATE INDEX IF NOT EXISTS idx_item_instance_equipped ON item_instance(equipped_slot) WHERE equipped_slot IS NOT NULL;
`;

// ============================================
// 2. 物品使用冷却表（动态）
// ============================================
const itemUseCooldownTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_cooldown (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）
  cooldown_until TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_cooldown IS '物品使用冷却表';
COMMENT ON COLUMN item_use_cooldown.character_id IS '角色ID';
COMMENT ON COLUMN item_use_cooldown.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_use_cooldown.cooldown_until IS '冷却结束时间';

CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_char ON item_use_cooldown(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_cooldown_item ON item_use_cooldown(item_def_id);
`;

// ============================================
// 3. 物品使用次数表（动态）
// ============================================
const itemUseCountTableSQL = `
CREATE TABLE IF NOT EXISTS item_use_count (
  id BIGSERIAL PRIMARY KEY,
  character_id BIGINT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_def_id VARCHAR(64) NOT NULL,                   -- 物品定义ID（静态配置ID）

  daily_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  last_daily_reset DATE NOT NULL DEFAULT CURRENT_DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(character_id, item_def_id)
);

COMMENT ON TABLE item_use_count IS '物品使用次数表';
COMMENT ON COLUMN item_use_count.character_id IS '角色ID';
COMMENT ON COLUMN item_use_count.item_def_id IS '物品定义ID（静态配置ID）';
COMMENT ON COLUMN item_use_count.daily_count IS '当日使用次数';
COMMENT ON COLUMN item_use_count.total_count IS '累计使用次数';
COMMENT ON COLUMN item_use_count.last_daily_reset IS '最后一次日重置日期';

CREATE INDEX IF NOT EXISTS idx_item_use_count_char ON item_use_count(character_id);
CREATE INDEX IF NOT EXISTS idx_item_use_count_item ON item_use_count(item_def_id);
`;

const itemInstanceColumnsToCheck = [
  { name: 'identified', type: 'BOOLEAN NOT NULL DEFAULT true', comment: '是否已鉴定' },
  { name: 'quality', type: 'CHAR(1)', comment: '实例品质（为空则按定义表）' },
  { name: 'quality_rank', type: 'INTEGER', comment: '实例品质排序值（为空则按定义表）' },
  { name: 'affix_gen_version', type: 'INTEGER NOT NULL DEFAULT 1', comment: '词条生成版本号（用于规则升级）' },
  { name: 'affix_roll_meta', type: 'JSONB', comment: '词条生成元信息（预算/参数快照）' },
];

const checkAndAddItemInstanceColumns = async () => {
  for (const col of itemInstanceColumnsToCheck) {
    const checkSQL = `
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'item_instance' AND column_name = $1
    `;
    const result = await query(checkSQL, [col.name]);

    if (result.rows.length === 0) {
      const addSQL = `ALTER TABLE item_instance ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`;
      await query(addSQL);

      const commentSQL = `COMMENT ON COLUMN item_instance.${col.name} IS '${col.comment}'`;
      await query(commentSQL);

      console.log(`物品实例表已添加缺失字段: ${col.name}`);
    }
  }
};

/**
 * 历史版本里动态表对静态定义表有外键依赖。
 * 现在定义改为 JSON 直读，初始化时统一解除这些依赖。
 */
const dropLegacyStaticDefForeignKeys = async () => {
  await query('ALTER TABLE item_instance DROP CONSTRAINT IF EXISTS item_instance_item_def_id_fkey');
  await query('ALTER TABLE item_use_cooldown DROP CONSTRAINT IF EXISTS item_use_cooldown_item_def_id_fkey');
  await query('ALTER TABLE item_use_count DROP CONSTRAINT IF EXISTS item_use_count_item_def_id_fkey');
};

const parseAffixArray = (raw: unknown): unknown[] => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const CURRENT_AFFIX_GEN_VERSION = 5;

const toFiniteNumber = (valueRaw: unknown): number | null => {
  if (typeof valueRaw === 'number' && Number.isFinite(valueRaw)) return valueRaw;
  if (typeof valueRaw === 'string') {
    const parsed = Number(valueRaw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

const resolveAffixRollRatio = (affix: Record<string, unknown>): number | null => {
  const rollRatioRaw = toFiniteNumber(affix.roll_ratio);
  if (rollRatioRaw !== null) {
    return clampNumber(rollRatioRaw, 0, 1);
  }
  const rollPercentRaw = toFiniteNumber(affix.roll_percent);
  if (rollPercentRaw !== null) {
    return clampNumber(rollPercentRaw / 100, 0, 1);
  }
  return null;
};

const normalizeItemInstanceAffixForModifiers = (affixRaw: unknown): {
  changed: boolean;
  normalized: unknown;
} => {
  if (!affixRaw || typeof affixRaw !== 'object') {
    return { changed: false, normalized: affixRaw };
  }

  const affix = { ...(affixRaw as Record<string, unknown>) };
  const applyType = String(affix.apply_type || '').trim().toLowerCase();
  let changed = false;

  if (applyType === 'flat' || applyType === 'percent') {
    const modifiers = normalizeGeneratedAffixModifiers({
      applyType,
      effectType: undefined,
      params: undefined,
      modifiersRaw: affix.modifiers,
      fallbackAttrKeyRaw: affix.attr_key,
      fallbackValueRaw: affix.value,
    });
    if (modifiers.length > 0) {
      const normalizedModifiers = modifiers.map((modifier) => ({
        attr_key: modifier.attr_key,
        value: modifier.value,
      }));
      const previousModifiersText = JSON.stringify(affix.modifiers ?? null);
      const nextModifiersText = JSON.stringify(normalizedModifiers);
      if (previousModifiersText !== nextModifiersText) changed = true;
      affix.modifiers = normalizedModifiers;

      const primaryValue = modifiers[0]?.value ?? 0;
      if (typeof affix.value !== 'number' || !Number.isFinite(affix.value) || affix.value !== primaryValue) {
        affix.value = primaryValue;
        changed = true;
      }
    }
  } else if (applyType === 'special') {
    // special外层不再保留attr_key，触发语义由key与params定义。
  }

  if ('attr_key' in affix) {
    delete affix.attr_key;
    changed = true;
  }

  return { changed, normalized: affix };
};

const normalizeItemInstanceAffixToRating = (
  affixRaw: unknown,
  realmRank: number,
): {
  changed: boolean;
  normalized: unknown;
} => {
  if (!affixRaw || typeof affixRaw !== 'object') {
    return { changed: false, normalized: affixRaw };
  }
  const affix = { ...(affixRaw as Record<string, unknown>) };
  const applyType = String(affix.apply_type || '').trim().toLowerCase();
  if (applyType !== 'flat' && applyType !== 'percent') {
    return { changed: false, normalized: affix };
  }

  const effectiveLevel = getEffectiveLevelByRealmRank(realmRank);
  const modifiersRaw = Array.isArray(affix.modifiers) ? affix.modifiers : [];
  if (modifiersRaw.length <= 0) {
    if (affix.value_type === 'rating') {
      affix.value_type = 'raw';
      delete affix.rating_attr_key;
      return { changed: true, normalized: affix };
    }
    return { changed: false, normalized: affix };
  }

  let changed = false;
  let hasRatingModifier = false;
  let primaryRatingAttrKey: string | undefined;

  const normalizedModifiers = modifiersRaw
    .map((modifierRaw) => {
      if (!modifierRaw || typeof modifierRaw !== 'object') return null;
      const row = modifierRaw as Record<string, unknown>;
      const attrKey = typeof row.attr_key === 'string' ? row.attr_key.trim() : '';
      const value =
        typeof row.value === 'number'
          ? row.value
          : typeof row.value === 'string'
            ? Number(row.value)
            : NaN;
      if (!attrKey || !Number.isFinite(value)) return null;

      const existingBaseKey = resolveRatingBaseAttrKey(attrKey);
      if (existingBaseKey) {
        hasRatingModifier = true;
        if (!primaryRatingAttrKey) primaryRatingAttrKey = attrKey;
        const rounded = Math.round(value);
        if (rounded !== value) changed = true;
        return { attr_key: attrKey, value: rounded };
      }

      if (!isRatioAttrKey(attrKey)) {
        return { attr_key: attrKey, value };
      }
      const ratingAttrKey = toRatingAttrKey(attrKey);
      if (!ratingAttrKey) {
        return { attr_key: attrKey, value };
      }
      const ratingValue = convertPercentToRating(attrKey, value, effectiveLevel);
      if (ratingValue === 0 && value !== 0) {
        return { attr_key: attrKey, value };
      }

      hasRatingModifier = true;
      if (!primaryRatingAttrKey) primaryRatingAttrKey = ratingAttrKey;
      changed = true;
      return { attr_key: ratingAttrKey, value: ratingValue };
    })
    .filter((row): row is { attr_key: string; value: number } => Boolean(row));

  if (normalizedModifiers.length <= 0) {
    return { changed, normalized: affix };
  }

  const beforeModifiers = JSON.stringify(affix.modifiers ?? null);
  const afterModifiers = JSON.stringify(normalizedModifiers);
  if (beforeModifiers !== afterModifiers) changed = true;
  affix.modifiers = normalizedModifiers;

  const primaryValue = normalizedModifiers[0]?.value ?? 0;
  if (typeof affix.value !== 'number' || !Number.isFinite(affix.value) || affix.value !== primaryValue) {
    affix.value = primaryValue;
    changed = true;
  }

  if (hasRatingModifier) {
    if (affix.apply_type !== 'flat') {
      affix.apply_type = 'flat';
      changed = true;
    }
    if (affix.value_type !== 'rating') {
      affix.value_type = 'rating';
      changed = true;
    }
    if (primaryRatingAttrKey && affix.rating_attr_key !== primaryRatingAttrKey) {
      affix.rating_attr_key = primaryRatingAttrKey;
      changed = true;
    }
  } else {
    if (affix.value_type !== 'raw' && affix.value_type !== undefined) {
      changed = true;
    }
    affix.value_type = 'raw';
    if ('rating_attr_key' in affix) {
      delete affix.rating_attr_key;
      changed = true;
    }
  }

  return { changed, normalized: affix };
};

const normalizeItemInstancePercentAffixByConfigV5 = (params: {
  affixRaw: unknown;
  affixDefByKey: Map<string, Record<string, unknown>>;
  attrFactor: number;
}): {
  changed: boolean;
  normalized: unknown;
  recalculated: boolean;
} => {
  if (!params.affixRaw || typeof params.affixRaw !== 'object') {
    return { changed: false, normalized: params.affixRaw, recalculated: false };
  }
  const affix = { ...(params.affixRaw as Record<string, unknown>) };
  const applyType = String(affix.apply_type || '').trim().toLowerCase();
  if (applyType !== 'percent') {
    return { changed: false, normalized: affix, recalculated: false };
  }

  const key = String(affix.key || '').trim();
  if (!key) return { changed: false, normalized: affix, recalculated: false };
  const affixDef = params.affixDefByKey.get(key);
  if (!affixDef) return { changed: false, normalized: affix, recalculated: false };

  const tier = Math.max(1, Math.floor(toFiniteNumber(affix.tier) ?? 1));
  const tierRows = Array.isArray(affixDef.tiers) ? affixDef.tiers : [];
  const tierDef = tierRows.find((tierRaw) => {
    if (!tierRaw || typeof tierRaw !== 'object') return false;
    const row = tierRaw as Record<string, unknown>;
    return Math.max(1, Math.floor(toFiniteNumber(row.tier) ?? 1)) === tier;
  });
  if (!tierDef || typeof tierDef !== 'object') {
    return { changed: false, normalized: affix, recalculated: false };
  }

  const tierRecord = tierDef as Record<string, unknown>;
  const tierMin = toFiniteNumber(tierRecord.min);
  const tierMax = toFiniteNumber(tierRecord.max);
  if (tierMin === null || tierMax === null) {
    return { changed: false, normalized: affix, recalculated: false };
  }

  let rollRatio = resolveAffixRollRatio(affix);
  if (rollRatio === null) {
    const currentValue = toFiniteNumber(affix.value);
    if (currentValue === null) {
      return { changed: false, normalized: affix, recalculated: false };
    }
    const unscaledValue =
      Number.isFinite(params.attrFactor) && params.attrFactor > 0
        ? currentValue / params.attrFactor
        : currentValue;
    const span = tierMax - tierMin;
    rollRatio = span <= Number.EPSILON ? 1 : clampNumber((unscaledValue - tierMin) / span, 0, 1);
  }

  const sampledTierValue = tierMin + (tierMax - tierMin) * rollRatio;
  const rawScaledValue =
    Number.isFinite(params.attrFactor) && params.attrFactor !== 1
      ? sampledTierValue * params.attrFactor
      : sampledTierValue;
  const resolved = buildAffixValueAndModifiers({
    applyType: 'percent',
    keyRaw: affixDef.key,
    effectType: typeof affixDef.effect_type === 'string' ? (affixDef.effect_type as AffixEffectType) : undefined,
    params:
      affixDef.params && typeof affixDef.params === 'object' && !Array.isArray(affixDef.params)
        ? (affixDef.params as AffixParams)
        : undefined,
    modifiersRaw: affixDef.modifiers,
    rawScaledValue,
  });
  if (!resolved) return { changed: false, normalized: affix, recalculated: false };

  let changed = false;
  if (affix.value !== resolved.value) {
    affix.value = resolved.value;
    changed = true;
  }
  const nextModifiers = resolved.modifiers.map((row) => ({ attr_key: row.attr_key, value: row.value }));
  if (JSON.stringify(affix.modifiers ?? null) !== JSON.stringify(nextModifiers)) {
    affix.modifiers = nextModifiers;
    changed = true;
  }
  if (!Number.isFinite(toFiniteNumber(affix.roll_ratio) ?? NaN)) {
    affix.roll_ratio = rollRatio;
    affix.roll_percent = Number((rollRatio * 100).toFixed(2));
    changed = true;
  }
  return { changed, normalized: affix, recalculated: true };
};

const migrateItemInstanceAffixesToModifiers = async (): Promise<void> => {
  const result = await query(
    `
      SELECT id, affixes
      FROM item_instance
      WHERE affixes IS NOT NULL
    `
  );

  let scannedCount = 0;
  let updatedCount = 0;

  for (const row of result.rows as Array<{ id: string | number; affixes: unknown }>) {
    const affixes = parseAffixArray(row.affixes);
    if (affixes.length <= 0) continue;
    scannedCount += 1;

    let changed = false;
    const normalizedAffixes: unknown[] = [];
    for (const affixRaw of affixes) {
      const normalizedAffix = normalizeItemInstanceAffixForModifiers(affixRaw);
      if (normalizedAffix.changed) changed = true;
      normalizedAffixes.push(normalizedAffix.normalized);
    }

    if (!changed) continue;
    updatedCount += 1;
    await query(
      'UPDATE item_instance SET affixes = $1::jsonb, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(normalizedAffixes), row.id]
    );
  }

  console.log(`  → 词条复合结构迁移完成：扫描装备=${scannedCount}，更新装备=${updatedCount}`);
};

const migrateItemInstanceAffixesToRatingV3 = async (): Promise<void> => {
  const result = await query(
    `
      SELECT id, item_def_id, affixes, affix_gen_version
      FROM item_instance
      WHERE affixes IS NOT NULL
    `
  );

  let scannedCount = 0;
  let updatedCount = 0;

  for (const row of result.rows as Array<{
    id: string | number;
    item_def_id: string;
    affixes: unknown;
    affix_gen_version: unknown;
  }>) {
    const affixes = parseAffixArray(row.affixes);
    if (affixes.length <= 0) continue;
    scannedCount += 1;

    const itemDef = getItemDefinitionById(String(row.item_def_id || '').trim());
    const realmRank = getRealmRankOneBasedForEquipment(itemDef?.equip_req_realm);

    let changed = false;
    const normalizedAffixes: unknown[] = [];
    for (const affixRaw of affixes) {
      const normalized = normalizeItemInstanceAffixToRating(affixRaw, realmRank);
      if (normalized.changed) changed = true;
      normalizedAffixes.push(normalized.normalized);
    }

    const currentVersion = Number(row.affix_gen_version);
    const needsVersionUpgrade = !Number.isFinite(currentVersion) || currentVersion < 3;
    if (!changed && !needsVersionUpgrade) continue;

    updatedCount += 1;
    await query(
      `
        UPDATE item_instance
        SET affixes = $1::jsonb,
            affix_gen_version = 3,
            updated_at = NOW()
        WHERE id = $2
      `,
      [JSON.stringify(normalizedAffixes), row.id]
    );
  }

  console.log(`  → 词条Rating迁移完成：扫描装备=${scannedCount}，更新装备=${updatedCount}`);
};

const migrateItemInstancePercentAffixNerfV5 = async (): Promise<void> => {
  const affixPoolById = new Map<string, Map<string, Record<string, unknown>>>();
  for (const poolDef of getAffixPoolDefinitions()) {
    if (poolDef.enabled === false) continue;
    const poolId = String(poolDef.id || '').trim();
    if (!poolId) continue;
    const affixDefByKey = new Map<string, Record<string, unknown>>();
    const affixRows = Array.isArray(poolDef.affixes) ? poolDef.affixes : [];
    for (const affixRaw of affixRows) {
      if (!affixRaw || typeof affixRaw !== 'object') continue;
      const affix = affixRaw as Record<string, unknown>;
      const key = String(affix.key || '').trim();
      if (!key) continue;
      const applyType = String(affix.apply_type || '').trim().toLowerCase();
      if (applyType !== 'percent') continue;
      affixDefByKey.set(key, affix);
    }
    affixPoolById.set(poolId, affixDefByKey);
  }

  const result = await query(
    `
      SELECT id, item_def_id, quality, quality_rank, affixes, affix_gen_version
      FROM item_instance
      WHERE affixes IS NOT NULL
    `
  );

  let scannedCount = 0;
  let updatedCount = 0;
  let recalculatedAffixCount = 0;
  let changedAffixCount = 0;

  for (const row of result.rows as Array<{
    id: string | number;
    item_def_id: unknown;
    quality: unknown;
    quality_rank: unknown;
    affixes: unknown;
    affix_gen_version: unknown;
  }>) {
    const currentVersion = Number(row.affix_gen_version);
    const needsVersionUpgrade = !Number.isFinite(currentVersion) || currentVersion < CURRENT_AFFIX_GEN_VERSION;
    if (!needsVersionUpgrade) continue;

    const affixes = parseAffixArray(row.affixes);
    if (affixes.length <= 0) continue;
    scannedCount += 1;

    const itemDefId = String(row.item_def_id || '').trim();
    const itemDef = getItemDefinitionById(itemDefId);
    const poolId = String(itemDef?.affix_pool_id || '').trim();
    const affixDefByKey = affixPoolById.get(poolId) ?? new Map<string, Record<string, unknown>>();

    const defQualityRank = resolveQualityRankFromName(itemDef?.quality, 1);
    const resolvedQualityRank = Number.isFinite(Number(row.quality_rank))
      ? Math.max(1, Math.floor(Number(row.quality_rank)))
      : resolveQualityRankFromName(row.quality, defQualityRank);
    const defQualityMultiplier = QUALITY_MULTIPLIER_BY_RANK[defQualityRank] ?? 1;
    const resolvedQualityMultiplier = QUALITY_MULTIPLIER_BY_RANK[resolvedQualityRank] ?? 1;
    const attrFactor =
      Number.isFinite(defQualityMultiplier) && defQualityMultiplier > 0
        ? resolvedQualityMultiplier / defQualityMultiplier
        : 1;

    let changed = false;
    const normalizedAffixes: unknown[] = [];
    for (const affixRaw of affixes) {
      const normalized = normalizeItemInstancePercentAffixByConfigV5({
        affixRaw,
        affixDefByKey,
        attrFactor,
      });
      if (normalized.recalculated) {
        recalculatedAffixCount += 1;
      }
      if (normalized.changed) {
        changed = true;
        changedAffixCount += 1;
      }
      normalizedAffixes.push(normalized.normalized);
    }

    updatedCount += 1;
    await query(
      `
        UPDATE item_instance
        SET affixes = $1::jsonb,
            affix_gen_version = $2,
            updated_at = NOW()
        WHERE id = $3
      `,
      [
        JSON.stringify(changed ? normalizedAffixes : affixes),
        CURRENT_AFFIX_GEN_VERSION,
        row.id,
      ]
    );
  }

  console.log(
    `  → 百分比词条配置回溯完成：扫描装备=${scannedCount}，更新装备=${updatedCount}，重算词条=${recalculatedAffixCount}，变更词条=${changedAffixCount}`
  );
};

const migrateTechniqueBookBindTypeForMarket = async (): Promise<void> => {
  const techniqueBookDefIds = getItemDefinitions()
    .filter((itemDef) => itemDef.enabled !== false && String(itemDef.sub_category || '').trim() === 'technique_book')
    .map((itemDef) => String(itemDef.id || '').trim())
    .filter((itemDefId): itemDefId is string => itemDefId.length > 0);

  if (techniqueBookDefIds.length <= 0) {
    console.log('  → 功法书可交易迁移跳过：未找到功法书定义');
    return;
  }

  const result = await query(
    `
      UPDATE item_instance
      SET bind_type = 'none',
          bind_owner_user_id = NULL,
          bind_owner_character_id = NULL,
          updated_at = NOW()
      WHERE item_def_id = ANY($1::varchar[])
        AND bind_type <> 'none'
    `,
    [techniqueBookDefIds],
  );

  const updated = Number(result.rowCount || 0);
  console.log(`  → 功法书可交易迁移完成：更新实例=${updated}`);
};

/**
 * 统一扩容 item_instance.obtained_from 字段长度。
 *
 * 原因：
 * - 业务侧来源标识已包含动态前缀（如 craft-refund:recipe_id / use_item:item_def_id）。
 * - 旧长度 VARCHAR(32) 在部分配置数据下会触发 22001（字符串过长）并中断事务。
 *
 * 边界说明：
 * 1) 仅做“扩容”不做截断，避免损失来源追踪信息。
 * 2) 迁移为幂等执行（通过 migrationKey 控制只执行一次），避免重复 DDL。
 */
const migrateItemInstanceObtainedFromLengthV128 = async (): Promise<void> => {
  await query('ALTER TABLE item_instance ALTER COLUMN obtained_from TYPE VARCHAR(128)');
  await query("COMMENT ON COLUMN item_instance.obtained_from IS '获取来源类型';");
  console.log('  → 物品来源字段扩容完成：item_instance.obtained_from VARCHAR(128)');
};

// ============================================
// 初始化物品系统表
// ============================================
export const initItemTables = async (): Promise<void> => {
  console.log('  → 物品定义/词条池/套装/配方改为静态JSON加载，跳过建表');

  await query(itemInstanceTableSQL);
  await query(itemUseCooldownTableSQL);
  await query(itemUseCountTableSQL);

  await dropLegacyStaticDefForeignKeys();
  await checkAndAddItemInstanceColumns();

  await runDbMigrationOnce({
    migrationKey: 'item_instance_affixes_modifiers_v1',
    description: '将装备词条实例统一迁移为支持modifiers复合结构',
    execute: migrateItemInstanceAffixesToModifiers,
  });

  await runDbMigrationOnce({
    migrationKey: 'item_instance_affixes_rating_v3',
    description: '将装备词条实例统一迁移为Rating语义（value_type=rating）',
    execute: migrateItemInstanceAffixesToRatingV3,
  });

  await runDbMigrationOnce({
    migrationKey: 'item_instance_percent_affix_nerf_v5',
    description: '将历史装备百分比词条数值下调75%并升级词条版本到v5',
    execute: migrateItemInstancePercentAffixNerfV5,
  });

  await runDbMigrationOnce({
    migrationKey: 'item_instance_technique_book_tradeable_v1',
    description: '将历史功法书实例解绑为none以支持坊市交易',
    execute: migrateTechniqueBookBindTypeForMarket,
  });

  await runDbMigrationOnce({
    migrationKey: 'item_instance_obtained_from_v128',
    description: '扩容 item_instance.obtained_from 字段长度到 VARCHAR(128)',
    execute: migrateItemInstanceObtainedFromLengthV128,
  });

  await query("COMMENT ON COLUMN item_instance.identified IS '是否已鉴定';");
  await query("COMMENT ON COLUMN item_instance.quality IS '实例品质（为空则按定义表）';");
  await query("COMMENT ON COLUMN item_instance.quality_rank IS '实例品质排序值（为空则按定义表）';");
  await query("COMMENT ON COLUMN item_instance.affix_gen_version IS '词条生成版本号（用于规则升级）';");
  await query("COMMENT ON COLUMN item_instance.affix_roll_meta IS '词条生成元信息（预算/参数快照）';");

  console.log('✓ 物品系统表检测完成');
};
