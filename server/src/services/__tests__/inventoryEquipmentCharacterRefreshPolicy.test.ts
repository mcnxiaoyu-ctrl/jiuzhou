/**
 * 装备操作角色刷新策略测试
 *
 * 作用：锁定洗炼/镶嵌只有在操作已穿戴装备时才刷新角色快照和推送角色更新。
 * 输入/输出：输入为源码文本，输出为策略断言。
 * 数据流：装备实例 location -> affectsCharacter -> 条件 getCharacterComputedByCharacterId -> 路由条件推送。
 * 复用设计说明：`affectsCharacter` 是装备突变返回 DTO 的统一刷新信号，避免路由层重复判断装备位置。
 * 关键边界条件与坑点：
 * 1. 背包/仓库装备变更只影响背包快照，不能触发角色全量重算。
 * 2. 已穿戴装备仍必须刷新角色和战斗状态，否则属性面板与战斗快照会过期。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const equipmentSource = readFileSync(new URL('../inventory/equipment.ts', import.meta.url), 'utf8');
const socketSource = readFileSync(new URL('../inventory/socket.ts', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../../routes/inventoryRoutes.ts', import.meta.url), 'utf8');

test('reroll/socket 应通过 affectsCharacter 控制角色重算', () => {
  assert.match(equipmentSource, /const affectsCharacter = item\.location === "equipped"/u);
  assert.match(equipmentSource, /affectsCharacter\s*\?\s*await getCharacterComputedByCharacterId/u);
  assert.match(socketSource, /const affectsCharacter = equip\.location === "equipped"/u);
  assert.match(socketSource, /affectsCharacter\s*\?\s*await getCharacterComputedByCharacterId/u);
  assert.match(routeSource, /result\.data\?\.affectsCharacter === true/u);
});
