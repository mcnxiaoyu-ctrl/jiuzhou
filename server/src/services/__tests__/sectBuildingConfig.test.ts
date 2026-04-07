import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGE_HOUSE_BUILDING_TYPE,
  getForgeHouseEquipmentCostDiscountRate,
  getSectBuildingDisplayName,
  getSectBuildingUpgradeConfig,
  HALL_BUILDING_TYPE,
} from '../sect/buildingConfig.js';
import { getBuildingUpgradeRequirement } from '../sect/buildingRequirement.js';
import { applyEquipmentGrowthCostDiscount } from '../inventory/shared/equipmentGrowthCost.js';

test('铁匠铺折扣应按等级每级 0.5% 递增并在 50 级封顶', () => {
  assert.equal(getForgeHouseEquipmentCostDiscountRate(0), 0);
  assert.equal(getForgeHouseEquipmentCostDiscountRate(1), 0.005);
  assert.equal(getForgeHouseEquipmentCostDiscountRate(25), 0.125);
  assert.equal(getForgeHouseEquipmentCostDiscountRate(50), 0.25);
  assert.equal(getForgeHouseEquipmentCostDiscountRate(99), 0.25);
});

test('铁匠铺与宗门大殿都应进入可升级建筑配置', () => {
  const hallConfig = getSectBuildingUpgradeConfig(HALL_BUILDING_TYPE);
  const forgeConfig = getSectBuildingUpgradeConfig(FORGE_HOUSE_BUILDING_TYPE);

  assert.ok(hallConfig);
  assert.ok(forgeConfig);
  assert.equal(getSectBuildingDisplayName(FORGE_HOUSE_BUILDING_TYPE), '铁匠铺');
  assert.equal(getSectBuildingDisplayName(HALL_BUILDING_TYPE), '宗门大殿');
});

test('铁匠铺升级需求应开放到 50 级，其他未开放建筑仍保持关闭', () => {
  const forgeRequirement = getBuildingUpgradeRequirement(FORGE_HOUSE_BUILDING_TYPE, 1);
  const closedRequirement = getBuildingUpgradeRequirement('library', 1);

  assert.equal(forgeRequirement.upgradable, true);
  assert.equal(forgeRequirement.nextLevel, 2);
  assert.equal(forgeRequirement.reason, null);
  assert.equal(closedRequirement.upgradable, false);
  assert.equal(closedRequirement.reason, '暂未开放');
});

test('装备成长折扣应统一下压材料与货币成本，且材料至少保留 1', () => {
  const discounted = applyEquipmentGrowthCostDiscount(
    {
      materialItemDefId: 'enhance-001',
      materialQty: 1,
      silverCost: 125,
      spiritStoneCost: 20,
    },
    0.25,
  );

  assert.deepEqual(discounted, {
    materialItemDefId: 'enhance-001',
    materialQty: 1,
    silverCost: 93,
    spiritStoneCost: 15,
  });
});
