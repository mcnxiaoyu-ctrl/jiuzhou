import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * idle_configs Prisma schema 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住挂机配置模型必须声明的伙伴参战开关字段，避免后续重构时漏掉持久化列。
 * 2. 做什么：把模型截取与字段断言集中在统一辅助函数中，避免多个测试各自复制文本匹配逻辑。
 * 3. 不做什么：不连接数据库、不执行 Prisma CLI，只检查 schema 文本与运行时代码约定是否一致。
 *
 * 输入/输出：
 * - 输入：`server/prisma/schema.prisma` 文件内容。
 * - 输出：断言 `idle_configs` 模型声明 `include_partner_in_battle` 且默认值为 `true`。
 *
 * 数据流/状态流：
 * - 读取 schema 文件 -> 按模型名截取文本块 -> 统一断言关键列存在。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 schema 文本，不验证数据库现状；真实补列仍需后续同步数据库。
 * 2. 若未来拆分 Prisma schema 文件，必须同步更新 `schemaPath` 与模型截取逻辑，否则测试会误报。
 */

const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

const getModelBlock = (modelName: string): string => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const modelPattern = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`);
  const match = schema.match(modelPattern);
  return match?.[0] ?? '';
};

const assertModelHasField = (modelName: string, fieldPattern: RegExp, message: string): void => {
  const block = getModelBlock(modelName);
  assert.match(block, fieldPattern, message);
};

test('idle_configs: Prisma schema 应声明 include_partner_in_battle 列且默认开启', () => {
  assertModelHasField(
    'idle_configs',
    /\binclude_partner_in_battle\s+Boolean\s+@default\(true\)/,
    'idle_configs 缺少 include_partner_in_battle Boolean @default(true) 列定义',
  );
});
