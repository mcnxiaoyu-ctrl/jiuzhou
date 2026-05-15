/**
 * AI 图片模型 client 测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：锁定 OpenAI 兼容图片请求的模型差异化参数构造，尤其是 Gemini 不支持的字段裁剪。
 * 2) 不做什么：不请求真实图片模型、不落盘图片，也不覆盖头像和技能图标的业务 prompt。
 *
 * 输入/输出：
 * - 输入：模型 baseURL、模型名、尺寸与期望返回格式。
 * - 输出：可交给 OpenAI SDK images.generate 的请求 payload。
 *
 * 数据流/状态流：
 * imageModelClient 构造参数 -> OpenAI SDK 图片请求；测试只校验构造结果，不触发网络副作用。
 *
 * 复用设计说明：
 * - 伙伴头像与技能图标共用 imageModelClient，测试这个单入口即可同时保护两条链路。
 * - Gemini 识别规则来自共享协议模块，避免图片链路和文本链路各写一套匹配逻辑。
 *
 * 关键边界条件与坑点：
 * 1) Gemini OpenAI 兼容生图接口会拒绝 response_format，携带该字段会导致 400 unknown_parameter。
 * 2) 只有官方 OpenAI endpoint 保留 response_format；第三方兼容网关可能转发到 Gemini 上游，必须默认省略。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAIImageGenerationPayload } from '../ai/imageModelClient.js';

test('buildOpenAIImageGenerationPayload: Gemini 兼容生图请求必须省略 response_format', () => {
    const payload = buildOpenAIImageGenerationPayload({
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelName: 'gemini-3.1-pro-preview',
        prompt: '生成伙伴头像',
        size: '512x512',
        responseFormat: 'b64_json',
    });

    assert.deepEqual(payload, {
        model: 'gemini-3.1-pro-preview',
        prompt: '生成伙伴头像',
        size: '512x512',
    });
});

test('buildOpenAIImageGenerationPayload: 第三方 OpenAI 兼容网关必须省略 response_format', () => {
    const payload = buildOpenAIImageGenerationPayload({
        baseURL: 'https://api.147ai.cn/v1',
        modelName: 'gpt-image-1.5',
        prompt: '生成伙伴头像',
        size: '512x512',
        responseFormat: 'b64_json',
    });

    assert.deepEqual(payload, {
        model: 'gpt-image-1.5',
        prompt: '生成伙伴头像',
        size: '512x512',
    });
});

test('buildOpenAIImageGenerationPayload: 官方 OpenAI 生图请求应保留 response_format', () => {
    const payload = buildOpenAIImageGenerationPayload({
        baseURL: 'https://api.openai.com/v1',
        modelName: 'gpt-image-1',
        prompt: '生成伙伴头像',
        size: '1024x1024',
        responseFormat: 'b64_json',
    });

    assert.deepEqual(payload, {
        model: 'gpt-image-1',
        prompt: '生成伙伴头像',
        size: '1024x1024',
        response_format: 'b64_json',
    });
});