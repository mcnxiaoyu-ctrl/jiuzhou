/**
 * 生成功法书封面生成器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：根据生成功法名称、品质、类型与描述调用图像模型，生成独立的功法书封面图。
 * 2) 做什么：把功法书封面 prompt、压缩与统一持久化集中在单模块，供发布功法书链路复用，避免服务层重复维护图片细节。
 * 3) 不做什么：不负责功法发布事务、不直接写数据库，也不处理普通功法书的静态图标。
 *
 * 输入/输出：
 * - 输入：生成功法的展示信息。
 * - 输出：最终功法书封面地址；COS/CDN 启用时为远端 URL，否则为 `/uploads/techniques/*.webp`。
 *
 * 数据流/状态流：
 * 生成功法定义 -> buildGeneratedTechniqueBookCoverPrompt -> imageModelClient -> 压缩 -> generatedImageStorage -> metadata.generatedBookCoverIcon。
 *
 * 关键边界条件与坑点：
 * 1) 这里只服务 `book-generated-technique`，不能把普通功法书静态资源链路混进来，否则物品定义与实例展示会再次分叉。
 * 2) 封面图需要强调“书册封面”而不是技能图标；如果提示词继续沿用技能图标语义，最终成图会不适合背包物品展示。
 */
import sharp from 'sharp';
import {
  downloadImageBuffer,
  generateConfiguredImageAsset,
  OPENAI_IMAGE_GENERATION_MAX_RETRIES,
} from '../ai/imageModelClient.js';
import { readImageModelConfig } from '../ai/modelConfig.js';
import {
  debugImageGenerationLog,
  summarizeImageGenerationError,
} from './imageGenerationDebugShared.js';
import { persistGeneratedImage } from './generatedImageStorage.js';

export type GeneratedTechniqueBookCoverInput = {
  techniqueId: string;
  techniqueName: string;
  quality: string;
  techniqueType: string;
  attributeElement: string;
  description: string;
};

const BOOK_COVER_OUTPUT_WIDTH = 384;
const BOOK_COVER_OUTPUT_HEIGHT = 512;
const BOOK_COVER_OUTPUT_QUALITY = 84;

const buildGeneratedTechniqueBookCoverPrompt = (
  input: GeneratedTechniqueBookCoverInput,
): string => {
  return [
    `生成中国仙侠功法书封面，书名「${input.techniqueName}」`,
    `功法品质：${input.quality}`,
    `功法类型：${input.techniqueType}`,
    `元素倾向：${input.attributeElement}`,
    `功法描述：${input.description}`,
    '主体必须是一本竖版秘籍封面或卷册封面，正面展示，适合游戏背包物品图标裁切。',
    '封面应有明显的封皮、题签、纹样、金线、灵气或元素意象，但不要出现人物头像，不要画成技能徽章。',
    '整体为国风仙侠游戏道具插画，主体完整，背景简化，无文字、英文、水印。',
  ].join('\n');
};

const getSafeTechniqueId = (techniqueId: string): string => {
  return (techniqueId || 'generated-technique')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'generated-technique';
};

const compressGeneratedTechniqueBookCover = async (buffer: Buffer): Promise<Buffer> => {
  return sharp(buffer)
    .rotate()
    .resize({
      width: BOOK_COVER_OUTPUT_WIDTH,
      height: BOOK_COVER_OUTPUT_HEIGHT,
      fit: 'cover',
      withoutEnlargement: false,
    })
    .webp({
      quality: BOOK_COVER_OUTPUT_QUALITY,
      effort: 4,
    })
    .toBuffer();
};

const persistGeneratedTechniqueBookCover = async (
  buffer: Buffer,
  techniqueId: string,
): Promise<string> => {
  const compressed = await compressGeneratedTechniqueBookCover(buffer);
  return persistGeneratedImage({
    buffer: compressed,
    group: 'techniques',
    fileStem: `book-cover-${getSafeTechniqueId(techniqueId)}`,
    contentType: 'image/webp',
    extension: 'webp',
  });
};

export const generateGeneratedTechniqueBookCover = async (
  input: GeneratedTechniqueBookCoverInput,
): Promise<string> => {
  const config = readImageModelConfig();
  if (!config) {
    throw new Error('缺少 AI_TECHNIQUE_IMAGE_MODEL_URL 或 AI_TECHNIQUE_IMAGE_MODEL_KEY 配置');
  }

  const prompt = buildGeneratedTechniqueBookCoverPrompt(input);
  debugImageGenerationLog(
    'generated-technique-book-cover',
    'provider=',
    config.provider,
    'endpoint=',
    config.endpoint,
    'model=',
    config.modelName,
    'retry=',
    config.provider === 'openai' ? OPENAI_IMAGE_GENERATION_MAX_RETRIES : 'none',
    'techniqueId=',
    input.techniqueId,
  );

  try {
    const generated = await generateConfiguredImageAsset(prompt);
    if (!generated) {
      throw new Error('缺少 AI_TECHNIQUE_IMAGE_MODEL_URL 或 AI_TECHNIQUE_IMAGE_MODEL_KEY 配置');
    }

    if (generated.asset.b64) {
      const assetUrl = await persistGeneratedTechniqueBookCover(
        Buffer.from(generated.asset.b64, 'base64'),
        input.techniqueId,
      );
      debugImageGenerationLog('generated-technique-book-cover', 'persisted from b64:', assetUrl);
      return assetUrl;
    }

    if (generated.asset.url) {
      const buffer = await downloadImageBuffer(generated.asset.url, generated.timeoutMs);
      const assetUrl = await persistGeneratedTechniqueBookCover(buffer, input.techniqueId);
      debugImageGenerationLog('generated-technique-book-cover', 'persisted from url:', assetUrl);
      return assetUrl;
    }

    throw new Error('图像模型未返回可用图片数据');
  } catch (error) {
    const summary = summarizeImageGenerationError(error instanceof Error ? error : String(error));
    debugImageGenerationLog('generated-technique-book-cover', 'generate failed:', summary);
    throw new Error(`生成功法书封面失败：${summary}`);
  }
};
