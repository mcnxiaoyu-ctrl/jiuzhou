/**
 * 库存只读接口 preflight 策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/info` 与 `/inventory/items` 不再挂同步库存实体态 preflight。
 * 2. 做什么：锁定写操作仍然使用 `prepareInventoryConcreteState`，保证使用、移动、装备、拆解等操作面对真实实例。
 * 3. 不做什么：不连接 Redis/PostgreSQL，不启动 HTTP 服务，不断言具体物品数据。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts、inventory/service.ts 源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * GET 只读请求 -> 投影视图读取；POST 写请求 -> prepareInventoryInteraction -> 实体态写操作。
 *
 * 复用设计说明：
 * - 读写边界集中在路由层测试，避免后续新增 GET 路由时复制错误的同步 flush 策略。
 * - service 层测试锁定默认 info 查询不再假设 pending grants 已 flush，所有调用方共享底层 `GetInventoryInfoOptions` 类型入口。
 *
 * 关键边界条件与坑点：
 * 1. 所有写入库存实例、装备状态或消耗材料的路由必须继续保留 preflight，否则会拿到尚未落库的实例 ID。
 * 2. `/inventory/items` 只读列表不展示 pending grant 的虚拟物品 ID，只通过容量 overlay 体现占用。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const extractRouteSource = (
  source: string,
  method: 'get' | 'post',
  path: string,
): string => {
  const startToken = `router.${method}('${path}'`;
  const startIndex = source.indexOf(startToken);
  assert.notEqual(startIndex, -1, `缺少 ${startToken} 路由`);

  const nextRouteIndex = source.indexOf('\nrouter.', startIndex + startToken.length);
  return source.slice(startIndex, nextRouteIndex === -1 ? source.length : nextRouteIndex);
};

const extractInventoryInfoMethodSource = (source: string): string => {
  const startToken = 'async getInventoryInfo(';
  const startIndex = source.indexOf(startToken);
  assert.notEqual(startIndex, -1, '缺少 InventoryService.getInventoryInfo 方法');

  const bodyStartIndex = source.indexOf('{', startIndex);
  assert.notEqual(bodyStartIndex, -1, 'InventoryService.getInventoryInfo 缺少函数体');

  let braceDepth = 0;
  for (let index = bodyStartIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  assert.fail('InventoryService.getInventoryInfo 函数体未闭合');
};

test('库存 GET 只读接口不应挂同步实体态 preflight', () => {
  const source = readSource('../../routes/inventoryRoutes.ts');
  const infoRouteSource = extractRouteSource(source, 'get', '/info');
  const itemsRouteSource = extractRouteSource(source, 'get', '/items');

  assert.match(infoRouteSource, /router\.get\('\/info',\s*asyncHandler/u);
  assert.doesNotMatch(infoRouteSource, /prepareInventoryConcreteState/u);

  assert.match(itemsRouteSource, /router\.get\('\/items',\s*asyncHandler/u);
  assert.doesNotMatch(itemsRouteSource, /prepareInventoryConcreteState/u);
  assert.doesNotMatch(itemsRouteSource, /knownConcreteState:\s*true/u);
});

test('库存写操作路由应保留同步实体态 preflight', () => {
  const source = readSource('../../routes/inventoryRoutes.ts');
  const preflightWriteRoutes = [
    '/craft/execute',
    '/gem/convert',
    '/gem/synthesize',
    '/gem/synthesize/batch',
    '/move',
    '/use',
    '/equip',
    '/unequip',
    '/enhance',
    '/refine',
    '/reroll-affixes',
    '/socket',
    '/disassemble',
    '/disassemble/batch',
    '/remove',
    '/remove/batch',
    '/sort',
    '/lock',
  ] as const;

  for (const routePath of preflightWriteRoutes) {
    const routeSource = extractRouteSource(source, 'post', routePath);
    assert.ok(
      routeSource.startsWith(`router.post('${routePath}', prepareInventoryConcreteState`),
      `${routePath} 必须保留 prepareInventoryConcreteState`,
    );
  }
});

test('InventoryService.getInventoryInfo 默认不应声明 pending grants 已 flush', () => {
  const source = readSource('../inventory/service.ts');
  const methodSource = extractInventoryInfoMethodSource(source);

  assert.match(
    source,
    /import\s+type\s+\{[^}]*\bGetInventoryInfoOptions\b[^}]*\}\s+from\s+["']\.\/bag\.js["'];/u,
  );
  assert.match(methodSource, /options\s*:\s*GetInventoryInfoOptions/u);
  assert.match(methodSource, /options\s*:\s*GetInventoryInfoOptions\s*=\s*\{\}/u);
  assert.match(methodSource, /return\s+getInventoryInfo\(\s*characterId\s*,\s*options\s*\);/u);
  assert.equal(
    methodSource.includes('knownPendingGrantsFlushed: true'),
    false,
    'getInventoryInfo 默认调用不得声明 pending grants 已 flush',
  );
});
