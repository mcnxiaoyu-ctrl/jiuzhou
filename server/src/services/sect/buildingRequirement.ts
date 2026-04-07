import { toNumber } from './db.js';
import {
  getSectBuildingUpgradeConfig,
  SECT_BUILDING_MAX_LEVEL,
} from './buildingConfig.js';
import type {
  SectBuildingRequirement,
  SectBuildingRow,
  SectBuildingView,
} from './types.js';

const FULLY_UPGRADED_MESSAGE = '建筑已满级';
const UPGRADE_CLOSED_MESSAGE = '暂未开放';

export const getBuildingUpgradeRequirement = (
  buildingType: string,
  currentLevel: number,
): SectBuildingRequirement => {
  const config = getSectBuildingUpgradeConfig(buildingType);
  if (!config) {
    return {
      upgradable: false,
      maxLevel: SECT_BUILDING_MAX_LEVEL,
      nextLevel: null,
      funds: null,
      buildPoints: null,
      reason: UPGRADE_CLOSED_MESSAGE,
    };
  }

  if (currentLevel >= config.maxLevel) {
    return {
      upgradable: false,
      maxLevel: config.maxLevel,
      nextLevel: null,
      funds: null,
      buildPoints: null,
      reason: FULLY_UPGRADED_MESSAGE,
    };
  }

  const cost = config.getUpgradeCost(currentLevel);
  return {
    upgradable: true,
    maxLevel: config.maxLevel,
    nextLevel: currentLevel + 1,
    funds: cost.funds,
    buildPoints: cost.buildPoints,
    reason: null,
  };
};

export const withBuildingRequirement = (
  building: SectBuildingRow,
): SectBuildingView => {
  const level = toNumber(building.level);
  return {
    ...building,
    level,
    requirement: getBuildingUpgradeRequirement(building.building_type, level),
  };
};

export const buildingUpgradeConstants = {
  BUILDING_MAX_LEVEL: SECT_BUILDING_MAX_LEVEL,
  FULLY_UPGRADED_MESSAGE,
  UPGRADE_CLOSED_MESSAGE,
};
