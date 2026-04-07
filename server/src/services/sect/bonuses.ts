import { pool } from '../../config/database.js';
import { assertMember, toNumber } from './db.js';
import { getForgeHouseEquipmentCostDiscountRate } from './buildingConfig.js';
import type { SectBonuses, SectBuildingRow } from './types.js';

export const calculateSectBonuses = (
  sectLevel: number,
  buildings: SectBuildingRow[],
  memberPosition: string
): SectBonuses => {
  const bonuses: SectBonuses = {
    attrBonus: {},
    expBonus: 0,
    dropBonus: 0,
    craftBonus: 0,
    equipmentGrowthCostDiscount: 0,
  };
  bonuses.expBonus += sectLevel * 2;

  for (const building of buildings) {
    switch (building.building_type) {
      case 'library':
        bonuses.expBonus += building.level * 1;
        break;
      case 'training_hall':
        bonuses.attrBonus['wugong'] = (bonuses.attrBonus['wugong'] || 0) + building.level * 10;
        bonuses.attrBonus['fagong'] = (bonuses.attrBonus['fagong'] || 0) + building.level * 10;
        break;
      case 'alchemy_room':
        bonuses.craftBonus += building.level * 2;
        break;
      case 'forge_house':
        bonuses.equipmentGrowthCostDiscount = getForgeHouseEquipmentCostDiscountRate(building.level);
        break;
      case 'spirit_array':
        bonuses.attrBonus['lingqi_huifu'] = (bonuses.attrBonus['lingqi_huifu'] || 0) + building.level * 5;
        break;
      case 'defense_array':
        bonuses.dropBonus += building.level * 1;
        break;
    }
  }

  const positionBonus: Record<string, number> = {
    leader: 20,
    vice_leader: 15,
    elder: 10,
    elite: 5,
    disciple: 0,
  };
  bonuses.expBonus += positionBonus[memberPosition] || 0;
  return bonuses;
};

export const getSectBonuses = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: SectBonuses }> => {
  const member = await assertMember(characterId);
  const sectRes = await pool.query('SELECT level FROM sect_def WHERE id = $1', [member.sectId]);
  if (sectRes.rows.length === 0) return { success: false, message: '宗门不存在' };
  const level = toNumber(sectRes.rows[0].level);
  const bRes = await pool.query('SELECT * FROM sect_building WHERE sect_id = $1', [member.sectId]);
  const bonuses = calculateSectBonuses(level, bRes.rows as SectBuildingRow[], member.position);
  return { success: true, message: 'ok', data: bonuses };
};
