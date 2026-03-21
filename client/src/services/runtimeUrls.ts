/**
 * 作用：
 * 1. 集中管理前端运行时的 API / 服务器 / CDN URL 解析，避免请求层、静态资源层各自复制一套基址判断。
 * 2. 为静态资源、头像、keepalive 请求等入口提供同一数据源，确保 `VITE_CDN_BASE` 只在这里生效一次。
 * 不做什么：
 * 1. 不创建 axios 实例，不处理请求拦截与响应错误。
 * 2. 不负责业务资源兜底，不对空路径追加默认图片。
 *
 * 输入/输出：
 * - 输入：浏览器运行时 location、`VITE_API_BASE`、`VITE_CDN_BASE` 与资源路径字符串。
 * - 输出：统一的 `API_BASE` / `SERVER_BASE` / `CDN_BASE` 常量，以及拼接后的资源 URL。
 *
 * 数据流/状态流：
 * - env + window.location -> 基础地址解析
 * - 基础地址 -> `buildAssetUrl` / `resolveAssetUrl`
 * - 业务模块与入口模块复用同一条 URL 解析链
 *
 * 关键边界条件与坑点：
 * 1. `/uploads/*` 必须始终走 `SERVER_BASE`，不能误切到静态资源域，否则玩家上传头像会 404。
 * 2. 其它以 `/` 开头的静态资源默认走当前页面静态源；若配置 `VITE_CDN_BASE`，再统一走 CDN，避免前端 public 资源被误拼到 API 源站。
 */

const normalizeBaseUrl = (raw: string): string => {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalizedHostname = String(hostname || '').trim().toLowerCase();
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
};

const resolveApiBase = (): string => {
  const fromEnv = normalizeBaseUrl(
    (import.meta.env.VITE_API_BASE as string | undefined) ?? '',
  );

  if (typeof window === 'undefined' || !window.location) {
    return fromEnv || 'http://localhost:6011/api';
  }

  const protocol = window.location.protocol || 'http:';
  const hostname = window.location.hostname;
  const isDev = isLoopbackHostname(hostname);
  const runtimeDefault = isDev
    ? `${protocol}//${hostname}:6011/api`
    : `${protocol}//${hostname}/api`;
  const base = fromEnv || runtimeDefault;

  try {
    const url = new URL(base);
    if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(hostname)) {
      url.hostname = hostname;
      return normalizeBaseUrl(url.toString());
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    if (base.startsWith('/')) {
      return normalizeBaseUrl(`${window.location.origin}${base}`);
    }
    return base;
  }
};

const resolveCdnBase = (): string => {
  const fromEnv = normalizeBaseUrl(
    (import.meta.env.VITE_CDN_BASE as string | undefined) ?? '',
  );
  if (fromEnv) return fromEnv;
  if (typeof window !== 'undefined' && window.location) {
    return normalizeBaseUrl(window.location.origin);
  }
  return SERVER_BASE;
};

export interface AssetUrlHostConfig {
  serverBase: string;
  cdnBase: string;
}

export const API_BASE = resolveApiBase();
export const SERVER_BASE = API_BASE.replace(/\/api\/?$/, '');
export const CDN_BASE = resolveCdnBase();
export const CDN_ENABLED = CDN_BASE !== SERVER_BASE;

export const buildAssetUrl = (
  path: string,
  hostConfig: AssetUrlHostConfig,
): string => {
  const raw = (path ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/uploads/')) return `${hostConfig.serverBase}${raw}`;
  if (raw.startsWith('/')) return `${hostConfig.cdnBase}${raw}`;
  return `${hostConfig.cdnBase}/${raw}`;
};

export const resolveAssetUrl = (path: string): string => {
  return buildAssetUrl(path, {
    serverBase: SERVER_BASE,
    cdnBase: CDN_BASE,
  });
};

export const resolveAvatarUrl = (
  avatar?: string | null,
): string | undefined => {
  if (!avatar) return undefined;
  return resolveAssetUrl(avatar);
};
