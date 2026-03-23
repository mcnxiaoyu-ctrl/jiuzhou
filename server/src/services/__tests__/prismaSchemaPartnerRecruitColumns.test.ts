import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Prisma 伙伴招募表 schema 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住伙伴招募任务表在 Prisma schema 中必须声明的关键运行时列，避免服务层已经依赖布尔列时 schema 漏改。
 * 2. 做什么：复用统一的模型块截取逻辑，让字段断言集中在单一入口，避免每个测试重复手写 schema 文本匹配。
 * 3. 不做什么：不连接数据库，不执行 Prisma CLI，也不校验线上表结构是否已同步。
 *
 * 输入/输出：
 * - 输入：`server/prisma/schema.prisma` 文件内容。
 * - 输出：断言 `partner_recruit_job` 模型内包含运行时代码依赖的关键列定义。
 *
 * 数据流/状态流：
 * - 读取 schema 文件 -> 截取 `partner_recruit_job` 模型块 -> 校验新增列定义存在。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 schema 文本，真实数据库补列仍依赖 Prisma `db push`。
 * 2. 如果未来拆分 Prisma schema 文件，必须同步更新这里的读取路径，否则测试会因定位失败而误报。
 */

const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

const getModelBlock = (modelName: string): string => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const modelPattern = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`);
  const match = schema.match(modelPattern);
  return match?.[0] ?? '';
};

test('partner_recruit_job: Prisma schema 应声明高级招募令模式标记列', () => {
  const block = getModelBlock('partner_recruit_job');
  assert.match(
    block,
    /\bused_custom_base_model_token\s+Boolean\b/,
    'partner_recruit_job 缺少 used_custom_base_model_token 列定义',
  );
});

test('characters: Prisma schema 应声明伙伴招募连续未出天累计字段', () => {
  const block = getModelBlock('characters');
  assert.match(
    block,
    /\bpartner_recruit_generated_non_heaven_count\s+Int\b/,
    'characters 缺少 partner_recruit_generated_non_heaven_count 列定义',
  );
});
