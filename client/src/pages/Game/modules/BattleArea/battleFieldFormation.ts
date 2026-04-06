/**
 * BattleArea 阵型排布规则
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：根据阵营朝向与单位类型，把伙伴固定到指定前后排，并在需要时补空槽位，保证“固定第一行/第二行”是稳定布局而不是简单排序。
 * - 做什么：把“下方阵营伙伴第一行、上方阵营伙伴第二行”的规则集中到单一纯函数，避免 BattleArea、面板组件、样式层各自猜测排布。
 * - 不做什么：不负责尺寸档位、不读 DOM、不做点击和动画逻辑。
 *
 * 输入/输出：
 * - 输入：阵营类型与 BattleUnit 列表。
 * - 输出：BattleFieldFormation，包含固定棋盘、实际渲染列数、已占列数和按网格顺序排好的 cells（含占位空槽）。
 *
 * 数据流/状态流：
 * - BattleArea 归一化单位 -> 本模块生成阵型
 * - BattleTeamPanel 读取 formation -> 设置网格列数并渲染单位/空槽
 *
 * 关键边界条件与坑点：
 * 1. “固定行”不等于“简单排前面/后面”，若不补空槽位，另一类单位会自动补满这一行，视觉上仍然不是前后排分离。
 * 2. 不足 5 人时必须向中间靠拢；如果仍按左对齐补空位，固定 2x5 棋盘会看起来像“贴边站位”。
 */

import type { BattleUnit } from './types';

type BattleTeamSide = 'enemy' | 'ally';

export type BattleFieldFormation = {
  columns: number;
  rows: number;
  occupiedColumnCount: number;
  cells: Array<BattleUnit | null>;
  renderColumns: number;
  renderCells: Array<BattleUnit | null>;
};

const BATTLE_FORMATION_MAX_COLUMNS = 5;
const BATTLE_FORMATION_FIXED_ROWS = 2;
type BattleFieldColumn = {
  firstRowUnit: BattleUnit | null;
  secondRowUnit: BattleUnit | null;
};

const resolveCenteredSlots = (count: number): number[] => {
  if (count <= 0) return [];
  if (count === 1) return [2];
  if (count === 2) return [1, 3];
  if (count === 3) return [1, 2, 3];
  if (count === 4) return [0, 1, 3, 4];
  return [0, 1, 2, 3, 4];
};

const isPartnerUnit = (unit: BattleUnit): boolean => unit.unitType === 'partner';

const buildStandaloneColumn = (
  team: BattleTeamSide,
  unit: BattleUnit,
): BattleFieldColumn => {
  if (team === 'ally') {
    return isPartnerUnit(unit)
      ? { firstRowUnit: unit, secondRowUnit: null }
      : { firstRowUnit: null, secondRowUnit: unit };
  }
  return isPartnerUnit(unit)
    ? { firstRowUnit: null, secondRowUnit: unit }
    : { firstRowUnit: unit, secondRowUnit: null };
};

const buildPairedColumn = (
  team: BattleTeamSide,
  partnerUnit: BattleUnit,
  ownerUnit: BattleUnit,
): BattleFieldColumn => {
  return team === 'ally'
    ? { firstRowUnit: partnerUnit, secondRowUnit: ownerUnit }
    : { firstRowUnit: ownerUnit, secondRowUnit: partnerUnit };
};

const buildColumnFromOwnerAndPartner = (
  team: BattleTeamSide,
  ownerUnit: BattleUnit,
  partnerUnit: BattleUnit | null,
): BattleFieldColumn => {
  if (!partnerUnit) {
    return buildStandaloneColumn(team, ownerUnit);
  }
  return buildPairedColumn(team, partnerUnit, ownerUnit);
};

const resolveBattleFieldColumns = (
  team: BattleTeamSide,
  units: BattleUnit[],
): BattleFieldColumn[] => {
  const orderedUnits = units.slice().sort((leftUnit, rightUnit) => {
    const leftOrder = Number.isFinite(leftUnit.formationOrder)
      ? Number(leftUnit.formationOrder)
      : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(rightUnit.formationOrder)
      ? Number(rightUnit.formationOrder)
      : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return 0;
  });
  const ownerPartnerMap = new Map<string, BattleUnit[]>();
  const standalonePartners: BattleUnit[] = [];

  for (const unit of orderedUnits) {
    if (!isPartnerUnit(unit)) {
      continue;
    }
    const ownerUnitId = typeof unit.ownerUnitId === 'string' ? unit.ownerUnitId.trim() : '';
    if (!ownerUnitId) {
      standalonePartners.push(unit);
      continue;
    }
    const ownerPartners = ownerPartnerMap.get(ownerUnitId) ?? [];
    ownerPartners.push(unit);
    ownerPartnerMap.set(ownerUnitId, ownerPartners);
  }

  const columns: BattleFieldColumn[] = [];

  for (let index = 0; index < orderedUnits.length; index += 1) {
    const currentUnit = orderedUnits[index];
    if (!currentUnit) {
      continue;
    }
    if (isPartnerUnit(currentUnit)) {
      continue;
    }
    const ownedPartners = ownerPartnerMap.get(currentUnit.id) ?? [];
    const matchedPartner = ownedPartners.shift() ?? null;
    if (ownedPartners.length <= 0) {
      ownerPartnerMap.delete(currentUnit.id);
    } else {
      ownerPartnerMap.set(currentUnit.id, ownedPartners);
    }
    columns.push(buildColumnFromOwnerAndPartner(team, currentUnit, matchedPartner));
  }

  for (const partnerUnit of standalonePartners) {
    columns.push(buildStandaloneColumn(team, partnerUnit));
  }
  for (const partnerUnits of ownerPartnerMap.values()) {
    for (const partnerUnit of partnerUnits) {
      columns.push(buildStandaloneColumn(team, partnerUnit));
    }
  }

  return columns;
};

export const resolveBattleFieldFormation = (
  team: BattleTeamSide,
  units: BattleUnit[],
): BattleFieldFormation => {
  const orderedColumns = resolveBattleFieldColumns(team, units).slice(0, BATTLE_FORMATION_MAX_COLUMNS);
  const centeredSlots = resolveCenteredSlots(orderedColumns.length);
  const firstRowCells: Array<BattleUnit | null> = Array.from(
    { length: BATTLE_FORMATION_MAX_COLUMNS },
    () => null,
  );
  const secondRowCells: Array<BattleUnit | null> = Array.from(
    { length: BATTLE_FORMATION_MAX_COLUMNS },
    () => null,
  );

  orderedColumns.forEach((column, index) => {
    const slotIndex = centeredSlots[index];
    if (slotIndex === undefined) {
      return;
    }
    firstRowCells[slotIndex] = column.firstRowUnit;
    secondRowCells[slotIndex] = column.secondRowUnit;
  });

  const occupiedColumnIndexes = Array.from({ length: BATTLE_FORMATION_MAX_COLUMNS }, (_, columnIndex) => columnIndex)
    .filter((columnIndex) => firstRowCells[columnIndex] || secondRowCells[columnIndex]);
  const occupiedColumnCount = occupiedColumnIndexes.length;
  const renderColumns = Math.max(1, occupiedColumnCount);
  const renderFirstRow = occupiedColumnIndexes.length > 0
    ? occupiedColumnIndexes.map((columnIndex) => firstRowCells[columnIndex])
    : [null];
  const renderSecondRow = occupiedColumnIndexes.length > 0
    ? occupiedColumnIndexes.map((columnIndex) => secondRowCells[columnIndex])
    : [null];

  return {
    columns: BATTLE_FORMATION_MAX_COLUMNS,
    rows: BATTLE_FORMATION_FIXED_ROWS,
    occupiedColumnCount,
    cells: [...firstRowCells, ...secondRowCells],
    renderColumns,
    renderCells: [...renderFirstRow, ...renderSecondRow],
  };
};
