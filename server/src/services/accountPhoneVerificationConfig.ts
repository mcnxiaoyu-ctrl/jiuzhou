import dotenv from 'dotenv';

dotenv.config();

/**
 * 账号手机号验证码配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析账号级手机号验证码开关、场景短信模板与发送频控配置，供注册、手机号登录、老账号绑定和登录后账号绑定共用。
 * 2. 做什么：把原先散落在坊市命名下的短信能力提升为账号级能力，并在这里收敛“发码场景 -> 阿里云模板 CODE”的唯一映射入口。
 * 3. 不做什么：不发送短信、不访问 Redis，也不决定具体业务场景是否允许发码。
 *
 * 输入/输出：
 * - 输入：`process.env` 中的 ACCOUNT_PHONE_VERIFICATION_* 与各场景 ALIYUN_SMS_*_TEMPLATE_CODE 配置。
 * - 输出：`AccountPhoneVerificationConfig`，供服务层直接消费。
 *
 * 数据流/状态流：
 * 环境变量 -> 本模块归一化场景模板表与频控配置 -> 短信服务 / 手机号验证码服务 / 登录后账号绑定服务复用。
 *
 * 复用设计说明：
 * - 登录、注册、老账号绑定、登录后账号绑定都依赖同一套短信发送能力，集中到这里可以避免多个配置模块重复判断模板 CODE。
 * - 场景模板、是否开启、冷却时间、小时/天限次是高频业务调整点，因此统一放在账号级配置入口。
 *
 * 关键边界条件与坑点：
 * 1. 手机号验证默认开启；只有显式配置 ACCOUNT_PHONE_VERIFICATION_ENABLED=false 或旧 MARKET_PHONE_BINDING_ENABLED=false 才关闭。
 * 2. 只要显式开启，就必须提供阿里云短信签名和全部场景模板编码，不能进入“接口放行但短信无法发送”的半启用状态。
 */

export type SmsVerificationTemplateScene =
  | 'loginRegister'
  | 'changeBoundPhone'
  | 'resetPassword'
  | 'bindNewPhone'
  | 'verifyBoundPhone';

export type AccountPhoneVerificationTemplateCodes = Record<SmsVerificationTemplateScene, string>;

export type AccountPhoneVerificationConfig = {
  enabled: boolean;
  signName: string;
  templateCodes: AccountPhoneVerificationTemplateCodes;
  codeExpireSeconds: number;
  sendCooldownSeconds: number;
  sendHourlyLimit: number;
  sendDailyLimit: number;
};

const SMS_VERIFICATION_TEMPLATE_SCENES: SmsVerificationTemplateScene[] = [
  'loginRegister',
  'changeBoundPhone',
  'resetPassword',
  'bindNewPhone',
  'verifyBoundPhone',
];

const SMS_VERIFICATION_TEMPLATE_SCENE_META: Record<
  SmsVerificationTemplateScene,
  { envKey: string; label: string }
> = {
  loginRegister: {
    envKey: 'ALIYUN_SMS_LOGIN_REGISTER_TEMPLATE_CODE',
    label: '登录/注册模板',
  },
  changeBoundPhone: {
    envKey: 'ALIYUN_SMS_CHANGE_BOUND_PHONE_TEMPLATE_CODE',
    label: '修改绑定手机号模板',
  },
  resetPassword: {
    envKey: 'ALIYUN_SMS_RESET_PASSWORD_TEMPLATE_CODE',
    label: '重置密码模板',
  },
  bindNewPhone: {
    envKey: 'ALIYUN_SMS_BIND_NEW_PHONE_TEMPLATE_CODE',
    label: '绑定新手机号模板',
  },
  verifyBoundPhone: {
    envKey: 'ALIYUN_SMS_VERIFY_BOUND_PHONE_TEMPLATE_CODE',
    label: '验证绑定手机号模板',
  },
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

const readTemplateCode = (scene: SmsVerificationTemplateScene): string => {
  return asString(process.env[SMS_VERIFICATION_TEMPLATE_SCENE_META[scene].envKey]);
};

const readTemplateCodes = (): AccountPhoneVerificationTemplateCodes => {
  return {
    loginRegister: readTemplateCode('loginRegister'),
    changeBoundPhone: readTemplateCode('changeBoundPhone'),
    resetPassword: readTemplateCode('resetPassword'),
    bindNewPhone: readTemplateCode('bindNewPhone'),
    verifyBoundPhone: readTemplateCode('verifyBoundPhone'),
  };
};

const resolveMissingTemplateMessages = (
  templateCodes: AccountPhoneVerificationTemplateCodes,
): string[] => {
  const missingMessages: string[] = [];
  for (const scene of SMS_VERIFICATION_TEMPLATE_SCENES) {
    if (!templateCodes[scene]) {
      const meta = SMS_VERIFICATION_TEMPLATE_SCENE_META[scene];
      missingMessages.push(`${meta.envKey}（${meta.label}）`);
    }
  }
  return missingMessages;
};

export const readAccountPhoneVerificationConfig = (): AccountPhoneVerificationConfig => {
  const enabled = readEnabled();
  const signName = asString(process.env.ALIYUN_SMS_SIGN_NAME);
  const templateCodes = readTemplateCodes();
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
      templateCodes,
      codeExpireSeconds,
      sendCooldownSeconds,
      sendHourlyLimit,
      sendDailyLimit,
    };
  }

  if (!signName) {
    throw new Error('ACCOUNT_PHONE_VERIFICATION_ENABLED=true 时必须配置 ALIYUN_SMS_SIGN_NAME');
  }

  const missingTemplateMessages = resolveMissingTemplateMessages(templateCodes);
  if (missingTemplateMessages.length > 0) {
    throw new Error(
      `ACCOUNT_PHONE_VERIFICATION_ENABLED=true 时必须配置短信模板编码：${missingTemplateMessages.join('、')}`,
    );
  }

  return {
    enabled,
    signName,
    templateCodes,
    codeExpireSeconds,
    sendCooldownSeconds,
    sendHourlyLimit,
    sendDailyLimit,
  };
};

export const ACCOUNT_PHONE_VERIFICATION_CONFIG = readAccountPhoneVerificationConfig();
