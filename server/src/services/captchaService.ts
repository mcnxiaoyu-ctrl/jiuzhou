/**
 * 图形验证码共享服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一生成登录/注册共用的图片验证码，集中处理答案归一化、SVG 图片组装、Redis 持久化与一次性消费校验。
 * 2. 做什么：把验证码 Redis key、TTL、错误文案收敛到单一模块，避免登录和注册路由各自维护同一套规则。
 * 3. 不做什么：不处理 HTTP 请求参数，不直接返回 Express 响应，也不承担账号密码校验逻辑。
 *
 * 输入/输出：
 * - 输入：`createCaptcha` 无输入；`verifyCaptcha` 接收 `captchaId` 与用户输入 `captchaCode`。
 * - 输出：`createCaptcha` 返回图片数据与过期时间；`verifyCaptcha` 成功时无返回，失败时抛业务错误。
 *
 * 数据流/状态流：
 * - 路由层调用 `createCaptcha` -> 生成 4 位验证码 -> 组装 SVG -> 写入 Redis `auth:captcha:<id>` -> 返回 `captchaId/imageData/expiresAt`
 * - 登录/注册提交 `captchaId + captchaCode` -> `verifyCaptcha` 读 Redis -> 比对答案与过期时间 -> 删除 Redis 记录 -> 通过或抛错
 *
 * 关键边界条件与坑点：
 * 1. 验证码成功或失败后都必须删除 Redis 记录，保证一次性消费，否则登录和注册会出现不同的重试口径。
 * 2. 过期判断只信任服务端 Redis 中的 `expiresAt`，不能依赖前端倒计时，避免客户端时间漂移造成规则不一致。
 */
import { randomUUID } from 'node:crypto';

import { redis } from '../config/redis.js';
import { BusinessError } from '../middleware/BusinessError.js';

type StoredCaptchaRecord = {
  answer: string;
  expiresAt: number;
};

export type CaptchaChallenge = {
  captchaId: string;
  imageData: string;
  expiresAt: number;
};

const CAPTCHA_REDIS_KEY_PREFIX = 'auth:captcha:';
const CAPTCHA_TTL_SECONDS = 300;
const CAPTCHA_LENGTH = 4;
const CAPTCHA_WIDTH = 132;
const CAPTCHA_HEIGHT = 56;
const CAPTCHA_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const buildCaptchaKey = (captchaId: string): string => `${CAPTCHA_REDIS_KEY_PREFIX}${captchaId}`;

const normalizeCaptchaCode = (captchaCode: string): string => captchaCode.trim().toUpperCase();

const pickCaptchaChar = (): string => {
  const index = Math.floor(Math.random() * CAPTCHA_CHARSET.length);
  return CAPTCHA_CHARSET.charAt(index);
};

const generateCaptchaAnswer = (): string =>
  Array.from({ length: CAPTCHA_LENGTH }, () => pickCaptchaChar()).join('');

const encodeSvgDataUri = (svg: string): string => {
  const base64 = Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
};

const buildNoiseLines = (): string =>
  Array.from({ length: 5 }, (_, index) => {
    const x1 = 10 + index * 22;
    const y1 = 8 + (index % 2) * 10;
    const x2 = 28 + index * 20;
    const y2 = 46 - (index % 3) * 7;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(71,85,105,0.28)" stroke-width="1.4" />`;
  }).join('');

const buildNoiseDots = (): string =>
  Array.from({ length: 18 }, (_, index) => {
    const cx = 10 + (index * 7) % (CAPTCHA_WIDTH - 20);
    const cy = 9 + (index * 11) % (CAPTCHA_HEIGHT - 18);
    const radius = index % 2 === 0 ? 1.3 : 1.8;
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="rgba(100,116,139,0.24)" />`;
  }).join('');

const buildCaptchaSvg = (answer: string): string => {
  const letters = Array.from(answer).map((char, index) => {
    const x = 22 + index * 24;
    const y = index % 2 === 0 ? 37 : 40;
    const rotation = index % 2 === 0 ? -8 : 6;
    return `<text x="${x}" y="${y}" font-size="28" font-family="'Trebuchet MS', 'Verdana', sans-serif" font-weight="700" fill="#111827" transform="rotate(${rotation} ${x} ${y})">${char}</text>`;
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" viewBox="0 0 ${CAPTCHA_WIDTH} ${CAPTCHA_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="图片验证码">`,
    '<defs>',
    '<linearGradient id="captcha-bg" x1="0%" y1="0%" x2="100%" y2="100%">',
    '<stop offset="0%" stop-color="#f8fafc" />',
    '<stop offset="100%" stop-color="#e2e8f0" />',
    '</linearGradient>',
    '</defs>',
    `<rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" rx="12" fill="url(#captcha-bg)" />`,
    buildNoiseLines(),
    buildNoiseDots(),
    letters,
    '</svg>',
  ].join('');
};

export const createCaptcha = async (): Promise<CaptchaChallenge> => {
  const captchaId = randomUUID();
  const answer = generateCaptchaAnswer();
  const expiresAt = Date.now() + CAPTCHA_TTL_SECONDS * 1000;
  const payload: StoredCaptchaRecord = {
    answer,
    expiresAt,
  };

  await redis.set(
    buildCaptchaKey(captchaId),
    JSON.stringify(payload),
    'EX',
    CAPTCHA_TTL_SECONDS,
  );

  return {
    captchaId,
    imageData: encodeSvgDataUri(buildCaptchaSvg(answer)),
    expiresAt,
  };
};

export const verifyCaptcha = async (captchaId: string, captchaCode: string): Promise<void> => {
  const key = buildCaptchaKey(captchaId);
  const raw = await redis.get(key);

  if (!raw) {
    throw new BusinessError('图片验证码已失效，请重新获取');
  }

  const record = JSON.parse(raw) as StoredCaptchaRecord;
  if (record.expiresAt <= Date.now()) {
    await redis.del(key);
    throw new BusinessError('图片验证码已失效，请重新获取');
  }

  await redis.del(key);

  if (normalizeCaptchaCode(captchaCode) !== record.answer) {
    throw new BusinessError('图片验证码错误，请重新获取');
  }
};
