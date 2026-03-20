/**
 * 共享伙伴文本模型请求测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定共享伙伴文本模型请求会把三魂归契素材语境注入到伙伴本体 prompt 输入。
 * 2. 做什么：确保融合入口仍然复用统一请求构造，而不是在 service 中额外拼第二套 userMessage。
 * 3. 不做什么：不请求真实模型、不访问数据库，也不覆盖天生功法生成链路。
 *
 * 输入/输出：
 * - 输入：品质、固定 seed、三魂归契素材参考信息。
 * - 输出：文本模型请求参数中的 userMessage JSON。
 *
 * 数据流/状态流：
 * 三魂归契素材参考 -> buildGeneratedPartnerTextModelRequest -> prompt 输入 JSON -> 文本模型调用。
 *
 * 关键边界条件与坑点：
 * 1. 素材语境必须挂在共享 prompt 输入对象上，否则三魂归契与招募会再次分叉成两套提示词协议。
 * 2. 该语境只用于伙伴本体文本模型，不应隐式污染其他生成链路；测试因此只锁定 request userMessage。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGeneratedPartnerTextModelRequest,
} from '../shared/partnerGeneratedPreview.js';

test('buildGeneratedPartnerTextModelRequest: 应把三魂归契素材参考信息注入伙伴本体 prompt', () => {
  const request = buildGeneratedPartnerTextModelRequest({
    quality: '地',
    seed: 20260320,
    fusionReferencePartners: [
      {
        templateName: '青木小偶',
        description: '青云村木匠启灵而成的小木偶，胆子不大，却总会抢在主人前面挡下第一击。',
        role: '护卫',
        quality: '黄',
        attributeElement: 'mu',
      },
      {
        templateName: '赤砂行者',
        description: '常年走在荒漠商路的砂灵旅者，言语不多，却能从风沙里辨出前路吉凶。',
        role: '游侠',
        quality: '玄',
        attributeElement: 'huo',
      },
      {
        templateName: '玄潮书灵',
        description: '久居旧阁的书卷之灵，性子温润，却会在危急时化字成阵护住同伴。',
        role: '术士',
        quality: '地',
        attributeElement: 'shui',
      },
    ],
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    fusionReferencePartners?: Array<{
      templateName?: string;
      description?: string;
      role?: string;
      quality?: string;
      attributeElement?: string;
    }>;
  };

  assert.deepEqual(parsedUserMessage.fusionReferencePartners, [
    {
      templateName: '青木小偶',
      description: '青云村木匠启灵而成的小木偶，胆子不大，却总会抢在主人前面挡下第一击。',
      role: '护卫',
      quality: '黄',
      attributeElement: 'mu',
    },
    {
      templateName: '赤砂行者',
      description: '常年走在荒漠商路的砂灵旅者，言语不多，却能从风沙里辨出前路吉凶。',
      role: '游侠',
      quality: '玄',
      attributeElement: 'huo',
    },
    {
      templateName: '玄潮书灵',
      description: '久居旧阁的书卷之灵，性子温润，却会在危急时化字成阵护住同伴。',
      role: '术士',
      quality: '地',
      attributeElement: 'shui',
    },
  ]);
});
