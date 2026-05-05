/**
 * CORS 选项构建工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一解析 CORS_ORIGIN 环境变量，并提供本地开发默认白名单策略。
 * 2. 做什么：在未显式配置 CORS_ORIGIN 时，同时允许前端静态端口与 Vite 开发端口访问后端 API。
 * 3. 不做什么：不读取业务配置、不注册 Express 中间件，也不处理鉴权。
 *
 * 输入 / 输出：
 * - 输入：可选的 CORS_ORIGIN 字符串，以及浏览器请求携带的 Origin。
 * - 输出：cors 中间件可直接消费的 origin 选项。
 *
 * 数据流 / 状态流：
 * process.env.CORS_ORIGIN -> buildCorsOriginOption -> Express CORS / Socket.IO CORS -> 浏览器跨域校验。
 *
 * 复用设计说明：
 * 1. Express API 与 Socket.IO 共用同一份 origin 构建逻辑，避免 HTTP 和 WebSocket 白名单不一致。
 * 2. 默认端口白名单集中在模块级 Set，后续本地端口变化只改一个入口，不在 app/socket 中重复判断。
 * 3. CORS_ORIGIN 仍保留显式配置优先级，生产环境可通过环境变量收紧到指定域名。
 *
 * 关键边界条件与坑点：
 * 1. 无 Origin 的同源、curl 或健康检查请求应放行，否则会误伤非浏览器请求。
 * 2. 默认白名单只按端口识别本地开发入口；生产环境必须配置 CORS_ORIGIN，不能依赖开发默认策略。
 */
export type CorsOriginFn = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
) => void;

const DEFAULT_LOCAL_CORS_PORTS = new Set(['6010', '5173']);

const parseCorsOrigins = (raw: string): string[] => {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const buildDefaultCorsOriginOption = (): CorsOriginFn => {
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    const value = String(origin).trim();
    if (!value) return cb(null, true);
    try {
      const url = new URL(value);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      return cb(null, DEFAULT_LOCAL_CORS_PORTS.has(port));
    } catch {
      return cb(null, false);
    }
  };
};

export const buildCorsOriginOption = (raw: string | undefined): string | CorsOriginFn => {
  const value = String(raw ?? '').trim();
  if (!value) return buildDefaultCorsOriginOption();
  if (value === '*') return (_origin, cb) => cb(null, true);
  const origins = parseCorsOrigins(value);
  if (origins.length <= 1) return origins[0] ?? buildDefaultCorsOriginOption();
  return (origin, cb) => {
    if (!origin) return cb(null, true);
    return cb(null, origins.includes(origin));
  };
};

