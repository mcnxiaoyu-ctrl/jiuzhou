/**
 * 九州修仙录 - 角色功法服务
 * 功能：学习功法、修炼升级、装备功法、技能配置、属性计算
 */
import { query, pool } from '../config/database.js';
import { updateSectionProgress } from './mainQuestService.js';
import { updateAchievementProgress } from './achievementService.js';
import { isCharacterInBattle } from './battleService.js';
import { getRealmRankZeroBased } from './shared/realmOrder.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import { getSkillDefinitions, getTechniqueDefinitions } from './staticConfigLoader.js';

// ============================================
// 类型定义
// ============================================
export interface CharacterTechnique {
  id: number;
  character_id: number;
  technique_id: string;
  current_layer: number;
  slot_type: 'main' | 'sub' | null;
  slot_index: number | null;
  acquired_at: Date;
  // 关联的功法定义
  technique_name?: string;
  technique_type?: string;
  technique_quality?: string;
  max_layer?: number;
  attribute_type?: string;
  attribute_element?: string;
}

export interface CharacterSkillSlot {
  slot_index: number;
  skill_id: string;
  skill_name?: string;
  skill_icon?: string;
}

export interface TechniquePassive {
  key: string;
  value: number;
}

export interface UpgradeCost {
  spirit_stones: number;
  exp: number;
  materials: { itemId: string; qty: number; itemName?: string; itemIcon?: string | null }[];
}

export interface ServiceResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
}


// ============================================
// 辅助函数
// ============================================
const coerceCostMaterials = (raw: unknown): Array<{ itemId: string; qty: number }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const itemId = (x as { itemId?: unknown }).itemId;
      const qty = (x as { qty?: unknown }).qty;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      return { itemId, qty };
    })
    .filter((v): v is { itemId: string; qty: number } => !!v);
};

const getItemMetaMap = async (itemIds: string[]): Promise<Map<string, { name: string; icon: string | null }>> => {
  const uniq = Array.from(new Set(itemIds.filter((x) => typeof x === 'string' && x.trim().length > 0)));
  if (uniq.length === 0) return new Map();
  const result = await query(`SELECT id, name, icon FROM item_def WHERE id = ANY($1::text[]) AND enabled = true`, [uniq]);
  return new Map(result.rows.map((r) => [r.id, { name: r.name, icon: r.icon ?? null }]));
};

const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmRankZeroBased(realmRaw, subRealmRaw);
};

const isRealmSufficient = (currentRealm: unknown, requiredRealm: unknown, currentSubRealm?: unknown): boolean => {
  const required = typeof requiredRealm === 'string' ? requiredRealm.trim() : '';
  if (!required) return true;
  return getRealmRank(currentRealm, currentSubRealm) >= getRealmRank(required);
};

const asStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

const getTechniqueDefMap = () => {
  return new Map(
    getTechniqueDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );
};

const getSkillDefMap = () => {
  return new Map(
    getSkillDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );
};

type EquippedTechniqueLite = {
  techniqueId: string;
  currentLayer: number;
  slotType: 'main' | 'sub';
  slotIndex: number | null;
};

type AvailableSkillEntry = {
  skillId: string;
  techniqueId: string;
  techniqueName: string;
  skillName: string;
  skillIcon: string;
  description: string | null;
  costLingqi: number;
  costQixue: number;
  cooldown: number;
  targetType: string;
  targetCount: number;
  damageType: string | null;
  element: string;
  effects: unknown[];
};

const loadEquippedTechniqueLite = async (characterId: number): Promise<EquippedTechniqueLite[]> => {
  const res = await query(
    `
      SELECT technique_id, current_layer, slot_type, slot_index
      FROM character_technique
      WHERE character_id = $1 AND slot_type IS NOT NULL
    `,
    [characterId],
  );

  return (res.rows as Array<Record<string, unknown>>)
    .map((row) => {
      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
      const currentLayer = Number(row.current_layer ?? 0) || 0;
      const slotType = row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null;
      const slotIndex = row.slot_index === null || row.slot_index === undefined ? null : Number(row.slot_index);
      if (!techniqueId || !slotType) return null;
      return {
        techniqueId,
        currentLayer,
        slotType,
        slotIndex: Number.isFinite(slotIndex ?? NaN) ? Math.floor(Number(slotIndex)) : null,
      };
    })
    .filter((entry): entry is EquippedTechniqueLite => Boolean(entry));
};

const loadAvailableSkillEntries = async (characterId: number): Promise<AvailableSkillEntry[]> => {
  const equipped = await loadEquippedTechniqueLite(characterId);
  if (equipped.length === 0) return [];

  const techniqueIds = Array.from(new Set(equipped.map((entry) => entry.techniqueId)));
  const layerRes = await query(
    `
      SELECT technique_id, layer, unlock_skill_ids
      FROM technique_layer
      WHERE technique_id = ANY($1::varchar[])
    `,
    [techniqueIds],
  );

  const techniqueMap = getTechniqueDefMap();
  const skillMap = getSkillDefMap();
  const maxLayerByTechnique = new Map(equipped.map((entry) => [entry.techniqueId, entry.currentLayer] as const));
  const unlockedByTechnique = new Map<string, Set<string>>();

  for (const row of layerRes.rows as Array<Record<string, unknown>>) {
    const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
    const layer = Number(row.layer ?? 0) || 0;
    const maxLayer = maxLayerByTechnique.get(techniqueId) ?? 0;
    if (!techniqueId || layer <= 0 || layer > maxLayer) continue;
    const skillIds = asStringArray(row.unlock_skill_ids);
    const set = unlockedByTechnique.get(techniqueId) ?? new Set<string>();
    for (const skillId of skillIds) set.add(skillId);
    unlockedByTechnique.set(techniqueId, set);
  }

  const dedup = new Set<string>();
  const entries: AvailableSkillEntry[] = [];
  for (const equippedEntry of equipped) {
    const techniqueDef = techniqueMap.get(equippedEntry.techniqueId);
    const techniqueName = String(techniqueDef?.name || equippedEntry.techniqueId);
    const skillIds = Array.from(unlockedByTechnique.get(equippedEntry.techniqueId) ?? []);
    for (const skillId of skillIds) {
      const skillDef = skillMap.get(skillId);
      if (!skillDef) continue;
      const key = `${equippedEntry.techniqueId}:${skillId}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      entries.push({
        skillId,
        techniqueId: equippedEntry.techniqueId,
        techniqueName,
        skillName: String(skillDef.name || skillId),
        skillIcon: String(skillDef.icon || ''),
        description: typeof skillDef.description === 'string' ? skillDef.description : null,
        costLingqi: Number(skillDef.cost_lingqi ?? 0) || 0,
        costQixue: Number(skillDef.cost_qixue ?? 0) || 0,
        cooldown: Number(skillDef.cooldown ?? 0) || 0,
        targetType: String(skillDef.target_type || ''),
        targetCount: Number(skillDef.target_count ?? 1) || 1,
        damageType: typeof skillDef.damage_type === 'string' ? skillDef.damage_type : null,
        element: String(skillDef.element || 'none'),
        effects: Array.isArray(skillDef.effects) ? skillDef.effects : [],
      });
    }
  }

  return entries.sort((left, right) => left.techniqueName.localeCompare(right.techniqueName) || left.skillName.localeCompare(right.skillName));
};

// ============================================
// 1. 获取角色已学习的功法列表
// ============================================
export const getCharacterTechniques = async (
  characterId: number
): Promise<ServiceResult<CharacterTechnique[]>> => {
  try {
    const result = await query(
      `
        SELECT id, character_id, technique_id, current_layer, slot_type, slot_index, acquired_at
        FROM character_technique
        WHERE character_id = $1
      `,
      [characterId],
    );
    const techniqueMap = getTechniqueDefMap();
    const rowsWithRank: Array<CharacterTechnique & { __quality_rank: number }> = [];
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
      const def = techniqueMap.get(techniqueId);
      if (!def) continue;
      rowsWithRank.push({
        id: Number(row.id ?? 0) || 0,
        character_id: Number(row.character_id ?? 0) || 0,
        technique_id: techniqueId,
        current_layer: Number(row.current_layer ?? 1) || 1,
        slot_type: row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null,
        slot_index: row.slot_index === null || row.slot_index === undefined ? null : Number(row.slot_index),
        acquired_at: row.acquired_at instanceof Date ? row.acquired_at : new Date(String(row.acquired_at ?? '')),
        technique_name: def.name,
        technique_type: def.type,
        technique_quality: def.quality,
        max_layer: Number(def.max_layer ?? 1),
        attribute_type: def.attribute_type ?? 'physical',
        attribute_element: def.attribute_element ?? 'none',
        __quality_rank: Number(def.quality_rank ?? 1),
      });
    }
    const rows = rowsWithRank
      .sort((left, right) => {
        const rank = (slotType: CharacterTechnique['slot_type']): number => (slotType === 'main' ? 0 : slotType === 'sub' ? 1 : 2);
        const slotCmp = rank(left.slot_type) - rank(right.slot_type);
        if (slotCmp !== 0) return slotCmp;
        const leftIndex = left.slot_index ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = right.slot_index ?? Number.MAX_SAFE_INTEGER;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        return right.__quality_rank - left.__quality_rank;
      })
      .map(({ __quality_rank, ...entry }) => entry);
    return { success: true, message: '获取成功', data: rows };
  } catch (error) {
    console.error('获取角色功法失败:', error);
    return { success: false, message: '获取角色功法失败' };
  }
};

// ============================================
// 2. 获取角色已装备的功法（主+副）
// ============================================
export const getEquippedTechniques = async (
  characterId: number
): Promise<ServiceResult<{ main: CharacterTechnique | null; subs: CharacterTechnique[] }>> => {
  try {
    const all = await getCharacterTechniques(characterId);
    if (!all.success) return { success: false, message: all.message };
    
    let main: CharacterTechnique | null = null;
    const subs: CharacterTechnique[] = [];
    
    for (const row of all.data ?? []) {
      if (!row.slot_type) continue;
      if (row.slot_type === 'main') {
        main = row;
      } else if (row.slot_type === 'sub') {
        subs.push(row);
      }
    }
    
    return { success: true, message: '获取成功', data: { main, subs } };
  } catch (error) {
    console.error('获取装备功法失败:', error);
    return { success: false, message: '获取装备功法失败' };
  }
};


// ============================================
// 3. 学习功法
// ============================================
export const learnTechnique = async (
  characterId: number,
  techniqueId: string,
  obtainedFrom: string = 'item',
  obtainedRefId?: string
): Promise<ServiceResult<CharacterTechnique>> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 检查是否已学习
    const existCheck = await client.query(
      'SELECT id FROM character_technique WHERE character_id = $1 AND technique_id = $2',
      [characterId, techniqueId]
    );
    if (existCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '已学习该功法' };
    }
    
    // 检查功法是否存在
    const techniqueDef = getTechniqueDefMap().get(techniqueId) ?? null;
    if (!techniqueDef) {
      await client.query('ROLLBACK');
      return { success: false, message: '功法不存在' };
    }

    const charResult = await client.query(
      'SELECT realm, sub_realm FROM characters WHERE id = $1 LIMIT 1',
      [characterId],
    );
    if (charResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }

    const requiredRealm = typeof techniqueDef.required_realm === 'string' ? techniqueDef.required_realm.trim() : '';
    const currentRealm = charResult.rows[0].realm;
    const currentSubRealm = charResult.rows[0].sub_realm;
    if (!isRealmSufficient(currentRealm, requiredRealm, currentSubRealm)) {
      await client.query('ROLLBACK');
      return { success: false, message: `境界不足，需要达到${requiredRealm}` };
    }
    
    // 插入角色功法记录（初始层数为1）
    const insertResult = await client.query(`
      INSERT INTO character_technique (
        character_id, technique_id, current_layer, 
        obtained_from, obtained_ref_id
      ) VALUES ($1, $2, 1, $3, $4)
      RETURNING *
    `, [characterId, techniqueId, obtainedFrom, obtainedRefId || null]);
    
    await client.query('COMMIT');
    await invalidateCharacterComputedCache(characterId);
    return { 
      success: true, 
      message: `成功学习${techniqueDef.name}`, 
      data: insertResult.rows[0] 
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('学习功法失败:', error);
    return { success: false, message: '学习功法失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 4. 获取功法升级消耗
// ============================================
export const getTechniqueUpgradeCost = async (
  characterId: number,
  techniqueId: string
): Promise<ServiceResult<UpgradeCost & { currentLayer: number; maxLayer: number }>> => {
  try {
    // 获取角色当前功法层数
    const ctResult = await query(
      'SELECT current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      return { success: false, message: '未学习该功法' };
    }
    const currentLayer = ctResult.rows[0].current_layer;
    
    // 获取功法最大层数
    const techniqueDef = getTechniqueDefMap().get(techniqueId) ?? null;
    if (!techniqueDef) {
      return { success: false, message: '功法不存在' };
    }
    const maxLayer = Number(techniqueDef.max_layer ?? 1);
    
    if (currentLayer >= maxLayer) {
      return { success: false, message: '已达最高层数' };
    }
    
    // 获取下一层消耗
    const nextLayer = currentLayer + 1;
    const layerResult = await query(
      'SELECT cost_spirit_stones, cost_exp, cost_materials FROM technique_layer WHERE technique_id = $1 AND layer = $2',
      [techniqueId, nextLayer]
    );
    if (layerResult.rows.length === 0) {
      return { success: false, message: '层级配置不存在' };
    }
    
    const layer = layerResult.rows[0];
    const rawMaterials = coerceCostMaterials(layer.cost_materials);
    const metaMap = await getItemMetaMap(rawMaterials.map((m) => m.itemId));
    const materials = rawMaterials.map((m) => {
      const meta = metaMap.get(m.itemId) ?? null;
      return { itemId: m.itemId, qty: m.qty, itemName: meta?.name, itemIcon: meta?.icon };
    });
    return {
      success: true,
      message: '获取成功',
      data: {
        currentLayer,
        maxLayer,
        spirit_stones: layer.cost_spirit_stones,
        exp: layer.cost_exp,
        materials
      }
    };
  } catch (error) {
    console.error('获取升级消耗失败:', error);
    return { success: false, message: '获取升级消耗失败' };
  }
};


// ============================================
// 5. 修炼升级功法
// ============================================
export const upgradeTechnique = async (
  characterId: number,
  techniqueId: string
): Promise<ServiceResult<{ newLayer: number; unlockedSkills: string[]; upgradedSkills: string[] }>> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 获取角色当前功法层数
    const ctResult = await client.query(
      'SELECT id, current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2 FOR UPDATE',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '未学习该功法' };
    }
    const currentLayer = ctResult.rows[0].current_layer;
    const ctId = ctResult.rows[0].id;
    
    // 获取功法最大层数
    const techniqueDef = getTechniqueDefMap().get(techniqueId) ?? null;
    if (!techniqueDef) {
      await client.query('ROLLBACK');
      return { success: false, message: '功法不存在' };
    }
    const maxLayer = Number(techniqueDef.max_layer ?? 1);
    const techName = techniqueDef.name;
    
    if (currentLayer >= maxLayer) {
      await client.query('ROLLBACK');
      return { success: false, message: '已达最高层数' };
    }
    
    // 获取下一层消耗和奖励
    const nextLayer = currentLayer + 1;
    const layerResult = await client.query(
      `SELECT cost_spirit_stones, cost_exp, cost_materials, 
              unlock_skill_ids, upgrade_skill_ids, required_realm
       FROM technique_layer WHERE technique_id = $1 AND layer = $2`,
      [techniqueId, nextLayer]
    );
    if (layerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '层级配置不存在' };
    }
    
    const layer = layerResult.rows[0];
    const costStones = layer.cost_spirit_stones || 0;
    const costExp = layer.cost_exp || 0;
    const costMaterials = coerceCostMaterials(layer.cost_materials);
    
    // 检查并扣除灵石和经验
    const charResult = await client.query(
      'SELECT spirit_stones, exp, realm, sub_realm FROM characters WHERE id = $1 FOR UPDATE',
      [characterId]
    );
    if (charResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    
    const char = charResult.rows[0];
    const requiredRealm = typeof layer.required_realm === 'string' ? layer.required_realm.trim() : '';
    const currentRealm = char.realm;
    const currentSubRealm = char.sub_realm;
    if (!isRealmSufficient(currentRealm, requiredRealm, currentSubRealm)) {
      await client.query('ROLLBACK');
      return { success: false, message: `境界不足，需要达到${requiredRealm}` };
    }

    if (char.spirit_stones < costStones) {
      await client.query('ROLLBACK');
      return { success: false, message: `灵石不足，需要${costStones}，当前${char.spirit_stones}` };
    }
    if (char.exp < costExp) {
      await client.query('ROLLBACK');
      return { success: false, message: `经验不足，需要${costExp}，当前${char.exp}` };
    }
    
    // 检查并扣除材料
    for (const mat of costMaterials) {
      const matResult = await client.query(
        `SELECT COALESCE(SUM(qty), 0) as total 
         FROM item_instance 
         WHERE owner_character_id = $1 AND item_def_id = $2 AND location IN ('bag', 'warehouse')`,
        [characterId, mat.itemId]
      );
      const totalQty = parseInt(matResult.rows[0].total);
      if (totalQty < mat.qty) {
        // 获取材料名称
        const matNameResult = await client.query('SELECT name FROM item_def WHERE id = $1', [mat.itemId]);
        const matName = matNameResult.rows[0]?.name || mat.itemId;
        await client.query('ROLLBACK');
        return { success: false, message: `材料不足：${matName}，需要${mat.qty}，当前${totalQty}` };
      }
    }
    
    // 扣除灵石和经验
    await client.query(
      'UPDATE characters SET spirit_stones = spirit_stones - $1, exp = exp - $2, updated_at = NOW() WHERE id = $3',
      [costStones, costExp, characterId]
    );
    
    // 扣除材料
    for (const mat of costMaterials) {
      let remainingQty = mat.qty;
      const itemsResult = await client.query(
        `SELECT id, qty FROM item_instance 
         WHERE owner_character_id = $1 AND item_def_id = $2 AND location IN ('bag', 'warehouse')
         ORDER BY qty ASC FOR UPDATE`,
        [characterId, mat.itemId]
      );
      
      for (const item of itemsResult.rows) {
        if (remainingQty <= 0) break;
        
        if (item.qty <= remainingQty) {
          await client.query('DELETE FROM item_instance WHERE id = $1', [item.id]);
          remainingQty -= item.qty;
        } else {
          await client.query(
            'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
            [remainingQty, item.id]
          );
          remainingQty = 0;
        }
      }
    }
    
    // 升级功法层数
    await client.query(
      'UPDATE character_technique SET current_layer = $1, updated_at = NOW() WHERE id = $2',
      [nextLayer, ctId]
    );
    
    await client.query('COMMIT');
    await invalidateCharacterComputedCache(characterId);

    try {
      await updateSectionProgress(characterId, { type: 'upgrade_technique', techniqueId, layer: nextLayer });
    } catch (error) {
      console.error('更新主线功法升级目标失败:', error);
    }
    try {
      await updateAchievementProgress(characterId, 'skill:level:any', 1);
      await updateAchievementProgress(characterId, `skill:level:layer:${nextLayer}`, 1);
      await updateAchievementProgress(characterId, `skill:level:${techniqueId}`, 1);
    } catch {}

    return {
      success: true,
      message: `${techName}修炼至第${nextLayer}层`,
      data: {
        newLayer: nextLayer,
        unlockedSkills: layer.unlock_skill_ids || [],
        upgradedSkills: layer.upgrade_skill_ids || []
      }
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('修炼功法失败:', error);
    return { success: false, message: '修炼功法失败' };
  } finally {
    client.release();
  }
};


// ============================================
// 6. 装备功法到槽位
// ============================================
export const equipTechnique = async (
  characterId: number,
  techniqueId: string,
  slotType: 'main' | 'sub',
  slotIndex?: number // sub时需要指定1-3
): Promise<ServiceResult> => {
  // 检查是否在战斗中
  if (isCharacterInBattle(characterId)) {
    return { success: false, message: '战斗中无法切换功法' };
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 检查是否已学习该功法
    const ctResult = await client.query(
      'SELECT id, slot_type, slot_index FROM character_technique WHERE character_id = $1 AND technique_id = $2 FOR UPDATE',
      [characterId, techniqueId]
    );
    if (ctResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '未学习该功法' };
    }
    
    const ct = ctResult.rows[0];
    const wasMain = ct.slot_type === 'main';
    
    // 如果已装备在目标位置，无需操作
    if (ct.slot_type === slotType && (slotType === 'main' || ct.slot_index === slotIndex)) {
      await client.query('ROLLBACK');
      return { success: true, message: '功法已在该位置' };
    }
    
    if (slotType === 'main') {
      // 卸下当前主功法
      await client.query(
        `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
         WHERE character_id = $1 AND slot_type = 'main'`,
        [characterId]
      );
    } else {
      // 副功法槽位验证
      if (!slotIndex || slotIndex < 1 || slotIndex > 3) {
        await client.query('ROLLBACK');
        return { success: false, message: '副功法槽位必须为1-3' };
      }
      
      // 卸下当前槽位的功法
      await client.query(
        `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
         WHERE character_id = $1 AND slot_type = 'sub' AND slot_index = $2`,
        [characterId, slotIndex]
      );
    }
    
    // 装备新功法
    await client.query(
      `UPDATE character_technique SET slot_type = $1, slot_index = $2, updated_at = NOW()
       WHERE id = $3`,
      [slotType, slotType === 'main' ? null : slotIndex, ct.id]
    );
    
    // 如果装备了主功法，更新角色属性类型
    if (slotType === 'main') {
      const techniqueDef = getTechniqueDefMap().get(techniqueId) ?? null;
      if (techniqueDef) {
        await client.query(
          'UPDATE characters SET attribute_type = $1, attribute_element = $2, updated_at = NOW() WHERE id = $3',
          [techniqueDef.attribute_type ?? 'physical', techniqueDef.attribute_element ?? 'none', characterId]
        );
      }
    } else if (wasMain) {
      const mainResult = await client.query(
        `SELECT technique_id
         FROM character_technique
         WHERE character_id = $1 AND slot_type = 'main'
         LIMIT 1`,
        [characterId]
      );
      if (mainResult.rows.length > 0) {
        const mainTechniqueId = typeof mainResult.rows[0].technique_id === 'string' ? mainResult.rows[0].technique_id : '';
        const mainDef = getTechniqueDefMap().get(mainTechniqueId) ?? null;
        await client.query(
          'UPDATE characters SET attribute_type = $1, attribute_element = $2, updated_at = NOW() WHERE id = $3',
          [mainDef?.attribute_type ?? 'physical', mainDef?.attribute_element ?? 'none', characterId]
        );
      } else {
        await client.query(
          `UPDATE characters SET attribute_type = 'physical', attribute_element = 'none', updated_at = NOW() WHERE id = $1`,
          [characterId]
        );
      }
    }
    
    await client.query('COMMIT');
    await invalidateCharacterComputedCache(characterId);
    return { success: true, message: '装备成功' };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('装备功法失败:', error);
    return { success: false, message: '装备功法失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 7. 卸下功法
// ============================================
export const unequipTechnique = async (
  characterId: number,
  techniqueId: string
): Promise<ServiceResult> => {
  // 检查是否在战斗中
  if (isCharacterInBattle(characterId)) {
    return { success: false, message: '战斗中无法切换功法' };
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      `UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW()
       WHERE character_id = $1 AND technique_id = $2 AND slot_type IS NOT NULL
       RETURNING slot_type`,
      [characterId, techniqueId]
    );
    
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '功法未装备' };
    }
    
    // 如果卸下的是主功法，重置角色属性类型
    if (result.rows[0].slot_type === 'main') {
      await client.query(
        `UPDATE characters SET attribute_type = 'physical', attribute_element = 'none', updated_at = NOW() WHERE id = $1`,
        [characterId]
      );
    }
    
    await client.query('COMMIT');
    await invalidateCharacterComputedCache(characterId);
    return { success: true, message: '卸下成功' };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('卸下功法失败:', error);
    return { success: false, message: '卸下功法失败' };
  } finally {
    client.release();
  }
};


// ============================================
// 8. 获取角色可用技能列表（从已装备功法解锁的技能）
// ============================================
export const getAvailableSkills = async (
  characterId: number
): Promise<ServiceResult<{ 
  skillId: string; 
  skillName: string; 
  skillIcon: string; 
  techniqueId: string; 
  techniqueName: string;
  // 完整技能数据
  description: string | null;
  costLingqi: number;
  costQixue: number;
  cooldown: number;
  targetType: string;
  targetCount: number;
  damageType: string | null;
  element: string;
  effects: unknown[];
}[]>> => {
  try {
    const skills = (await loadAvailableSkillEntries(characterId)).map((row) => ({
      skillId: row.skillId,
      skillName: row.skillName,
      skillIcon: row.skillIcon,
      techniqueId: row.techniqueId,
      techniqueName: row.techniqueName,
      description: row.description,
      costLingqi: row.costLingqi,
      costQixue: row.costQixue,
      cooldown: row.cooldown,
      targetType: row.targetType,
      targetCount: row.targetCount,
      damageType: row.damageType,
      element: row.element,
      effects: row.effects,
    }));
    
    return { success: true, message: '获取成功', data: skills };
  } catch (error) {
    console.error('获取可用技能失败:', error);
    return { success: false, message: '获取可用技能失败' };
  }
};

// ============================================
// 9. 获取角色已装备的技能槽
// ============================================
export const getEquippedSkills = async (
  characterId: number
): Promise<ServiceResult<CharacterSkillSlot[]>> => {
  try {
    const result = await query(
      `
        SELECT slot_index, skill_id
        FROM character_skill_slot
        WHERE character_id = $1
        ORDER BY slot_index
      `,
      [characterId],
    );
    const skillMap = getSkillDefMap();
    const rows = (result.rows as Array<Record<string, unknown>>).map((row) => {
      const skillId = typeof row.skill_id === 'string' ? row.skill_id : '';
      const def = skillMap.get(skillId);
      return {
        slot_index: Number(row.slot_index ?? 0) || 0,
        skill_id: skillId,
        skill_name: String(def?.name || skillId),
        skill_icon: String(def?.icon || ''),
      };
    });
    return { success: true, message: '获取成功', data: rows };
  } catch (error) {
    console.error('获取技能槽失败:', error);
    return { success: false, message: '获取技能槽失败' };
  }
};

// ============================================
// 10. 装备技能到槽位
// ============================================
export const equipSkill = async (
  characterId: number,
  skillId: string,
  slotIndex: number
): Promise<ServiceResult> => {
  if (slotIndex < 1 || slotIndex > 10) {
    return { success: false, message: '技能槽位必须为1-10' };
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 检查技能是否可用（来自已装备功法且已解锁）
    const available = await loadAvailableSkillEntries(characterId);
    if (!available.some((entry) => entry.skillId === skillId)) {
      await client.query('ROLLBACK');
      return { success: false, message: '技能不可用（未解锁或功法未装备）' };
    }
    
    // 检查技能是否已装备在其他槽位
    const existResult = await client.query(
      'SELECT slot_index FROM character_skill_slot WHERE character_id = $1 AND skill_id = $2',
      [characterId, skillId]
    );
    if (existResult.rows.length > 0 && existResult.rows[0].slot_index !== slotIndex) {
      // 从原槽位移除
      await client.query(
        'DELETE FROM character_skill_slot WHERE character_id = $1 AND skill_id = $2',
        [characterId, skillId]
      );
    }
    
    // 装备到目标槽位（替换原有技能）
    await client.query(`
      INSERT INTO character_skill_slot (character_id, slot_index, skill_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (character_id, slot_index) DO UPDATE SET skill_id = $3, updated_at = NOW()
    `, [characterId, slotIndex, skillId]);
    
    await client.query('COMMIT');
    return { success: true, message: '装备成功' };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('装备技能失败:', error);
    return { success: false, message: '装备技能失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 11. 卸下技能
// ============================================
export const unequipSkill = async (
  characterId: number,
  slotIndex: number
): Promise<ServiceResult> => {
  try {
    const result = await query(
      'DELETE FROM character_skill_slot WHERE character_id = $1 AND slot_index = $2',
      [characterId, slotIndex]
    );
    
    if (result.rowCount === 0) {
      return { success: false, message: '该槽位无技能' };
    }
    
    return { success: true, message: '卸下成功' };
  } catch (error) {
    console.error('卸下技能失败:', error);
    return { success: false, message: '卸下技能失败' };
  }
};


// ============================================
// 12. 计算功法被动加成（用于战斗和属性面板）
// ============================================
const calcTechniquePassiveEffectiveValue = (value: number, ratio: number): number => {
  // 百分比统一为比例值后，需要保留更高精度，避免 30% 副功法把小数加成截断成 0。
  return Math.round(value * ratio * 10000) / 10000;
};

export const calculateTechniquePassives = async (
  characterId: number
): Promise<ServiceResult<Record<string, number>>> => {
  try {
    const passiveRows = await query(
      `
        SELECT ct.slot_type, tl.passives
        FROM character_technique ct
        JOIN technique_layer tl
          ON tl.technique_id = ct.technique_id
         AND tl.layer <= ct.current_layer
        WHERE ct.character_id = $1
          AND ct.slot_type IS NOT NULL
      `,
      [characterId],
    );

    const passives: Record<string, number> = {};

    for (const row of passiveRows.rows) {
      const slotType = row.slot_type === 'main' ? 'main' : row.slot_type === 'sub' ? 'sub' : null;
      if (!slotType) continue;

      const ratio = slotType === 'main' ? 1 : 0.3;
      const layerPassives = Array.isArray(row.passives) ? (row.passives as TechniquePassive[]) : [];
      for (const p of layerPassives) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.key !== 'string' || p.key.length === 0) continue;
        if (typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
        const effectiveValue = calcTechniquePassiveEffectiveValue(p.value, ratio);
        passives[p.key] = (passives[p.key] || 0) + effectiveValue;
      }
    }
    
    return { success: true, message: '计算成功', data: passives };
  } catch (error) {
    console.error('计算功法被动失败:', error);
    return { success: false, message: '计算功法被动失败' };
  }
};

// ============================================
// 13. 获取角色战斗技能列表（用于战斗系统）
// ============================================
export const getBattleSkills = async (
  characterId: number
): Promise<ServiceResult<{ skillId: string; upgradeLevel: number }[]>> => {
  try {
    const slotResult = await query(
      'SELECT skill_id FROM character_skill_slot WHERE character_id = $1 ORDER BY slot_index',
      [characterId]
    );

    if (slotResult.rows.length === 0) {
      return { success: true, message: '无装备技能', data: [] };
    }

    const orderedSkillIds = slotResult.rows
      .map((row) => (typeof row.skill_id === 'string' ? row.skill_id.trim() : ''))
      .filter((skillId): skillId is string => skillId.length > 0);

    if (orderedSkillIds.length === 0) {
      return { success: true, message: '无装备技能', data: [] };
    }

    const uniqueSkillIds = [...new Set(orderedSkillIds)];
    const skillMap = getSkillDefMap();
    const techniqueRows = await query(
      `
        SELECT ct.technique_id, tl.upgrade_skill_ids
        FROM character_technique ct
        JOIN technique_layer tl
          ON tl.technique_id = ct.technique_id
         AND tl.layer <= ct.current_layer
        WHERE ct.character_id = $1
      `,
      [characterId],
    );

    const upgradedSkillCountByTechniqueAndSkill = new Map<string, number>();
    for (const row of techniqueRows.rows as Array<Record<string, unknown>>) {
      const techniqueId = typeof row.technique_id === 'string' ? row.technique_id : '';
      if (!techniqueId) continue;
      const upgradedSkillIds = asStringArray(row.upgrade_skill_ids);
      for (const upgradedSkillId of upgradedSkillIds) {
        const key = `${techniqueId}:${upgradedSkillId}`;
        upgradedSkillCountByTechniqueAndSkill.set(key, (upgradedSkillCountByTechniqueAndSkill.get(key) ?? 0) + 1);
      }
    }

    const upgradeLevelBySkillId = new Map<string, number>();
    for (const skillId of uniqueSkillIds) {
      const skillDef = skillMap.get(skillId);
      if (!skillDef) continue;
      if (skillDef.source_type !== 'technique' || typeof skillDef.source_id !== 'string' || !skillDef.source_id) {
        upgradeLevelBySkillId.set(skillId, 0);
        continue;
      }
      const key = `${skillDef.source_id}:${skillId}`;
      const upgradeLevel = upgradedSkillCountByTechniqueAndSkill.get(key) ?? 0;
      upgradeLevelBySkillId.set(skillId, upgradeLevel);
    }

    const skills = orderedSkillIds.map((skillId) => ({
      skillId,
      upgradeLevel: upgradeLevelBySkillId.get(skillId) ?? 0,
    }));

    return { success: true, message: '获取成功', data: skills };
  } catch (error) {
    console.error('获取战斗技能失败:', error);
    return { success: false, message: '获取战斗技能失败' };
  }
};

// ============================================
// 14. 获取完整的角色功法状态（用于前端展示）
// ============================================
export const getCharacterTechniqueStatus = async (
  characterId: number
): Promise<ServiceResult<{
  techniques: CharacterTechnique[];
  equippedMain: CharacterTechnique | null;
  equippedSubs: CharacterTechnique[];
  equippedSkills: CharacterSkillSlot[];
  availableSkills: { 
    skillId: string; 
    skillName: string; 
    skillIcon: string; 
    techniqueId: string;
    techniqueName: string;
    description: string | null;
    costLingqi: number;
    costQixue: number;
    cooldown: number;
    targetType: string;
    targetCount: number;
    damageType: string | null;
    element: string;
    effects: unknown[];
  }[];
  passives: Record<string, number>;
}>> => {
  try {
    const [techniquesRes, equippedRes, skillsRes, availableRes, passivesRes] = await Promise.all([
      getCharacterTechniques(characterId),
      getEquippedTechniques(characterId),
      getEquippedSkills(characterId),
      getAvailableSkills(characterId),
      calculateTechniquePassives(characterId)
    ]);
    
    if (!techniquesRes.success || !equippedRes.success || !skillsRes.success || 
        !availableRes.success || !passivesRes.success) {
      return { success: false, message: '获取功法状态失败' };
    }
    
    return {
      success: true,
      message: '获取成功',
      data: {
        techniques: techniquesRes.data!,
        equippedMain: equippedRes.data!.main,
        equippedSubs: equippedRes.data!.subs,
        equippedSkills: skillsRes.data!,
        availableSkills: availableRes.data!,
        passives: passivesRes.data!
      }
    };
  } catch (error) {
    console.error('获取功法状态失败:', error);
    return { success: false, message: '获取功法状态失败' };
  }
};
