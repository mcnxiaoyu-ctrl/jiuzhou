/**
 * 作用：
 * 1) 基于指定装备套装（set_id）调用火山方舟 `doubao-seedream-5-0-260128` 生成一张“1图8件”大图。
 * 2) 基于本地 RMBG-2.0（ModelScope: `AI-ModelScope/RMBG-2.0`）对整图按 4x2 网格逐格抠图。
 * 3) 对每张抠图子图做白底残留清理与 alpha 紧裁，导出最终 PNG 素材。
 *
 * 不做什么：
 * 1) 不做旧流程兼容（不再走“单件独立生成”流程）。
 * 2) 不做接口失败兜底与重试，出现错误直接抛出并终止。
 *
 * 输入 / 输出：
 * - 输入：CLI 参数（必须包含 `--set-id`），环境变量 `ARK_API_KEY` + RMBG 本地配置，seeds 文件 `equipment_def.json`。
 * - 输出：
 *   a) `<outputDir>/<setId>-sheet.png`（方舟原始大图）
 *   b) `<outputDir>/<setId>-sheet-matted.png`（本地 RMBG 抠图后大图）
 *   c) `<outputDir>/01-*.png ... 08-*.png`（最终切图素材）
 *   d) `<outputDir>/<setId>-manifest.json`（切图元数据）
 *
 * 数据流 / 状态流：
 * 1) 读取套装装备定义 -> 2) 生成大图 Prompt -> 3) 请求方舟接口拿到大图 ->
 * 4) 按 4x2 网格逐格调用本地 RMBG-2.0 抠图 -> 5) 白底清理 + alpha 紧裁 -> 6) 输出素材与 manifest。
 *
 * 关键边界条件与坑点：
 * 1) `equipment_def.json` 中套装必须精确 8 件且槽位完整（weapon/head/clothes/gloves/pants/necklace/accessory/artifact）。
 * 2) `size` 必须是 `宽x高`，且像素总数必须 >= 3686400（模型硬约束，脚本本地先校验）。
 * 3) RMBG 本地推理首次执行会自动创建 `server/.venv-rmbg` 并安装依赖，耗时取决于网络与磁盘速度。
 * 4) 抠图后仍可能存在格子留白；因此每张切图必须按 alpha 再做紧裁。
 * 5) `ARK_API_KEY` 缺失会立即失败；RMBG 运行依赖系统 `python3` 用于创建虚拟环境。
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const ARK_IMAGE_API_URL =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const ARK_MODEL_ID = "doubao-seedream-5-0-260128";
const RMBG_DEFAULT_MODEL_ID = "AI-ModelScope/RMBG-2.0";
const RMBG_DEFAULT_DEVICE = "auto";
const RMBG_BOOTSTRAP_PYTHON_BIN = "python3";
const RMBG_DEFAULT_CACHE_DIR = path.resolve(
  __dirname,
  "../../.cache/modelscope",
);
const RMBG_VENV_DIR = path.resolve(__dirname, "../../.venv-rmbg");
const RMBG_VENV_PYTHON_BIN = path.join(RMBG_VENV_DIR, "bin", "python");
const RMBG_VENV_PIP_BIN = path.join(RMBG_VENV_DIR, "bin", "pip");
const RMBG_PYTHON_ENTRY_PATH = path.resolve(
  __dirname,
  "./rmbg_remove_background.py",
);
const RMBG_REQUIREMENTS_PATH = path.resolve(
  __dirname,
  "./rmbg_requirements.txt",
);
const RMBG_IMPORT_CHECK_CODE =
  'import numpy, torch, torchvision, transformers, modelscope, PIL, kornia, timm; assert int(transformers.__version__.split(".")[0]) < 5, transformers.__version__';
const GRID_COLUMNS = 4;
const GRID_ROWS = 2;
const REQUIRED_PIECE_COUNT = 8;
const MIN_IMAGE_PIXELS = 3_686_400;
const DEFAULT_SIZE = "3072x1536";
const SPRITE_TRIM_ALPHA_THRESHOLD = 18;
const SPRITE_TRIM_PADDING = 16;
const SPRITE_BG_CLEAN_ALPHA_MIN = 6;
const SPRITE_BG_CLEAN_WHITE_MIN = 228;
const SPRITE_BG_CLEAN_CHROMA_MAX = 18;
const SPRITE_EDGE_DECONTAM_SAMPLE_BORDER = 12;
const SPRITE_EDGE_DECONTAM_ALPHA_MIN = 8;
const SPRITE_EDGE_DECONTAM_ALPHA_MAX = 248;
const SPRITE_EDGE_DECONTAM_BG_DIFF_MAX = 24;
const SPRITE_EDGE_DECONTAM_CHROMA_MAX = 28;
const SPRITE_EDGE_DECONTAM_ALPHA_SUPPRESS_FACTOR = 0.38;
const EQUIPMENT_SEED_FILE_PATH = path.resolve(
  __dirname,
  "../data/seeds/equipment_def.json",
);
const DEFAULT_OUTPUT_ROOT_DIR = path.resolve(
  __dirname,
  "../../generated/equipment-set-sprites",
);

const SLOT_ORDER = [
  "weapon",
  "head",
  "clothes",
  "gloves",
  "pants",
  "necklace",
  "accessory",
  "artifact",
] as const;

type EquipSlot = (typeof SLOT_ORDER)[number];

const SLOT_LABEL_MAP: Record<EquipSlot, string> = {
  weapon: "武器",
  head: "头部",
  clothes: "衣服",
  gloves: "手套",
  pants: "下装",
  necklace: "项链",
  accessory: "戒指/配饰",
  artifact: "法宝",
};

interface CliOptions {
  setId: string;
  outputDir: string;
  size: string;
  promptExtra: string;
  seed?: number;
}

interface EquipmentSeedItem {
  id: string;
  name: string;
  set_id?: string;
  equip_slot?: string;
}

interface EquipmentSeedFile {
  items: EquipmentSeedItem[];
}

interface SetPiece {
  id: string;
  name: string;
  setId: string;
  equipSlot: EquipSlot;
}

interface ArkImageGenerationRequest {
  model: string;
  prompt: string;
  size: string;
  response_format: "b64_json";
  sequential_image_generation: "disabled";
  stream: false;
  watermark: false;
  seed?: number;
}

interface ArkImageGenerationDataItem {
  b64_json?: string;
  error?: {
    code?: string;
    message?: string;
  };
}

interface ArkImageGenerationResponse {
  data?: ArkImageGenerationDataItem[];
}

interface SpriteManifestItem {
  index: number;
  equipSlot: EquipSlot;
  equipSlotLabel: string;
  itemId: string;
  itemName: string;
  file: string;
}

interface SpriteManifest {
  setId: string;
  model: string;
  generationMode: "single-sheet+rmbg-local";
  generatedAt: string;
  sourceSheet: string;
  mattedSheet: string;
  prompt: string;
  sprites: SpriteManifestItem[];
}

interface LocalRmbgRuntimeConfig {
  pythonBin: string;
  modelId: string;
  cacheDir: string;
  device: "auto" | "cpu" | "cuda";
}

interface SpriteExportResult {
  sprites: SpriteManifestItem[];
  mattedSheetBuffer: Buffer;
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/**
 * 判断字符串是否为受支持的装备槽位。
 */
const isEquipSlot = (value: string): value is EquipSlot => {
  return SLOT_ORDER.includes(value as EquipSlot);
};

/**
 * 输出 CLI 用法说明。
 */
const printUsage = (): void => {
  console.log(`
用法：
  pnpm --filter ./server asset:generate-set-sprites -- --set-id <setId> [--output-dir <dir>] [--size <WxH>] [--seed <number>] [--prompt-extra <text>]

必填参数：
  --set-id       装备套装ID（来源：equipment_def.json 的 set_id）

可选参数：
  --output-dir   输出目录（默认：server/generated/equipment-set-sprites/<setId>）
  --size         大图生图尺寸（默认：${DEFAULT_SIZE}，像素总数必须 >= ${MIN_IMAGE_PIXELS}）
  --seed         生图随机种子（整数）
  --prompt-extra 追加到 Prompt 末尾的额外要求
  --help         显示本帮助

前置依赖：
  1) 系统 python3 可用（用于自动创建虚拟环境）
  2) 脚本会自动创建 server/.venv-rmbg 并自动安装 src/scripts/rmbg_requirements.txt
`);
};

/**
 * 校验并标准化 `宽x高` 尺寸字符串。
 */
const normalizeAndValidateSize = (sizeRaw: string): string => {
  const normalized = sizeRaw.trim().toLowerCase();
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) {
    throw new Error(
      "参数错误：`--size` 必须是 `宽x高` 像素格式，例如 `3072x1536`。",
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("参数错误：`--size` 的宽高必须是正整数。");
  }

  const pixels = width * height;
  if (pixels < MIN_IMAGE_PIXELS) {
    throw new Error(
      `参数错误：当前尺寸 ${width}x${height} 像素总数为 ${pixels}，低于模型要求 ${MIN_IMAGE_PIXELS}。`,
    );
  }

  if (width % GRID_COLUMNS !== 0 || height % GRID_ROWS !== 0) {
    throw new Error(
      `参数错误：为保证按 ${GRID_COLUMNS}x${GRID_ROWS} 统一尺寸裁切，宽高必须分别能被 ${GRID_COLUMNS} 和 ${GRID_ROWS} 整除，当前为 ${width}x${height}。`,
    );
  }

  return `${width}x${height}`;
};

/**
 * 解析命令行参数。
 */
const parseCliOptions = (argv: string[]): CliOptions => {
  let setId = "";
  let outputDirArg = "";
  let size = DEFAULT_SIZE;
  let promptExtra = "";
  let seed: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--") {
      continue;
    }

    if (current === "--help") {
      printUsage();
      process.exit(0);
    }

    if (current === "--set-id") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("参数错误：`--set-id` 缺少值。");
      }
      setId = value.trim();
      index += 1;
      continue;
    }

    if (current === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("参数错误：`--output-dir` 缺少值。");
      }
      outputDirArg = value.trim();
      index += 1;
      continue;
    }

    if (current === "--size") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("参数错误：`--size` 缺少值。");
      }
      size = normalizeAndValidateSize(value);
      index += 1;
      continue;
    }

    if (current === "--prompt-extra") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("参数错误：`--prompt-extra` 缺少值。");
      }
      promptExtra = value.trim();
      index += 1;
      continue;
    }

    if (current === "--seed") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("参数错误：`--seed` 缺少值。");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error("参数错误：`--seed` 必须是整数。");
      }
      seed = parsed;
      index += 1;
      continue;
    }

    throw new Error(`参数错误：不支持的参数 ${current}`);
  }

  if (!setId) {
    throw new Error("参数错误：缺少必填参数 `--set-id`。");
  }

  size = normalizeAndValidateSize(size);

  const outputDir = outputDirArg
    ? path.resolve(process.cwd(), outputDirArg)
    : path.join(DEFAULT_OUTPUT_ROOT_DIR, setId);

  return {
    setId,
    outputDir,
    size,
    promptExtra,
    seed,
  };
};

/**
 * 从 equipment_def.json 读取套装 8 件数据并做结构化校验。
 */
const loadSetPieces = async (setId: string): Promise<SetPiece[]> => {
  const raw = await fs.readFile(EQUIPMENT_SEED_FILE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as EquipmentSeedFile;

  if (!Array.isArray(parsed.items)) {
    throw new Error("数据错误：equipment_def.json 缺少 `items` 数组。");
  }

  const pieces = parsed.items
    .filter(
      (entry) =>
        typeof entry?.set_id === "string" && entry.set_id.trim() === setId,
    )
    .map((entry) => {
      const equipSlotRaw = String(entry.equip_slot ?? "").trim();
      if (!isEquipSlot(equipSlotRaw)) {
        throw new Error(
          `数据错误：套装 ${setId} 存在非法槽位 ${equipSlotRaw || "(空)"}。`,
        );
      }

      return {
        id: String(entry.id ?? "").trim(),
        name: String(entry.name ?? "").trim(),
        setId,
        equipSlot: equipSlotRaw,
      } satisfies SetPiece;
    });

  if (pieces.length !== REQUIRED_PIECE_COUNT) {
    const supportedSetIds = Array.from(
      new Set(
        parsed.items
          .map((entry) => String(entry.set_id ?? "").trim())
          .filter((entry) => entry.length > 0),
      ),
    ).sort((left, right) => left.localeCompare(right));

    throw new Error(
      `数据错误：套装 ${setId} 在 equipment_def.json 中数量为 ${pieces.length}，要求必须是 ${REQUIRED_PIECE_COUNT} 件。可用 set_id：${supportedSetIds.join(", ")}`,
    );
  }

  const pieceBySlot = new Map<EquipSlot, SetPiece>();
  for (const piece of pieces) {
    if (pieceBySlot.has(piece.equipSlot)) {
      throw new Error(
        `数据错误：套装 ${setId} 在槽位 ${piece.equipSlot} 出现重复定义。`,
      );
    }
    if (!piece.id || !piece.name) {
      throw new Error(`数据错误：套装 ${setId} 存在空的装备 id/name。`);
    }
    pieceBySlot.set(piece.equipSlot, piece);
  }

  return SLOT_ORDER.map((slot) => {
    const piece = pieceBySlot.get(slot);
    if (!piece) {
      throw new Error(`数据错误：套装 ${setId} 缺少槽位 ${slot}。`);
    }
    return piece;
  });
};

/**
 * 构建“1图8件”生图 Prompt。
 */
const buildSheetPrompt = (
  setId: string,
  pieces: SetPiece[],
  promptExtra: string,
): string => {
  const pieceText = pieces
    .map((piece) => `${SLOT_LABEL_MAP[piece.equipSlot]}=${piece.name}`)
    .join("，");

  const segments = [
    `请生成一张国风仙侠游戏UI装备图标素材图，必须只包含8件装备。`,
    `套装ID：${setId}。`,
    `8件装备固定排布为4列2行网格，每格仅1件，从左到右、从上到下的槽位顺序固定为：武器、头部、衣服、手套、下装、项链、戒指/配饰、法宝。`,
    `对应装备名称为：${pieceText}。`,
    `构图安全区要求：每件装备主体（含发光外沿）必须完整位于所在格子内，四边至少预留10%安全留白；若空间不足必须缩小物体，不可贴边、不可截断。`,
    `长柄/长刃类武器必须完整入框，尖端与柄端都不可触碰格子边缘。`,
    `套装一致性要求：8件必须被识别为同一套装，不是8件散装道具；先定义统一“视觉圣经”，包含主色1个、辅色1个、点缀色1个，并在全部8件中严格复用。`,
    `配色要求：所有宝石/能量体/发光部位使用同一色相家族，不允许红绿紫蓝混搭跳色；金属与布料的明度关系保持一致。`,
    `纹样要求：统一使用中式仙侠语汇（云纹、回纹、玉雕纹、符纹其一或组合），同一纹样要在多件装备重复出现，强化套装感。`,
    `整体风格要求：经典游戏道具图标风，2D手绘厚涂，轮廓清晰，体积光影明确；保留适度夸张但不要Q版。`,
    `文化风格要求：明确中国仙侠/东方古风审美，服装结构偏中式交领、宽袖、系带；头饰是中式冠饰，不是西式王冠。`,
    `装备主体必须完整、居中、清晰，不可互相遮挡，不可超出格子可视范围；每格只表现单个装备图标，不要额外装饰物。`,
    `严格禁止：背景卡片、格子边框、分隔线、文字、logo、水印、人物、地台、展示底座、棋盘格透明底纹、多余阴影块。`,
    `严格禁止风格：欧美西幻元素（十字徽记、骑士板甲、西式礼服剪裁、西式皮手套主导造型）、电商白底产品渲染风、低对比灰白雾面风、过于素净写实静物风。`,
    `严格禁止任何数字或序号标注（包括但不限于 1~8、罗马数字、角标、编号标签）；这些顺序信息仅用于生成约束，不得出现在画面中。`,
    `背景要求：统一纯净浅色背景（接近纯白），背景尽量平整无纹理，便于整图抠图后再裁切。`,
  ];

  if (promptExtra) {
    segments.push(`额外要求：${promptExtra}`);
  }

  return segments.join(" ");
};

/**
 * 调用方舟图像接口并返回首张图片二进制。
 */
const requestArkSheetImageBuffer = async (
  prompt: string,
  size: string,
  seed?: number,
): Promise<Buffer> => {
  const apiKey = String(process.env.ARK_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("环境变量错误：缺少 `ARK_API_KEY`。");
  }

  const requestBody: ArkImageGenerationRequest = {
    model: ARK_MODEL_ID,
    prompt,
    size,
    response_format: "b64_json",
    sequential_image_generation: "disabled",
    stream: false,
    watermark: false,
    ...(seed === undefined ? {} : { seed }),
  };

  const response = await fetch(ARK_IMAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `方舟接口调用失败：HTTP ${response.status}，响应：${errorText}`,
    );
  }

  const payload = (await response.json()) as ArkImageGenerationResponse;
  const first = payload.data?.[0];
  if (!first) {
    throw new Error("方舟接口调用失败：返回 data 为空。");
  }

  if (first.error) {
    throw new Error(
      `方舟接口调用失败：${String(first.error.code ?? "UNKNOWN")} ${String(first.error.message ?? "无错误详情")}`,
    );
  }

  const b64 = String(first.b64_json ?? "").trim();
  if (!b64) {
    throw new Error("方舟接口调用失败：返回结果不包含 b64_json。");
  }

  return Buffer.from(b64, "base64");
};

/**
 * 解析本地 RMBG 推理配置，统一入口避免在多个调用点重复拼装。
 *
 * 输入：
 * - 进程环境变量（可选）：
 *   1) `RMBG_MODELSCOPE_MODEL_ID`（默认 `AI-ModelScope/RMBG-2.0`）
 *   2) `RMBG_MODELSCOPE_CACHE_DIR`（默认 `server/.cache/modelscope`）
 *   3) `RMBG_DEVICE`（`auto` / `cpu` / `cuda`，默认 `auto`）
 *
 * 输出：
 * - 标准化后的本地推理配置对象。
 *
 * 关键边界条件：
 * 1) `RMBG_DEVICE` 仅允许 `auto/cpu/cuda`，其他值直接失败，避免静默落到未知行为。
 * 2) 相对缓存目录会被解析为相对于当前工作目录的绝对路径，确保 Python 侧拿到稳定路径。
 */
const resolveLocalRmbgRuntimeConfig = (): LocalRmbgRuntimeConfig => {
  const modelId =
    String(process.env.RMBG_MODELSCOPE_MODEL_ID ?? "").trim() ||
    RMBG_DEFAULT_MODEL_ID;
  const cacheDirRaw = String(
    process.env.RMBG_MODELSCOPE_CACHE_DIR ?? "",
  ).trim();
  const cacheDirFromEnv = cacheDirRaw.startsWith("~/")
    ? path.join(os.homedir(), cacheDirRaw.slice(2))
    : path.resolve(process.cwd(), cacheDirRaw);
  const cacheDir = cacheDirRaw ? cacheDirFromEnv : RMBG_DEFAULT_CACHE_DIR;

  const deviceRaw =
    String(process.env.RMBG_DEVICE ?? "")
      .trim()
      .toLowerCase() || RMBG_DEFAULT_DEVICE;
  if (deviceRaw !== "auto" && deviceRaw !== "cpu" && deviceRaw !== "cuda") {
    throw new Error(
      `环境变量错误：\`RMBG_DEVICE\` 仅支持 auto/cpu/cuda，当前值：${deviceRaw}`,
    );
  }

  return {
    pythonBin: RMBG_VENV_PYTHON_BIN,
    modelId,
    cacheDir,
    device: deviceRaw,
  };
};

/**
 * 将 `execFile` 异常统一格式化为可读文本，避免在多个调用点重复拼接 stdout/stderr。
 *
 * 输入：
 * - `error`：`execFile` 抛出的未知异常对象。
 *
 * 输出：
 * - 包含错误消息与子进程标准输出/标准错误的字符串。
 */
const formatExecFailure = (error: unknown): string => {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }

  const detail = error as {
    message?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };

  const stdout =
    typeof detail.stdout === "string"
      ? detail.stdout.trim()
      : Buffer.isBuffer(detail.stdout)
        ? detail.stdout.toString("utf-8").trim()
        : "";
  const stderr =
    typeof detail.stderr === "string"
      ? detail.stderr.trim()
      : Buffer.isBuffer(detail.stderr)
        ? detail.stderr.toString("utf-8").trim()
        : "";

  const traces = [stdout, stderr]
    .filter((entry) => entry.length > 0)
    .join("\n");
  const processMessage = String(detail.message ?? "无错误详情");
  return traces ? `${processMessage}\n${traces}` : processMessage;
};

/**
 * 判断文件路径是否存在。
 */
const isPathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * 自动准备 RMBG Python 运行时：
 * 1) 若虚拟环境不存在则自动创建；
 * 2) 若依赖缺失则自动安装 requirements。
 *
 * 设计原因：
 * - 统一在脚本内自举环境，避免系统 Python（PEP 668）导致安装失败时还要手工介入。
 * - 依赖检查与安装只在入口执行一次，后续抠图流程复用同一运行时，避免重复逻辑散落。
 *
 * 输入：
 * - 无（使用脚本内固定路径常量）。
 *
 * 输出：
 * - 可直接执行 RMBG 推理脚本的 Python 解释器绝对路径。
 *
 * 关键边界条件：
 * 1) `rmbg_requirements.txt` 缺失时立即失败，避免进入不完整安装状态。
 * 2) 安装后会再次执行 import 校验，确保不是“安装命令成功但依赖仍不可用”。
 */
const ensureLocalRmbgPythonRuntime = async (): Promise<string> => {
  const hasRequirementsFile = await isPathExists(RMBG_REQUIREMENTS_PATH);
  if (!hasRequirementsFile) {
    throw new Error(
      `本地 RMBG 运行时准备失败：requirements 文件不存在：${RMBG_REQUIREMENTS_PATH}`,
    );
  }

  const hasVenvPython = await isPathExists(RMBG_VENV_PYTHON_BIN);
  if (!hasVenvPython) {
    console.log(`检测到 RMBG 虚拟环境不存在，开始创建：${RMBG_VENV_DIR}`);
    try {
      await execFileAsync(
        RMBG_BOOTSTRAP_PYTHON_BIN,
        ["-m", "venv", RMBG_VENV_DIR],
        {
          maxBuffer: 1024 * 1024 * 20,
        },
      );
    } catch (error) {
      throw new Error(
        `本地 RMBG 运行时准备失败：创建虚拟环境失败：${formatExecFailure(error)}`,
      );
    }
  }

  const checkImportArgs = ["-c", RMBG_IMPORT_CHECK_CODE];
  let dependencyReady = false;
  try {
    await execFileAsync(RMBG_VENV_PYTHON_BIN, checkImportArgs, {
      maxBuffer: 1024 * 1024 * 20,
    });
    dependencyReady = true;
  } catch {
    dependencyReady = false;
  }

  if (!dependencyReady) {
    console.log(
      "检测到 RMBG Python 依赖缺失，开始自动安装（首次可能耗时较长）...",
    );
    try {
      await execFileAsync(
        RMBG_VENV_PIP_BIN,
        ["install", "-r", RMBG_REQUIREMENTS_PATH],
        {
          maxBuffer: 1024 * 1024 * 40,
        },
      );
    } catch (error) {
      throw new Error(
        `本地 RMBG 运行时准备失败：安装依赖失败：${formatExecFailure(error)}`,
      );
    }

    try {
      await execFileAsync(RMBG_VENV_PYTHON_BIN, checkImportArgs, {
        maxBuffer: 1024 * 1024 * 20,
      });
    } catch (error) {
      throw new Error(
        `本地 RMBG 运行时准备失败：依赖安装后校验失败：${formatExecFailure(error)}`,
      );
    }
  }

  return RMBG_VENV_PYTHON_BIN;
};

/**
 * 调用本地 Python RMBG-2.0 脚本完成整图抠图。
 *
 * 输入：
 * - `sheetPngBuffer`：方舟生成的整图 PNG 二进制。
 * - `runtimeConfig`：由 `resolveLocalRmbgRuntimeConfig` 解析后的运行配置。
 *
 * 输出：
 * - 抠图后的 PNG 二进制（保留 alpha 通道）。
 *
 * 关键边界条件：
 * 1) Python 子进程任一错误都会透传 stdout/stderr，便于直接定位模型下载或推理失败。
 * 2) 临时目录在 finally 中强制清理，避免多次生成后残留中间文件。
 */
const requestLocalRmbgMattedSheetBuffer = async (
  sheetPngBuffer: Buffer,
  runtimeConfig: LocalRmbgRuntimeConfig,
): Promise<Buffer> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jiu-rmbg-"));
  const inputPath = path.join(tempDir, "sheet-input.png");
  const outputPath = path.join(tempDir, "sheet-output.png");

  await fs.writeFile(inputPath, sheetPngBuffer);
  await fs.mkdir(runtimeConfig.cacheDir, { recursive: true });

  const pythonArgs = [
    RMBG_PYTHON_ENTRY_PATH,
    "--input-path",
    inputPath,
    "--output-path",
    outputPath,
    "--model-id",
    runtimeConfig.modelId,
    "--cache-dir",
    runtimeConfig.cacheDir,
    "--device",
    runtimeConfig.device,
  ];

  try {
    try {
      await execFileAsync(runtimeConfig.pythonBin, pythonArgs, {
        maxBuffer: 1024 * 1024 * 20,
      });
    } catch (error) {
      throw new Error(`本地 RMBG 抠图失败：${formatExecFailure(error)}`);
    }

    const imageBuffer = await fs.readFile(outputPath);
    if (imageBuffer.length <= 0) {
      throw new Error("本地 RMBG 抠图失败：输出文件为空。");
    }
    return imageBuffer;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

/**
 * 清理与画布边缘连通的“近白色背景块”。
 *
 * 设计目的：
 * 1) RMBG 在浅色背景场景下，偶发把背景块残留为半透明/不透明白块。
 * 2) 这些残留通常具备两个特征：颜色接近白色、且与图片边缘连通。
 * 3) 本函数仅清理“边缘连通 + 近白 + 低饱和”像素，避免误伤主体内部高亮细节。
 *
 * 输入：
 * - `spriteBuffer`：单格切图（RGBA PNG）。
 *
 * 输出：
 * - 清理后的 RGBA PNG。
 *
 * 关键边界条件：
 * 1) 仅当像素 alpha >= `SPRITE_BG_CLEAN_ALPHA_MIN` 才参与清理，避免把已透明背景重复处理。
 * 2) 主体若真的贴边并且是近白低饱和，也可能被清理；当前流程中道具居中，这种风险可接受。
 */
const removeBorderConnectedNearWhiteBackground = async (
  spriteBuffer: Buffer,
): Promise<Buffer> => {
  const rawImage = await sharp(spriteBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(rawImage.info.width ?? 0);
  const height = Number(rawImage.info.height ?? 0);
  const channelCount = Number(rawImage.info.channels ?? 0);
  const channels = 4 as const;

  if (width <= 0 || height <= 0 || channelCount < 4) {
    throw new Error("图片处理失败：清理白底时像素数据异常。");
  }

  const rgba = Buffer.from(rawImage.data);
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueHead = 0;
  let queueTail = 0;

  const toPixelIndex = (x: number, y: number): number => y * width + x;
  const toByteOffset = (pixelIndex: number): number => pixelIndex * channels;

  const isNearWhiteCandidateByPixelIndex = (pixelIndex: number): boolean => {
    const offset = toByteOffset(pixelIndex);
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const alpha = rgba[offset + 3];

    if (alpha < SPRITE_BG_CLEAN_ALPHA_MIN) {
      return false;
    }

    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const chroma = maxChannel - minChannel;
    return (
      minChannel >= SPRITE_BG_CLEAN_WHITE_MIN &&
      chroma <= SPRITE_BG_CLEAN_CHROMA_MAX
    );
  };

  const pushBorderCandidate = (x: number, y: number): void => {
    const pixelIndex = toPixelIndex(x, y);
    if (visited[pixelIndex] === 1) {
      return;
    }
    if (!isNearWhiteCandidateByPixelIndex(pixelIndex)) {
      return;
    }
    visited[pixelIndex] = 1;
    queue[queueTail] = pixelIndex;
    queueTail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    pushBorderCandidate(x, 0);
    pushBorderCandidate(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    pushBorderCandidate(0, y);
    pushBorderCandidate(width - 1, y);
  }

  while (queueHead < queueTail) {
    const current = queue[queueHead];
    queueHead += 1;

    const currentOffset = toByteOffset(current);
    rgba[currentOffset + 3] = 0;
    rgba[currentOffset] = 0;
    rgba[currentOffset + 1] = 0;
    rgba[currentOffset + 2] = 0;

    const x = current % width;
    const y = Math.floor(current / width);

    if (x > 0) {
      const left = current - 1;
      if (visited[left] === 0 && isNearWhiteCandidateByPixelIndex(left)) {
        visited[left] = 1;
        queue[queueTail] = left;
        queueTail += 1;
      }
    }
    if (x < width - 1) {
      const right = current + 1;
      if (visited[right] === 0 && isNearWhiteCandidateByPixelIndex(right)) {
        visited[right] = 1;
        queue[queueTail] = right;
        queueTail += 1;
      }
    }
    if (y > 0) {
      const up = current - width;
      if (visited[up] === 0 && isNearWhiteCandidateByPixelIndex(up)) {
        visited[up] = 1;
        queue[queueTail] = up;
        queueTail += 1;
      }
    }
    if (y < height - 1) {
      const down = current + width;
      if (visited[down] === 0 && isNearWhiteCandidateByPixelIndex(down)) {
        visited[down] = 1;
        queue[queueTail] = down;
        queueTail += 1;
      }
    }
  }

  return sharp(rgba, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .png()
    .toBuffer();
};

/**
 * 从单格原图边缘估计背景色（RGB 中位数）。
 *
 * 设计目的：
 * 1) 细边白边通常来自“原图背景色混入半透明边缘像素”，先拿到单格背景色是去污前提。
 * 2) 使用边缘采样 + 中位数而非均值，能降低少量贴边主体像素对估计结果的干扰。
 *
 * 输入：
 * - `rawCellBuffer`：未抠图的单格原图（RGB/RGBA 均可）。
 *
 * 输出：
 * - 估算出的背景 RGB 颜色。
 *
 * 关键边界条件：
 * 1) 图片必须至少 1x1 且通道数 >= 3，否则直接抛错。
 * 2) 采样宽度不会超过图像宽高，确保在小图上也不会越界。
 */
const estimateBackgroundColorFromRawCellEdge = async (
  rawCellBuffer: Buffer,
): Promise<RgbColor> => {
  const rawImage = await sharp(rawCellBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(rawImage.info.width ?? 0);
  const height = Number(rawImage.info.height ?? 0);
  const channels = Number(rawImage.info.channels ?? 0);

  if (width <= 0 || height <= 0 || channels < 3) {
    throw new Error("图片处理失败：估算背景色时像素数据异常。");
  }

  const border = Math.max(
    1,
    Math.min(
      SPRITE_EDGE_DECONTAM_SAMPLE_BORDER,
      Math.floor(Math.min(width, height) / 2),
    ),
  );
  const redSamples: number[] = [];
  const greenSamples: number[] = [];
  const blueSamples: number[] = [];
  const pixelBytes = rawImage.data;

  const pushPixel = (x: number, y: number): void => {
    const offset = (y * width + x) * channels;
    redSamples.push(pixelBytes[offset]);
    greenSamples.push(pixelBytes[offset + 1]);
    blueSamples.push(pixelBytes[offset + 2]);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBorderPixel =
        x < border || y < border || x >= width - border || y >= height - border;
      if (!isBorderPixel) {
        continue;
      }
      pushPixel(x, y);
    }
  }

  const toMedian = (samples: number[]): number => {
    if (samples.length === 0) {
      throw new Error("图片处理失败：估算背景色时未采样到边缘像素。");
    }
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return {
    red: toMedian(redSamples),
    green: toMedian(greenSamples),
    blue: toMedian(blueSamples),
  };
};

/**
 * 针对半透明边缘执行背景去污，抑制细节处白色残留。
 *
 * 设计目的：
 * 1) RMBG 输出为“原始 RGB + 预测 alpha”，边缘常残留背景色（常见为白色晕边）。
 * 2) 先按 alpha 做去背景反推，再对“仍接近背景色”的半透明像素压低 alpha，可显著减轻白边。
 * 3) 仅处理半透明边缘区，不改动实心主体区域，避免把装备主体细节洗掉。
 *
 * 输入：
 * - `mattedCellBuffer`：RMBG 抠图后的单格图（RGBA）。
 * - `rawCellBuffer`：对应未抠图的单格原图，用于估算背景色。
 *
 * 输出：
 * - 去白边后的单格 RGBA PNG。
 *
 * 关键边界条件：
 * 1) 只处理 alpha ∈ [SPRITE_EDGE_DECONTAM_ALPHA_MIN, SPRITE_EDGE_DECONTAM_ALPHA_MAX] 的像素，实心主体不参与。
 * 2) 只有“接近背景色且低色度”的边缘才会压 alpha，降低误伤蓝白系装备高光的风险。
 */
const decontaminateSpriteEdgeAgainstBackground = async (
  mattedCellBuffer: Buffer,
  rawCellBuffer: Buffer,
): Promise<Buffer> => {
  const backgroundColor =
    await estimateBackgroundColorFromRawCellEdge(rawCellBuffer);
  const rawImage = await sharp(mattedCellBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(rawImage.info.width ?? 0);
  const height = Number(rawImage.info.height ?? 0);
  const channelCount = Number(rawImage.info.channels ?? 0);
  const channels = 4 as const;

  if (width <= 0 || height <= 0 || channelCount < 4) {
    throw new Error("图片处理失败：边缘去污时像素数据异常。");
  }

  const rgba = Buffer.from(rawImage.data);
  const clampByte = (value: number): number => {
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
  };

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    const offset = pixelIndex * channels;
    const alphaByte = rgba[offset + 3];
    if (
      alphaByte < SPRITE_EDGE_DECONTAM_ALPHA_MIN ||
      alphaByte > SPRITE_EDGE_DECONTAM_ALPHA_MAX
    ) {
      continue;
    }

    const alpha = alphaByte / 255;
    if (alpha <= 0) {
      continue;
    }

    const inverseAlpha = 1 - alpha;
    const correctedRed = clampByte(
      (rgba[offset] - backgroundColor.red * inverseAlpha) / alpha,
    );
    const correctedGreen = clampByte(
      (rgba[offset + 1] - backgroundColor.green * inverseAlpha) / alpha,
    );
    const correctedBlue = clampByte(
      (rgba[offset + 2] - backgroundColor.blue * inverseAlpha) / alpha,
    );
    rgba[offset] = correctedRed;
    rgba[offset + 1] = correctedGreen;
    rgba[offset + 2] = correctedBlue;

    const maxDiffToBackground = Math.max(
      Math.abs(correctedRed - backgroundColor.red),
      Math.abs(correctedGreen - backgroundColor.green),
      Math.abs(correctedBlue - backgroundColor.blue),
    );
    const maxChannel = Math.max(correctedRed, correctedGreen, correctedBlue);
    const minChannel = Math.min(correctedRed, correctedGreen, correctedBlue);
    const chroma = maxChannel - minChannel;
    const shouldSuppressAlpha =
      maxDiffToBackground <= SPRITE_EDGE_DECONTAM_BG_DIFF_MAX &&
      chroma <= SPRITE_EDGE_DECONTAM_CHROMA_MAX;

    if (shouldSuppressAlpha) {
      rgba[offset + 3] = clampByte(
        alphaByte * SPRITE_EDGE_DECONTAM_ALPHA_SUPPRESS_FACTOR,
      );
    }
  }

  return sharp(rgba, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .png()
    .toBuffer();
};

/**
 * 按 alpha 通道做紧裁，并追加透明内边距。
 */
const trimByAlphaBoundingBox = async (
  spriteBuffer: Buffer,
): Promise<Buffer> => {
  const rawImage = await sharp(spriteBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(rawImage.info.width ?? 0);
  const height = Number(rawImage.info.height ?? 0);
  const channels = Number(rawImage.info.channels ?? 0);

  if (width <= 0 || height <= 0 || channels < 4) {
    throw new Error("图片处理失败：切图像素数据异常，无法进行紧裁。");
  }

  const rgba = rawImage.data;
  const toOffset = (x: number, y: number): number => (y * width + x) * channels;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[toOffset(x, y) + 3];
      if (alpha < SPRITE_TRIM_ALPHA_THRESHOLD) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("图片处理失败：抠图后未检测到有效前景像素。");
  }

  const extractWidth = maxX - minX + 1;
  const extractHeight = maxY - minY + 1;

  return sharp(spriteBuffer)
    .extract({
      left: minX,
      top: minY,
      width: extractWidth,
      height: extractHeight,
    })
    .extend({
      top: SPRITE_TRIM_PADDING,
      bottom: SPRITE_TRIM_PADDING,
      left: SPRITE_TRIM_PADDING,
      right: SPRITE_TRIM_PADDING,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
};

/**
 * 在固定网格尺寸内将前景按 alpha 包围盒重新居中。
 *
 * 设计目的：
 * 1) 生图模型常出现“主体偏上/偏下/偏左/偏右”，但切图阶段又需要严格统一尺寸。
 * 2) 该函数不改变最终输出尺寸，只做平移居中，避免“看起来点歪”。
 *
 * 输入：
 * - `spriteBuffer`：单格 RGBA 抠图结果。
 * - `canvasWidth`：目标画布宽度（即当前网格单元宽度）。
 * - `canvasHeight`：目标画布高度（即当前网格单元高度）。
 *
 * 输出：
 * - 与网格同尺寸的居中 RGBA PNG。
 *
 * 关键边界条件：
 * 1) 仅将 alpha >= `SPRITE_TRIM_ALPHA_THRESHOLD` 视为有效前景，避免透明噪点影响居中。
 * 2) 若未检测到有效前景，直接失败；因为这代表抠图结果异常，继续导出只会产生空素材。
 */
const centerForegroundInFixedGrid = async (
  spriteBuffer: Buffer,
  canvasWidth: number,
  canvasHeight: number,
): Promise<Buffer> => {
  const rawImage = await sharp(spriteBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(rawImage.info.width ?? 0);
  const height = Number(rawImage.info.height ?? 0);
  const channels = Number(rawImage.info.channels ?? 0);

  if (width <= 0 || height <= 0 || channels < 4) {
    throw new Error("图片处理失败：居中处理时像素数据异常。");
  }

  const rgba = rawImage.data;
  const toOffset = (x: number, y: number): number => (y * width + x) * channels;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[toOffset(x, y) + 3];
      if (alpha < SPRITE_TRIM_ALPHA_THRESHOLD) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("图片处理失败：居中处理时未检测到有效前景像素。");
  }

  const extractWidth = maxX - minX + 1;
  const extractHeight = maxY - minY + 1;
  const centeredLeft = Math.floor((canvasWidth - extractWidth) / 2);
  const centeredTop = Math.floor((canvasHeight - extractHeight) / 2);
  const foregroundBuffer = await sharp(spriteBuffer)
    .extract({
      left: minX,
      top: minY,
      width: extractWidth,
      height: extractHeight,
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: foregroundBuffer,
        left: centeredLeft,
        top: centeredTop,
      },
    ])
    .png()
    .toBuffer();
};

/**
 * 对整图原图按网格逐格执行本地 RMBG 抠图，并按 4x2 固定网格直接导出切图。
 *
 * 设计原因：
 * 1) 整图一次性抠图时，小目标（尤其第 8 格法宝）容易在全局分辨率下丢细节。
 * 2) 逐格抠图能让每件装备占据更大有效像素面积，显著降低“局部被抠没”的问题。
 * 3) 切图阶段不再做紧裁，直接输出统一网格尺寸，避免边缘细节被再次裁掉。
 */
const exportSpritesFromRawSheetWithPerCellRmbg = async (
  rawSheetBuffer: Buffer,
  outputDir: string,
  setId: string,
  pieces: SetPiece[],
  runtimeConfig: LocalRmbgRuntimeConfig,
): Promise<SpriteExportResult> => {
  const normalizedRawSheet = await sharp(rawSheetBuffer)
    .ensureAlpha()
    .png()
    .toBuffer();
  const metadata = await sharp(normalizedRawSheet).metadata();
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);

  if (width <= 0 || height <= 0) {
    throw new Error("图片处理失败：原始大图尺寸无效。");
  }

  const unitWidth = Math.floor(width / GRID_COLUMNS);
  const unitHeight = Math.floor(height / GRID_ROWS);
  if (unitWidth <= 0 || unitHeight <= 0) {
    throw new Error(
      `图片处理失败：抠图后大图尺寸 ${width}x${height} 无法按 ${GRID_COLUMNS}x${GRID_ROWS} 切割。`,
    );
  }

  const manifestItems: SpriteManifestItem[] = [];
  const mattedSheetComposites: Array<{
    input: Buffer;
    left: number;
    top: number;
  }> = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const column = index % GRID_COLUMNS;
    const row = Math.floor(index / GRID_COLUMNS);

    const left = column * unitWidth;
    const top = row * unitHeight;
    const spriteWidth = column === GRID_COLUMNS - 1 ? width - left : unitWidth;
    const spriteHeight = row === GRID_ROWS - 1 ? height - top : unitHeight;

    const fileName = `${String(index + 1).padStart(2, "0")}-${piece.equipSlot}-${piece.id}.png`;
    const filePath = path.join(outputDir, fileName);

    const extractedRawCellBuffer = await sharp(normalizedRawSheet)
      .extract({
        left,
        top,
        width: spriteWidth,
        height: spriteHeight,
      })
      .ensureAlpha()
      .png()
      .toBuffer();

    const extractedMattedCellBuffer = await requestLocalRmbgMattedSheetBuffer(
      extractedRawCellBuffer,
      runtimeConfig,
    );
    const fixedGridSpriteBuffer = await centerForegroundInFixedGrid(
      extractedMattedCellBuffer,
      spriteWidth,
      spriteHeight,
    );
    await fs.writeFile(filePath, fixedGridSpriteBuffer);
    mattedSheetComposites.push({
      input: fixedGridSpriteBuffer,
      left,
      top,
    });

    manifestItems.push({
      index: index + 1,
      equipSlot: piece.equipSlot,
      equipSlotLabel: SLOT_LABEL_MAP[piece.equipSlot],
      itemId: piece.id,
      itemName: piece.name,
      file: fileName,
    });
  }

  const mattedSheetBuffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(mattedSheetComposites)
    .png()
    .toBuffer();

  return {
    sprites: manifestItems,
    mattedSheetBuffer,
  };
};

/**
 * 主流程。
 */
const main = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));
  const localRmbgRuntimeConfig = resolveLocalRmbgRuntimeConfig();
  const preparedRmbgPythonBin = await ensureLocalRmbgPythonRuntime();
  const localRmbgRuntimeConfigWithPython: LocalRmbgRuntimeConfig = {
    ...localRmbgRuntimeConfig,
    pythonBin: preparedRmbgPythonBin,
  };
  const pieces = await loadSetPieces(options.setId);
  const prompt = buildSheetPrompt(options.setId, pieces, options.promptExtra);

  await fs.mkdir(options.outputDir, { recursive: true });

  console.log(`准备生成套装素材（逐格抠图模式）：${options.setId}`);
  console.log(`输出目录：${options.outputDir}`);
  console.log(`使用模型：${ARK_MODEL_ID}`);
  console.log(`整图尺寸：${options.size}`);
  console.log(
    `本地抠图：${localRmbgRuntimeConfigWithPython.modelId}（device=${localRmbgRuntimeConfigWithPython.device}, cache=${localRmbgRuntimeConfigWithPython.cacheDir}）`,
  );

  const rawSheetBuffer = await requestArkSheetImageBuffer(
    prompt,
    options.size,
    options.seed,
  );
  const normalizedRawSheet = await sharp(rawSheetBuffer).png().toBuffer();

  const sourceSheetFileName = `${options.setId}-sheet.png`;
  const sourceSheetPath = path.join(options.outputDir, sourceSheetFileName);
  await fs.writeFile(sourceSheetPath, normalizedRawSheet);

  const exportResult = await exportSpritesFromRawSheetWithPerCellRmbg(
    normalizedRawSheet,
    options.outputDir,
    options.setId,
    pieces,
    localRmbgRuntimeConfigWithPython,
  );
  const normalizedMattedSheet = await sharp(exportResult.mattedSheetBuffer)
    .ensureAlpha()
    .png()
    .toBuffer();

  const mattedSheetFileName = `${options.setId}-sheet-matted.png`;
  const mattedSheetPath = path.join(options.outputDir, mattedSheetFileName);
  await fs.writeFile(mattedSheetPath, normalizedMattedSheet);

  const sprites = exportResult.sprites;

  const manifest: SpriteManifest = {
    setId: options.setId,
    model: ARK_MODEL_ID,
    generationMode: "single-sheet+rmbg-local",
    generatedAt: new Date().toISOString(),
    sourceSheet: sourceSheetFileName,
    mattedSheet: mattedSheetFileName,
    prompt,
    sprites,
  };

  const manifestPath = path.join(
    options.outputDir,
    `${options.setId}-manifest.json`,
  );
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log("生成完成：");
  console.log(`- 套装: ${options.setId}`);
  console.log(`- 原始大图: ${sourceSheetPath}`);
  console.log(`- 抠图大图: ${mattedSheetPath}`);
  console.log(`- 切图数量: ${sprites.length}`);
  console.log(`- manifest: ${manifestPath}`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`执行失败：${message}`);
  process.exit(1);
});
