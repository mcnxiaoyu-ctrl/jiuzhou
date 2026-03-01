/**
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验 `getInventoryInfoWithClient` 在“库存行不存在”分支下返回的默认容量是否符合仓库 1000 格设计。
 * - 不做什么：不覆盖真实数据库 I/O，不验证路由层与前端分仓展示逻辑。
 *
 * 输入/输出：
 * - 输入：模拟 `PoolClient.query` 返回序列（先查库存，再插入库存）。
 * - 输出：`InventoryInfo` 结果中的 `bag_capacity` / `warehouse_capacity` / 使用计数。
 *
 * 数据流/状态流：
 * - 测试通过 mock client 捕获 SQL 调用顺序；
 * - 首次查询无行时触发插入；
 * - 断言函数返回默认容量（背包 100、仓库 1000）而非错误回退值。
 *
 * 关键边界条件与坑点：
 * 1) `query` 需要兼容服务层的字符串 SQL 调用方式，避免 mock 签名不匹配导致假阳性。
 * 2) 缺失库存行场景下会发生两次查询（SELECT + INSERT），必须同时断言调用次数和插入语句存在。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { getInventoryInfoWithClient } from "../inventory/index.js";

type QueryCall = {
  text: string;
  values?: unknown[];
};

type QueryResponse = {
  rows: Array<Record<string, unknown>>;
};

const createMockClient = (responses: QueryResponse[]) => {
  let pointer = 0;
  const calls: QueryCall[] = [];

  const client = {
    query: async (text: unknown, values?: unknown[]) => {
      calls.push({ text: String(text), values });
      const response = responses[pointer] ?? { rows: [] };
      pointer += 1;
      return response;
    },
  } as unknown as PoolClient;

  return { client, calls };
};

test("库存行不存在时应返回仓库1000格默认容量", async () => {
  const { client, calls } = createMockClient([{ rows: [] }, { rows: [] }]);

  const info = await getInventoryInfoWithClient(9527, client);

  assert.equal(info.bag_capacity, 100);
  assert.equal(info.warehouse_capacity, 1000);
  assert.equal(info.bag_used, 0);
  assert.equal(info.warehouse_used, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.text ?? "", /INSERT INTO inventory/i);
});

test("库存行存在时应直接返回数据库容量", async () => {
  const expected = {
    bag_capacity: 120,
    warehouse_capacity: 1000,
    bag_used: 3,
    warehouse_used: 888,
  };
  const { client, calls } = createMockClient([{ rows: [expected] }]);

  const info = await getInventoryInfoWithClient(10001, client);

  assert.deepEqual(info, expected);
  assert.equal(calls.length, 1);
});
