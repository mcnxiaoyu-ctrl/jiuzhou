/**
 * 洞府研修创作方向提示词共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中声明仅供洞府研修使用的创作方向约束，避免把玩家研修特有的“拉开机制差异”要求泄漏到伙伴天生功法链路。
 * 2. 做什么：为研修 service 与提示词测试提供统一 extraContext 结构，避免字段名与规则文案在多处散落。
 * 3. 不做什么：不查询数据库、不拼接最近成功记录，也不直接参与 AI 结果校验。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：稳定的洞府研修创作方向 prompt context。
 *
 * 数据流/状态流：
 * 洞府研修服务 -> buildTechniqueResearchCreativeDirectionPromptContext -> extraContext -> 功法生成共享核心读取。
 *
 * 关键边界条件与坑点：
 * 1. 这里的规则只应描述“怎么拉开创意差异”，不能夹带任何突破品质、层数、数值预算的暗示。
 * 2. 字段名 `techniqueResearchCreativeDirectionRules` 属于洞府研修专属 prompt 协议；若改名，必须同步更新共享约束与测试。
 */
export const TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE =
  '若 extraContext.techniqueResearchCreativeDirectionRules 存在，必须逐条遵守这些洞府研修专属创作方向；重点拉开技能机制骨架与战斗节奏，而不是只换元素、名称或描述外皮';

export const TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES = [
  '优先把差异放在技能机制骨架与战斗节奏上，而不是只换元素、名称或描述外皮；若采用相近主题，也要尽量改换触发条件、资源消耗、效果链条或成长曲线。',
] as const;

export type TechniqueResearchCreativeDirectionPromptContext = {
  techniqueResearchCreativeDirectionRules: string[];
};

export const buildTechniqueResearchCreativeDirectionPromptContext = (): TechniqueResearchCreativeDirectionPromptContext => ({
  techniqueResearchCreativeDirectionRules: [...TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES],
});
