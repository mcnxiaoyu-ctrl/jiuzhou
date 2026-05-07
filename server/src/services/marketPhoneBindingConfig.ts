import { ACCOUNT_PHONE_VERIFICATION_CONFIG } from './accountPhoneVerificationConfig.js';

/**
 * 坊市手机号绑定配置兼容出口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把坊市绑定继续使用的配置名映射到账号级手机号验证码配置，保持既有调用点稳定。
 * 2. 做什么：让坊市绑定、聊天发言守卫和账号登录注册共享同一套短信开关、模板、冷却与限次规则。
 * 3. 不做什么：不再独立解析环境变量，也不维护第二套短信验证码策略。
 *
 * 输入/输出：
 * - 输入：账号级手机号验证码配置模块的运行期结果。
 * - 输出：`MARKET_PHONE_BINDING_CONFIG`，供既有坊市绑定服务读取。
 *
 * 数据流/状态流：
 * 账号级配置 -> 本兼容出口 -> 坊市绑定服务 / 坊市守卫 / 聊天守卫。
 *
 * 复用设计说明：
 * - 坊市绑定不是独立短信体系，保留本出口可以减少改动面，同时把规则单一入口收敛到账号级配置。
 * - 短信发送频控是高频调整点，所有场景必须读取同一份配置，避免登录注册和坊市绑定口径漂移。
 *
 * 关键边界条件与坑点：
 * 1. 本文件只做兼容映射，新增短信配置必须加到 `accountPhoneVerificationConfig.ts`，不能在这里重新分支。
 * 2. `enabled=false` 时坊市守卫继续不强制绑定，和原有关闭状态行为保持一致。
 */

export type MarketPhoneBindingConfig = typeof ACCOUNT_PHONE_VERIFICATION_CONFIG;

export const readMarketPhoneBindingConfig = (): MarketPhoneBindingConfig => ACCOUNT_PHONE_VERIFICATION_CONFIG;

export const MARKET_PHONE_BINDING_CONFIG = readMarketPhoneBindingConfig();
