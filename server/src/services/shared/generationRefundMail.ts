/**
 * AI 生成退款邮件 Markdown 共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中构造洞府研修与伙伴招募退款邮件正文，统一输出邮件详情页已支持的 Markdown 子集。
 * 2. 做什么：把“结果说明 + 附件提示 + 原因引用”收敛到单一入口，避免服务层继续散落手写换行和文案结构。
 * 3. 不做什么：不负责退款奖励计算、不负责邮件发送，也不负责前端失败提示文案。
 *
 * 输入/输出：
 * - 输入：退款场景摘要、附件提示、原因标题、原因正文，以及可选的额外说明列表。
 * - 输出：可直接写入邮件 `content` 字段的 Markdown 字符串。
 *
 * 数据流/状态流：
 * 服务层退款原因 -> 本模块统一组织 Markdown 区块 -> mailService.sendMail -> MailMarkdownContent 渲染。
 *
 * 复用设计说明：
 * - 洞府研修与伙伴招募都需要“退款结果 + 附件说明 + 原因详情”这套结构，集中在这里后只保留场景差异字段，减少重复维护。
 * - Markdown 结构是邮件展示的高频变化点，后续若新增其他 AI 生成退款链路，可继续复用内部通用构造器而不必复制模板。
 *
 * 关键边界条件与坑点：
 * 1. 原因文本必须先 `trim`，否则空白字符串会渲染出无意义的引用块，拉低邮件可读性。
 * 2. 这里只能输出前端已支持的标题、列表、引用与段落语法，不能引入表格、HTML 或嵌套列表。
 */

type RefundMailMarkdownSection = {
  summary: string;
  attachmentNotice: string;
  reasonTitle: string;
  reason: string;
  extraNotices?: string[];
};

const buildRefundMailMarkdown = (section: RefundMailMarkdownSection): string => {
  const normalizedReason = section.reason.trim();
  const normalizedExtraNotices = (section.extraNotices ?? []).map((notice) => notice.trim()).filter(Boolean);
  const lines = [
    '## 结果说明',
    '',
    section.summary,
    '',
    `- ${section.attachmentNotice}`,
    ...normalizedExtraNotices.map((notice) => `- ${notice}`),
  ];

  if (!normalizedReason) {
    return lines.join('\n');
  }

  return [
    ...lines,
    '',
    `## ${section.reasonTitle}`,
    '',
    `> ${normalizedReason}`,
  ].join('\n');
};

export const buildTechniqueResearchRefundMailMarkdown = (
  reason: string,
  refundCooldownBypassToken: boolean,
): string => {
  return buildRefundMailMarkdown({
    summary: '本次洞府研修未能成法，系统已将本次返还通过邮件发放。',
    attachmentNotice: '本次返还已通过邮件附件发放，请及时领取。',
    reasonTitle: '结算原因',
    reason,
    extraNotices: refundCooldownBypassToken
      ? ['本次额外消耗的顿悟符也已一并返还。']
      : undefined,
  });
};

export const buildPartnerRecruitRefundMailMarkdown = (reason: string): string => {
  return buildRefundMailMarkdown({
    summary: '本次伙伴招募未能成形，系统已将本次消耗通过邮件退回。',
    attachmentNotice: '本次退回已通过邮件附件发放，请及时领取。',
    reasonTitle: '失败原因',
    reason,
  });
};
