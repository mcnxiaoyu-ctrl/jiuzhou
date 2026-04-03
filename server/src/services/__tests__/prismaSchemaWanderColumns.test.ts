import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Prisma 云游奇遇表 schema 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住云游故事表/幕次表在 Prisma schema 中必须声明的伙伴快照、称号颜色与属性列，避免运行时代码已读写这些字段但 schema 漏改。
 * 2. 做什么：把 schema 文本截取与字段断言保持在单一测试文件里，减少同类回归测试重复样板。
 * 3. 不做什么：不连接数据库，不执行 Prisma CLI，也不校验线上表结构是否已完成同步。
 *
 * 输入/输出：
 * - 输入：`server/prisma/schema.prisma` 文件内容。
 * - 输出：断言 `character_wander_story` / `character_wander_story_episode` 模型内包含伙伴快照、称号颜色与属性字段。
 *
 * 数据流/状态流：
 * 读取 schema 文件 -> 截取模型块 -> 断言关键列存在。
 *
 * 关键边界条件与坑点：
 * 1. 这里只检查 schema 文本，真实补列仍需后续执行 Prisma `db push`。
 * 2. 如果未来拆分 schema 文件或重命名模型，必须同步更新这里的定位逻辑，否则测试会误报。
 */

const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

const getModelBlock = (modelName: string): string => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const modelPattern = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`);
  const match = schema.match(modelPattern);
  return match?.[0] ?? '';
};

test('character_wander_story_episode: Prisma schema 应声明 AI 生成称号颜色与属性列', () => {
  const block = getModelBlock('character_wander_story_episode');
  assert.match(
    block,
    /\breward_title_color\s+String\?\s+@db\.VarChar\(16\)/,
    'character_wander_story_episode 缺少 reward_title_color 列定义',
  );
  assert.match(
    block,
    /\breward_title_effects\s+Json\?/,
    'character_wander_story_episode 缺少 reward_title_effects 列定义',
  );
});

test('character_wander_story: Prisma schema 应声明故事级伙伴快照列', () => {
  const block = getModelBlock('character_wander_story');
  assert.match(
    block,
    /\bstory_partner_snapshot\s+Json\?/,
    'character_wander_story 缺少 story_partner_snapshot 列定义',
  );
});
