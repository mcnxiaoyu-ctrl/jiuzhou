/**
 * 动态伙伴归元洗髓露规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定动态伙伴“归元洗髓露”属性重生成请求必须复用正常 AI 伙伴生成规则，但只请求基础属性字段。
 * 2. 做什么：锁定物品使用链路必须要求 `partnerId`，并由伙伴服务统一更新动态伙伴定义与刷新快照。
 * 3. 不做什么：不直连数据库，不执行真实模型调用，也不覆盖伙伴页 UI 渲染。
 *
 * 输入/输出：
 * - 输入：属性重生成请求构造参数、`itemService.ts` / `partnerService.ts` 源码文本。
 * - 输出：结构化请求断言结果、源码接线断言结果。
 *
 * 数据流/状态流：
 * 伙伴定义原始描述 -> 属性重生成请求 -> `/inventory/use` 伙伴定向效果 -> `partnerService` 更新动态伙伴定义。
 *
 * 关键边界条件与坑点：
 * 1. 洗髓只能重生成 `baseAttrs / levelAttrGains`，不能把 `innateTechniques`、头像或名字重新拉进输出 schema。
 * 2. `partnerId` 缺失时必须在统一物品入口直接拒绝，否则伙伴页与背包页会出现两套目标校验。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildGeneratedPartnerBaseAttrRefreshRequest } from '../shared/partnerGeneratedPreview.js';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('buildGeneratedPartnerBaseAttrRefreshRequest: 应锁定原始描述并只请求基础属性字段', () => {
  const request = buildGeneratedPartnerBaseAttrRefreshRequest({
    quality: '地',
    baseModel: '孤峰剑胚',
    promptNoiseHash: 'partner-recruit-test-hash',
    primaryAttackGrowthTarget: 28,
    partner: {
      name: '玄槐',
      description: '原始描述：山门古槐旁诞生的木灵剑侍，寡言冷静，出手极稳。',
      role: '剑侍',
      attributeElement: 'mu',
      maxTechniqueSlots: 3,
    },
  });

  const prompt = JSON.parse(request.userMessage) as Record<string, unknown>;
  assert.equal(request.responseFormat.type, 'json_schema');
  const schema = request.responseFormat.json_schema.schema;
  const properties = schema.properties as Record<string, unknown>;

  assert.equal(request.baseModel, '孤峰剑胚');
  assert.equal(prompt.quality, '地');
  assert.deepEqual(prompt.lockedFields, ['name', 'description', 'attributeElement', 'role', 'maxTechniqueSlots']);
  assert.deepEqual(prompt.targetPartnerProfile, {
    name: '玄槐',
    originalDescription: '原始描述：山门古槐旁诞生的木灵剑侍，寡言冷静，出手极稳。',
    attributeElement: 'mu',
    role: '剑侍',
    maxTechniqueSlots: 3,
  });
  assert.ok('partner' in properties);
  assert.ok(!('innateTechniques' in properties));

  const partnerSchema = properties.partner as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(partnerSchema.required, ['combatStyle', 'baseAttrs', 'levelAttrGains']);
  assert.ok(partnerSchema.properties);
  assert.ok('combatStyle' in partnerSchema.properties);
  assert.ok('baseAttrs' in partnerSchema.properties);
  assert.ok('levelAttrGains' in partnerSchema.properties);
  assert.ok(!('name' in partnerSchema.properties));
  assert.ok(!('description' in partnerSchema.properties));
});

test('itemService 与 partnerService: 应通过统一物品入口消费归元洗髓露并刷新动态伙伴快照', () => {
  const itemServiceSource = readSource('../itemService.ts');
  const partnerServiceSource = readSource('../partnerService.ts');

  assert.ok(itemServiceSource.includes("effectType === 'reroll_partner_base_attrs'"));
  assert.ok(itemServiceSource.includes("const partnerId = Number(options.partnerId);"));
  assert.ok(itemServiceSource.includes("return { success: false, message: '请选择目标伙伴' };"));
  assert.match(
    itemServiceSource,
    /effectType === 'reroll_partner_base_attrs'[\s\S]*?await partnerService\.rerollGeneratedPartnerBaseAttrsByItem\(\{/u,
  );
  assert.match(
    partnerServiceSource,
    /async rerollGeneratedPartnerBaseAttrsByItem\([\s\S]*?UPDATE generated_partner_def[\s\S]*?base_attrs = \$[\d]+::jsonb[\s\S]*?level_attr_gains = \$[\d]+::jsonb/u,
  );
  assert.match(
    partnerServiceSource,
    /async rerollGeneratedPartnerBaseAttrsByItem\([\s\S]*?refreshGeneratedPartnerSnapshots\(\)[\s\S]*?schedulePartnerBattleStateRefreshByCharacterId\(characterId\)/u,
  );
});
