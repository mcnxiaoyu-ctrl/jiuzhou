/**
 * AI 生成退款邮件 Markdown 模板测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定洞府研修退款邮件与伙伴招募退款邮件的 Markdown 正文结构，确保邮件详情页能稳定渲染标题、列表与引用。
 * 2. 做什么：验证两条退款链路共用同一套正文组织方式，避免后续重构回退成各自手写换行文本。
 * 3. 不做什么：不发送真实邮件、不连接数据库，也不验证前端样式细节。
 *
 * 输入/输出：
 * - 输入：退款原因，以及洞府研修是否额外返还顿悟符。
 * - 输出：规范化后的 Markdown 邮件正文字符串。
 *
 * 数据流/状态流：
 * 服务层退款原因 -> 共享退款邮件模块 -> 邮件正文字符串 -> 邮件详情页 Markdown 渲染组件。
 *
 * 关键边界条件与坑点：
 * 1. 理由区块必须使用前端已支持的 Markdown 子集；若误用表格、HTML 或嵌套列表，邮件详情页不会按预期展示。
 * 2. 顿悟符返还提示只应出现在洞府研修的对应分支中，不能污染伙伴招募正文。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPartnerRecruitRefundMailMarkdown,
  buildTechniqueResearchRefundMailMarkdown,
} from '../shared/generationRefundMail.js';

test('buildTechniqueResearchRefundMailMarkdown: 应输出包含标题、列表与引用的 markdown 正文', () => {
  assert.equal(
    buildTechniqueResearchRefundMailMarkdown(
      'AI生成异常，已自动退款：模型超时 对应返还已通过邮件发放，请前往邮箱领取。',
      true,
    ),
    [
      '## 结果说明',
      '',
      '本次洞府研修未能成法，系统已将本次返还通过邮件发放。',
      '',
      '- 本次返还已通过邮件附件发放，请及时领取。',
      '- 本次额外消耗的顿悟符也已一并返还。',
      '',
      '## 结算原因',
      '',
      '> AI生成异常，已自动退款：模型超时 对应返还已通过邮件发放，请前往邮箱领取。',
    ].join('\n'),
  );
});

test('buildPartnerRecruitRefundMailMarkdown: 应输出伙伴招募退款 markdown 正文', () => {
  assert.equal(
    buildPartnerRecruitRefundMailMarkdown('伙伴生成失败：底模审核未通过'),
    [
      '## 结果说明',
      '',
      '本次伙伴招募未能成形，系统已将本次消耗通过邮件退回。',
      '',
      '- 本次退回已通过邮件附件发放，请及时领取。',
      '',
      '## 失败原因',
      '',
      '> 伙伴生成失败：底模审核未通过',
    ].join('\n'),
  );
});
