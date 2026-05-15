/**
 * OpenAI 兼容模型识别共享工具
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中识别走 OpenAI 兼容协议但实际由 Gemini 承接的模型配置。
 * 2) 做什么：为文本结构化输出与图片生成参数裁剪提供同一份 provider 判断，避免各链路重复写 URL / 模型名匹配规则。
 * 3) 不做什么：不读取环境变量、不发起请求，也不决定业务失败后的退款或重试策略。
 *
 * 输入/输出：
 * - 输入：已归一化或原始的 OpenAI 兼容 baseURL 与模型名。
 * - 输出：当前配置是否应按 Gemini OpenAI 兼容层处理。
 *
 * 数据流/状态流：
 * modelConfig / 文本模型配置 -> 本模块识别 -> 文本 response_format 转换 / 图片请求参数构造。
 *
 * 复用设计说明：
 * - Gemini 兼容层限制会同时影响文本 JSON Schema 与图片生成参数，判断规则必须集中维护。
 * - 后续若补充 Vertex AI 或新域名，只改这里即可覆盖伙伴招募、功法生成、云游和头像/图标生图链路。
 *
 * 关键边界条件与坑点：
 * 1) 既要识别 Google 官方域名，也要识别第三方转发但模型名仍包含 gemini 的情况。
 * 2) 这里只判断协议特征，不把 Gemini 强行改成独立 provider，避免破坏现有 OpenAI SDK 调用路径。
 */
export type OpenAICompatibleModelSignature = {
    baseURL: string;
    modelName: string;
};

export const isGeminiOpenAICompatibleModel = (
    config: OpenAICompatibleModelSignature,
): boolean => {
    const baseURL = config.baseURL.toLowerCase();
    const modelName = config.modelName.toLowerCase();
    return (
        baseURL.includes('generativelanguage.googleapis.com') ||
        baseURL.includes('aiplatform.googleapis.com') ||
        modelName.includes('gemini')
    );
};