import dotenv from 'dotenv';

dotenv.config();

/**
 * 账号手机号验证码配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析账号级手机号验证码开关、短信模板与发送频控配置，供注册、手机号登录、老账号绑定和登录后账号绑定共用。
 * 2. 做什么：把原先散落在坊市命名下的短信能力提升为账号级能力，避免登录注册与账号绑定各自读取环境变量。
 * 3. 不做什么：不发送短信、不访问 Redis，也不决定具体业务场景是否允许发码。
 *
 * 输入/输出：
 * - 输入：`process.env` 中的 ACCOUNT_PHONE_VERIFICATION_* 与 ALIYUN_SMS_* 配置。
 * - 输出：`AccountPhoneVerificationConfig`，供服务层直接消费。
 *
 * 数据流/状态流：
 * 环境变量 -> 本模块归一化 -> 短信服务 / 手机号验证码服务 / 登录后账号绑定服务复用。
 *
 * 复用设计说明：
 * - 登录、注册、老账号绑定、登录后账号绑定都依赖同一套短信模板和发送限流，集中到这里可以避免多个配置模块重复判断。
 * - 是否开启、冷却时间、小时/天限次是高频业务调整点，因此统一放在账号级配置入口。
 *
 * 关键边界条件与坑点：
 * 1. 手机号验证默认开启；只有显式配置 ACCOUNT_PHONE_VERIFICATION_ENABLED=false 或旧 MARKET_PHONE_BINDING_ENABLED=false 才关闭。
 * 2. 只要显式开启，就必须提供阿里云短信签名和模板编码，不能进入“接口放行但短信无法发送”的半启用状态。
 */

export type AccountPhoneVerificationConfig = {
  enabled: boolean;
  signName: string;
  templateCode: string;
  codeExpireSeconds: number;
  sendCooldownSeconds: number;
  sendHourlyLimit: number;
  sendDailyLimit: number;
};

const DEFAULT_CODE_EXPIRE_SECONDS = 300;
const DEFAULT_SEND_COOLDOWN_SECONDS = 60;
const DEFAULT_SEND_HOURLY_LIMIT = 5;
const DEFAULT_SEND_DAILY_LIMIT = 10;

const asString = (raw: string | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

const asBoolean = (raw: string | undefined): boolean => {
  const normalized = asString(raw).toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const asPositiveInt = (raw: string | undefined, defaultValue: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : defaultValue;
};

const readEnabled = (): boolean => {
  const accountEnabled = asString(process.env.ACCOUNT_PHONE_VERIFICATION_ENABLED);
  if (accountEnabled) {
    return asBoolean(accountEnabled);
  }
  const legacyMarketEnabled = asString(process.env.MARKET_PHONE_BINDING_ENABLED);
  if (legacyMarketEnabled) {
    return asBoolean(legacyMarketEnabled);
  }
  return true;
};

export const readAccountPhoneVerificationConfig = (): AccountPhoneVerificationConfig => {
  const enabled = readEnabled();
  const signName = asString(process.env.ALIYUN_SMS_SIGN_NAME);
  const templateCode = asString(process.env.ALIYUN_SMS_VERIFY_TEMPLATE_CODE);
  const codeExpireSeconds = asPositiveInt(
    process.env.ACCOUNT_PHONE_VERIFICATION_CODE_EXPIRE_SECONDS
      ?? process.env.MARKET_PHONE_BINDING_CODE_EXPIRE_SECONDS,
    DEFAULT_CODE_EXPIRE_SECONDS,
  );
  const sendCooldownSeconds = asPositiveInt(
    process.env.ACCOUNT_PHONE_VERIFICATION_SEND_COOLDOWN_SECONDS
      ?? process.env.MARKET_PHONE_BINDING_SEND_COOLDOWN_SECONDS,
    DEFAULT_SEND_COOLDOWN_SECONDS,
  );
  const sendHourlyLimit = asPositiveInt(
    process.env.ACCOUNT_PHONE_VERIFICATION_SEND_HOURLY_LIMIT
      ?? process.env.MARKET_PHONE_BINDING_SEND_HOURLY_LIMIT,
    DEFAULT_SEND_HOURLY_LIMIT,
  );
  const sendDailyLimit = asPositiveInt(
    process.env.ACCOUNT_PHONE_VERIFICATION_SEND_DAILY_LIMIT
      ?? process.env.MARKET_PHONE_BINDING_SEND_DAILY_LIMIT,
    DEFAULT_SEND_DAILY_LIMIT,
  );

  if (!enabled) {
    return {
      enabled,
      signName,
      templateCode,
      codeExpireSeconds,
      sendCooldownSeconds,
      sendHourlyLimit,
      sendDailyLimit,
    };
  }

  if (!signName) {
    throw new Error('ACCOUNT_PHONE_VERIFICATION_ENABLED=true 时必须配置 ALIYUN_SMS_SIGN_NAME');
  }

  if (!templateCode) {
    throw new Error('ACCOUNT_PHONE_VERIFICATION_ENABLED=true 时必须配置 ALIYUN_SMS_VERIFY_TEMPLATE_CODE');
  }

  return {
    enabled,
    signName,
    templateCode,
    codeExpireSeconds,
    sendCooldownSeconds,
    sendHourlyLimit,
    sendDailyLimit,
  };
};

export const ACCOUNT_PHONE_VERIFICATION_CONFIG = readAccountPhoneVerificationConfig();
