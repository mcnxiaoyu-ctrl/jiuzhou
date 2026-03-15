/**
 * 作用：集中管理主题模式的解析、提交与文档同步；不负责具体的主题切换 UI。
 * 输入/输出：
 * - 输入：本地持久化主题值、系统主题偏好、用户手动选择的 `ThemeMode`
 * - 输出：供入口与业务组件复用的主题解析结果和同步动作
 * 数据流：
 * - 入口文件先读取初始主题并应用到 `document.body`
 * - App 持有运行时主题状态并响应主题事件
 * - 设置弹窗通过统一提交函数写入持久化并广播事件
 * 关键边界条件与坑点：
 * 1. 只有用户明确保存过 `light` / `dark` 时才视为手动选择，缺失记录时按系统主题解析。
 * 2. 初始系统主题不会写回 `localStorage`，避免把“自动解析结果”误当成“用户手动选择”。
 * 3. 仅支持 `light` / `dark` 两种模式，本模块不引入 `system` 第三态。
 * 4. 文档主题同步依赖 `document.body` 已可用，因此应在入口文件挂载阶段调用。
 */
export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ui_theme_v1';
export const THEME_EVENT_NAME = 'app:theme';

export const parseThemeMode = (raw: string | null | undefined): ThemeMode | null => {
  if (raw === 'dark' || raw === 'light') return raw;
  return null;
};

export const getPersistedThemeMode = (): ThemeMode | null => {
  return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
};

export const getSystemThemeMode = (): ThemeMode => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const getStoredThemeMode = (): ThemeMode => {
  return getPersistedThemeMode() ?? getSystemThemeMode();
};

export const persistThemeMode = (mode: ThemeMode): void => {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
};

export const emitThemeModeChange = (mode: ThemeMode): void => {
  window.dispatchEvent(new CustomEvent(THEME_EVENT_NAME, { detail: { mode } }));
};

export const commitThemeModeSelection = (mode: ThemeMode): void => {
  persistThemeMode(mode);
  emitThemeModeChange(mode);
};

export const applyThemeModeToDocument = (mode: ThemeMode, target: Document = document): void => {
  target.body.classList.toggle('theme-dark', mode === 'dark');
};
