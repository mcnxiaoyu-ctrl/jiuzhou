/**
 * 九州修仙录 - 功法系统数据表
 * 包含：功法定义表、功法层级表、技能定义表、角色功法表、角色技能槽表
 */
import { query } from '../config/database.js';

// ============================================
// 2. 功法层级表 (technique_layer) - 每层配置
// ============================================
const techniqueLayerTableSQL = `
CREATE TABLE IF NOT EXISTS technique_layer (
  id SERIAL PRIMARY KEY,
  technique_id VARCHAR(64) NOT NULL,
  layer INTEGER NOT NULL,                             -- 层数 1-9
  
  -- 升级消耗
  cost_spirit_stones INTEGER NOT NULL DEFAULT 0,      -- 灵石消耗
  cost_exp INTEGER NOT NULL DEFAULT 0,                -- 经验消耗
  cost_materials JSONB DEFAULT '[]',                  -- 材料消耗 [{itemId, qty}]
  
  -- 被动加成（实际数值）
  passives JSONB DEFAULT '[]',                        -- [{key, value}] value为实际数值（比例字段使用1=100%）
  
  -- 技能解锁/强化
  unlock_skill_ids TEXT[] DEFAULT '{}',               -- 本层解锁的技能ID
  upgrade_skill_ids TEXT[] DEFAULT '{}',              -- 本层强化的技能ID
  
  -- 前置条件
  required_realm VARCHAR(50),                         -- 本层境界要求（可选）
  required_quest_id VARCHAR(64),                      -- 前置任务ID（可选）
  
  -- 描述
  layer_desc TEXT,                                    -- 本层描述/心得
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(technique_id, layer)
);

-- 添加表注释
COMMENT ON TABLE technique_layer IS '功法层级表';
COMMENT ON COLUMN technique_layer.technique_id IS '功法ID';
COMMENT ON COLUMN technique_layer.layer IS '层数 1-9';
COMMENT ON COLUMN technique_layer.cost_spirit_stones IS '升级灵石消耗';
COMMENT ON COLUMN technique_layer.cost_exp IS '升级经验消耗';
COMMENT ON COLUMN technique_layer.cost_materials IS '升级材料消耗 [{itemId, qty}]';
COMMENT ON COLUMN technique_layer.passives IS '被动加成 [{key, value}] 实际数值（比例字段1=100%）';
COMMENT ON COLUMN technique_layer.unlock_skill_ids IS '本层解锁的技能ID列表';
COMMENT ON COLUMN technique_layer.upgrade_skill_ids IS '本层强化的技能ID列表';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_technique_layer_tech ON technique_layer(technique_id);
`;

// ============================================
// 4. 角色功法表 (character_technique) - 动态数据
// ============================================
const characterTechniqueTableSQL = `
CREATE TABLE IF NOT EXISTS character_technique (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  technique_id VARCHAR(64) NOT NULL,
  
  current_layer INTEGER DEFAULT 1,                    -- 当前层数
  slot_type VARCHAR(10),                              -- 装备槽：main/sub/null(未装备)
  slot_index INTEGER,                                 -- 副功法槽位 1-3（main时为null）
  
  -- 来源追溯
  obtained_from VARCHAR(32),                          -- 获取来源：drop/shop/quest/sect/gift/admin
  obtained_ref_id VARCHAR(64),                        -- 来源引用ID
  
  acquired_at TIMESTAMPTZ DEFAULT NOW(),              -- 获得时间
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(character_id, technique_id)
);

-- 添加表注释
COMMENT ON TABLE character_technique IS '角色功法表（动态数据）';
COMMENT ON COLUMN character_technique.character_id IS '角色ID';
COMMENT ON COLUMN character_technique.technique_id IS '功法ID';
COMMENT ON COLUMN character_technique.current_layer IS '当前修炼层数';
COMMENT ON COLUMN character_technique.slot_type IS '装备槽类型：main主功法/sub副功法/null未装备';
COMMENT ON COLUMN character_technique.slot_index IS '副功法槽位索引 1-3';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_char_tech_char ON character_technique(character_id);
CREATE INDEX IF NOT EXISTS idx_char_tech_slot ON character_technique(character_id, slot_type);
CREATE INDEX IF NOT EXISTS idx_char_tech_equipped ON character_technique(character_id) WHERE slot_type IS NOT NULL;
`;

// ============================================
// 5. 角色技能槽表 (character_skill_slot) - 动态数据
// ============================================
const characterSkillSlotTableSQL = `
CREATE TABLE IF NOT EXISTS character_skill_slot (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL,                        -- 槽位 1-10
  skill_id VARCHAR(64) NOT NULL,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(character_id, slot_index),
  UNIQUE(character_id, skill_id)
);

-- 添加表注释
COMMENT ON TABLE character_skill_slot IS '角色技能槽表';
COMMENT ON COLUMN character_skill_slot.character_id IS '角色ID';
COMMENT ON COLUMN character_skill_slot.slot_index IS '技能槽位 1-10';
COMMENT ON COLUMN character_skill_slot.skill_id IS '装配的技能ID';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_char_skill_char ON character_skill_slot(character_id);
`;

// ============================================
// 初始化功法系统表
// ============================================
export const initTechniqueTables = async (): Promise<void> => {
  try {
    console.log('  → 功法/技能定义改为静态JSON加载，跳过建表');
    
    // 2. 创建功法层级表
    await query(techniqueLayerTableSQL);
    
    // 4. 创建角色功法表
    await query(characterTechniqueTableSQL);
    
    // 5. 创建角色技能槽表
    await query(characterSkillSlotTableSQL);

    await query('ALTER TABLE technique_layer DROP CONSTRAINT IF EXISTS technique_layer_technique_id_fkey');
    await query('ALTER TABLE character_technique DROP CONSTRAINT IF EXISTS character_technique_technique_id_fkey');
    await query('ALTER TABLE character_skill_slot DROP CONSTRAINT IF EXISTS character_skill_slot_skill_id_fkey');
    
    console.log('✓ 功法系统表检测完成');
  } catch (error) {
    console.error('✗ 功法系统表初始化失败:', error);
    throw error;
  }
};
